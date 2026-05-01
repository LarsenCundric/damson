import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Brain } from '../src/brain.ts';
import { TaskManager } from '../src/tasks.ts';
import { collectSources, archiveConsumedDigests, buildBriefPrompt } from '../src/morning-brief.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'damson-test-brief-'));
  const brain = new Brain(dir);
  const tasks = new TaskManager(dir);
  return { dir, brain, tasks, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('collectSources: empty when no digests + no tasks', () => {
  const { brain, tasks, cleanup } = setup();
  try {
    const sources = collectSources(brain, tasks);
    assert.equal(sources.digests.length, 0);
    assert.equal(sources.recentTasks.length, 0);
    assert.equal(sources.taskCount.active, 0);
  } finally {
    cleanup();
  }
});

test('collectSources picks up digest files', () => {
  const { dir, brain, tasks, cleanup } = setup();
  try {
    mkdirSync(join(dir, 'digests'), { recursive: true });
    writeFileSync(join(dir, 'digests', 'github-prs.md'), '## yesterday\n\n3 new PRs opened\n');
    writeFileSync(join(dir, 'digests', 'site-uptime.md'), '## status\n\nall green\n');

    const sources = collectSources(brain, tasks);
    assert.equal(sources.digests.length, 2);
    const names = sources.digests.map((d) => d.name).sort();
    assert.deepEqual(names, ['github-prs', 'site-uptime']);
  } finally {
    cleanup();
  }
});

test('collectSources includes recent completed tasks within 24h', () => {
  const { brain, tasks, cleanup } = setup();
  try {
    tasks.create('recent', 'just finished', '/tmp', 'code');
    tasks.start('recent', 1);
    tasks.complete('recent', 'exit', 0, 'all good');

    const sources = collectSources(brain, tasks);
    assert.equal(sources.recentTasks.length, 1);
    assert.equal(sources.recentTasks[0].id, 'recent');
    assert.equal(sources.taskCount.succeeded, 1);
  } finally {
    cleanup();
  }
});

test('collectSources counts succeeded vs failed correctly', () => {
  const { brain, tasks, cleanup } = setup();
  try {
    tasks.create('ok1', 'a', '/tmp');
    tasks.start('ok1', 1);
    tasks.complete('ok1', 'exit', 0);

    tasks.create('ok2', 'b', '/tmp');
    tasks.start('ok2', 2);
    tasks.complete('ok2', 'exit', 0);

    tasks.create('bad', 'c', '/tmp');
    tasks.start('bad', 3);
    tasks.complete('bad', 'exit', 1);

    tasks.create('lost', 'd', '/tmp');
    tasks.start('lost', 4);
    tasks.complete('lost', 'lost', -3);

    const sources = collectSources(brain, tasks);
    assert.equal(sources.taskCount.succeeded, 2);
    assert.equal(sources.taskCount.failed, 2);
  } finally {
    cleanup();
  }
});

test('archiveConsumedDigests removes files and saves to archive', () => {
  const { dir, brain, cleanup } = setup();
  try {
    mkdirSync(join(dir, 'digests'), { recursive: true });
    writeFileSync(join(dir, 'digests', 'one.md'), '## entry one\n\ncontent A\n');
    writeFileSync(join(dir, 'digests', 'two.md'), '## entry two\n\ncontent B\n');

    archiveConsumedDigests(brain, ['one', 'two']);

    assert.equal(existsSync(join(dir, 'digests', 'one.md')), false);
    assert.equal(existsSync(join(dir, 'digests', 'two.md')), false);
    // Archive file exists, contains both
    const archiveFiles = readdirSync(join(dir, 'digests')).filter((f: string) => f.endsWith('-archive.md'));
    assert.equal(archiveFiles.length, 1);
    const archive = readFileSync(join(dir, 'digests', archiveFiles[0]), 'utf-8');
    assert.match(archive, /## one/);
    assert.match(archive, /## two/);
    assert.match(archive, /content A/);
    assert.match(archive, /content B/);
  } finally {
    cleanup();
  }
});

test('buildBriefPrompt: empty case is a short check-in', () => {
  const sources = {
    digests: [],
    recentTasks: [],
    taskCount: { active: 0, succeeded: 0, failed: 0 },
  };
  const prompt = buildBriefPrompt(sources);
  assert.match(prompt, /Nothing landed/);
  assert.match(prompt, /under 3 lines/);
});

test('buildBriefPrompt includes task summary numbers', () => {
  const sources = {
    digests: [],
    recentTasks: [
      { id: 't1', state: 'succeeded', description: 'fix the bug', summary: 'fixed it' },
      { id: 't2', state: 'failed', description: 'ship feature', summary: 'broke tests' },
    ],
    taskCount: { active: 1, succeeded: 1, failed: 1 },
  };
  const prompt = buildBriefPrompt(sources);
  assert.match(prompt, /1 active, 1 succeeded, 1 failed/);
  assert.match(prompt, /t1: fix the bug/);
  assert.match(prompt, /t2: ship feature/);
  assert.match(prompt, /broke tests/);
});

test('buildBriefPrompt embeds digest content', () => {
  const sources = {
    digests: [
      { name: 'gh', content: '3 PRs need review' },
      { name: 'site', content: 'uptime 99.9%' },
    ],
    recentTasks: [],
    taskCount: { active: 0, succeeded: 0, failed: 0 },
  };
  const prompt = buildBriefPrompt(sources);
  assert.match(prompt, /### gh/);
  assert.match(prompt, /3 PRs need review/);
  assert.match(prompt, /### site/);
  assert.match(prompt, /99\.9%/);
});

test('buildBriefPrompt instructs the agent to use 👉 for actionable items', () => {
  const sources = {
    digests: [{ name: 'x', content: 'something' }],
    recentTasks: [],
    taskCount: { active: 0, succeeded: 0, failed: 0 },
  };
  const prompt = buildBriefPrompt(sources);
  assert.match(prompt, /👉/);
});
