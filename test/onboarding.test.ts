import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Onboarding } from '../src/onboarding.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'damson-test-onboard-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('needs onboarding when self.md is missing', () => {
  const { dir, cleanup } = setup();
  try {
    const o = new Onboarding(dir);
    assert.equal(o.needsOnboarding(), true);
    assert.match(o.systemPromptBlock(), /Onboarding needed/);
  } finally {
    cleanup();
  }
});

test('needs onboarding when self.md is the bootstrap template (empty fields)', () => {
  const { dir, cleanup } = setup();
  try {
    writeFileSync(
      join(dir, 'self.md'),
      `# self — what damson knows about you

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
`
    );
    const o = new Onboarding(dir);
    assert.equal(o.needsOnboarding(), true);
  } finally {
    cleanup();
  }
});

test('does NOT need onboarding when fields are filled', () => {
  const { dir, cleanup } = setup();
  try {
    writeFileSync(
      join(dir, 'self.md'),
      `# self — what damson knows about you

## Identity

- Name: Alice
- Pronouns: she/her
- Timezone: PDT

## Work

- What you do: indie hacker, ships small SaaS
- Day job: senior eng at a startup

*damson updates this file as it learns.*
`
    );
    const o = new Onboarding(dir);
    assert.equal(o.needsOnboarding(), false);
    assert.equal(o.systemPromptBlock(), '');
  } finally {
    cleanup();
  }
});

test('does NOT need onboarding when self.md is long and free-form (post-edit)', () => {
  const { dir, cleanup } = setup();
  try {
    writeFileSync(
      join(dir, 'self.md'),
      'I am a person who does things. '.repeat(50)
    );
    const o = new Onboarding(dir);
    assert.equal(o.needsOnboarding(), false);
  } finally {
    cleanup();
  }
});
