/**
 * Approval flow for destructive actions.
 *
 * The agent calls `request_approval` with a description of what it wants
 * to do. damson sends an inline-keyboard message to the paired user.
 * The promise resolves when the user taps Yes or No, or after a timeout
 * (default 5 min — fail-safe = denied).
 *
 * Used by the agent to gate things that can't be undone:
 *   - Pushing to a remote
 *   - Deleting files / branches / tables
 *   - Sending a public message (tweet, Slack post, email)
 *   - Spending money (Stripe charge, paid API call)
 */

import { randomBytes } from 'node:crypto';

export type ApprovalDecision = 'approved' | 'denied' | 'timeout';

interface PendingApproval {
  id: string;
  description: string;
  createdAt: number;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export class ApprovalRegistry {
  private pending = new Map<string, PendingApproval>();

  /**
   * Returns { id, promise } — caller sends the id+description to user via
   * inline keyboard, awaits the promise.
   */
  request(description: string, timeoutMs = DEFAULT_TIMEOUT_MS): { id: string; promise: Promise<ApprovalDecision> } {
    const id = randomBytes(6).toString('hex');
    const promise = new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          resolve('timeout');
        }
      }, timeoutMs);
      this.pending.set(id, {
        id,
        description: description.slice(0, 500),
        createdAt: Date.now(),
        resolve,
        timer,
      });
    });
    return { id, promise };
  }

  /** Called when the user taps a button in Telegram. */
  decide(id: string, decision: 'approved' | 'denied'): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(decision);
    return true;
  }

  cancel(id: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve('denied');
    return true;
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
