/**
 * Announce queue — debounced Telegram delivery. Coalesces bursts so the
 * user gets one batched message instead of N.
 *
 * `immediate` priority bypasses debouncing.
 */

import type { Bot } from 'grammy';
import type { AnnounceItem } from './event-router.ts';

const NORMAL_DEBOUNCE_MS = 1500;
const DEDUP_TTL_MS = 60_000;

export class AnnounceQueue {
  private bot: Bot;
  private chatId: number;
  private queue: AnnounceItem[] = [];
  private timer: NodeJS.Timeout | null = null;
  private recentIds = new Map<string, number>();

  constructor(bot: Bot, chatId: number) {
    this.bot = bot;
    this.chatId = chatId;
  }

  enqueue(item: AnnounceItem): void {
    // Dedup by id within window
    const last = this.recentIds.get(item.id);
    if (last && Date.now() - last < DEDUP_TTL_MS) return;
    this.recentIds.set(item.id, Date.now());
    this.queue.push(item);
    if (item.priority === 'immediate') {
      void this.flush();
    } else {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush(), NORMAL_DEBOUNCE_MS);
    }
  }

  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const items = this.queue;
    this.queue = [];
    const text = items.length === 1 ? items[0].message : items.map((i) => `• ${i.message}`).join('\n\n');
    try {
      await this.bot.api.sendMessage(this.chatId, text.slice(0, 4000));
    } catch (e) {
      console.error(`[announce] send failed: ${(e as Error).message}`);
    }
  }
}
