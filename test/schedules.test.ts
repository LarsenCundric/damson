/**
 * Tests for ScheduleManager. Bash executor tested with real subprocess
 * (fast — <100ms per call).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScheduleManager, executeBashSchedule, type ScheduleRecord } from '../src/schedules.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'damson-test-sched-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('create + get + list happy path', () => {
  const { dir, cleanup } = setup();
  try {
    const sm = new ScheduleManager(dir);
    const r = sm.create({ name: 'morning', cron: '0 9 * * *', type: 'agent', prompt: 'morning brief' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(sm.get('morning')?.cron, '0 9 * * *');
    assert.equal(sm.list().length, 1);
  } finally {
    cleanup();
  }
});

test('rejects invalid cron', () => {
  const { dir, cleanup } = setup();
  try {
    const sm = new ScheduleManager(dir);
    const r = sm.create({ name: 'broken', cron: 'totally not cron', type: 'bash', command: 'echo' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /invalid cron/);
  } finally {
    cleanup();
  }
});

test('rejects heartbeat-style spam schedules', () => {
  const { dir, cleanup } = setup();
  try {
    const sm = new ScheduleManager(dir);
    const r = sm.create({ name: 'heartbeat-ping', cron: '* * * * *', type: 'bash', command: 'echo alive' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /heartbeat\/keepalive/);

    // Also catches it in the prompt
    const r2 = sm.create({ name: 'wake-bot', cron: '* * * * *', type: 'agent', prompt: 'health check' });
    assert.equal(r2.ok, false);
  } finally {
    cleanup();
  }
});

test('rejects bash without command, agent without prompt', () => {
  const { dir, cleanup } = setup();
  try {
    const sm = new ScheduleManager(dir);
    const r1 = sm.create({ name: 'b1', cron: '* * * * *', type: 'bash' });
    assert.equal(r1.ok, false);
    const r2 = sm.create({ name: 'a1', cron: '* * * * *', type: 'agent' });
    assert.equal(r2.ok, false);
  } finally {
    cleanup();
  }
});

test('rejects duplicate names', () => {
  const { dir, cleanup } = setup();
  try {
    const sm = new ScheduleManager(dir);
    sm.create({ name: 'dup', cron: '* * * * *', type: 'bash', command: 'echo' });
    const r = sm.create({ name: 'dup', cron: '* * * * *', type: 'bash', command: 'echo other' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /already exists/);
  } finally {
    cleanup();
  }
});

test('persists across instances', () => {
  const { dir, cleanup } = setup();
  try {
    const sm1 = new ScheduleManager(dir);
    sm1.create({ name: 'persisted', cron: '0 0 * * *', type: 'bash', command: 'echo daily' });

    const sm2 = new ScheduleManager(dir);
    assert.equal(sm2.get('persisted')?.command, 'echo daily');
  } finally {
    cleanup();
  }
});

test('getDue: never-run schedule with past cron is due', () => {
  const { dir, cleanup } = setup();
  try {
    const sm = new ScheduleManager(dir);
    sm.create({ name: 'minutely', cron: '* * * * *', type: 'bash', command: 'echo' });
    // Wait 70s would be the real test — instead pass a future "now"
    const future = new Date(Date.now() + 90_000);
    const due = sm.getDue(future);
    assert.equal(due.length, 1);
    assert.equal(due[0].name, 'minutely');
  } finally {
    cleanup();
  }
});

test('getDue: not due if just ran', () => {
  const { dir, cleanup } = setup();
  try {
    const sm = new ScheduleManager(dir);
    sm.create({ name: 'fresh', cron: '0 9 * * *', type: 'bash', command: 'echo' }); // 9am UTC
    sm.markRun('fresh');
    // It just ran, next 9am is hours away
    const due = sm.getDue();
    assert.equal(due.length, 0);
  } finally {
    cleanup();
  }
});

test('markRun increments runCount and removes oneShot schedules', () => {
  const { dir, cleanup } = setup();
  try {
    const sm = new ScheduleManager(dir);
    sm.create({ name: 'normal', cron: '0 0 * * *', type: 'bash', command: 'echo' });
    sm.create({ name: 'oneshot', cron: '0 0 * * *', type: 'bash', command: 'echo', oneShot: true });

    sm.markRun('normal');
    sm.markRun('oneshot');

    assert.equal(sm.get('normal')?.runCount, 1);
    assert.equal(sm.get('oneshot'), undefined, 'oneshot should be deleted after running');
  } finally {
    cleanup();
  }
});

test('delete removes schedule', () => {
  const { dir, cleanup } = setup();
  try {
    const sm = new ScheduleManager(dir);
    sm.create({ name: 'gone', cron: '* * * * *', type: 'bash', command: 'echo' });
    assert.equal(sm.delete('gone'), true);
    assert.equal(sm.get('gone'), undefined);
    assert.equal(sm.delete('nonexistent'), false);
  } finally {
    cleanup();
  }
});

test('formatList renders all schedules', () => {
  const { dir, cleanup } = setup();
  try {
    const sm = new ScheduleManager(dir);
    sm.create({ name: 'a', cron: '* * * * *', type: 'bash', command: 'echo' });
    sm.create({ name: 'b', cron: '0 9 * * *', type: 'agent', prompt: 'check', oneShot: true });
    const out = sm.formatList();
    assert.match(out, /^- a \(bash, /m);
    assert.match(out, /one-shot/);
    assert.match(out, /agent/);
  } finally {
    cleanup();
  }
});

// ============ executor: bash ============

test('executeBashSchedule captures stdout', async () => {
  const { dir, cleanup } = setup();
  try {
    const fakeRecord: ScheduleRecord = {
      name: 'echo-test',
      cron: '* * * * *',
      type: 'bash',
      command: 'echo "hello world"',
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
    const out = await executeBashSchedule(fakeRecord, dir);
    assert.match(out, /hello world/);
  } finally {
    cleanup();
  }
});

test('executeBashSchedule captures non-zero exit + stderr', async () => {
  const { dir, cleanup } = setup();
  try {
    const fakeRecord: ScheduleRecord = {
      name: 'fail-test',
      cron: '* * * * *',
      type: 'bash',
      command: 'echo "warning" >&2; exit 3',
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
    const out = await executeBashSchedule(fakeRecord, dir);
    assert.match(out, /exit 3/);
    assert.match(out, /warning/);
  } finally {
    cleanup();
  }
});
