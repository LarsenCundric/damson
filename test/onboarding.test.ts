import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Onboarding } from '../src/onboarding.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'damson-test-onboard-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const TEMPLATE = `# self — what damson knows about you

This file is built during your first conversation with damson. It refines over time.

## Identity

- Name:
- Pronouns:
- Timezone:

## Work

- What you do:
- Day job:
- Side projects:

---

*damson updates this file as it learns. You can edit it anytime.*
`;

const FILLED = `# self — what damson knows about you

## Identity

- Name: Alice
- Pronouns: she/her
- Timezone: PDT

## Work

- What you do: indie hacker shipping small SaaS
- Day job: senior eng at a startup

*damson updates this file as it learns.*
`;

// ============ stage start ============

test('first call: stage = start, isActive = true', () => {
  const { dir, cleanup } = setup();
  try {
    const o = new Onboarding(dir);
    assert.equal(o.currentStage(), 'start');
    assert.equal(o.isActive(), true);
    assert.match(o.systemPromptBlock(), /Onboarding stage: start/);
    assert.match(o.systemPromptBlock(), /Got a GitHub username/);
  } finally {
    cleanup();
  }
});

test('start prompt asks ONE question only, no tool calls', () => {
  const { dir, cleanup } = setup();
  try {
    const o = new Onboarding(dir);
    const block = o.systemPromptBlock();
    assert.match(block, /ONE question/);
    assert.match(block, /Do NOT call web_fetch/);
  } finally {
    cleanup();
  }
});

// ============ stage transitions ============

test('setStage(investigating) persists and advances prompt', () => {
  const { dir, cleanup } = setup();
  try {
    const o = new Onboarding(dir);
    o.setStage('investigating');
    assert.equal(o.currentStage(), 'investigating');
    assert.match(o.systemPromptBlock(), /Onboarding stage: investigating/);
    assert.match(o.systemPromptBlock(), /web_fetch/);
  } finally {
    cleanup();
  }
});

test('setStage(skipped) ends onboarding, no prompt block', () => {
  const { dir, cleanup } = setup();
  try {
    const o = new Onboarding(dir);
    o.setStage('skipped');
    assert.equal(o.currentStage(), 'skipped');
    assert.equal(o.isActive(), false);
    assert.equal(o.systemPromptBlock(), '');
  } finally {
    cleanup();
  }
});

test('skip() with reason records note', () => {
  const { dir, cleanup } = setup();
  try {
    const o = new Onboarding(dir);
    o.skip('user said no thanks');
    assert.equal(o.currentStage(), 'skipped');
    assert.deepEqual(o.getNotes(), ['skip reason: user said no thanks']);
  } finally {
    cleanup();
  }
});

test('done state stays done across reloads', () => {
  const { dir, cleanup } = setup();
  try {
    const o1 = new Onboarding(dir);
    o1.setStage('done');
    const o2 = new Onboarding(dir);
    assert.equal(o2.currentStage(), 'done');
    assert.equal(o2.isActive(), false);
  } finally {
    cleanup();
  }
});

// ============ self.md detection ============

test('self.md still template → currentStage stays at start', () => {
  const { dir, cleanup } = setup();
  try {
    writeFileSync(join(dir, 'self.md'), TEMPLATE);
    const o = new Onboarding(dir);
    assert.equal(o.currentStage(), 'start');
  } finally {
    cleanup();
  }
});

test('self.md filled by user → auto-advance from confirming → first_watcher', () => {
  const { dir, cleanup } = setup();
  try {
    const o = new Onboarding(dir);
    o.setStage('confirming');
    writeFileSync(join(dir, 'self.md'), FILLED);
    assert.equal(o.currentStage(), 'first_watcher', 'should auto-advance once self.md is real');
  } finally {
    cleanup();
  }
});

test('self.md filled while at start also advances to first_watcher (user wrote it manually)', () => {
  const { dir, cleanup } = setup();
  try {
    writeFileSync(join(dir, 'self.md'), FILLED);
    const o = new Onboarding(dir);
    assert.equal(o.currentStage(), 'first_watcher');
  } finally {
    cleanup();
  }
});

// ============ notes ============

test('recordNote keeps last 20', () => {
  const { dir, cleanup } = setup();
  try {
    const o = new Onboarding(dir);
    for (let i = 0; i < 25; i++) o.recordNote(`n${i}`);
    const notes = o.getNotes();
    assert.equal(notes.length, 20);
    assert.equal(notes[0], 'n5');
    assert.equal(notes[19], 'n24');
  } finally {
    cleanup();
  }
});

test('notes appear in system prompt block', () => {
  const { dir, cleanup } = setup();
  try {
    const o = new Onboarding(dir);
    o.recordNote('user GitHub: alice');
    o.recordNote('writes mostly TypeScript');
    o.setStage('investigating');
    const block = o.systemPromptBlock();
    assert.match(block, /What you've gathered so far/);
    assert.match(block, /user GitHub: alice/);
    assert.match(block, /writes mostly TypeScript/);
  } finally {
    cleanup();
  }
});

// ============ stage prompts ============

test('first_watcher prompt asks for ONE proposal', () => {
  const { dir, cleanup } = setup();
  try {
    const o = new Onboarding(dir);
    o.setStage('first_watcher');
    const block = o.systemPromptBlock();
    assert.match(block, /ONE concrete proactive action/);
    assert.match(block, /Pick the most relevant one/);
    assert.match(block, /ONE proposal, not a list/);
  } finally {
    cleanup();
  }
});

test('done state survives self.md edits', () => {
  const { dir, cleanup } = setup();
  try {
    writeFileSync(join(dir, 'self.md'), FILLED);
    const o = new Onboarding(dir);
    o.setStage('done');
    writeFileSync(join(dir, 'self.md'), FILLED + '\n\n## More notes\n\nlater addition');
    assert.equal(o.currentStage(), 'done', 'done is sticky');
  } finally {
    cleanup();
  }
});
