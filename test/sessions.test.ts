import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/sessions.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'damson-test-sessions-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('cold session creates new UUID', () => {
  const { dir, cleanup } = setup();
  try {
    const sm = SessionManager.fromBrainDir(dir);
    const r = sm.create('/repo', 'fix the bug');
    assert.match(r.sessionId, /^[0-9a-f-]{36}$/i);
  } finally {
    cleanup();
  }
});

test('long related prompt matches', () => {
  const { dir, cleanup } = setup();
  try {
    const sm = SessionManager.fromBrainDir(dir);
    const c = sm.create('/repo', 'fix the heartbeat detection bug in supervisor.js');
    sm.touch(c.sessionId, 't1', 'fix the heartbeat detection bug in supervisor.js');

    const m = sm.findMatch('/repo', 'the heartbeat supervisor stall detection broke, retry');
    assert.ok(m, 'should match');
    assert.equal(m!.sessionId, c.sessionId);
    assert.match(m!.reason, /topic overlap/);
  } finally {
    cleanup();
  }
});

test('short follow-up matches when only one session in cwd', () => {
  const { dir, cleanup } = setup();
  try {
    const sm = SessionManager.fromBrainDir(dir);
    const c = sm.create('/repo', 'fix supervisor heartbeat bug');
    sm.touch(c.sessionId, 't1', 'fix supervisor heartbeat bug');

    const m = sm.findMatch('/repo', 'now push it');
    assert.ok(m, 'short follow-up should match the only session');
    assert.equal(m!.sessionId, c.sessionId);
    assert.match(m!.reason, /short follow-up/);
  } finally {
    cleanup();
  }
});

test('short follow-up does NOT match when two ambiguous sessions', () => {
  const { dir, cleanup } = setup();
  try {
    const sm = SessionManager.fromBrainDir(dir);
    const a = sm.create('/repo', 'fix supervisor bug');
    sm.touch(a.sessionId, 't1', 'fix supervisor bug');
    const b = sm.create('/repo', 'add new feature');
    sm.touch(b.sessionId, 't2', 'add new feature');

    const m = sm.findMatch('/repo', 'now push it');
    assert.equal(m, null, 'should refuse to guess between two sessions');
  } finally {
    cleanup();
  }
});

test('cwd mismatch never matches', () => {
  const { dir, cleanup } = setup();
  try {
    const sm = SessionManager.fromBrainDir(dir);
    const c = sm.create('/repo', 'fix bug');
    sm.touch(c.sessionId, 't1', 'fix bug');

    const m = sm.findMatch('/other', 'fix bug');
    assert.equal(m, null);
  } finally {
    cleanup();
  }
});

test('unrelated long prompt does not match', () => {
  const { dir, cleanup } = setup();
  try {
    const sm = SessionManager.fromBrainDir(dir);
    const c = sm.create('/repo', 'fix supervisor bug in heartbeat detection');
    sm.touch(c.sessionId, 't1', 'fix supervisor bug in heartbeat detection');

    const m = sm.findMatch('/repo', 'completely unrelated work on css theming for landing page');
    assert.equal(m, null);
  } finally {
    cleanup();
  }
});

test('invalidate stops a session from matching', () => {
  const { dir, cleanup } = setup();
  try {
    const sm = SessionManager.fromBrainDir(dir);
    const c = sm.create('/repo', 'fix supervisor heartbeat bug');
    sm.touch(c.sessionId, 't1', 'fix supervisor heartbeat bug');
    sm.invalidate(c.sessionId);

    const m = sm.findMatch('/repo', 'fix supervisor heartbeat bug retry');
    assert.equal(m, null);
  } finally {
    cleanup();
  }
});

test('persists across instances', () => {
  const { dir, cleanup } = setup();
  try {
    const sm1 = SessionManager.fromBrainDir(dir);
    const c = sm1.create('/repo', 'persistent session test');

    const sm2 = SessionManager.fromBrainDir(dir);
    const all = sm2.list();
    assert.equal(all.length, 1);
    assert.equal(all[0].sessionId, c.sessionId);
  } finally {
    cleanup();
  }
});
