/**
 * EventRouter — policy table for events.
 *
 * For each event type, decides:
 *   - whether to wake the agent (Claude turn)
 *   - whether to announce to user (Telegram)
 *   - whether to inject as system event for next turn
 *   - whether to coalesce with concurrent events
 *
 * Lessons from Boris (preserved as-is):
 *   - task.done.* requires agent wake (the agent synthesizes the message,
 *     not the router — prevents raw worker dumps and gives you a chance to
 *     verify before reporting)
 *   - hints.suppressAnnounce gates the whole route() — fs-watcher nudge
 *     events can't accidentally consume expectations meant for the real event
 *   - 5-second coalesce window (not 30) — long batching delayed pings
 *   - quiet hours: defer wakes, don't drop reasons
 */

import type { EventBus } from './event-bus.ts';
import type { Event } from './types.ts';

export interface AnnounceItem {
  id: string;
  message: string;
  priority: 'immediate' | 'normal';
}

export interface AnnounceQueue {
  enqueue(item: AnnounceItem): void;
}

export interface SystemEventQueue {
  enqueue(chatId: number, msg: string, type: string): void;
}

interface PolicyEntry {
  requiresAgent: boolean;
  priority: 'immediate' | 'normal' | 'silent';
  /** Skip generic routing entirely (e.g. user.message goes through handleMessage). */
  handledElsewhere?: boolean;
  buildSystemEvent?: (e: Event) => string;
  buildAnnounce?: (e: Event) => AnnounceItem | null;
}

const POLICY: Record<string, PolicyEntry> = {
  'user.message': { requiresAgent: true, priority: 'immediate', handledElsewhere: true },
  'user.reply': { requiresAgent: true, priority: 'immediate', handledElsewhere: true },
  'user.reaction': {
    requiresAgent: true,
    priority: 'normal',
    buildSystemEvent: (e) => {
      const p = e.payload as { reactions?: string[]; sentiment?: string; targetSnippet?: string };
      return `[user reaction] ${p.reactions?.join(' ') || ''}. Sentiment: ${p.sentiment || '?'}. Target: "${(p.targetSnippet || '').slice(0, 200)}"`;
    },
  },

  'task.done.success': {
    // Agent synthesizes the user-facing message — never auto-dump worker prose.
    requiresAgent: true,
    priority: 'normal',
    buildSystemEvent: (e) => {
      const p = e.payload as {
        taskId: string;
        durationMin: number;
        toolCount?: number;
        userSummary?: string;
      };
      return [
        `[task:${p.taskId}] completed successfully in ${p.durationMin}m (${p.toolCount || 0} tool calls).`,
        p.userSummary ? `Worker output:\n${p.userSummary}` : '(no prose output)',
        `You own the user-facing message. Synthesize 1-3 lines about what changed. If the result is a no-op the user already expects, stay silent.`,
      ].join('\n\n');
    },
  },

  'task.done.failure': {
    requiresAgent: true,
    priority: 'immediate',
    buildSystemEvent: (e) => {
      const p = e.payload as {
        taskId: string;
        reason: string;
        durationMin: number;
        toolCount?: number;
        oomKilled?: boolean;
        userSummary?: string;
        stderrTail?: string;
      };
      return [
        `[task:${p.taskId}] FAILED: ${p.reason} after ${p.durationMin}m, ${p.toolCount || 0} tools.`,
        p.oomKilled ? `**OOM CONFIRMED** — kernel killed the process.` : '',
        p.userSummary ? `Last prose: ${p.userSummary.slice(-400)}` : '',
        p.stderrTail ? `Stderr tail:\n${p.stderrTail.slice(-500)}` : '',
        `Don't silently accept failure. Verify with git/files, then either retry with a focused prompt or surface to the user with a question.`,
      ]
        .filter(Boolean)
        .join('\n\n');
    },
  },

  'task.stall': {
    requiresAgent: false,
    priority: 'silent',
    buildSystemEvent: (e) => {
      const p = e.payload as {
        taskId: string;
        ageMs: number;
        sinceOutputMs: number;
        toolCount?: number;
        tail?: string;
      };
      return `[task:${p.taskId}] no-output stall: ${Math.round(p.sinceOutputMs / 60_000)}m silent (age ${Math.round(p.ageMs / 60_000)}m, ${p.toolCount || 0} tools). CC often runs silently while working — DEFAULT: wait. Only cancel if task >75% of timeout AND tail shows a stuck loop.`;
    },
  },

  'task.frozen': {
    requiresAgent: true,
    priority: 'immediate',
    buildSystemEvent: (e) => {
      const p = e.payload as {
        taskId: string;
        ageMs: number;
        sinceOutputMs: number;
        toolCount?: number;
      };
      return `[task:${p.taskId}] LIKELY FROZEN: 0% CPU AND no output for ${Math.round(p.sinceOutputMs / 60_000)}m. Stronger than stall. RECOMMEND: cancel_task and retry, or investigate.`;
    },
  },

  'task.progress': {
    // Only updates /tasks step counter — never user-visible
    requiresAgent: false,
    priority: 'silent',
  },

  'boot': {
    requiresAgent: false,
    priority: 'silent',
  },
};

/**
 * Match policy for prefix-typed events like `watcher.<name>`. Tier comes
 * from the watcher's `notify` field (carried in the payload).
 */
function getPolicy(eventType: string, payload: Record<string, unknown>): PolicyEntry {
  if (POLICY[eventType]) return POLICY[eventType];
  if (eventType.startsWith('watcher.')) {
    const tier = (payload.notify as string) || 'ask';
    if (tier === 'always') {
      return {
        requiresAgent: false,
        priority: 'normal',
        buildAnnounce: (e) => {
          const p = e.payload as { watcherName: string; summary: string; eventId: string };
          return { id: `watcher-${p.eventId}`, message: `🔔 ${p.watcherName}: ${p.summary}`, priority: 'normal' };
        },
      };
    }
    if (tier === 'digest_only') {
      return {
        requiresAgent: false,
        priority: 'silent',
        buildSystemEvent: (e) => {
          const p = e.payload as { watcherName: string; summary: string };
          return `[watcher:${p.watcherName}] ${p.summary}`;
        },
      };
    }
    // 'ask' — let agent decide whether to surface
    return {
      requiresAgent: true,
      priority: 'normal',
      buildSystemEvent: (e) => {
        const p = e.payload as { watcherName: string; watcherType: string; summary: string };
        return `[watcher:${p.watcherName} (${p.watcherType})] ${p.summary}\n\nDecide: ping the user about this, just log to brain, or stay silent. The user has set notify=ask for this watcher — they want you to use judgment. Surface only if it's the kind of thing they'd want to know now.`;
      },
    };
  }
  return { requiresAgent: false, priority: 'silent' };
}

const COALESCE_MS = 5_000;

interface CoalesceBucket {
  events: Event[];
  timer: NodeJS.Timeout | null;
}

export interface RouterDeps {
  bus: EventBus;
  triggerAgentWake: (reasons: string[]) => void;
  announceQueue: AnnounceQueue;
  enqueueSystemEvent: (chatId: number, msg: string, type: string) => void;
  chatId: number;
}

export class EventRouter {
  private deps: RouterDeps;
  private coalescing = new Map<string, CoalesceBucket>();

  constructor(deps: RouterDeps) {
    this.deps = deps;
    this.deps.bus.subscribe((e) => this.route(e));
  }

  private route(event: Event): void {
    const policy = getPolicy(event.type, event.payload);
    if (policy.handledElsewhere) return;

    // Nudge events bypass everything — the real follow-up will fire too
    if (event.hints?.suppressAnnounce) return;

    if (policy.buildSystemEvent) {
      try {
        const msg = policy.buildSystemEvent(event);
        if (msg) this.deps.enqueueSystemEvent(this.deps.chatId, msg, event.type);
      } catch (e) {
        console.error(`[router] buildSystemEvent failed for ${event.type}: ${(e as Error).message}`);
      }
    }

    if (policy.buildAnnounce) {
      try {
        const out = policy.buildAnnounce(event);
        if (out) this.deps.announceQueue.enqueue(out);
      } catch (e) {
        console.error(`[router] buildAnnounce failed for ${event.type}: ${(e as Error).message}`);
      }
    }

    if (policy.requiresAgent) {
      this.scheduleAgentWake(event, policy);
    }
  }

  private scheduleAgentWake(event: Event, policy: PolicyEntry): void {
    const key = event.type;
    let bucket = this.coalescing.get(key);
    if (!bucket) {
      bucket = { events: [], timer: null };
      this.coalescing.set(key, bucket);
    }
    bucket.events.push(event);

    if (bucket.timer) clearTimeout(bucket.timer);
    const delay = policy.priority === 'immediate' ? 500 : COALESCE_MS;
    bucket.timer = setTimeout(() => {
      const reasons = bucket!.events.map((e) => {
        const p = e.payload as { taskId?: string; name?: string };
        return `${e.type}:${p.taskId || p.name || e.id.slice(0, 8)}`;
      });
      this.coalescing.delete(key);
      this.deps.triggerAgentWake(reasons);
    }, delay);
  }
}
