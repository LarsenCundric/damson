/**
 * Conversation transcript store. JSONL per chat per day. Redacts secrets
 * before writing.
 */

import { existsSync, appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from './secrets.ts';

export interface Turn {
  ts: string;
  role: 'user' | 'assistant';
  content: string;
}

export class ConversationStore {
  private brainDir: string;

  constructor(brainDir: string) {
    this.brainDir = brainDir;
    mkdirSync(join(brainDir, 'transcripts'), { recursive: true });
  }

  private fileFor(chatId: number, date: string): string {
    const dir = join(this.brainDir, 'transcripts', String(chatId));
    mkdirSync(dir, { recursive: true });
    return join(dir, `${date}.jsonl`);
  }

  append(chatId: number, role: 'user' | 'assistant', content: string): void {
    const safe = redactSecrets(content).text;
    const date = new Date().toISOString().slice(0, 10);
    const turn: Turn = { ts: new Date().toISOString(), role, content: safe };
    appendFileSync(this.fileFor(chatId, date), JSON.stringify(turn) + '\n');
  }

  /** Return last N turns across recent days, respecting any /clear sentinel. */
  recent(chatId: number, count: number): Turn[] {
    const dir = join(this.brainDir, 'transcripts', String(chatId));
    if (!existsSync(dir)) return [];
    const cutoff = this.clearedAt(chatId);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse();
    const turns: Turn[] = [];
    for (const f of files) {
      const lines = readFileSync(join(dir, f), 'utf-8').trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const turn = JSON.parse(lines[i]) as Turn;
          if (cutoff > 0 && Date.parse(turn.ts) < cutoff) {
            // Hit the boundary — earlier turns are cleared
            return turns.reverse();
          }
          turns.push(turn);
          if (turns.length >= count) break;
        } catch {}
      }
      if (turns.length >= count) break;
    }
    return turns.reverse();
  }

  /**
   * Cut a "clear" boundary so subsequent recent() calls don't see prior
   * turns. Implemented as a sentinel file (`<chatId>.cleared-at`) holding
   * the timestamp; recent() filters everything older than that.
   *
   * This preserves history on disk (you can still memory_search it) while
   * giving the user a clean conversational slate.
   */
  clear(chatId: number): void {
    const dir = join(this.brainDir, 'transcripts', String(chatId));
    mkdirSync(dir, { recursive: true });
    const sentinel = join(dir, '.cleared-at');
    writeFileSync(sentinel, new Date().toISOString());
  }

  private clearedAt(chatId: number): number {
    const sentinel = join(this.brainDir, 'transcripts', String(chatId), '.cleared-at');
    if (!existsSync(sentinel)) return 0;
    try {
      return Date.parse(readFileSync(sentinel, 'utf-8').trim()) || 0;
    } catch {
      return 0;
    }
  }
}
