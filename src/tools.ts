/**
 * Tool registry.
 *
 * Defines damson's tools and their handlers. Each tool is a single object
 * with both the schema (sent to Claude) and the implementation. New tools
 * register here.
 *
 * For v0.1 we ship a minimal set: bash, read_file, write_file, web_fetch,
 * memory_save, memory_search, config_get, config_set. Watchers, code_task,
 * scheduling come in 0.2.
 */

import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import type { ToolHandler, ToolInput } from './types.ts';
import type { Brain } from './brain.ts';
import type { BrainConfig } from './config.ts';
import { KNOWN_CONFIG_KEYS } from './config.ts';

const PATH_ENV = `${homedir()}/.local/bin:${homedir()}/.smux/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;

// Commands that require approval — never auto-execute.
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-rf?\b/,
  /\bgit\s+push\s+(--force|-f)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bsudo\s+rm\b/,
  /\bdrop\s+(table|database)\b/i,
];

function isDestructive(cmd: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(cmd));
}

export function buildTools(opts: { brain: Brain; brainConfig: BrainConfig; reposDir: string }): ToolHandler[] {
  const { brain, brainConfig, reposDir } = opts;

  return [
    {
      def: {
        name: 'bash',
        description:
          'Run a bash command. Use for git, gh, curl, jq, anything shell. Refuses destructive commands without approval (rm -rf, git push --force, drop table). Returns stdout + stderr.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command' },
            cwd: { type: 'string', description: 'Working directory (optional)' },
            timeout_ms: { type: 'number', description: 'Default 60000' },
          },
          required: ['command'],
        },
      },
      execute: async (input: ToolInput) => {
        const command = String(input.command || '');
        if (!command.trim()) return 'Error: empty command';
        if (isDestructive(command)) {
          return `Refused: "${command}" is destructive. Ask the user for explicit approval first.`;
        }
        const cwd = (input.cwd as string | undefined) || reposDir;
        const timeout = (input.timeout_ms as number | undefined) || 60_000;
        return new Promise<string>((resolve) => {
          const proc = spawn('bash', ['-c', command], {
            cwd: existsSync(cwd) ? cwd : process.cwd(),
            env: { ...process.env, HOME: homedir(), PATH: PATH_ENV },
            timeout,
          });
          let out = '';
          let err = '';
          proc.stdout.on('data', (d) => (out += d));
          proc.stderr.on('data', (d) => (err += d));
          proc.on('close', (code) => {
            const result = `exit ${code}\n--- stdout ---\n${out.slice(-4000)}${err ? `\n--- stderr ---\n${err.slice(-2000)}` : ''}`;
            resolve(result);
          });
          proc.on('error', (e) => resolve(`spawn error: ${e.message}`));
        });
      },
    },

    {
      def: {
        name: 'read_file',
        description: 'Read a file from disk. Returns first 10KB.',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      execute: (input: ToolInput) => {
        const p = String(input.path || '');
        const path = isAbsolute(p) ? p : join(reposDir, p);
        if (!existsSync(path)) return `Error: file not found: ${path}`;
        const content = readFileSync(path, 'utf-8');
        return content.length > 10_000 ? content.slice(0, 10_000) + '\n...(truncated)' : content;
      },
    },

    {
      def: {
        name: 'write_file',
        description:
          'Write content to a file. Creates parent dirs. Refuses to overwrite .env or files in damson\'s own src/ directory — those need code_task.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
      execute: (input: ToolInput) => {
        const p = String(input.path || '');
        const path = isAbsolute(p) ? p : join(reposDir, p);
        if (path.includes('/.env') || path.endsWith('/.env')) return 'Refused: .env contains secrets. Use /secret instead.';
        if (path.match(/\/damson\/src\/.+\.(ts|js)$/)) return 'Refused: damson source files need code_task with version bump.';
        try {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, String(input.content || ''));
          return `Wrote ${String(input.content || '').length} chars to ${path}`;
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      },
    },

    {
      def: {
        name: 'web_fetch',
        description: 'HTTP GET a URL. Returns body (max 10KB). Use for docs, APIs, status pages.',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            headers: { type: 'object', description: 'Optional headers' },
          },
          required: ['url'],
        },
      },
      execute: async (input: ToolInput) => {
        try {
          const res = await fetch(String(input.url), {
            headers: (input.headers as Record<string, string>) || undefined,
            signal: AbortSignal.timeout(30_000),
          });
          const body = await res.text();
          return `${res.status} ${res.statusText}\n${body.slice(0, 10_000)}`;
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      },
    },

    {
      def: {
        name: 'memory_save',
        description:
          'Save a fact, decision, or note to brain/. For "always X / never Y" rules, use config_set instead — config doesn\'t drift.',
        input_schema: {
          type: 'object',
          properties: {
            subdir: {
              type: 'string',
              enum: ['daily', 'decisions', 'projects', 'people'],
              description: 'Where in brain/ to save',
            },
            name: { type: 'string', description: 'File name (without .md)' },
            content: { type: 'string', description: 'What to save' },
          },
          required: ['subdir', 'name', 'content'],
        },
      },
      execute: (input: ToolInput) => {
        const ok = brain.save(String(input.subdir), String(input.name), String(input.content));
        return ok ? `✓ saved to brain/${input.subdir}/${input.name}.md` : 'failed';
      },
    },

    {
      def: {
        name: 'memory_search',
        description:
          'Search brain/ for relevant past content. Call this BEFORE answering anything that depends on prior context (URLs, people, projects, decisions).',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'number', description: 'Default 5' },
          },
          required: ['query'],
        },
      },
      execute: (input: ToolInput) => {
        const hits = brain.search(String(input.query), (input.limit as number) || 5);
        if (hits.length === 0) return '(no matches)';
        return hits.map((h) => `### ${h.file} (relevance ${h.relevance.toFixed(2)})\n${h.snippet}`).join('\n\n');
      },
    },

    {
      def: {
        name: 'config_get',
        description: 'Read a brain/config.json value. Omit key to list all.',
        input_schema: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: [],
        },
      },
      execute: (input: ToolInput) => {
        if (input.key) {
          const v = brainConfig.get(String(input.key));
          return v === undefined
            ? `(unset) — known keys: ${Object.keys(KNOWN_CONFIG_KEYS).join(', ')}`
            : `${input.key} = ${JSON.stringify(v)}`;
        }
        const all = brainConfig.getAll();
        if (Object.keys(all).length === 0) return '(no config set)';
        return Object.entries(all)
          .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
          .join('\n');
      },
    },

    {
      def: {
        name: 'config_set',
        description: `Set a hard rule in brain/config.json. Use this when the user states "always X / never Y" — config persists across restarts and doesn't drift.

Pre-registered keys (with type validation): ${Object.keys(KNOWN_CONFIG_KEYS).join(', ')}.

You can also set arbitrary keys (e.g. "git.never_force_push": true). They're saved with a soft warning. Use dotted identifiers like "browser.mode" or "github.default_repo".`,
        input_schema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Dotted identifier, e.g. "browser.mode" or "review.always_request_approval"' },
            value: { description: 'Boolean, string, or number. For known keys must match the registered type.' },
          },
          required: ['key', 'value'],
        },
      },
      execute: (input: ToolInput) => {
        const r = brainConfig.set(String(input.key), input.value);
        if (!r.ok) return `Error: ${r.error}`;
        const base = `✓ Set ${input.key} = ${JSON.stringify(input.value)}`;
        return r.warning ? `${base}\n\n${r.warning}` : base;
      },
    },
  ];
}
