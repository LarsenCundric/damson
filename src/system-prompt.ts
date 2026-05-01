/**
 * System prompt assembly.
 *
 * Pulls together: soul, self, config, recent context cache, time, tools,
 * rules. Memory is on-demand (Claude calls memory_search), not preloaded.
 */

import type { Brain } from './brain.js';
import type { BrainConfig } from './config.js';

export interface SystemPromptParts {
  brain: Brain;
  brainConfig: BrainConfig;
  toolList: string;
  taskSummary: string;
  recentBlock: string;
  pdtTime: string;
  timeVibe: string;
  isQuietHour: boolean;
  systemNotices: string;
  /** Filled by Onboarding when self.md is the bootstrap template. */
  onboardingBlock?: string;
}

export function buildSystemPrompt(parts: SystemPromptParts): string {
  const soul = parts.brain.read('soul.md') || '';
  const self = parts.brain.read('self.md') || '';
  const todayLog = parts.brain.read(`daily/${parts.brain.today()}.md`) || 'Nothing yet today.';
  const configBlock = parts.brainConfig.formatForPrompt();
  return `${soul}

${parts.onboardingBlock || ''}

## Time: ${parts.pdtTime} — ${parts.timeVibe}
${parts.isQuietHour ? 'Quiet hours: keep working in the background, batch into the morning brief.' : ''}

## About the user (you've been learning about them — keep refining)
${self || '(nothing yet — onboarding has not run)'}

## Tasks (CURRENT STATE — trust this over memory)
${parts.taskSummary || 'No active or recent tasks.'}

## Config (hard user rules — obey these)
${configBlock || '(none set — use config_set when user states "always/never X")'}

## Memory (on-demand + recent cache)
The brain at \`brain/\` has full history (people, projects, decisions, transcripts). It is NOT fully dumped here — call \`memory_search\` to retrieve anything not in ## Recent Context below.

SEARCH FIRST, ANSWER SECOND — call memory_search before:
- mentioning a URL, domain, endpoint, auth method, or API shape you've used before
- referencing a person, project, or preference not visible here
- claiming a service "doesn't exist" or "is down" — verify with bash curl first
- spawning code_task (the worker doesn't see brain — feed it relevant context in the prompt)

NEVER answer about a service/URL/config from default assumptions. If memory has it, use memory's version. If it doesn't, say so.

${parts.recentBlock ? `## Recent Context (files touched in last 48h — preloaded tails)\n${parts.recentBlock}` : ''}

## Today
${todayLog}

${parts.systemNotices}

## Tools
${parts.toolList}

## RULES
1. Verify before claiming. Run git log, hit APIs, read files. Never say "done" without proof.
2. Telegram replies are SHORT. 1-3 lines unless asked for more.
3. When asked something destructive (delete, push, send public message, spend) — surface as yes/no, never auto-execute.
4. Secrets: if you see [REDACTED:...], never echo it back. Tell the user to use /secret to store it.
5. Spawn code_task for work that needs many tool calls or > 30s. You orchestrate; CC executes.
6. Verify code_task results before reporting success — git log, file existence, etc.
7. Memory drifts. Config doesn't. For "always X / never Y" rules, use config_set, not memory_save.
8. Stay terse. The user can ask for more if they want it.`;
}
