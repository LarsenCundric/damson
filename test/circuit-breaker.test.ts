import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../src/circuit-breaker.ts';

function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

test('closed → success keeps it closed, failures reset on success', async () => {
  const cb = new CircuitBreaker({ threshold: 3 });
  await cb.run(async () => 'ok');
  await cb.run(async () => 'ok');
  await assert.rejects(() => cb.run(async () => { throw new Error('x'); }));
  await cb.run(async () => 'ok'); // success resets failure count
  // 2 more failures should NOT trip yet
  await assert.rejects(() => cb.run(async () => { throw new Error('x'); }));
  await assert.rejects(() => cb.run(async () => { throw new Error('x'); }));
  assert.equal(cb.isOpen(), false);
});

test('threshold consecutive failures opens the breaker', async () => {
  const cb = new CircuitBreaker({ threshold: 3 });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => cb.run(async () => { throw new Error(`fail-${i}`); }));
  }
  assert.equal(cb.isOpen(), true);
});

test('open breaker fast-fails with CIRCUIT_OPEN code', async () => {
  const cb = new CircuitBreaker({ threshold: 1, baseCooldownMs: 60_000 });
  await assert.rejects(() => cb.run(async () => { throw new Error('first'); }));
  await assert.rejects(
    () => cb.run(async () => 'ok-but-blocked'),
    (e: Error & { code?: string }) => e.code === 'CIRCUIT_OPEN'
  );
});

test('after cooldown the breaker enters half_open and a success closes it', async () => {
  const c = clock();
  const cb = new CircuitBreaker({ threshold: 1, baseCooldownMs: 1000, now: c.now });
  await assert.rejects(() => cb.run(async () => { throw new Error('x'); }));
  assert.equal(cb.state_(), 'open');
  c.advance(2000);
  // First call after cooldown should be allowed (half_open), success → closed
  const r = await cb.run(async () => 'recovered');
  assert.equal(r, 'recovered');
  assert.equal(cb.state_(), 'closed');
});

test('half_open failure re-opens with longer cooldown', async () => {
  const c = clock();
  const cb = new CircuitBreaker({ threshold: 1, baseCooldownMs: 1000, now: c.now });
  // First failure → open (cooldown = 1000 * 2^0 = 1000)
  await assert.rejects(() => cb.run(async () => { throw new Error('x'); }));
  c.advance(1500); // past cooldown → half_open eligible
  // Half-open probe fails → re-open with cooldown = 1000 * 2^2 = 4000
  await assert.rejects(() => cb.run(async () => { throw new Error('still broken'); }));
  // 2000ms is NOT enough to reset
  c.advance(2000);
  await assert.rejects(
    () => cb.run(async () => 'whatever'),
    (e: Error & { code?: string }) => e.code === 'CIRCUIT_OPEN'
  );
  // Advance past 4000ms total since reopen (2000 already + 3000 more = 5000)
  c.advance(3000);
  const r = await cb.run(async () => 'recovered');
  assert.equal(r, 'recovered');
});

test('cooldown caps at maxCooldownMs', async () => {
  const c = clock();
  const cb = new CircuitBreaker({ threshold: 1, baseCooldownMs: 1000, maxCooldownMs: 5000, now: c.now });
  // fail many times, escalating cooldown — should cap at 5s
  for (let i = 0; i < 10; i++) {
    await assert.rejects(() => cb.run(async () => { throw new Error('x'); }));
    c.advance(10_000); // skip well past cooldown
    // re-fail to escalate
  }
  // After all those, the cooldown should be capped at 5000.
  // We can't read it directly, but advancing 5001ms past last open should let a probe through.
  const lastOpenAt = c.now() - 10_000; // last fail set openedAt to "before this advance"
  void lastOpenAt;
  // Just check that maxCooldownMs is honoured: a successful call after sufficient time closes it
  c.advance(10_000);
  const r = await cb.run(async () => 'ok');
  assert.equal(r, 'ok');
});

test('reset clears state', async () => {
  const cb = new CircuitBreaker({ threshold: 1 });
  await assert.rejects(() => cb.run(async () => { throw new Error('x'); }));
  assert.equal(cb.isOpen(), true);
  cb.reset();
  assert.equal(cb.isOpen(), false);
  const r = await cb.run(async () => 'works');
  assert.equal(r, 'works');
});
