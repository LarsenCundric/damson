/**
 * System events queue. The EventRouter writes here; the agent loop drains
 * it at the start of each turn and prepends the entries to the user
 * message. This is how the agent "sees" what the router decided to surface.
 *
 * Per-chat. Bounded size — old entries drop if user is offline a long time.
 */

interface QueuedEvent {
  ts: number;
  type: string;
  msg: string;
}

const MAX_PER_CHAT = 30;
const MAX_AGE_MS = 6 * 3600_000; // 6h — anything older is stale

export class SystemEventQueue {
  private byChat = new Map<number, QueuedEvent[]>();

  enqueue(chatId: number, msg: string, type: string): void {
    const arr = this.byChat.get(chatId) || [];
    arr.push({ ts: Date.now(), type, msg });
    // bound + prune
    const fresh = arr.filter((e) => Date.now() - e.ts < MAX_AGE_MS);
    this.byChat.set(chatId, fresh.slice(-MAX_PER_CHAT));
  }

  drain(chatId: number): QueuedEvent[] {
    const arr = this.byChat.get(chatId) || [];
    this.byChat.delete(chatId);
    return arr;
  }

  peek(chatId: number): QueuedEvent[] {
    return [...(this.byChat.get(chatId) || [])];
  }
}
