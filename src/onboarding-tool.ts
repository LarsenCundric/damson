/**
 * `onboarding_advance` tool — agent calls this to move the state machine
 * forward. Stage transitions are how onboarding stays code-driven instead
 * of pure-prompt.
 */

import type { ToolHandler, ToolInput } from './types.ts';
import type { Onboarding, OnboardingStage } from './onboarding.ts';

const VALID_STAGES = new Set<OnboardingStage>([
  'start',
  'investigating',
  'confirming',
  'first_watcher',
  'done',
  'skipped',
]);

export function buildOnboardingTool(deps: { onboarding: Onboarding }): ToolHandler {
  return {
    def: {
      name: 'onboarding_advance',
      description: `Advance the onboarding state machine. Call this once per stage transition during first-run setup.

Valid stages: start | investigating | confirming | first_watcher | done | skipped.

Use 'skipped' if the user explicitly opts out of investigation. Use 'done' when first_watcher is resolved (yes or no). Other stages flow naturally as described in the onboarding prompt block.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          stage: {
            type: 'string',
            enum: ['start', 'investigating', 'confirming', 'first_watcher', 'done', 'skipped'],
            description: 'The new stage to move to',
          },
          note: {
            type: 'string',
            description: 'Optional short note about what was learned in this stage (kept for context across turns)',
          },
        },
        required: ['stage'],
      },
    },
    execute: (input: ToolInput) => {
      const stage = String(input.stage || '') as OnboardingStage;
      if (!VALID_STAGES.has(stage)) {
        return `Error: invalid stage "${stage}". Valid: ${[...VALID_STAGES].join(', ')}`;
      }
      if (input.note) deps.onboarding.recordNote(String(input.note));
      const result = deps.onboarding.setStage(stage);
      if (result.rejected) return `Error: ${result.rejected}`;
      return `✓ onboarding stage → ${result.stage}`;
    },
  };
}
