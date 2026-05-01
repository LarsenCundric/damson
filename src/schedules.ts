/**
 * Schedules — recurring or one-shot scheduled work.
 *
 * Three types:
 *   - bash:   runs a literal shell command. Output → user message.
 *   - agent:  runs a full damson tool loop with the prompt as the trigger.
 *             Most powerful; can curl, reason, decide whether to alert.
 *   - ai:     blind LLM call with no tools. Pure text generation only.
 *             Avoid for anything involving real data — it hallucinates.
 *             (Boris incident: a 4-hourly "analyze Datafast" type:'ai'
 *             schedule fabricated traffic numbers for hours before the
 *             user noticed.)
 *
 * Stored as `brain/.schedules.json`. Heartbeat ticks them.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { CronExpressionParser } from 'cron-parser';

export type ScheduleType = 'bash' | 'agent' | 'ai';
export type DeliveryTier = 'telegram' | 'brain_file' | 'silent_unless_flagged';

export interface ScheduleConfig {
  name: string;
  cron: string;
  type: ScheduleType;
  /** Required for type=bash. */
  command?: string;
  /** Required for type=agent or type=ai. */
  prompt?: string;
  /** Where the output should go. Defaults: bash/agent → telegram, ai → telegram. */
  delivery?: DeliveryTier;
  /** True = auto-deletes after first run. For "remind me at 3pm" cases. */
  oneShot?: boolean;
  /** Skip Telegram message, only land in morning brief / brain. */
  silent?: boolean;
}

export interface ScheduleRecord extends ScheduleConfig {
  createdAt: string;
  lastRunAt?: string;
  runCount: number;
}

export interface DueSchedule extends ScheduleRecord {
  dueAt: number;
}

const HEARTBEAT_PATTERNS = /heartbeat|ping|alive|health.*check|ready.*help|status.*check/i;

export class ScheduleManager {
  private file: string;
  private cache: Record<string, ScheduleRecord> = {};

  constructor(brainDir: string) {
    mkdirSync(brainDir, { recursive: true });
    this.file = join(brainDir, '.schedules.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      this.cache = JSON.parse(readFileSync(this.file, 'utf-8'));
    } catch (e) {
      console.error(`[schedules] parse failed: ${(e as Error).message}`);
      this.cache = {};
    }
  }

  private flush(): void {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.cache, null, 2));
    renameSync(tmp, this.file);
  }

  /**
   * Returns either a created record or a string error.
   */
  create(cfg: ScheduleConfig): { ok: true; record: ScheduleRecord } | { ok: false; error: string } {
    const name = (cfg.name || '').trim();
    if (!name) return { ok: false, error: 'name is required' };
    if (this.cache[name]) return { ok: false, error: `schedule "${name}" already exists` };

    // Block heartbeat-style spam schedules entirely
    const checkSpam = HEARTBEAT_PATTERNS.test(name) || HEARTBEAT_PATTERNS.test(cfg.command || '') || HEARTBEAT_PATTERNS.test(cfg.prompt || '');
    if (checkSpam) {
      return { ok: false, error: `"${name}" looks like a heartbeat/keepalive — those create runaway loops. damson has built-in liveness; this is blocked.` };
    }

    // Validate cron
    try {
      CronExpressionParser.parse(cfg.cron);
    } catch (e) {
      return { ok: false, error: `invalid cron "${cfg.cron}": ${(e as Error).message}` };
    }

    if (cfg.type === 'bash' && !cfg.command) return { ok: false, error: 'bash schedules need a command' };
    if ((cfg.type === 'agent' || cfg.type === 'ai') && !cfg.prompt)
      return { ok: false, error: `${cfg.type} schedules need a prompt` };

    const record: ScheduleRecord = {
      ...cfg,
      delivery: cfg.delivery || 'telegram',
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
    this.cache[name] = record;
    this.flush();
    return { ok: true, record };
  }

  delete(name: string): boolean {
    if (!this.cache[name]) return false;
    delete this.cache[name];
    this.flush();
    return true;
  }

  get(name: string): ScheduleRecord | undefined {
    return this.cache[name];
  }

  list(): ScheduleRecord[] {
    return Object.values(this.cache);
  }

  /** Find all schedules that should fire by `now`. */
  getDue(now = new Date()): DueSchedule[] {
    const due: DueSchedule[] = [];
    for (const s of Object.values(this.cache)) {
      try {
        const interval = CronExpressionParser.parse(s.cron, {
          currentDate: s.lastRunAt ? new Date(s.lastRunAt) : new Date(Date.parse(s.createdAt) - 1000),
        });
        const next = interval.next().toDate();
        if (next.getTime() <= now.getTime()) {
          due.push({ ...s, dueAt: next.getTime() });
        }
      } catch {
        // bad cron — skip
      }
    }
    return due;
  }

  markRun(name: string): void {
    const r = this.cache[name];
    if (!r) return;
    r.lastRunAt = new Date().toISOString();
    r.runCount = (r.runCount || 0) + 1;
    if (r.oneShot) {
      delete this.cache[name];
    }
    this.flush();
  }

  /** Format for /schedules and digest output. */
  formatList(): string {
    const all = Object.values(this.cache);
    if (all.length === 0) return 'No schedules.';
    return all
      .map((s) => `- ${s.name} (${s.type}, ${s.cron}${s.oneShot ? ', one-shot' : ''}${s.silent ? ', silent' : ''}) → ${s.delivery || 'telegram'}`)
      .join('\n');
  }
}

// ====================================================================
// Executors — run a single schedule and return the output text.
// Heartbeat dispatches based on schedule.type.
// ====================================================================

const PATH_ENV = `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;

export async function executeBashSchedule(s: ScheduleRecord, cwd: string): Promise<string> {
  if (!s.command) return '(no command)';
  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', s.command!], {
      cwd,
      env: { ...process.env, PATH: PATH_ENV },
      timeout: 60_000,
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      const result = (out || err || '(no output)').slice(0, 4000);
      resolve(code === 0 ? result : `(exit ${code})\n${result}`);
    });
    proc.on('error', (e) => resolve(`spawn error: ${e.message}`));
  });
}

/** type=ai — blind LLM call with no tools. Hallucinates if asked to "analyze" anything. */
export async function executeAiSchedule(
  s: ScheduleRecord,
  client: import('@anthropic-ai/sdk').default,
  brainContext: string
): Promise<string> {
  const systemPrompt = `You are damson generating a scheduled report. Output the report body only — no preamble, no XML tags, no markdown code fences unless the content is genuinely code. NO TOOLS available — you cannot fetch data. If the prompt requires real data and you don't have it in context below, say so plainly instead of fabricating.

Context:
${brainContext.slice(0, 2000)}`;
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: s.prompt || '(no prompt)' }],
    });
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n')
      .trim();
    return text || '(no output)';
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

/**
 * type=agent runs through the full damson agent loop. The runtime injects
 * an `agentRunner` callback because schedules.ts shouldn't depend on agent.ts
 * (avoids a cycle). The callback gets the prompt and returns a result.
 */
export type AgentRunner = (prompt: string, opts?: { silent?: boolean }) => Promise<string>;

export async function executeAgentSchedule(s: ScheduleRecord, runner: AgentRunner): Promise<string> {
  if (!s.prompt) return '(no prompt)';
  return runner(s.prompt, { silent: !!s.silent });
}
