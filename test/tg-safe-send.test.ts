import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _internal, safeSendMessage } from '../src/tg-safe-send.ts';

const { chunkText, isMarkdownParseError, isRateLimit } = _internal;

test('chunkText: short message is one chunk', () => {
  const chunks = chunkText('hello world');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], 'hello world');
});

test('chunkText: splits at paragraph boundary preferred', () => {
  const text = 'p1 line\n'.repeat(500) + '\n\n' + 'p2 line\n'.repeat(50);
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 2);
  // Each chunk under 4000
  for (const c of chunks) assert.ok(c.length <= 4000, `chunk ${c.length} exceeds 4000`);
});

test('chunkText: hard cut when no boundary available', () => {
  const text = 'a'.repeat(10_000);
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 4000);
  // Reassemble equals original (modulo whitespace trim)
  assert.equal(chunks.join(''), text);
});

test('chunkText: empty string returns one empty chunk', () => {
  const chunks = chunkText('');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], '');
});

test('isMarkdownParseError detects Telegram parse errors', () => {
  assert.equal(isMarkdownParseError({ description: "Bad Request: can't parse entities" }), true);
  assert.equal(isMarkdownParseError({ description: 'parse_mode: invalid' }), true);
  assert.equal(isMarkdownParseError(new Error("can't parse entities: bad markup")), true);
  assert.equal(isMarkdownParseError({ description: 'something else' }), false);
});

test('isRateLimit detects 429 with retry_after', () => {
  const r = isRateLimit({ error_code: 429, description: 'Too Many Requests: retry after 12' });
  assert.ok(r);
  assert.equal(r!.retryAfterSec, 12);
  assert.equal(isRateLimit({ error_code: 400 }), null);
});

// ============ Integration with a fake bot ============

interface SendCall {
  chatId: number;
  text: string;
  opts?: { parse_mode?: string };
}

function fakeBot(behavior: (call: SendCall, attemptIdx: number) => unknown) {
  const calls: SendCall[] = [];
  let attemptIdx = 0;
  return {
    api: {
      async sendMessage(chatId: number, text: string, opts?: { parse_mode?: string }) {
        const call: SendCall = { chatId, text, opts };
        calls.push(call);
        const r = behavior(call, attemptIdx++);
        if (r instanceof Error) throw r;
        if (r && typeof r === 'object' && 'description' in r) throw r;
        return { message_id: 100 + calls.length };
      },
      async editMessageText() {
        return true;
      },
    },
    calls,
  };
}

test('safeSendMessage: success on first try returns message_id', async () => {
  const fake = fakeBot(() => undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id = await safeSendMessage(fake as any, 42, 'hello');
  assert.equal(id, 101);
  assert.equal(fake.calls.length, 1);
});

test('safeSendMessage: markdown parse error → falls back to plain text', async () => {
  const fake = fakeBot((call) => {
    if (call.opts?.parse_mode === 'Markdown') {
      return { description: "Bad Request: can't parse entities", error_code: 400 };
    }
    return undefined;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id = await safeSendMessage(fake as any, 42, '*broken markdown', { parse_mode: 'Markdown' });
  assert.ok(id, 'should succeed via plain fallback');
  // First call had parse_mode, second did not
  assert.equal(fake.calls[0].opts?.parse_mode, 'Markdown');
  assert.equal(fake.calls[1].opts?.parse_mode, undefined);
});

test('safeSendMessage: long message sent as multiple chunks', async () => {
  const fake = fakeBot(() => undefined);
  const long = ('paragraph line\n'.repeat(300));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id = await safeSendMessage(fake as any, 42, long);
  assert.ok(id);
  assert.ok(fake.calls.length >= 2, `expected ≥2 chunks, got ${fake.calls.length}`);
});

test('safeSendMessage: hard error after retries returns undefined (no throw)', async () => {
  const fake = fakeBot(() => new Error('network exploded'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id = await safeSendMessage(fake as any, 42, 'hello');
  assert.equal(id, undefined);
  // Three attempts
  assert.equal(fake.calls.length, 3);
});
