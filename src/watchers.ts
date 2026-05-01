/**
 * Watchers — the proactive primitive.
 *
 * A watcher is a small YAML file in `brain/watchers/<name>.yaml`:
 *
 *   name: my-prs
 *   type: github_events
 *   poll_every: 10m            # min duration; defaults to 10m
 *   notify: ask                # ask | always | digest_only
 *   config: { ... }            # type-specific
 *
 * The WatcherRegistry loads YAMLs at boot, instantiates each by type,
 * registers a hook on the heartbeat, and lets each tick emit events
 * through the bus. Watcher state (last-seen ids, last-tick time) lives
 * in `brain/watchers/<name>.state.json` — survives restarts.
 *
 * Implementations register via `registerWatcherType`. v0.3 ships
 * `github_events` and `http_poll`.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { EventBus } from './event-bus.js';

export type NotifyTier = 'ask' | 'always' | 'digest_only';

export interface WatcherConfig {
  name: string;
  type: string;
  pollEveryMs: number;
  notify: NotifyTier;
  config: Record<string, unknown>;
}

export interface WatcherState {
  [key: string]: unknown;
}

export interface WatcherEvent {
  /** Stable id within this watcher (used for dedup state). */
  eventId: string;
  /** Short human-readable summary for system events / digests. */
  summary: string;
  /** Full payload to attach to the bus event. */
  payload: Record<string, unknown>;
}

export interface WatcherTickContext {
  config: WatcherConfig;
  state: WatcherState;
  emit: (events: WatcherEvent[]) => void;
}

/** A WatcherImpl produces events on tick. State is mutable — implementation
 * should update it as it processes. */
export interface WatcherImpl {
  tick(ctx: WatcherTickContext): Promise<void> | void;
}

export type WatcherFactory = (config: WatcherConfig) => WatcherImpl;

const REGISTRY = new Map<string, WatcherFactory>();

export function registerWatcherType(type: string, factory: WatcherFactory): void {
  REGISTRY.set(type, factory);
}

function parseDuration(s: string | number | undefined, defaultMs: number): number {
  if (typeof s === 'number') return s;
  if (!s) return defaultMs;
  const m = /^(\d+)\s*(s|sec|seconds|m|min|minutes|h|hr|hours|d|day|days)?$/i.exec(String(s).trim());
  if (!m) return defaultMs;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 'm').toLowerCase();
  if (unit.startsWith('s')) return n * 1000;
  if (unit.startsWith('h')) return n * 3600_000;
  if (unit.startsWith('d')) return n * 86_400_000;
  return n * 60_000; // default minutes
}

interface LoadedWatcher {
  config: WatcherConfig;
  impl: WatcherImpl;
  lastTickAt: number;
  stateFile: string;
}

export class WatcherRegistry {
  private dir: string;
  private bus: EventBus;
  private watchers: LoadedWatcher[] = [];

  constructor(brainDir: string, bus: EventBus) {
    this.dir = join(brainDir, 'watchers');
    this.bus = bus;
    mkdirSync(this.dir, { recursive: true });
  }

  /** Load all watcher YAMLs from brain/watchers/*.yaml. Idempotent. */
  load(): void {
    this.watchers = [];
    if (!existsSync(this.dir)) return;
    const files = readdirSync(this.dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const f of files) {
      const path = join(this.dir, f);
      let parsed: Record<string, unknown>;
      try {
        parsed = parseYaml(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      } catch (e) {
        console.error(`[watchers] failed to parse ${f}: ${(e as Error).message}`);
        continue;
      }
      if (!parsed || typeof parsed !== 'object') {
        console.error(`[watchers] skipping ${f}: empty/invalid`);
        continue;
      }
      const name = String(parsed.name || f.replace(/\.ya?ml$/, ''));
      const type = String(parsed.type || '');
      if (!type) {
        console.error(`[watchers] ${name}: missing 'type'`);
        continue;
      }
      const factory = REGISTRY.get(type);
      if (!factory) {
        console.error(`[watchers] ${name}: unknown type "${type}" (registered: ${[...REGISTRY.keys()].join(', ') || 'none'})`);
        continue;
      }
      const config: WatcherConfig = {
        name,
        type,
        pollEveryMs: parseDuration(parsed.poll_every as string, 10 * 60_000),
        notify: (parsed.notify as NotifyTier) || 'ask',
        config: (parsed.config as Record<string, unknown>) || {},
      };
      const impl = factory(config);
      this.watchers.push({
        config,
        impl,
        lastTickAt: 0,
        stateFile: join(this.dir, `${name}.state.json`),
      });
      console.log(`[watchers] loaded ${name} (${type}, every ${Math.round(config.pollEveryMs / 60_000)}m, notify=${config.notify})`);
    }
  }

  /** Heartbeat hook — calls tick() on any watcher whose pollEveryMs has elapsed. */
  async tick(): Promise<void> {
    const now = Date.now();
    for (const w of this.watchers) {
      if (now - w.lastTickAt < w.config.pollEveryMs) continue;
      w.lastTickAt = now;
      try {
        const state = this.loadState(w.stateFile);
        const collected: WatcherEvent[] = [];
        await w.impl.tick({
          config: w.config,
          state,
          emit: (events) => collected.push(...events),
        });
        this.saveState(w.stateFile, state);
        for (const ev of collected) {
          this.bus.emit({
            type: `watcher.${w.config.name}` as `watcher.${string}`,
            source: 'watcher',
            payload: {
              watcherName: w.config.name,
              watcherType: w.config.type,
              notify: w.config.notify,
              eventId: ev.eventId,
              summary: ev.summary,
              ...ev.payload,
            },
          });
        }
      } catch (e) {
        console.error(`[watchers] ${w.config.name} tick error: ${(e as Error).message}`);
      }
    }
  }

  list(): WatcherConfig[] {
    return this.watchers.map((w) => ({ ...w.config }));
  }

  private loadState(file: string): WatcherState {
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      return {};
    }
  }

  private saveState(file: string, state: WatcherState): void {
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, file);
  }
}
