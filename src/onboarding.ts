/**
 * Onboarding — the "investigate you" first-run flow.
 *
 * Detects whether the user has been onboarded (self.md is non-template) and
 * exposes a setup nudge for the system prompt. The actual back-and-forth
 * happens in regular chat, with the agent using brain tools — but we surface
 * the intent so it doesn't get skipped.
 *
 * v0.3 scope: just the detection and the system-prompt nudge. The full
 * GitHub-investigation flow (read public profile, draft self.md, ask
 * follow-ups, propose first watcher) is the agent's responsibility — it has
 * web_fetch and write_file already.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEMPLATE_MARKERS = ['# self — what damson knows about you', 'damson updates this file as it learns'];

export class Onboarding {
  private brainDir: string;

  constructor(brainDir: string) {
    this.brainDir = brainDir;
  }

  /** True if self.md exists but still looks like the bootstrap template. */
  needsOnboarding(): boolean {
    const path = join(this.brainDir, 'self.md');
    if (!existsSync(path)) return true;
    const content = readFileSync(path, 'utf-8');
    // Heuristic: file is short AND contains template markers AND no filled-in content
    if (content.length > 800) return false;
    const hasMarker = TEMPLATE_MARKERS.some((m) => content.includes(m));
    if (!hasMarker) return false;
    // Check for any non-template, non-empty values after the bullet headers
    const filledLines = content.split('\n').filter((line) => {
      const m = /^- (Name|Pronouns|Timezone|What you do|Day job|Side projects|Communication preference|How much you want damson to act vs\. ask|What damson should help with|What damson should NOT touch):\s*(.+)$/.exec(line);
      return m && m[2].trim().length > 0;
    });
    return filledLines.length === 0;
  }

  /** System-prompt block to inject when onboarding is needed. */
  systemPromptBlock(): string {
    if (!this.needsOnboarding()) return '';
    return `## ⚠️ Onboarding needed
The user just installed damson and self.md is still the empty template. Before doing other work, you should:
1. Greet briefly. Don't info-dump.
2. Ask for their GitHub username (one question at a time — chat is sequential).
3. When you have it, fetch \`https://github.com/<username>\` and \`https://api.github.com/users/<username>/repos?sort=updated&per_page=20\` via web_fetch. Read what they ship, what languages, what's recent.
4. Draft a self.md with what you found and write it via write_file (path = brain/self.md). Quote-source claims so the user can correct ("Based on your last 30 commits across X repos…").
5. Ask 2-3 short follow-ups based on what you found ("What's <project>?" / "Day-job hours I should avoid pinging?").
6. Once self.md has real content, propose ONE concrete proactive action: "Want me to watch <repo> for PRs needing review?" If yes, write a watcher YAML to brain/watchers/<name>.yaml.
7. Stop. Don't push for more setup in the same session.

If the user has no GitHub or refuses to share — skip. Just ask "what should I help with?" and write that to self.md.`;
  }
}
