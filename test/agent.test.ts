/**
 * Agent integration tests with a fake Anthropic client.
 *
 * Catches the multi-iteration text-accumulation bug (v0.5.1 → v0.5.2) and
 * gates against future regressions: when the agent loop runs `text → tool →
 * text → end_turn`, the final result.text must contain BOTH text blocks,
 * not just the last one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/agent.ts';
import { Brain } from '../src/brain.ts';
import { BrainConfig } from '../src/config.ts';
import { Onboarding } from '../src/onboarding.ts';
import type { ToolHandler } from '../src/types.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'damson-test-agent-'));
  // Pre-fill self.md so onboarding doesn't add an extra system block
  writeFileSync(
    join(dir, 'self.md'),
    `# self\n\n## Identity\n- Name: Tester\n- Timezone: UTC\n\n## Work\n- What you do: testing damson\n`
  );
  const brain = new Brain(dir);
  const brainConfig = new BrainConfig(dir);
  const onboarding = new Onboarding(dir);
  onboarding.setStage('done');
  return { dir, brain, brainConfig, onboarding, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Fake Anthropic client that returns a programmable sequence of responses.
 * Each call to messages.stream() yields the next response in the queue and
 * fires the matching text chunks via the 'text' listener.
 */
function fakeClient(responses: Array<{ text?: string; toolUse?: { id: string; name: string; input: unknown }; stop: 'end_turn' | 'tool_use' }>) {
  let i = 0;
  return {
    messages: {
      stream(_opts: unknown) {
        const r = responses[Math.min(i, responses.length - 1)];
        i++;
        const listeners: Record<string, Array<(arg: unknown) => void>> = {};
        const result = {
          on(event: string, fn: (arg: unknown) => void) {
            (listeners[event] ||= []).push(fn);
            return result;
          },
          async finalMessage() {
            // Fire text listeners synchronously so test sees them
            if (r.text) {
              for (const fn of listeners.text || []) fn(r.text);
            }
            const content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }> = [];
            if (r.text) content.push({ type: 'text', text: r.text });
            if (r.toolUse) content.push({ type: 'tool_use', ...r.toolUse });
            return {
              id: 'msg_' + i,
              type: 'message',
              role: 'assistant',
              content,
              stop_reason: r.stop,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
              model: 'fake',
            };
          },
        };
        return result;
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeTool(name: string, execute: () => string): ToolHandler {
  return {
    def: { name, description: 'fake', input_schema: { type: 'object', properties: {} } },
    execute,
  };
}

test('single-iteration: result.text matches the streamed text', async () => {
  const { brain, brainConfig, onboarding, cleanup } = setup();
  try {
    const client = fakeClient([{ text: 'hello world', stop: 'end_turn' }]);
    const agent = new Agent({
      client,
      brain,
      brainConfig,
      onboarding,
      tools: [],
      taskSummary: () => '',
    });
    const streamed: string[] = [];
    const r = await agent.run({
      chatId: 1,
      userMessage: 'hi',
      history: [],
      onTextChunk: (c) => streamed.push(c),
    });
    assert.equal(r.text, 'hello world');
    assert.equal(streamed.join(''), 'hello world');
    assert.equal(r.iterations, 1);
  } finally {
    cleanup();
  }
});

test('CRITICAL: multi-iteration text accumulates across iterations (v0.5.1 regression guard)', async () => {
  const { brain, brainConfig, onboarding, cleanup } = setup();
  try {
    // text → tool_use, then text → end_turn. Both texts must appear in result.text.
    const client = fakeClient([
      { text: 'first, let me check', toolUse: { id: 'tu1', name: 'check', input: {} }, stop: 'tool_use' },
      { text: 'now I know the answer is 42', stop: 'end_turn' },
    ]);
    const agent = new Agent({
      client,
      brain,
      brainConfig,
      onboarding,
      tools: [makeTool('check', () => 'tool returned 42')],
      taskSummary: () => '',
    });
    const streamed: string[] = [];
    const r = await agent.run({
      chatId: 1,
      userMessage: 'what is the answer?',
      history: [],
      onTextChunk: (c) => streamed.push(c),
    });
    // Both text blocks must be in the final result
    assert.match(r.text, /first, let me check/);
    assert.match(r.text, /now I know the answer is 42/);
    // Streamed events should match (chunks were emitted in order)
    assert.match(streamed.join(''), /first, let me check.*now I know the answer is 42/s);
    assert.equal(r.iterations, 2);
    assert.equal(r.toolCalls, 1);
  } finally {
    cleanup();
  }
});

test('three-iteration text + tool + text + tool + text', async () => {
  const { brain, brainConfig, onboarding, cleanup } = setup();
  try {
    const client = fakeClient([
      { text: 'step one', toolUse: { id: 't1', name: 'noop', input: {} }, stop: 'tool_use' },
      { text: 'step two', toolUse: { id: 't2', name: 'noop', input: {} }, stop: 'tool_use' },
      { text: 'step three (final)', stop: 'end_turn' },
    ]);
    const agent = new Agent({
      client,
      brain,
      brainConfig,
      onboarding,
      tools: [makeTool('noop', () => 'ok')],
      taskSummary: () => '',
    });
    const r = await agent.run({ chatId: 1, userMessage: 'go', history: [] });
    assert.match(r.text, /step one/);
    assert.match(r.text, /step two/);
    assert.match(r.text, /step three/);
    assert.equal(r.iterations, 3);
    assert.equal(r.toolCalls, 2);
  } finally {
    cleanup();
  }
});

test('iteration with no text block does not produce empty section', async () => {
  const { brain, brainConfig, onboarding, cleanup } = setup();
  try {
    // First iteration is tool-only (no text), second has text.
    // Without text-empty filtering we'd produce "\n\nthe answer".
    const client = fakeClient([
      { toolUse: { id: 't1', name: 'noop', input: {} }, stop: 'tool_use' },
      { text: 'the answer', stop: 'end_turn' },
    ]);
    const agent = new Agent({
      client,
      brain,
      brainConfig,
      onboarding,
      tools: [makeTool('noop', () => 'ok')],
      taskSummary: () => '',
    });
    const r = await agent.run({ chatId: 1, userMessage: 'go', history: [] });
    assert.equal(r.text.trim(), 'the answer');
  } finally {
    cleanup();
  }
});

test('tool execution result reaches the agent loop', async () => {
  const { brain, brainConfig, onboarding, cleanup } = setup();
  try {
    let called = 0;
    const client = fakeClient([
      { toolUse: { id: 't1', name: 'inc', input: {} }, stop: 'tool_use' },
      { text: 'done', stop: 'end_turn' },
    ]);
    const agent = new Agent({
      client,
      brain,
      brainConfig,
      onboarding,
      tools: [makeTool('inc', () => { called++; return 'incremented'; })],
      taskSummary: () => '',
    });
    await agent.run({ chatId: 1, userMessage: 'go', history: [] });
    assert.equal(called, 1);
  } finally {
    cleanup();
  }
});

test('unknown tool returns is_error result, agent recovers', async () => {
  const { brain, brainConfig, onboarding, cleanup } = setup();
  try {
    const client = fakeClient([
      { toolUse: { id: 't1', name: 'nonexistent', input: {} }, stop: 'tool_use' },
      { text: 'recovered', stop: 'end_turn' },
    ]);
    const agent = new Agent({
      client,
      brain,
      brainConfig,
      onboarding,
      tools: [],
      taskSummary: () => '',
    });
    const r = await agent.run({ chatId: 1, userMessage: 'go', history: [] });
    assert.equal(r.text, 'recovered');
    assert.equal(r.iterations, 2);
  } finally {
    cleanup();
  }
});
