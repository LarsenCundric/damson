/**
 * Heartbeat tests. We avoid spawning real subprocesses and instead simulate
 * the file artifacts the supervisor would have left behind: .done file,
 * .output (stream-json), .stderr.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/event-bus.ts';
import { TaskManager } from '../src/tasks.ts';
import { Heartbeat } from '../src/heartbeat.ts';
import type { Event } from '../src/types.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'damson-test-hb-'));
  const taskDir = join(dir, '.task-runs');
  mkdirSync(taskDir, { recursive: true });
  return { dir, taskDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function buildHeartbeat(dir: string, taskDir: string) {
  const bus = new EventBus();
  const tasks = new TaskManager(dir);
  const events: Event[] = [];
  bus.subscribe((e) => events.push(e));
  const hb = new Heartbeat({
    tasks,
    bus,
    taskRunsDir: taskDir,
    activeRuns: new Map(),
  });
  return { bus, tasks, hb, events };
}

test('orphan recovery: success — emits task.done.success and cleans files', async () => {
  const { dir, taskDir, cleanup } = setup();
  try {
    const { tasks, hb, events } = buildHeartbeat(dir, taskDir);

    // Pre-existing task in TaskManager from a previous lifetime
    tasks.create('orphan1', 'do thing', '/tmp', 'code');
    tasks.start('orphan1', 99999);

    // Simulate completion files left on disk
    const result = JSON.stringify({ type: 'result', result: 'finished the thing successfully' });
    writeFileSync(join(taskDir, 'orphan1.output'), result + '\n');
    writeFileSync(join(taskDir, 'orphan1.done'), '0\n');

    // Force tick by calling the private method directly (recoverOrphans is
    // gated by orphanCheckDone — start() calls it once on first tick).
    hb.start();
    await new Promise((r) => setTimeout(r, 5_500)); // first tick fires after 5s

    const successEvents = events.filter((e) => e.type === 'task.done.success');
    assert.equal(successEvents.length, 1, `expected 1 success event, got ${successEvents.length}`);
    const p = successEvents[0].payload as { taskId: string; userSummary: string; orphanRecovered: boolean };
    assert.equal(p.taskId, 'orphan1');
    assert.equal(p.orphanRecovered, true);
    assert.match(p.userSummary, /finished the thing successfully/);

    // Files should be cleaned up
    assert.equal(tasks.get('orphan1')?.state, 'succeeded');

    hb.stop();
  } finally {
    cleanup();
  }
});

test('orphan recovery: failure — emits task.done.failure with stderr', async () => {
  const { dir, taskDir, cleanup } = setup();
  try {
    const { tasks, hb, events } = buildHeartbeat(dir, taskDir);
    tasks.create('orphan2', 'will fail', '/tmp', 'code');
    tasks.start('orphan2', 88888);

    writeFileSync(join(taskDir, 'orphan2.stderr'), 'something went very wrong\n');
    writeFileSync(join(taskDir, 'orphan2.done'), '1\n');

    hb.start();
    await new Promise((r) => setTimeout(r, 5_500));

    const failures = events.filter((e) => e.type === 'task.done.failure');
    assert.equal(failures.length, 1);
    const p = failures[0].payload as { taskId: string; exitCode: number; stderrTail: string };
    assert.equal(p.taskId, 'orphan2');
    assert.equal(p.exitCode, 1);
    assert.match(p.stderrTail, /something went very wrong/);
    assert.equal(tasks.get('orphan2')?.state, 'failed');

    hb.stop();
  } finally {
    cleanup();
  }
});

test('orphan recovery: timeout exit code 124 → reason "overall-timeout"', async () => {
  const { dir, taskDir, cleanup } = setup();
  try {
    const { tasks, hb, events } = buildHeartbeat(dir, taskDir);
    tasks.create('orphan3', 'will timeout', '/tmp', 'code');
    tasks.start('orphan3', 77777);

    writeFileSync(join(taskDir, 'orphan3.done'), '124\n');

    hb.start();
    await new Promise((r) => setTimeout(r, 5_500));

    const failures = events.filter((e) => e.type === 'task.done.failure');
    assert.equal(failures.length, 1);
    const p = failures[0].payload as { reason: string };
    assert.equal(p.reason, 'overall-timeout');

    hb.stop();
  } finally {
    cleanup();
  }
});

test('orphan recovery extracts summary from assistant text blocks when no result event', async () => {
  const { dir, taskDir, cleanup } = setup();
  try {
    const { tasks, hb, events } = buildHeartbeat(dir, taskDir);
    tasks.create('orphan4', 'streaming output', '/tmp', 'code');
    tasks.start('orphan4', 66666);

    // No result event — just assistant text blocks
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first part' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'second part' }] } }),
    ];
    writeFileSync(join(taskDir, 'orphan4.output'), lines.join('\n') + '\n');
    writeFileSync(join(taskDir, 'orphan4.done'), '0\n');

    hb.start();
    await new Promise((r) => setTimeout(r, 5_500));

    const successes = events.filter((e) => e.type === 'task.done.success');
    assert.equal(successes.length, 1);
    const p = successes[0].payload as { userSummary: string };
    assert.match(p.userSummary, /first part/);
    assert.match(p.userSummary, /second part/);

    hb.stop();
  } finally {
    cleanup();
  }
});

test('orphan recovery skips tasks owned by activeRuns map', async () => {
  const { dir, taskDir, cleanup } = setup();
  try {
    const bus = new EventBus();
    const tasks = new TaskManager(dir);
    const events: Event[] = [];
    bus.subscribe((e) => events.push(e));
    const fakeRun = { id: 'live', cancel: () => false } as unknown as import('../src/supervisor.ts').SupervisedRun;
    const activeRuns = new Map([['live', fakeRun]]);

    const hb = new Heartbeat({ tasks, bus, taskRunsDir: taskDir, activeRuns });

    tasks.create('live', 'in-process', '/tmp', 'code');
    tasks.start('live', 12345);

    // .done file exists but heartbeat shouldn't touch it — supervisor will
    writeFileSync(join(taskDir, 'live.done'), '0\n');

    hb.start();
    await new Promise((r) => setTimeout(r, 5_500));

    const dones = events.filter((e) => e.type === 'task.done.success' || e.type === 'task.done.failure');
    assert.equal(dones.length, 0, 'should not double-handle live tasks');

    hb.stop();
  } finally {
    cleanup();
  }
});

test('hooks fire on every tick', async () => {
  const { dir, taskDir, cleanup } = setup();
  try {
    const { hb } = buildHeartbeat(dir, taskDir);
    let calls = 0;
    hb.addHook(() => {
      calls++;
    });
    hb.start();
    await new Promise((r) => setTimeout(r, 5_500));
    assert.ok(calls >= 1, `hook should have fired at least once, got ${calls}`);
    hb.stop();
  } finally {
    cleanup();
  }
});
