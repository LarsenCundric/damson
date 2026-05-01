/**
 * Morning brief — the daily payoff for a proactive agent.
 *
 * Aggregates everything that landed in the brain's digests/ folder + recent
 * task completions + watcher events the user hasn't seen, runs the agent
 * to synthesize a narrative summary, posts to Telegram.
 *
 * Triggered by a default schedule the user can edit:
 *   name: morning-brief
 *   type: agent
 *   cron: "0 16 * * *"   (9am PDT)
 *   prompt: "(handled internally by morning-brief module)"
 *
 * Or directly via /brief slash command for ad-hoc testing.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Brain } from './brain.js';
import type { TaskManager } from './tasks.js';

export interface BriefSources {
  digests: Array<{ name: string; content: string }>;
  recentTasks: Array<{ id: string; state: string; description: string; summary?: string }>;
  taskCount: { active: number; succeeded: number; failed: number };
}

/**
 * Gather everything the brief should reflect on, since the last brief.
 * Digests: read every file in brain/digests/, attach name + content, then
 * delete (the brief consumes them — no double-reporting).
 */
export function collectSources(brain: Brain, tasks: TaskManager): BriefSources {
  const digestDir = join(brain.dir, 'digests');
  const digests: Array<{ name: string; content: string }> = [];
  if (existsSync(digestDir)) {
    for (const f of readdirSync(digestDir).filter((f) => f.endsWith('.md'))) {
      const path = join(digestDir, f);
      try {
        const content = readFileSync(path, 'utf-8').trim();
        if (content.length > 0) {
          digests.push({ name: f.replace(/\.md$/, ''), content });
        }
      } catch {}
    }
  }

  // Recent tasks from the last 24h
  const cutoff = Date.now() - 24 * 3600_000;
  const recent = tasks.getRecent(20).filter((t) => {
    const ts = t.completedAt ? Date.parse(t.completedAt) : 0;
    return ts >= cutoff;
  });
  const active = tasks.getActive();

  return {
    digests,
    recentTasks: recent.map((t) => ({
      id: t.id,
      state: t.state,
      description: t.description.slice(0, 200),
      summary: t.summary?.slice(0, 400),
    })),
    taskCount: {
      active: active.length,
      succeeded: recent.filter((t) => t.state === 'succeeded').length,
      failed: recent.filter((t) => t.state === 'failed' || t.state === 'lost').length,
    },
  };
}

/**
 * After the brief is delivered, archive the consumed digests so they don't
 * appear in tomorrow's brief.
 */
export function archiveConsumedDigests(brain: Brain, names: string[]): void {
  const digestDir = join(brain.dir, 'digests');
  for (const name of names) {
    const path = join(digestDir, `${name}.md`);
    try {
      const content = readFileSync(path, 'utf-8');
      // Append to a daily archive so we keep history
      const archiveName = `${new Date().toISOString().slice(0, 10)}-archive`;
      brain.save('digests', archiveName, `## ${name}\n\n${content}`);
      unlinkSync(path);
    } catch {}
  }
}

/**
 * Format collected sources into a prompt for the agent. The agent then
 * synthesizes a narrative — not just a list — and decides what's worth
 * mentioning vs skipping.
 */
export function buildBriefPrompt(sources: BriefSources): string {
  if (sources.digests.length === 0 && sources.recentTasks.length === 0) {
    return `Generate a brief morning check-in. Nothing landed in queues overnight (no digests, no recent task completions). Just acknowledge that and ask what's up. Keep it under 3 lines.`;
  }

  const parts: string[] = [];
  parts.push(
    `You are generating the user's morning brief. Take everything below and synthesize a 3-5 line narrative — what mattered, what didn't, what needs their attention. Be terse. Skip routine successes; flag anomalies and items that need a decision.`
  );
  parts.push('');
  parts.push(`Task summary: ${sources.taskCount.active} active, ${sources.taskCount.succeeded} succeeded, ${sources.taskCount.failed} failed in last 24h.`);

  if (sources.recentTasks.length > 0) {
    parts.push('');
    parts.push('Recent task completions:');
    for (const t of sources.recentTasks) {
      parts.push(`- [${t.state}] ${t.id}: ${t.description}`);
      if (t.summary) parts.push(`  → ${t.summary.replace(/\n/g, ' ').slice(0, 200)}`);
    }
  }

  if (sources.digests.length > 0) {
    parts.push('');
    parts.push('Digest items (from silent watchers/schedules — user has not seen these):');
    for (const d of sources.digests) {
      parts.push(`### ${d.name}`);
      parts.push(d.content.slice(0, 1000));
      parts.push('');
    }
  }

  parts.push('');
  parts.push(
    'Output: just the brief, no preamble. Highlight anything needing the user\'s decision with "👉" prefix. End with "—" if there\'s nothing actionable.'
  );
  return parts.join('\n');
}
