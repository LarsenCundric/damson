/**
 * CircuitBreaker — exponential-backoff guard around flaky external calls.
 *
 * Wrap any operation; on N consecutive failures the breaker opens and fast-
 * fails subsequent calls for a cooldown period. After cooldown the breaker
 * goes "half-open" — the next call is allowed; success closes the breaker,
 * failure re-opens with longer cooldown.
 *
 * Used in damson around the Anthropic client so an outage doesn't crash-
 * loop autonomous wakes (each wake fails the same way; without the breaker
 * each event triggers a fresh failed call).
 */

const DEFAULT_THRESHOLD = 3;
const DEFAULT_BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 10 * 60_000;

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOpts {
  /** N consecutive failures to open the breaker. */
  threshold?: number;
  /** Initial cooldown when first opening. Doubles each subsequent open. */
  baseCooldownMs?: number;
  /** Hard cap on cooldown growth. */
  maxCooldownMs?: number;
  /** For testing — defaults to Date.now. */
  now?: () => number;
}

export class CircuitBreaker {
  private threshold: number;
  private baseCooldownMs: number;
  private maxCooldownMs: number;
  private now: () => number;

  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private currentCooldownMs: number;
  private consecutiveOpens = 0;

  constructor(opts: CircuitBreakerOpts = {}) {
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    this.baseCooldownMs = opts.baseCooldownMs ?? DEFAULT_BASE_COOLDOWN_MS;
    this.maxCooldownMs = opts.maxCooldownMs ?? MAX_COOLDOWN_MS;
    this.now = opts.now ?? Date.now;
    this.currentCooldownMs = this.baseCooldownMs;
  }

  /** Execute fn through the breaker. Throws if the breaker is open. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeReset();
    if (this.state === 'open') {
      const remaining = Math.max(0, this.openedAt + this.currentCooldownMs - this.now());
      const err = new Error(`circuit_open: cooling down (${Math.ceil(remaining / 1000)}s remaining)`);
      (err as Error & { code: string }).code = 'CIRCUIT_OPEN';
      throw err;
    }
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (e) {
      this.recordFailure();
      throw e;
    }
  }

  /** True if calling .run() right now would short-circuit. */
  isOpen(): boolean {
    this.maybeReset();
    return this.state === 'open';
  }

  state_(): BreakerState {
    return this.state;
  }

  /** Reset state. Useful for tests / a /reset slash command. */
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.consecutiveOpens = 0;
    this.currentCooldownMs = this.baseCooldownMs;
    this.openedAt = 0;
  }

  private maybeReset(): void {
    if (this.state !== 'open') return;
    if (this.now() - this.openedAt >= this.currentCooldownMs) {
      this.state = 'half_open';
    }
  }

  private recordSuccess(): void {
    this.failures = 0;
    if (this.state === 'half_open') {
      // recovery — fully close
      this.state = 'closed';
      this.consecutiveOpens = 0;
      this.currentCooldownMs = this.baseCooldownMs;
    }
  }

  private recordFailure(): void {
    if (this.state === 'half_open') {
      // recovery probe failed — back to open with longer cooldown
      this.state = 'open';
      this.openedAt = this.now();
      this.consecutiveOpens++;
      this.currentCooldownMs = Math.min(this.maxCooldownMs, this.baseCooldownMs * Math.pow(2, this.consecutiveOpens));
      return;
    }
    this.failures++;
    if (this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = this.now();
      this.consecutiveOpens++;
      this.currentCooldownMs = Math.min(this.maxCooldownMs, this.baseCooldownMs * Math.pow(2, this.consecutiveOpens - 1));
    }
  }
}
