/**
 * Tests for the supervisor. Use `bash -c` scripts as stand-ins for
 * `claude -p` since the protocol is the same: detached subprocess writes
 * stream-json to stdout, exit code in .done.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSupervised } from '../src/supervisor.ts';
import type { DoneEvent, ProgressEvent } from '../src/supervisor.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'damson-test-sup-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function waitForDone(run: ReturnType<typeof spawnSupervised>, timeoutMs = 30_000): Promise<DoneEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`done timeout after ${timeoutMs}ms`)), timeoutMs);
    run.on('done', (e) => {
      clearTimeout(timer);
      resolve(e);
    });
  });
}

test('exits cleanly with exit 0', async () => {
  const { dir, cleanup } = setup();
  try {
    const run = spawnSupervised({
      id: 'ok',
      command: 'echo hello',
      cwd: dir,
      taskDir: dir,
      timeoutMs: 30_000,
    });
    const done = await waitForDone(run);
    assert.equal(done.reason, 'exit');
    assert.equal(done.exitCode, 0);
    assert.match(done.output, /hello/);
  } finally {
    cleanup();
  }
});

test('captures non-zero exit code', async () => {
  const { dir, cleanup } = setup();
  try {
    const run = spawnSupervised({
      id: 'fail',
      command: 'exit 7',
      cwd: dir,
      taskDir: dir,
      timeoutMs: 30_000,
    });
    const done = await waitForDone(run);
    assert.equal(done.reason, 'exit');
    assert.equal(done.exitCode, 7);
  } finally {
    cleanup();
  }
});

test('captures stderr', async () => {
  const { dir, cleanup } = setup();
  try {
    const run = spawnSupervised({
      id: 'stderr',
      command: 'echo "fail noise" >&2; exit 2',
      cwd: dir,
      taskDir: dir,
      timeoutMs: 30_000,
    });
    const done = await waitForDone(run);
    assert.equal(done.exitCode, 2);
    assert.match(done.stderr, /fail noise/);
  } finally {
    cleanup();
  }
});

test('emits progress events for stream-json tool_use lines', async () => {
  const { dir, cleanup } = setup();
  try {
    // Simulate stream-json output: print three tool_use events then a result.
    // Each line is a separate JSON object (the format claude -p emits).
    const json1 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'bash', input: { command: 'ls' } }] },
    });
    const json2 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'read_file', input: { path: '/tmp/x' } }] },
    });
    const jsonResult = JSON.stringify({ type: 'result' });
    // sleep between lines so the supervisor's 5s poll loop sees them
    const cmd = `printf '%s\\n' '${json1}'; sleep 6; printf '%s\\n' '${json2}'; sleep 6; printf '%s\\n' '${jsonResult}'`;

    const run = spawnSupervised({
      id: 'stream',
      command: cmd,
      cwd: dir,
      taskDir: dir,
      timeoutMs: 60_000,
    });
    const progress: ProgressEvent[] = [];
    run.on('progress', (e) => progress.push(e));
    await waitForDone(run, 30_000);

    const tools = progress.filter((p) => p.kind === 'tool_use');
    assert.equal(tools.length, 2, `got ${tools.length} tool_use events`);
    assert.equal(tools[0].tool, 'bash');
    assert.equal(tools[1].tool, 'read_file');
    assert.equal(tools[0].step, 1);
    assert.equal(tools[1].step, 2);
    const results = progress.filter((p) => p.kind === 'result');
    assert.equal(results.length, 1);
  } finally {
    cleanup();
  }
});

test('cancel() terminates a running process', async () => {
  const { dir, cleanup } = setup();
  try {
    const run = spawnSupervised({
      id: 'long',
      command: 'sleep 60',
      cwd: dir,
      taskDir: dir,
      timeoutMs: 120_000,
    });
    setTimeout(() => run.cancel('manual-cancel'), 1000);
    const done = await waitForDone(run, 15_000);
    assert.ok(['manual-cancel', 'signal', 'exit'].includes(done.reason), `reason=${done.reason}`);
    assert.notEqual(done.exitCode, 0);
  } finally {
    cleanup();
  }
});

test('isAlive() reflects process state', async () => {
  const { dir, cleanup } = setup();
  try {
    const run = spawnSupervised({
      id: 'alive',
      command: 'sleep 2',
      cwd: dir,
      taskDir: dir,
      timeoutMs: 30_000,
    });
    assert.equal(run.isAlive(), true);
    await waitForDone(run);
    assert.equal(run.isAlive(), false);
  } finally {
    cleanup();
  }
});
