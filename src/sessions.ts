/**
 * Session router. Decides whether to spawn a Claude Code worker with a fresh
 * session-id or resume a recent matching session.
 *
 * Match heuristic (conservative — prefer cold over false-reuse):
 *   - cwd exact match
 *   - topic keyword overlap ≥ 2 for long prompts
 *   - lastActiveAt within REUSE_WINDOW_MS (15 min)
 *
 * Short follow-ups ("now push it") get a special path: if there's exactly
 * one recent session in the cwd, reuse with no keyword overlap required.
 *
 * Sessions expire after IDLE_TTL_MS (30 min) — past that we'd start cold
 * anyway because the worker has likely lost file context.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const REUSE_WINDOW_MS = 15 * 60_000;
const IDLE_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 40;

const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','by','for','from','has','have','he','i','in','is',
  'it','its','of','on','or','that','the','this','to','was','were','will','with','you',
  'your','me','my','we','our','also','can','do','does','done','get','got','if','just',
  'like','make','need','now','ok','some','so','then','there','these','they','what','when',
  'where','which','why','please','try','running','task','code','task_id','check','use','new',
]);

function keywords(text: string): string[] {
  if (!text) return [];
  return [...new Set(
    text.toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  )];
}

function overlapCount(a: string[], b: string[]): number {
  const setB = new Set(b);
  return a.filter((w) => setB.has(w)).length;
}

interface SessionRecord {
  sessionId: string;
  cwd: string;
  topicKw: string[];
  firstPrompt: string;
  createdAt: number;
  lastActiveAt: number;
  taskIds: string[];
  runCount: number;
}

export interface MatchResult {
  sessionId: string;
  reason: string;
}

export class SessionManager {
  private file: string;

  constructor(file: string) {
    this.file = file;
  }

  static fromBrainDir(brainDir: string): SessionManager {
    return new SessionManager(join(brainDir, '.sessions.json'));
  }

  private load(): SessionRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      return JSON.parse(readFileSync(this.file, 'utf-8'));
    } catch (e) {
      console.error(`[sessions] parse failed: ${(e as Error).message}`);
      return [];
    }
  }

  private save(arr: SessionRecord[]): void {
    const now = Date.now();
    const fresh = arr.filter((s) => now - s.lastActiveAt < IDLE_TTL_MS);
    fresh.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const pruned = fresh.slice(0, MAX_SESSIONS);
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(pruned, null, 2));
    renameSync(tmp, this.file);
  }

  findMatch(cwd: string, prompt: string): MatchResult | null {
    const now = Date.now();
    const promptKw = keywords(prompt);
    const isShortFollowup = (prompt || '').length < 40 || promptKw.length < 3;
    const sessions = this.load();
    const recentInCwd = sessions.filter((s) => s.cwd === cwd && now - s.lastActiveAt < REUSE_WINDOW_MS);
    for (const s of recentInCwd) {
      const overlap = overlapCount(promptKw, s.topicKw || []);
      const minOverlap = isShortFollowup ? (recentInCwd.length === 1 ? 0 : 1) : 2;
      if (overlap >= minOverlap) {
        return {
          sessionId: s.sessionId,
          reason: `cwd match + ${overlap} topic overlap + ${Math.round((now - s.lastActiveAt) / 60_000)}m idle${isShortFollowup ? ' (short follow-up)' : ''}`,
        };
      }
    }
    return null;
  }

  /** Reserve a new session UUID. Caller passes it via --session-id to claude. */
  create(cwd: string, prompt: string): { sessionId: string } {
    const sessionId = randomUUID();
    const sessions = this.load();
    sessions.push({
      sessionId,
      cwd,
      topicKw: keywords(prompt).slice(0, 20),
      firstPrompt: (prompt || '').slice(0, 200),
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      taskIds: [],
      runCount: 0,
    });
    this.save(sessions);
    return { sessionId };
  }

  /** Refresh lastActiveAt and merge new prompt keywords. Call on every use. */
  touch(sessionId: string, taskId: string, prompt: string): void {
    const sessions = this.load();
    const s = sessions.find((x) => x.sessionId === sessionId);
    if (!s) return;
    s.lastActiveAt = Date.now();
    s.runCount = (s.runCount || 0) + 1;
    if (taskId && !s.taskIds.includes(taskId)) s.taskIds.push(taskId);
    const merged = new Set([...(s.topicKw || []), ...keywords(prompt)]);
    s.topicKw = [...merged].slice(0, 30);
    this.save(sessions);
  }

  /** Mark a session unfit for reuse (e.g. after a hard failure). */
  invalidate(sessionId: string): void {
    const sessions = this.load();
    const s = sessions.find((x) => x.sessionId === sessionId);
    if (!s) return;
    s.lastActiveAt = 0;
    this.save(sessions);
  }

  list(): SessionRecord[] {
    return this.load();
  }
}
