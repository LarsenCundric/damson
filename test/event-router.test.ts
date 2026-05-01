import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { EventBus } from '../src/event-bus.ts';
import { EventRouter } from '../src/event-router.ts';
import type { AnnounceItem } from '../src/event-router.ts';

interface Recorder {
  wakes: string[][];
  announces: AnnounceItem[];
  systemEvents: Array<{ chatId: number; msg: string; type: string }>;
}

function setup(): { bus: EventBus; router: EventRouter; rec: Recorder } {
  const bus = new EventBus();
  const rec: Recorder = { wakes: [], announces: [], systemEvents: [] };
  const router = new EventRouter({
    bus,
    triggerAgentWake: (reasons) => rec.wakes.push(reasons),
    announceQueue: { enqueue: (item) => rec.announces.push(item) },
    enqueueSystemEvent: (chatId, msg, type) => rec.systemEvents.push({ chatId, msg, type }),
    chatId: 12345,
  });
  return { bus, router, rec };
}

test('task.done.success injects system event AND wakes agent', async () => {
  const { bus, rec } = setup();
  bus.emit({
    type: 'task.done.success',
    source: 'supervisor',
    payload: { taskId: 'foo', durationMin: 2, toolCount: 5, userSummary: 'did the thing' },
  });
  await sleep(6_500); // wait past 5s coalesce
  assert.equal(rec.systemEvents.length, 1);
  assert.match(rec.systemEvents[0].msg, /\[task:foo\] completed/);
  assert.match(rec.systemEvents[0].msg, /You own the user-facing message/);
  assert.equal(rec.wakes.length, 1);
  assert.equal(rec.wakes[0][0], 'task.done.success:foo');
  assert.equal(rec.announces.length, 0); // never auto-announced
});

test('task.done.failure wakes agent immediately (priority)', async () => {
  const { bus, rec } = setup();
  bus.emit({
    type: 'task.done.failure',
    source: 'supervisor',
    payload: { taskId: 'bar', reason: 'exit', durationMin: 1, toolCount: 2, stderrTail: 'oops' },
  });
  await sleep(800); // immediate priority = ~500ms delay
  assert.equal(rec.wakes.length, 1);
  assert.match(rec.systemEvents[0].msg, /FAILED/);
});

test('task.progress is silent — no wake, no announce', async () => {
  const { bus, rec } = setup();
  bus.emit({
    type: 'task.progress',
    source: 'supervisor',
    payload: { taskId: 'x', kind: 'tool_use', step: 1, tool: 'bash' },
    hints: { suppressAnnounce: true },
  });
  await sleep(6_500);
  assert.equal(rec.wakes.length, 0);
  assert.equal(rec.announces.length, 0);
  assert.equal(rec.systemEvents.length, 0);
});

test('hints.suppressAnnounce blocks ALL routing', async () => {
  const { bus, rec } = setup();
  // Even task.done.success — if marked suppress, nothing should fire
  bus.emit({
    type: 'task.done.success',
    source: 'fs-watcher',
    payload: { taskId: 'nudge', durationMin: 1 },
    hints: { suppressAnnounce: true },
  });
  await sleep(6_500);
  assert.equal(rec.wakes.length, 0);
  assert.equal(rec.systemEvents.length, 0);
});

test('coalescing batches same-type events into one wake', async () => {
  const { bus, rec } = setup();
  bus.emit({ type: 'task.done.success', source: 'supervisor', payload: { taskId: 'a', durationMin: 1 } });
  bus.emit({ type: 'task.done.success', source: 'supervisor', payload: { taskId: 'b', durationMin: 1 } });
  bus.emit({ type: 'task.done.success', source: 'supervisor', payload: { taskId: 'c', durationMin: 1 } });
  await sleep(6_500);
  assert.equal(rec.wakes.length, 1, 'three events should coalesce into one wake');
  assert.equal(rec.wakes[0].length, 3, 'wake reasons should list all three');
  assert.equal(rec.systemEvents.length, 3, 'each event still gets its own system event');
});

test('user.message handled elsewhere — router ignores it', async () => {
  const { bus, rec } = setup();
  bus.emit({ type: 'user.message', source: 'telegram', payload: { text: 'hi' } });
  await sleep(800);
  assert.equal(rec.wakes.length, 0);
  assert.equal(rec.systemEvents.length, 0);
});

test('task.stall is silent system event (no wake)', async () => {
  const { bus, rec } = setup();
  bus.emit({
    type: 'task.stall',
    source: 'supervisor',
    payload: { taskId: 's', ageMs: 600_000, sinceOutputMs: 480_000, toolCount: 3 },
  });
  await sleep(6_500);
  assert.equal(rec.wakes.length, 0);
  assert.equal(rec.systemEvents.length, 1);
  assert.match(rec.systemEvents[0].msg, /no-output stall/);
});

test('task.frozen wakes agent immediately', async () => {
  const { bus, rec } = setup();
  bus.emit({
    type: 'task.frozen',
    source: 'supervisor',
    payload: { taskId: 'f', ageMs: 300_000, sinceOutputMs: 180_000, toolCount: 1 },
  });
  await sleep(800);
  assert.equal(rec.wakes.length, 1);
  assert.match(rec.systemEvents[0].msg, /LIKELY FROZEN/);
});

test('watcher.* with notify=always announces to user, no agent wake', async () => {
  const { bus, rec } = setup();
  bus.emit({
    type: 'watcher.my-watcher',
    source: 'watcher',
    payload: {
      watcherName: 'my-watcher',
      watcherType: 'http_poll',
      notify: 'always',
      eventId: 'abc',
      summary: 'value changed: 100 → 110',
    },
  });
  await sleep(2_000);
  assert.equal(rec.announces.length, 1);
  assert.match(rec.announces[0].message, /value changed/);
  assert.equal(rec.wakes.length, 0);
});

test('watcher.* with notify=digest_only is silent (system event only)', async () => {
  const { bus, rec } = setup();
  bus.emit({
    type: 'watcher.background',
    source: 'watcher',
    payload: {
      watcherName: 'background',
      watcherType: 'http_poll',
      notify: 'digest_only',
      eventId: 'def',
      summary: 'minor change',
    },
  });
  await sleep(6_500);
  assert.equal(rec.announces.length, 0);
  assert.equal(rec.wakes.length, 0);
  assert.equal(rec.systemEvents.length, 1);
  assert.match(rec.systemEvents[0].msg, /minor change/);
});

test('watcher.* with notify=ask wakes agent (lets it decide)', async () => {
  const { bus, rec } = setup();
  bus.emit({
    type: 'watcher.gh',
    source: 'watcher',
    payload: {
      watcherName: 'gh',
      watcherType: 'github_events',
      notify: 'ask',
      eventId: 'pr-42',
      summary: 'PR #42 needs review',
    },
  });
  await sleep(6_500);
  assert.equal(rec.wakes.length, 1);
  assert.match(rec.systemEvents[0].msg, /PR #42 needs review/);
  assert.match(rec.systemEvents[0].msg, /Decide:/);
});
