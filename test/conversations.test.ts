import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../src/conversations.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'damson-test-conv-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('append + recent returns turns in order', () => {
  const { dir, cleanup } = setup();
  try {
    const c = new ConversationStore(dir);
    c.append(1, 'user', 'first');
    c.append(1, 'assistant', 'second');
    c.append(1, 'user', 'third');
    const turns = c.recent(1, 5);
    assert.equal(turns.length, 3);
    assert.equal(turns[0].content, 'first');
    assert.equal(turns[2].content, 'third');
  } finally {
    cleanup();
  }
});

test('recent respects count limit', () => {
  const { dir, cleanup } = setup();
  try {
    const c = new ConversationStore(dir);
    for (let i = 0; i < 10; i++) c.append(1, 'user', `msg ${i}`);
    const turns = c.recent(1, 3);
    assert.equal(turns.length, 3);
    assert.equal(turns[2].content, 'msg 9');
  } finally {
    cleanup();
  }
});

test('redaction strips secrets before persisting', () => {
  const { dir, cleanup } = setup();
  try {
    const c = new ConversationStore(dir);
    c.append(1, 'user', 'my key is sk-ant-api03-abcdefABCDEF1234567890abcdefABCDEF1234567890');
    const turns = c.recent(1, 5);
    assert.match(turns[0].content, /\[REDACTED:anthropic_key\]/);
    assert.doesNotMatch(turns[0].content, /sk-ant-api03/);
  } finally {
    cleanup();
  }
});

test('clear() makes subsequent recent() return only post-clear turns', async () => {
  const { dir, cleanup } = setup();
  try {
    const c = new ConversationStore(dir);
    c.append(1, 'user', 'before clear');
    c.append(1, 'assistant', 'before clear reply');
    // Tiny pause so cleared-at timestamp is after these turns
    await new Promise((r) => setTimeout(r, 10));
    c.clear(1);
    await new Promise((r) => setTimeout(r, 10));
    c.append(1, 'user', 'after clear');
    const turns = c.recent(1, 10);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].content, 'after clear');
  } finally {
    cleanup();
  }
});

test('clear() called on empty store is safe', () => {
  const { dir, cleanup } = setup();
  try {
    const c = new ConversationStore(dir);
    c.clear(42);
    const turns = c.recent(42, 5);
    assert.equal(turns.length, 0);
  } finally {
    cleanup();
  }
});

test('recent() is per-chat scoped', () => {
  const { dir, cleanup } = setup();
  try {
    const c = new ConversationStore(dir);
    c.append(1, 'user', 'chat 1 msg');
    c.append(2, 'user', 'chat 2 msg');
    assert.equal(c.recent(1, 5)[0].content, 'chat 1 msg');
    assert.equal(c.recent(2, 5)[0].content, 'chat 2 msg');
    assert.equal(c.recent(99, 5).length, 0);
  } finally {
    cleanup();
  }
});

test('clear() of chat A does not affect chat B', async () => {
  const { dir, cleanup } = setup();
  try {
    const c = new ConversationStore(dir);
    c.append(1, 'user', 'A1');
    c.append(2, 'user', 'B1');
    await new Promise((r) => setTimeout(r, 10));
    c.clear(1);
    await new Promise((r) => setTimeout(r, 10));
    c.append(1, 'user', 'A2');
    assert.equal(c.recent(1, 5).length, 1);
    assert.equal(c.recent(1, 5)[0].content, 'A2');
    assert.equal(c.recent(2, 5).length, 1);
    assert.equal(c.recent(2, 5)[0].content, 'B1');
  } finally {
    cleanup();
  }
});
