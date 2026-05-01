/**
 * Onboarding — the "investigate you" first-run flow.
 *
 * Stateful, resumable, code-driven. Not a prompt instruction.
 *
 * Stages:
 *   start            — first contact; ask for GitHub username (or skip)
 *   investigating    — fetched profile/repos; agent drafts self.md
 *   confirming       — drafted self.md exists; user verifies/corrects
 *   first_watcher    — propose one concrete proactive action
 *   done             — onboarded; system prompt block goes quiet
 *
 * State persists to brain/.onboarding.json. Each user message advances
 * the stage based on what's there.
 *
 * The agent still does the actual work (web_fetch, write_file, ask
 * follow-ups) — the state machine just tells it which step to focus on
 * via a tightly-scoped system prompt block.
 */

import { existsSync, readFileSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export type OnboardingStage =
  | 'start'
  | 'investigating'
  | 'confirming'
  | 'first_watcher'
  | 'done'
  | 'skipped';

interface OnboardingState {
  stage: OnboardingStage;
  startedAt: string;
  updatedAt: string;
  /** What we've learned so far, kept compact for the prompt. */
  notes: string[];
  /** Set when user opts out of investigation. */
  skippedAt?: string;
}

// Heuristics that tell us self.md has been meaningfully filled.
const TEMPLATE_MARKERS = [
  '# self — what damson knows about you',
  'damson updates this file as it learns',
];

export class Onboarding {
  private brainDir: string;
  private stateFile: string;

  constructor(brainDir: string) {
    this.brainDir = brainDir;
    this.stateFile = join(brainDir, '.onboarding.json');
  }

  // ============ State persistence ============

  private loadState(): OnboardingState | null {
    if (!existsSync(this.stateFile)) return null;
    try {
      return JSON.parse(readFileSync(this.stateFile, 'utf-8'));
    } catch {
      return null;
    }
  }

  private saveState(s: OnboardingState): void {
    s.updatedAt = new Date().toISOString();
    const tmp = this.stateFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, this.stateFile);
  }

  /** Ensure a state record exists. Returns the current state. */
  private ensure(): OnboardingState {
    let s = this.loadState();
    if (!s) {
      s = {
        stage: 'start',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        notes: [],
      };
      this.saveState(s);
    }
    return s;
  }

  // ============ Detection ============

  /** True if self.md is missing or still the bootstrap template. */
  private selfIsTemplate(): boolean {
    const path = join(this.brainDir, 'self.md');
    if (!existsSync(path)) return true;
    const content = readFileSync(path, 'utf-8');
    if (content.length > 800) return false;
    const hasMarker = TEMPLATE_MARKERS.some((m) => content.includes(m));
    if (!hasMarker) return false;
    // Filled fields look like "- Name: Alice" — a colon followed by content
    const filled = content.split('\n').filter((line) => /^- [A-Z][^:]*:\s+\S+/.test(line));
    return filled.length === 0;
  }

  /** Reflects state on every call: maybe a previous session got self.md filled
   * out by hand; we should detect that and advance. */
  currentStage(): OnboardingStage {
    const s = this.ensure();
    if (s.stage === 'done' || s.stage === 'skipped') return s.stage;
    // If self.md is now real, we're at least past 'confirming'
    if (!this.selfIsTemplate()) {
      // If we haven't proposed a watcher yet, advance to that step
      if (s.stage === 'start' || s.stage === 'investigating' || s.stage === 'confirming') {
        s.stage = 'first_watcher';
        this.saveState(s);
      }
    }
    return s.stage;
  }

  /** Is onboarding still in progress? */
  isActive(): boolean {
    const stage = this.currentStage();
    return stage !== 'done' && stage !== 'skipped';
  }

  // ============ Stage transitions (called by agent indirectly via tools) ============

  recordNote(note: string): void {
    const s = this.ensure();
    s.notes.push(note.slice(0, 200));
    if (s.notes.length > 20) s.notes = s.notes.slice(-20);
    this.saveState(s);
  }

  /**
   * Set stage. Returns the actual stage written (which may differ from the
   * requested one if a guard rejected it — e.g. trying to leave investigating
   * without self.md being filled out).
   */
  setStage(stage: OnboardingStage): { stage: OnboardingStage; rejected?: string } {
    const s = this.ensure();

    // Guard: can't move investigating → confirming without self.md being
    // a real file (not the empty template). The agent likes to claim it
    // saved info via a note instead of actually calling write_file; this
    // catches that.
    if (s.stage === 'investigating' && (stage === 'confirming' || stage === 'first_watcher')) {
      if (this.selfIsTemplate()) {
        return {
          stage: 'investigating',
          rejected: `cannot advance to "${stage}" — brain/self.md is still the empty template. Call write_file with path "brain/self.md" first.`,
        };
      }
    }

    s.stage = stage;
    if (stage === 'skipped') s.skippedAt = new Date().toISOString();
    this.saveState(s);
    return { stage };
  }

  /** User explicitly opts out. */
  skip(reason?: string): void {
    const s = this.ensure();
    s.stage = 'skipped';
    s.skippedAt = new Date().toISOString();
    if (reason) s.notes.push(`skip reason: ${reason}`);
    this.saveState(s);
  }

  /** Public read for the prompt builder. */
  getNotes(): string[] {
    return this.ensure().notes.slice();
  }

  // ============ System prompt block ============

  /**
   * Tightly-scoped instruction block injected into the system prompt while
   * onboarding is active. Different per stage so the agent focuses on one
   * thing at a time.
   */
  systemPromptBlock(): string {
    if (!this.isActive()) return '';
    const s = this.ensure();
    const notesBlock = s.notes.length > 0 ? `\n\nWhat you've gathered so far:\n${s.notes.map((n) => `- ${n}`).join('\n')}` : '';

    switch (s.stage) {
      case 'start':
        return `## ⚠️ Onboarding stage: start
This is your first conversation with the user. Don't info-dump. Greet briefly (1 line), then ask exactly ONE question: "Got a GitHub username? I'll look around so I'm not starting blank. Or say 'skip' if you'd rather just tell me what you need."

After the user replies, call \`onboarding_advance\` with:
  - stage: 'investigating' if they gave a username
  - stage: 'skipped' if they said skip / no thanks / refused
  - keep stage: 'start' if you don't have a clear answer (ask again)

Do NOT call web_fetch, write_file, or other tools yet. Only ask the question.${notesBlock}`;

      case 'investigating':
        return `## ⚠️ Onboarding stage: investigating
You have a GitHub username. Run these steps in order. DO NOT call onboarding_advance until step 4 has actually happened.

1. \`web_fetch https://api.github.com/users/<username>\` — profile basics
2. \`web_fetch https://api.github.com/users/<username>/repos?sort=updated&per_page=20\` — recent repos
3. Synthesize. Quote-source ("Based on your last 30 commits across 5 repos...") so the user can correct.
4. **CRITICAL:** call \`write_file\` with path \`brain/self.md\` (relative — no leading slash) containing the full markdown self.md you've drafted. Sections: Identity (name from profile, timezone if guessable), Work (what they ship — day job and side projects, inferred from repos), Style (languages, commit cadence), Goals (blank for now). DO NOT skip this step. DO NOT just record a "saved info" note — actually write the file. The next stage's prompt verifies self.md is non-template; if you skip write_file, onboarding loops back here.
5. Reply to the user with a short summary (NOT the whole file): "Here's what I figured out: [3-5 lines]. Anything wrong?" Ask 1-3 follow-ups based on findings ("What's <repo>?" / "Day-job hours to avoid?").
6. Call \`onboarding_advance\` with stage: 'confirming'. Optionally include a short note like "drafted self.md from public profile + 20 recent repos".

Fallback if GitHub 404s or rate-limits: ask "couldn't find that profile — tell me about yourself in one paragraph" and write whatever they say to self.md (still via write_file, still required).${notesBlock}`;

      case 'confirming':
        return `## ⚠️ Onboarding stage: confirming
You've drafted self.md. The user is replying to your follow-up questions. Update self.md (use write_file to overwrite) based on what they say. Don't keep asking new questions — once you have basic answers, move on.

When self.md feels real (Identity + Work fields filled), call \`onboarding_advance\` with stage: 'first_watcher'.${notesBlock}`;

      case 'first_watcher':
        return `## ⚠️ Onboarding stage: first_watcher
self.md is in shape. Now propose ONE concrete proactive action based on what you learned.
Examples:
- If they have public GitHub repos and care about review queue: "Want me to watch <repo> for PRs needing your review? I'd ping you when they land."
- If they ship a SaaS: "Want me to check your <analytics> daily and flag anomalies?"
- If they have a side project: "Want me to track stale branches and remind you weekly?"

Pick the most relevant one. Wait for yes/no.

If yes: write a YAML to brain/watchers/<name>.yaml using a github_events or http_poll template, confirm "watching <thing>, you'll hear from me when X". Then call \`onboarding_advance\` with stage: 'done'.

If no / "later": acknowledge, call \`onboarding_advance\` with stage: 'done'. The user can ask for watchers anytime.

ONE proposal, not a list. Don't push for more setup in the same session.${notesBlock}`;

      default:
        return '';
    }
  }
}
