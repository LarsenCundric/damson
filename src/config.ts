/**
 * Loads damson's configuration from environment variables and brain/config.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { DamsonConfig } from './types.ts';

function parseQuietHours(raw: string | undefined): { start: number; end: number } {
  if (!raw) return { start: 0, end: 8 };
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(raw.trim());
  if (!m) return { start: 0, end: 8 };
  return { start: parseInt(m[1], 10), end: parseInt(m[2], 10) };
}

export function loadConfig(): DamsonConfig {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const botToken = process.env.BOT_TOKEN;
  if (!anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is required (set it in .env)');
  if (!botToken) throw new Error('BOT_TOKEN is required (set it in .env). Get one from @BotFather on Telegram.');

  const brainDir = resolve(process.env.BRAIN_DIR || './brain');
  const reposDir = resolve(process.env.REPOS_DIR || join(homedir(), 'repos'));
  const defaultCcModel = process.env.DEFAULT_CC_MODEL || 'opus';
  const quietHours = parseQuietHours(process.env.QUIET_HOURS);
  const heartbeatIntervalMin = parseInt(process.env.HEARTBEAT_INTERVAL_MIN || '15', 10);

  return {
    anthropicApiKey,
    botToken,
    brainDir,
    reposDir,
    defaultCcModel,
    quietHours,
    heartbeatIntervalMin,
  };
}

// ==================== BRAIN CONFIG (config.json) ====================

export const KNOWN_CONFIG_KEYS = {
  'verify.before_claim': { type: 'bool', desc: 'damson must verify state with tools before claiming done' },
  'browser.mode': { values: ['cloud', 'local'], desc: 'browser execution backend (when used)' },
  'code_task.default_branch': { type: 'string', desc: 'default git branch for self-edit workers' },
  'cc.default_model': { values: ['opus', 'sonnet', 'haiku'], desc: 'default Claude Code model' },
} as const;

export type KnownConfigKey = keyof typeof KNOWN_CONFIG_KEYS;

export class BrainConfig {
  private file: string;
  private cache: Record<string, unknown> | null = null;
  private mtime = 0;

  constructor(brainDir: string) {
    this.file = join(brainDir, 'config.json');
  }

  private load(): Record<string, unknown> {
    if (!existsSync(this.file)) return {};
    const m = statSync(this.file).mtimeMs;
    if (this.cache && m === this.mtime) return this.cache;
    try {
      this.cache = JSON.parse(readFileSync(this.file, 'utf-8'));
      this.mtime = m;
    } catch (e) {
      console.error(`[config] parse failed: ${(e as Error).message}`);
      this.cache = {};
    }
    return this.cache!;
  }

  get<T = unknown>(key: string): T | undefined {
    const all = this.load();
    return key in all ? (all[key] as T) : undefined;
  }

  getAll(): Record<string, unknown> {
    return { ...this.load() };
  }

  /**
   * Set a config value. Known keys (in KNOWN_CONFIG_KEYS) get strict
   * validation. Unknown keys are accepted but flagged via the `warning`
   * field — this is intentional: the principle is "hard rules persist
   * here", and forcing every rule to be pre-registered breaks the
   * "always X / never Y" use case the user hasn't predicted yet.
   */
  set(key: string, value: unknown): { ok: true; warning?: string } | { ok: false; error: string } {
    // Validate key shape — must be a sane dotted identifier
    if (!/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*$/.test(key)) {
      return { ok: false, error: `invalid config key "${key}" — use dotted identifiers like "browser.mode"` };
    }

    let warning: string | undefined;
    if (key in KNOWN_CONFIG_KEYS) {
      const spec = KNOWN_CONFIG_KEYS[key as KnownConfigKey] as {
        values?: readonly string[];
        type?: 'string' | 'bool';
      };
      if (spec.values && !spec.values.includes(String(value))) {
        return { ok: false, error: `invalid value "${value}" for "${key}". Allowed: ${spec.values.join(', ')}` };
      }
      if (spec.type === 'bool' && typeof value !== 'boolean') {
        return { ok: false, error: `"${key}" must be a boolean` };
      }
      if (spec.type === 'string' && typeof value !== 'string') {
        return { ok: false, error: `"${key}" must be a string` };
      }
    } else {
      warning = `note: "${key}" is not a registered config key — accepting it. Registered keys with type validation: ${Object.keys(KNOWN_CONFIG_KEYS).join(', ')}.`;
    }

    const all = this.load();
    all[key] = value;
    mkdirSync(join(this.file, '..'), { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    renameSync(tmp, this.file);
    this.cache = all;
    this.mtime = statSync(this.file).mtimeMs;
    return warning ? { ok: true, warning } : { ok: true };
  }

  formatForPrompt(): string {
    const all = this.load();
    const keys = Object.keys(all);
    if (keys.length === 0) return '';
    return keys.sort().map(k => `- ${k}: ${JSON.stringify(all[k])}`).join('\n');
  }
}
