/**
 * Heartbeat — periodic tick that drives proactive behavior.
 *
 * Responsibilities:
 *   - Orphan recovery on boot: tasks that completed while damson was offline
 *     get their .done files read, results synthesized, events emitted through
 *     the same path as live completions
 *   - Watcher polling (when watchers register a tick callback)
 *   - Scheduled work (when schedules register a tick callback)
 *
 * Boris pattern: detached CC workers survive damson restarts because
 * `KillMode=process` in systemd. Heartbeat picks them up on boot.
 */

import { existsSync, readFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskManager } from './tasks.ts';
import type { EventBus } from './event-bus.ts';
import type { SupervisedRun } from './supervisor.ts';

const DEFAULT_TICK_MS = 30_000;
const ORPHAN_LATE_CHECK_MS = 3 * 60_000; // wait 3min after PID gone before declaring lost

export type TickHook = () => Promise<void> | void;

export interface HeartbeatDeps {
  tasks: TaskManager;
  bus: EventBus;
  taskRunsDir: string;
  /** Active in-process runs (so we don't double-handle them). */
  activeRuns: Map<string, SupervisedRun>;
  intervalMs?: number;
}

export class Heartbeat {
  private deps: HeartbeatDeps;
  private hooks: TickHook[] = [];
  private timer: NodeJS.Timeout | null = null;
  private orphanCheckDone = false;

  constructor(deps: HeartbeatDeps) {
    this.deps = deps;
  }

  /** Add a function called on each tick. Watchers / schedules use this. */
  addHook(hook: TickHook): void {
    this.hooks.push(hook);
  }

  start(): void {
    const interval = this.deps.intervalMs ?? DEFAULT_TICK_MS;
    // First tick after 5s so the bot is fully connected
    setTimeout(() => this.tick(), 5_000);
    this.timer = setInterval(() => this.tick(), interval);
    console.log(`[heartbeat] started — every ${Math.round(interval / 1000)}s`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      if (!this.orphanCheckDone) {
        this.orphanCheckDone = true;
        await this.recoverOrphans();
      }
      await this.checkLostTasks();
      for (const hook of this.hooks) {
        try {
          await hook();
        } catch (e) {
          console.error(`[heartbeat] hook error: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      console.error(`[heartbeat] tick error: ${(e as Error).message}`);
    }
  }

  /**
   * On boot, scan brain/.task-runs/*.done — these are tasks that completed
   * while damson was offline. Read their exit code + output, route through
   * the EventBus as if they completed live.
   */
  private async recoverOrphans(): Promise<void> {
    const dir = this.deps.taskRunsDir;
    if (!existsSync(dir)) return;
    const doneFiles = readdirSync(dir).filter((f) => f.endsWith('.done'));
    for (const doneFile of doneFiles) {
      const taskId = doneFile.slice(0, -'.done'.length);
      // Skip if we own this run live (shouldn't happen at boot but guard)
      if (this.deps.activeRuns.has(taskId)) continue;

      const donePath = join(dir, doneFile);
      const outputPath = join(dir, `${taskId}.output`);
      const stderrPath = join(dir, `${taskId}.stderr`);

      let exitCode = 1;
      try {
        exitCode = parseInt(readFileSync(donePath, 'utf-8').trim(), 10) || 0;
      } catch {}
      let output = '';
      try {
        output = existsSync(outputPath) ? readFileSync(outputPath, 'utf-8').trim() : '';
      } catch {}
      let stderr = '';
      try {
        stderr = existsSync(stderrPath) ? readFileSync(stderrPath, 'utf-8').trim() : '';
      } catch {}

      const summary = this.extractSummary(output) || (stderr ? `(stderr)\n${stderr.slice(-500)}` : '(no output)');
      const reason = exitCode === 124 || exitCode === 137 ? 'overall-timeout' : 'exit';
      const success = reason === 'exit' && exitCode === 0;

      // If TaskManager doesn't know about this task, that's fine — it might
      // have been spawned in a previous lifetime. Record completion anyway
      // so the agent can see it.
      const known = this.deps.tasks.get(taskId);
      if (known && (known.state === 'running' || known.state === 'queued' || known.state === 'stalled')) {
        this.deps.tasks.complete(taskId, reason, exitCode, summary);
      }

      console.log(`[heartbeat] orphan recovered: ${taskId} (exit ${exitCode})`);
      this.deps.bus.emit({
        type: success ? 'task.done.success' : 'task.done.failure',
        source: 'heartbeat',
        payload: {
          taskId,
          reason,
          exitCode,
          durationMin: 0,
          userSummary: summary,
          stderrTail: stderr.slice(-500),
          oomKilled: false,
          toolCount: 0,
          orphanRecovered: true,
        },
      });

      // Cleanup files now that we've handled the completion
      for (const f of [donePath, outputPath, stderrPath, join(dir, `${taskId}.sh`), join(dir, `${taskId}.progress`)]) {
        try {
          unlinkSync(f);
        } catch {}
      }
    }
  }

  /**
   * Tasks marked `running` whose PID is gone, with no .done file appearing
   * within ORPHAN_LATE_CHECK_MS, get marked as `lost`. Catches CC crashes.
   */
  private async checkLostTasks(): Promise<void> {
    for (const task of this.deps.tasks.getActive()) {
      if (task.state !== 'running' && task.state !== 'stalled') continue;
      if (!task.pid) continue;
      // Skip if we own this run live (supervisor handles it)
      if (this.deps.activeRuns.has(task.id)) continue;
      // Grace period — give it 3 min after start before checking
      const startedAt = task.startedAt ? Date.parse(task.startedAt) : Date.now();
      if (Date.now() - startedAt < ORPHAN_LATE_CHECK_MS) continue;

      let alive = false;
      try {
        process.kill(task.pid, 0);
        alive = true;
      } catch {}
      if (alive) continue;

      // PID gone. Look for late .done file.
      const donePath = join(this.deps.taskRunsDir, `${task.id}.done`);
      if (existsSync(donePath)) continue; // next tick's recoverOrphans will handle it

      // Truly lost. Mark and emit failure.
      this.deps.tasks.complete(task.id, 'lost', -3, 'PID gone, no completion record after 3min');
      console.log(`[heartbeat] task lost: ${task.id} (PID ${task.pid} gone, no .done)`);
      this.deps.bus.emit({
        type: 'task.done.failure',
        source: 'heartbeat',
        payload: {
          taskId: task.id,
          reason: 'lost',
          exitCode: -3,
          durationMin: Math.round((Date.now() - startedAt) / 60_000),
          userSummary: 'Process disappeared without writing completion record. Possible crash.',
          stderrTail: '',
          oomKilled: false,
          toolCount: 0,
        },
      });
    }
  }

  /** Extract a usable summary from CC's stream-json output. */
  private extractSummary(output: string): string {
    if (!output) return '';
    const lines = output.split('\n').filter(Boolean);
    // Walk backwards looking for the final result event
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev.type === 'result' && typeof ev.result === 'string') return ev.result;
      } catch {}
    }
    // Fallback: gather assistant text blocks
    const texts: string[] = [];
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const b of ev.message.content) {
            if (b.type === 'text' && b.text) texts.push(b.text);
          }
        }
      } catch {}
    }
    return texts.join('\n').trim();
  }
}
