import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrainConfig } from '../src/config.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'damson-test-config-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('known key with valid value: ok, no warning', () => {
  const { dir, cleanup } = setup();
  try {
    const c = new BrainConfig(dir);
    const r = c.set('browser.mode', 'cloud');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.warning, undefined);
    assert.equal(c.get('browser.mode'), 'cloud');
  } finally {
    cleanup();
  }
});

test('known enum key with invalid value: rejected', () => {
  const { dir, cleanup } = setup();
  try {
    const c = new BrainConfig(dir);
    const r = c.set('browser.mode', 'mars');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Allowed/);
  } finally {
    cleanup();
  }
});

test('known bool key with non-boolean: rejected', () => {
  const { dir, cleanup } = setup();
  try {
    const c = new BrainConfig(dir);
    const r = c.set('verify.before_claim', 'yes please');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /must be a boolean/);
  } finally {
    cleanup();
  }
});

test('unknown but valid-shaped key: accepted with warning', () => {
  const { dir, cleanup } = setup();
  try {
    const c = new BrainConfig(dir);
    const r = c.set('git.never_force_push', true);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.ok(r.warning, 'should have a warning for unregistered key');
      assert.match(r.warning, /not a registered/);
    }
    assert.equal(c.get('git.never_force_push'), true);
  } finally {
    cleanup();
  }
});

test('unknown key with arbitrary string value: accepted', () => {
  const { dir, cleanup } = setup();
  try {
    const c = new BrainConfig(dir);
    const r = c.set('github.default_repo', 'me/my-thing');
    assert.equal(r.ok, true);
    assert.equal(c.get('github.default_repo'), 'me/my-thing');
  } finally {
    cleanup();
  }
});

test('malformed key (spaces, leading digits) rejected', () => {
  const { dir, cleanup } = setup();
  try {
    const c = new BrainConfig(dir);
    assert.equal(c.set('has spaces', true).ok, false);
    assert.equal(c.set('1leading.digit', true).ok, false);
    assert.equal(c.set('', true).ok, false);
    // dotted is fine
    assert.equal(c.set('a.b.c', true).ok, true);
    // single segment is fine
    assert.equal(c.set('singleSegment', true).ok, true);
  } finally {
    cleanup();
  }
});

test('persists across instances', () => {
  const { dir, cleanup } = setup();
  try {
    const c1 = new BrainConfig(dir);
    c1.set('something.custom', 42);
    const c2 = new BrainConfig(dir);
    assert.equal(c2.get('something.custom'), 42);
  } finally {
    cleanup();
  }
});

test('formatForPrompt sorts and serializes', () => {
  const { dir, cleanup } = setup();
  try {
    const c = new BrainConfig(dir);
    c.set('browser.mode', 'cloud');
    c.set('zoo.last', true);
    c.set('apple.first', 'yes');
    const out = c.formatForPrompt();
    const lines = out.split('\n');
    assert.equal(lines[0], '- apple.first: "yes"');
    assert.equal(lines[1], '- browser.mode: "cloud"');
    assert.equal(lines[2], '- zoo.last: true');
  } finally {
    cleanup();
  }
});
