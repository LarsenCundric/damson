/**
 * Built-in watcher implementations.
 *
 * - http_poll: curl an endpoint, evaluate body via simple expression on JSON
 * - github_events: poll GitHub /notifications, emit per new entry
 *
 * Each registers with the watcher registry. Add new types here.
 */

import type { WatcherConfig, WatcherImpl, WatcherTickContext } from './watchers.ts';

// ==================== http_poll ====================
//
// config:
//   url: string                    (required)
//   headers: Record<string,string> (optional; values can be `${env:VAR}` to lazy-pull)
//   accept_jsonpath: string        (optional, dotted path: "data.0.id"; default = whole body)
//   change_only: boolean           (default true — only emit when value changes vs last tick)

interface HttpPollState {
  lastValue?: string;
  lastTickedAt?: number;
}

function expandEnv(s: string): string {
  return s.replace(/\$\{env:([A-Z0-9_]+)\}/g, (_, k) => process.env[k] || '');
}

function jsonPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = parseInt(part, 10);
      cur = isNaN(i) ? undefined : cur[i];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

class HttpPollWatcher implements WatcherImpl {
  private config: WatcherConfig;
  constructor(config: WatcherConfig) {
    this.config = config;
  }

  async tick(ctx: WatcherTickContext): Promise<void> {
    const cfg = this.config.config;
    const url = String(cfg.url || '');
    if (!url) throw new Error(`http_poll watcher ${this.config.name}: missing url`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.headers || {})) {
      headers[k] = expandEnv(String(v));
    }
    const acceptPath = String(cfg.accept_jsonpath || '');
    const changeOnly = cfg.change_only !== false;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    const body = await res.text();
    let extracted: unknown = body;
    if (acceptPath) {
      try {
        extracted = jsonPath(JSON.parse(body), acceptPath);
      } catch {
        extracted = body;
      }
    }
    const valueStr = typeof extracted === 'string' ? extracted : JSON.stringify(extracted);
    const state = ctx.state as HttpPollState;
    const lastValue = state.lastValue;
    state.lastValue = valueStr;
    state.lastTickedAt = Date.now();

    if (changeOnly && lastValue === valueStr) return;
    if (changeOnly && lastValue === undefined) {
      // First-ever tick: don't emit, just record baseline
      return;
    }

    ctx.emit([
      {
        eventId: `${this.config.name}-${Date.now()}`,
        summary: `${this.config.name}: ${lastValue || '(initial)'} → ${valueStr.slice(0, 200)}`,
        payload: {
          url,
          previous: lastValue,
          current: valueStr,
          status: res.status,
        },
      },
    ]);
  }
}

// ==================== github_events ====================
//
// config:
//   token_env: string              (default: GITHUB_TOKEN)
//   include: string[]              (filter notification reasons; default = ['review_requested', 'mention', 'assign'])
//   participating: boolean         (true = only PRs/issues you're directly involved in; default true)

const DEFAULT_GH_REASONS = ['review_requested', 'mention', 'assign'];

interface GhState {
  seenIds?: string[];
  lastSince?: string; // ISO timestamp
}

interface GhNotification {
  id: string;
  reason: string;
  updated_at: string;
  unread: boolean;
  subject: { title: string; type: string; url?: string };
  repository: { full_name: string };
}

class GithubEventsWatcher implements WatcherImpl {
  private config: WatcherConfig;
  constructor(config: WatcherConfig) {
    this.config = config;
  }

  async tick(ctx: WatcherTickContext): Promise<void> {
    const cfg = this.config.config;
    const tokenEnv = String(cfg.token_env || 'GITHUB_TOKEN');
    const token = process.env[tokenEnv];
    if (!token) {
      throw new Error(`github_events ${this.config.name}: ${tokenEnv} not set`);
    }
    const includeRaw = (cfg.include as string[]) || DEFAULT_GH_REASONS;
    const include = new Set(includeRaw.map((r) => String(r)));
    const participating = cfg.participating !== false;

    const state = ctx.state as GhState;
    const since = state.lastSince || new Date(Date.now() - 24 * 3600_000).toISOString();
    const url = `https://api.github.com/notifications?participating=${participating}&since=${encodeURIComponent(since)}&per_page=50`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new Error(`github_events ${this.config.name}: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
    }
    const notifications = (await res.json()) as GhNotification[];
    const seen = new Set(state.seenIds || []);
    const events = [];
    for (const n of notifications) {
      if (!n.unread) continue;
      if (!include.has(n.reason)) continue;
      if (seen.has(n.id)) continue;
      seen.add(n.id);

      const link = n.subject.url
        ? n.subject.url
            .replace('api.github.com/repos/', 'github.com/')
            .replace('/pulls/', '/pull/')
        : n.repository.full_name;

      events.push({
        eventId: `gh-${n.id}`,
        summary: `[${n.reason}] ${n.repository.full_name}: ${n.subject.title} (${n.subject.type})`,
        payload: {
          repo: n.repository.full_name,
          reason: n.reason,
          title: n.subject.title,
          subjectType: n.subject.type,
          url: link,
          updatedAt: n.updated_at,
          ghNotificationId: n.id,
        },
      });
    }

    state.seenIds = [...seen].slice(-500); // bound the seen-set
    state.lastSince = new Date().toISOString();
    if (events.length > 0) ctx.emit(events);
  }
}

// ==================== registration ====================

export function registerBuiltinWatchers(register: (type: string, factory: (config: WatcherConfig) => WatcherImpl) => void): void {
  register('http_poll', (config) => new HttpPollWatcher(config));
  register('github_events', (config) => new GithubEventsWatcher(config));
}
