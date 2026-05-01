/**
 * Tests for TaskManager. Uses a temp dir per test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager } from '../src/tasks.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'damson-test-tasks-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('create/start/complete happy path', () => {
  const { dir, cleanup } = setup();
  try {
    const tm = new TaskManager(dir);
    tm.create('t1', 'do a thing', '/tmp', 'code');
    assert.equal(tm.getActive().length, 1);
    assert.equal(tm.get('t1')?.state, 'queued');

    tm.start('t1', 12345);
    assert.equal(tm.get('t1')?.state, 'running');
    assert.equal(tm.get('t1')?.pid, 12345);

    tm.complete('t1', 'exit', 0, 'all good');
    assert.equal(tm.getActive().length, 0);
    assert.equal(tm.get('t1')?.state, 'succeeded');
    assert.equal(tm.get('t1')?.summary, 'all good');
  } finally {
    cleanup();
  }
});

test('failure state computed correctly', () => {
  const { dir, cleanup } = setup();
  try {
    const tm = new TaskManager(dir);
    tm.create('fail', 'will fail', '/tmp');
    tm.start('fail', 1);
    tm.complete('fail', 'exit', 1, 'broken');
    assert.equal(tm.get('fail')?.state, 'failed');

    tm.create('cancelled', 'will cancel', '/tmp');
    tm.start('cancelled', 2);
    tm.complete('cancelled', 'manual-cancel', -1);
    assert.equal(tm.get('cancelled')?.state, 'cancelled');

    tm.create('lost', 'will lose', '/tmp');
    tm.start('lost', 3);
    tm.complete('lost', 'lost', -3);
    assert.equal(tm.get('lost')?.state, 'lost');
  } finally {
    cleanup();
  }
});

test('persists across instances (restart simulation)', () => {
  const { dir, cleanup } = setup();
  try {
    const tm1 = new TaskManager(dir);
    tm1.create('survive', 'keep state', '/tmp');
    tm1.start('survive', 99);

    const tm2 = new TaskManager(dir);
    const t = tm2.get('survive');
    assert.equal(t?.state, 'running');
    assert.equal(t?.pid, 99);
  } finally {
    cleanup();
  }
});

test('history capped at 50', () => {
  const { dir, cleanup } = setup();
  try {
    const tm = new TaskManager(dir);
    for (let i = 0; i < 60; i++) {
      tm.create(`t${i}`, 'x', '/tmp');
      tm.start(`t${i}`, i);
      tm.complete(`t${i}`, 'exit', 0);
    }
    assert.equal(tm.getRecent(100).length, 50);
    // Most recent is at the front
    assert.equal(tm.getRecent(1)[0].id, 't59');
  } finally {
    cleanup();
  }
});

test('progress updates persist', () => {
  const { dir, cleanup } = setup();
  try {
    const tm = new TaskManager(dir);
    tm.create('progress', 'streaming', '/tmp');
    tm.start('progress', 1);
    tm.updateProgress('progress', 5, 'doing things');
    assert.equal(tm.get('progress')?.step, 5);
    assert.equal(tm.get('progress')?.outputPreview, 'doing things');
  } finally {
    cleanup();
  }
});

test('duplicate task id throws', () => {
  const { dir, cleanup } = setup();
  try {
    const tm = new TaskManager(dir);
    tm.create('dup', 'x', '/tmp');
    assert.throws(() => tm.create('dup', 'y', '/tmp'), /already exists/);
  } finally {
    cleanup();
  }
});

test('getSummary formats active and recent', () => {
  const { dir, cleanup } = setup();
  try {
    const tm = new TaskManager(dir);
    tm.create('done1', 'finished one', '/tmp');
    tm.complete('done1', 'exit', 0);
    tm.create('running1', 'still going', '/tmp');
    tm.start('running1', 1);
    tm.updateProgress('running1', 3);
    const summary = tm.getSummary();
    assert.match(summary, /Active:/);
    assert.match(summary, /running1/);
    assert.match(summary, /step 3/);
    assert.match(summary, /Recent:/);
    assert.match(summary, /done1/);
  } finally {
    cleanup();
  }
});
