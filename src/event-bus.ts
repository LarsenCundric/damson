/**
 * EventBus — single-dispatch typed event bus.
 *
 * Every side effect in damson flows through here. Watcher fires → bus.
 * Task done → bus. User reaction → bus. Subscribers (the EventRouter, primarily)
 * decide what to do.
 */

import { randomUUID } from 'node:crypto';
import type { Event, EventType } from './types.js';

type Handler = (e: Event) => void | Promise<void>;

export class EventBus {
  private handlers: Set<Handler> = new Set();

  subscribe(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  emit<P = Record<string, unknown>>(input: { type: EventType; source: string; payload: P; hints?: Event['hints'] }): Event<P> {
    const event: Event<P> = {
      id: randomUUID(),
      ts: Date.now(),
      ...input,
    };
    console.log(`[event] ${event.type} from=${event.source}${event.hints?.suppressAnnounce ? ' {suppressAnnounce}' : ''}`);
    for (const h of this.handlers) {
      try {
        const r = h(event as Event);
        if (r instanceof Promise) r.catch(err => console.error(`[bus] handler error: ${err.message}`));
      } catch (err) {
        console.error(`[bus] handler error: ${(err as Error).message}`);
      }
    }
    return event;
  }
}
