/**
 * Task state. Persisted to brain/.tasks.json (active) and
 * brain/.task-history.json (last N completed). Atomic writes via tmp+rename.
 *
 * The TaskManager is the source of truth for "what code_tasks are running" —
 * the supervisor emits events, this module records them.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Task, TaskState, TaskKind } from './types.js';

const HISTORY_LIMIT = 50;

export class TaskManager {
  private activeFile: string;
  private historyFile: string;
  private active: Record<string, Task> = {};
  private history: Task[] = [];

  constructor(brainDir: string) {
    mkdirSync(brainDir, { recursive: true });
    this.activeFile = join(brainDir, '.tasks.json');
    this.historyFile = join(brainDir, '.task-history.json');
    this.load();
  }

  private load(): void {
    if (existsSync(this.activeFile)) {
      try {
        this.active = JSON.parse(readFileSync(this.activeFile, 'utf-8'));
      } catch {
        this.active = {};
      }
    }
    if (existsSync(this.historyFile)) {
      try {
        this.history = JSON.parse(readFileSync(this.historyFile, 'utf-8'));
      } catch {
        this.history = [];
      }
    }
  }

  private writeAtomic(file: string, data: unknown): void {
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, file);
  }

  private flushActive(): void {
    this.writeAtomic(this.activeFile, this.active);
  }

  private flushHistory(): void {
    this.writeAtomic(this.historyFile, this.history);
  }

  create(id: string, description: string, cwd: string, kind: TaskKind = 'code'): Task {
    if (this.active[id]) throw new Error(`task "${id}" already exists`);
    const task: Task = {
      id,
      description: description.slice(0, 500),
      cwd,
      kind,
      state: 'queued',
    };
    this.active[id] = task;
    this.flushActive();
    return task;
  }

  start(id: string, pid: number): void {
    const t = this.active[id];
    if (!t) return;
    t.state = 'running';
    t.pid = pid;
    t.startedAt = new Date().toISOString();
    this.flushActive();
  }

  updateProgress(id: string, step: number, preview?: string): void {
    const t = this.active[id];
    if (!t) return;
    t.step = step;
    if (preview) t.outputPreview = preview.slice(-500);
    this.flushActive();
  }

  markStalled(id: string, tail?: string): void {
    const t = this.active[id];
    if (!t) return;
    t.state = 'stalled';
    if (tail) t.outputPreview = tail.slice(-500);
    this.flushActive();
  }

  complete(id: string, reason: string, exitCode: number, summary?: string): void {
    const t = this.active[id];
    if (!t) return;
    t.completedAt = new Date().toISOString();
    t.reason = reason;
    t.exitCode = exitCode;
    t.summary = summary?.slice(0, 5000);
    t.state = exitCode === 0 && reason === 'exit' ? 'succeeded' : reason === 'manual-cancel' ? 'cancelled' : reason === 'lost' ? 'lost' : 'failed';
    delete this.active[id];
    this.history.unshift(t);
    if (this.history.length > HISTORY_LIMIT) this.history = this.history.slice(0, HISTORY_LIMIT);
    this.flushActive();
    this.flushHistory();
  }

  get(id: string): Task | undefined {
    return this.active[id] || this.history.find((t) => t.id === id);
  }

  getActive(): Task[] {
    return Object.values(this.active);
  }

  getRecent(n = 5): Task[] {
    return this.history.slice(0, n);
  }

  /** Brief one-line summary for the system prompt. */
  getSummary(): string {
    const active = this.getActive();
    const recent = this.getRecent(3);
    const parts: string[] = [];
    if (active.length > 0) {
      parts.push(
        'Active:\n' +
          active.map((t) => `🔄 ${t.id}: ${t.description.slice(0, 60)}${t.step ? ` (step ${t.step})` : ''}`).join('\n')
      );
    }
    if (recent.length > 0) {
      parts.push(
        'Recent:\n' +
          recent
            .map((t) => {
              const emoji = t.state === 'succeeded' ? '✅' : t.state === 'cancelled' ? '🚫' : '❌';
              return `${emoji} ${t.id}: ${t.description.slice(0, 60)}`;
            })
            .join('\n')
      );
    }
    return parts.join('\n\n');
  }
}
