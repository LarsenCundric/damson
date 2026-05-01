/**
 * Tools the agent uses to create/list/delete schedules.
 */

import type { ToolHandler, ToolInput } from './types.ts';
import type { ScheduleManager, ScheduleType, DeliveryTier } from './schedules.ts';

export function buildScheduleTools(deps: { schedules: ScheduleManager }): ToolHandler[] {
  return [
    {
      def: {
        name: 'schedule_create',
        description: `Create a recurring scheduled task. For one-off reminders ("in 5min", "tomorrow at 9am") use remind_once instead — recurring crons spam forever.

⚠️ TYPE SEMANTICS — pick correctly:
  - 'agent' (DEFAULT for real work): runs a full damson tool loop with full tools (bash, web_fetch, memory_search, config_get). Use for "every 4h check Datafast and flag anomalies", "daily GitHub digest", anything requiring real data.
  - 'bash': runs one literal shell command. Simpler than agent but can't reason about output. Use for one-liners like \`curl URL | jq '.foo'\`.
  - 'ai': blind LLM call with NO TOOLS. HALLUCINATES if asked to "check / analyze / fetch" anything. ONLY for pure prose generation: "write a morning greeting", "brainstorm 3 marketing angles". NEVER for data tasks.

If the user asks "every X check Y" → MUST be 'agent' or 'bash', NEVER 'ai'.`,
        input_schema: {
          type: 'object' as const,
          properties: {
            name: { type: 'string', description: 'Unique identifier (kebab-case)' },
            cron: { type: 'string', description: 'Standard 5-field cron in UTC. Examples: "0 16 * * *" = 9am PDT daily, "0 */4 * * *" = every 4h.' },
            type: { type: 'string', enum: ['agent', 'bash', 'ai'], description: 'See description for which to pick' },
            command: { type: 'string', description: 'For type=bash. The shell command.' },
            prompt: { type: 'string', description: 'For type=agent or type=ai. Describe what to do; agent has tools, ai does not.' },
            delivery: { type: 'string', enum: ['telegram', 'brain_file', 'silent_unless_flagged'], description: 'Where output goes. Default: telegram.' },
            silent: { type: 'boolean', description: 'If true, output goes to morning brief instead of pinging immediately.' },
          },
          required: ['name', 'cron', 'type'],
        },
      },
      execute: (input: ToolInput) => {
        const result = deps.schedules.create({
          name: String(input.name || ''),
          cron: String(input.cron || ''),
          type: String(input.type || '') as ScheduleType,
          command: input.command ? String(input.command) : undefined,
          prompt: input.prompt ? String(input.prompt) : undefined,
          delivery: input.delivery as DeliveryTier | undefined,
          silent: !!input.silent,
        });
        if (!result.ok) return `Error: ${result.error}`;
        return `✓ schedule "${result.record.name}" created (${result.record.type}, ${result.record.cron})`;
      },
    },
    {
      def: {
        name: 'schedule_list',
        description: 'Show all active schedules.',
        input_schema: { type: 'object' as const, properties: {}, required: [] },
      },
      execute: () => deps.schedules.formatList(),
    },
    {
      def: {
        name: 'schedule_delete',
        description: 'Remove a schedule by name.',
        input_schema: {
          type: 'object' as const,
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
      execute: (input: ToolInput) => {
        const ok = deps.schedules.delete(String(input.name || ''));
        return ok ? `✓ removed schedule "${input.name}"` : `Error: no schedule named "${input.name}"`;
      },
    },
  ];
}
