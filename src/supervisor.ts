/**
 * Supervisor — detached subprocess runner with stall/freeze/done lifecycle events.
 *
 * Boris's pattern, ported with proper types. The wrapper script is a detached
 * bash subprocess that survives damson restarts. We monitor it via files
 * (stdout, stderr, .done, .progress) — no IPC. That means a damson restart
 * doesn't kill in-flight CC workers, and the heartbeat loop's orphan recovery
 * picks up completions that finished while damson was offline.
 *
 * Lifecycle events:
 *   'progress' — per tool_use, parsed from stream-json
 *   'stall'    — no-output threshold hit (notice, not kill)
 *   'frozen'   — CPU has been ~0% for a while (stronger than stall)
 *   'done'     — task ended (any reason)
 */

import { spawn, execSync } from 'node:child_process';
import {
  writeFileSync,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';

export type TerminationReason =
  | 'exit'
  | 'overall-timeout'
  | 'manual-cancel'
  | 'spawn-error'
  | 'signal'
  | 'lost';

export interface ProgressEvent {
  id: string;
  kind: 'tool_use' | 'result';
  step: number;
  tool?: string;
  args?: string;
  at: number;
}

export interface StallEvent {
  id: string;
  pid: number;
  ageMs: number;
  sinceOutputMs: number;
  tail: string;
  toolCount: number;
}

export interface FrozenEvent {
  id: string;
  pid: number;
  ageMs: number;
  sinceOutputMs: number;
  cpuTicksDelta: number;
  toolCount: number;
}

export interface DoneEvent {
  id: string;
  reason: TerminationReason;
  exitCode: number;
  durationMs: number;
  output: string;
  stderr: string;
  oomKilled: boolean;
  lastOutputAt: number;
  toolCount: number;
}

type Listener<T> = (e: T) => void;

interface Listeners {
  progress: Listener<ProgressEvent>[];
  stall: Listener<StallEvent>[];
  frozen: Listener<FrozenEvent>[];
  done: Listener<DoneEvent>[];
}

interface Files {
  scriptFile: string;
  outputFile: string;
  stderrFile: string;
  doneFile: string;
  progressFile: string;
}

export class SupervisedRun {
  readonly id: string;
  readonly pid: number;
  readonly startedAt = Date.now();
  endedAt: number | null = null;
  reason: TerminationReason | null = null;
  exitCode: number | null = null;
  lastOutputAt = Date.now();

  private files: Files;
  private listeners: Listeners = { progress: [], stall: [], frozen: [], done: [] };
  private cancelled = false;
  private stallSignaled = false;
  private frozenSignaled = false;
  private streamOffset = 0;
  private toolCount = 0;
  private lastCpuTicks: number | null = null;
  private lastCpuSampleAt = Date.now();

  constructor(opts: { id: string; pid: number } & Files) {
    this.id = opts.id;
    this.pid = opts.pid;
    this.files = {
      scriptFile: opts.scriptFile,
      outputFile: opts.outputFile,
      stderrFile: opts.stderrFile,
      doneFile: opts.doneFile,
      progressFile: opts.progressFile,
    };
  }

  on(event: 'progress', fn: Listener<ProgressEvent>): void;
  on(event: 'stall', fn: Listener<StallEvent>): void;
  on(event: 'frozen', fn: Listener<FrozenEvent>): void;
  on(event: 'done', fn: Listener<DoneEvent>): void;
  // implementation
  on(event: keyof Listeners, fn: (e: never) => void): void {
    (this.listeners[event] as Array<(e: never) => void>).push(fn);
  }

  private emit<E extends keyof Listeners>(event: E, payload: Parameters<Listeners[E][number]>[0]): void {
    for (const fn of this.listeners[event] as Listener<typeof payload>[]) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[supervisor] listener error: ${(e as Error).message}`);
      }
    }
  }

  cancel(reason: TerminationReason = 'manual-cancel'): boolean {
    if (this.cancelled || this.endedAt) return false;
    this.cancelled = true;
    try {
      process.kill(this.pid, 'SIGTERM');
    } catch {}
    setTimeout(() => {
      try {
        process.kill(this.pid, 'SIGKILL');
      } catch {}
    }, 5000);
    setTimeout(() => this.finalize(reason, -2), 3000);
    return true;
  }

  isAlive(): boolean {
    try {
      process.kill(this.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private finalize(reason: TerminationReason, exitCode: number): void {
    if (this.endedAt) return;
    this.endedAt = Date.now();
    this.reason = reason;
    this.exitCode = exitCode;
    const duration = this.endedAt - this.startedAt;

    let output = '';
    try {
      output = readFileSync(this.files.outputFile, 'utf-8');
      if (output.length > 500_000) {
        output = output.slice(0, 200_000) + '\n...(truncated middle for size)...\n' + output.slice(-200_000);
      }
    } catch {}

    let stderr = '';
    try {
      stderr = readFileSync(this.files.stderrFile, 'utf-8');
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    } catch {}

    let oomKilled = false;
    if (reason === 'signal' || (reason === 'exit' && (exitCode === 137 || exitCode === 139))) {
      try {
        const dmesg = execSync(
          `dmesg 2>/dev/null | tail -200 | grep -i -E "killed process ${this.pid}|oom.*${this.pid}" | tail -3`,
          { encoding: 'utf-8', timeout: 3000 }
        ).trim();
        if (dmesg) {
          oomKilled = true;
          stderr = `[OOM detected]\n${dmesg}\n\n---stderr---\n${stderr}`;
        }
      } catch {}
    }

    this.emit('done', {
      id: this.id,
      reason,
      exitCode,
      durationMs: duration,
      output,
      stderr,
      oomKilled,
      lastOutputAt: this.lastOutputAt,
      toolCount: this.toolCount,
    });

    for (const f of [
      this.files.scriptFile,
      this.files.outputFile,
      this.files.stderrFile,
      this.files.doneFile,
      this.files.progressFile,
    ]) {
      try {
        unlinkSync(f);
      } catch {}
    }
  }

  /** Read CPU ticks from /proc/<pid>/stat for freeze detection. Linux only. */
  private readCpuTicks(): { ticks: number; alive: boolean } {
    try {
      const stat = readFileSync(`/proc/${this.pid}/stat`, 'utf-8');
      const rparen = stat.lastIndexOf(')');
      const tail = stat.slice(rparen + 2).split(' ');
      const utime = parseInt(tail[11], 10) || 0;
      const stime = parseInt(tail[12], 10) || 0;
      return { ticks: utime + stime, alive: true };
    } catch {
      return { ticks: 0, alive: false };
    }
  }

  /** Incrementally parse new output bytes; emit progress per tool_use. */
  private parseNewOutput(): void {
    try {
      const st = statSync(this.files.outputFile);
      if (st.size <= this.streamOffset) return;
      const fd = openSync(this.files.outputFile, 'r');
      const bufSize = Math.min(st.size - this.streamOffset, 64 * 1024);
      const buf = Buffer.alloc(bufSize);
      const bytesRead = readSync(fd, buf, 0, bufSize, this.streamOffset);
      closeSync(fd);
      const chunk = buf.slice(0, bytesRead).toString('utf-8');
      this.streamOffset += bytesRead;
      const lastNewline = chunk.lastIndexOf('\n');
      if (lastNewline < 0) {
        this.streamOffset -= bytesRead;
        return;
      }
      const parsable = chunk.slice(0, lastNewline);
      const keep = bytesRead - (lastNewline + 1);
      this.streamOffset -= keep;
      for (const line of parsable.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'assistant' && ev.message?.content) {
            for (const block of ev.message.content) {
              if (block.type === 'tool_use') {
                this.toolCount++;
                const argHint = block.input ? JSON.stringify(block.input).slice(0, 100) : '';
                this.emit('progress', {
                  id: this.id,
                  kind: 'tool_use',
                  step: this.toolCount,
                  tool: block.name,
                  args: argHint,
                  at: Date.now(),
                });
              }
            }
          } else if (ev.type === 'result') {
            this.emit('progress', { id: this.id, kind: 'result', step: this.toolCount, at: Date.now() });
          }
        } catch {
          // not JSON — skip
        }
      }
    } catch {
      // file race etc.
    }
  }

  /** Internal: drives the poll loop. Public so spawnSupervised can attach. */
  _tick(opts: { noOutputMs: number; frozenMs: number }): void {
    if (this.endedAt) return;

    this.parseNewOutput();

    if (existsSync(this.files.doneFile)) {
      let currentSize = 0;
      try {
        currentSize = statSync(this.files.outputFile).size;
      } catch {}
      // Stable-read: wait for output to stop growing OR 15s elapsed
      if (this.doneSeenAt === null) {
        this.doneSeenAt = Date.now();
        this.doneSeenSize = currentSize;
        return;
      }
      const stable = currentSize === this.doneSeenSize;
      const waited = Date.now() - this.doneSeenAt > 15_000;
      if (!stable && !waited) {
        this.doneSeenSize = currentSize;
        return;
      }
      let exitCode = 1;
      try {
        exitCode = parseInt(readFileSync(this.files.doneFile, 'utf-8').trim(), 10) || 0;
      } catch {}
      if (exitCode === 124 || exitCode === 137) {
        this.finalize('overall-timeout', exitCode);
      } else {
        this.finalize('exit', exitCode);
      }
      return;
    }

    if (!this.isAlive()) {
      // Late .done detection: wait 3s then check again
      setTimeout(() => {
        if (this.endedAt) return;
        if (existsSync(this.files.doneFile)) {
          let exitCode = 1;
          try {
            exitCode = parseInt(readFileSync(this.files.doneFile, 'utf-8').trim(), 10) || 0;
          } catch {}
          this.finalize('exit', exitCode);
        } else {
          this.finalize('signal', -1);
        }
      }, 3000);
      return;
    }

    try {
      const st = statSync(this.files.outputFile);
      if (st.size > this.lastOutputSize) {
        this.lastOutputSize = st.size;
        this.lastOutputAt = Date.now();
        this.stallSignaled = false;
        this.frozenSignaled = false;
      }
    } catch {}

    if (this.endedAt) return;
    const sinceOutput = Date.now() - this.lastOutputAt;

    if (sinceOutput > opts.noOutputMs && !this.stallSignaled) {
      this.stallSignaled = true;
      let tail = '';
      try {
        const raw = readFileSync(this.files.outputFile, 'utf-8');
        tail = raw.slice(-500);
      } catch {}
      this.emit('stall', {
        id: this.id,
        pid: this.pid,
        ageMs: Date.now() - this.startedAt,
        sinceOutputMs: sinceOutput,
        tail,
        toolCount: this.toolCount,
      });
    }

    // CPU-based freeze detection — Linux only
    if (sinceOutput > 60_000 && Date.now() - this.lastCpuSampleAt > 30_000) {
      const sample = this.readCpuTicks();
      this.lastCpuSampleAt = Date.now();
      if (sample.alive) {
        if (this.lastCpuTicks !== null) {
          const ticksDelta = sample.ticks - this.lastCpuTicks;
          if (sinceOutput > opts.frozenMs && ticksDelta < 2 && !this.frozenSignaled) {
            this.frozenSignaled = true;
            this.emit('frozen', {
              id: this.id,
              pid: this.pid,
              ageMs: Date.now() - this.startedAt,
              sinceOutputMs: sinceOutput,
              cpuTicksDelta: ticksDelta,
              toolCount: this.toolCount,
            });
          }
        }
        this.lastCpuTicks = sample.ticks;
      }
    }
  }

  // poll-loop scratch state (managed by _tick)
  private doneSeenAt: number | null = null;
  private doneSeenSize: number | null = null;
  private lastOutputSize = 0;
}

export interface SpawnOpts {
  id: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  taskDir: string;
  timeoutMs?: number;
  noOutputMs?: number;
  frozenMs?: number;
}

export function spawnSupervised(opts: SpawnOpts): SupervisedRun {
  const {
    id,
    command,
    cwd,
    env,
    taskDir,
    timeoutMs = 15 * 60_000,
    noOutputMs = 3 * 60_000,
    frozenMs = 2 * 60_000,
  } = opts;

  mkdirSync(taskDir, { recursive: true });
  const scriptFile = join(taskDir, `${id}.sh`);
  const outputFile = join(taskDir, `${id}.output`);
  const stderrFile = join(taskDir, `${id}.stderr`);
  const doneFile = join(taskDir, `${id}.done`);
  const progressFile = join(taskDir, `${id}.progress`);

  const timeoutSec = Math.ceil(timeoutMs / 1000);
  const envExports = Object.entries(env || {})
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join('\n');

  const script = `#!/bin/bash
cd ${JSON.stringify(cwd)}
${envExports}
: > "${outputFile}"
: > "${stderrFile}"
date +%s > "${progressFile}"
(while true; do date +%s > "${progressFile}"; sleep 15; done) &
HEARTBEAT_PID=$!
timeout --kill-after=10 ${timeoutSec} stdbuf -oL -eL bash -c ${JSON.stringify(command)} >> "${outputFile}" 2>> "${stderrFile}"
EXIT=$?
kill $HEARTBEAT_PID 2>/dev/null
echo $EXIT > "${doneFile}"
`;

  writeFileSync(scriptFile, script, { mode: 0o755 });

  const proc = spawn('bash', [scriptFile], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  proc.unref();

  if (!proc.pid) {
    throw new Error(`failed to spawn supervised task ${id}`);
  }

  const run = new SupervisedRun({
    id,
    pid: proc.pid,
    scriptFile,
    outputFile,
    stderrFile,
    doneFile,
    progressFile,
  });

  const pollTimer = setInterval(() => {
    if (run.endedAt) {
      clearInterval(pollTimer);
      return;
    }
    run._tick({ noOutputMs, frozenMs });
  }, 5000);

  return run;
}
