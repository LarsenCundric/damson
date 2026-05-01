/**
 * Conversation transcript store. JSONL per chat per day. Redacts secrets
 * before writing.
 */

import { existsSync, appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from './secrets.js';

export interface Turn {
  ts: string;
  role: 'user' | 'assistant';
  content: string;
}

export class ConversationStore {
  constructor(private brainDir: string) {
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

  /** Return last N turns across recent days. */
  recent(chatId: number, count: number): Turn[] {
    const dir = join(this.brainDir, 'transcripts', String(chatId));
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse();
    const turns: Turn[] = [];
    for (const f of files) {
      const lines = readFileSync(join(dir, f), 'utf-8').trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          turns.push(JSON.parse(lines[i]));
          if (turns.length >= count) break;
        } catch {}
      }
      if (turns.length >= count) break;
    }
    return turns.reverse();
  }

  clear(chatId: number): void {
    // We don't actually delete history — we just stop loading it. The user can
    // wipe brain/transcripts/<chatId>/ themselves if they want a real wipe.
    // For v0.1 this is just a no-op; will be replaced with a marker file.
  }
}
