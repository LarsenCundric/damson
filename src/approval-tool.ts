/**
 * The `request_approval` tool — the agent calls this before destructive
 * actions. The implementation sends a Telegram inline-keyboard message
 * (Yes/No) and awaits the user's tap.
 *
 * This is a hard guardrail. The agent must call this for any action
 * that's irreversible (push to remote, send public message, delete data,
 * spend money).
 */

import { InlineKeyboard } from 'grammy';
import type { Bot } from 'grammy';
import type { ApprovalRegistry } from './approvals.ts';
import type { ToolHandler, ToolInput } from './types.ts';

export interface ApprovalDeps {
  registry: ApprovalRegistry;
  bot: Bot;
  chatId: number;
}

export function buildApprovalTool(deps: ApprovalDeps): ToolHandler {
  return {
    def: {
      name: 'request_approval',
      description: `Ask the user to approve a destructive action via inline-keyboard yes/no in Telegram. ALWAYS call this BEFORE any irreversible action: pushing to a remote, sending a public message (tweet, Slack, email), deleting files/branches/data, spending money, mass operations.

The promise resolves with the user's decision. If they don't tap within 5 minutes, the request times out as denied.

Returns "approved" | "denied" | "timeout".`,
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            description: 'Short verb-phrase description of what you want to do, in first person. e.g. "push v0.5.0 to origin/main", "send the draft tweet", "delete branch feature-x".',
          },
          details: {
            type: 'string',
            description: 'Optional extra context (commit hash, file count, dollar amount, etc.).',
          },
        },
        required: ['action'],
      },
    },
    execute: async (input: ToolInput) => {
      const action = String(input.action || '').trim();
      const details = input.details ? String(input.details) : '';
      if (!action) return 'Error: action is required';

      const description = details ? `${action}\n\n${details}` : action;
      const { id, promise } = deps.registry.request(description);

      const keyboard = new InlineKeyboard()
        .text('✅ Approve', `approve:${id}`)
        .text('❌ Deny', `deny:${id}`);

      try {
        await deps.bot.api.sendMessage(deps.chatId, `🔐 approval needed:\n\n${description.slice(0, 3500)}`, {
          reply_markup: keyboard,
        });
      } catch (e) {
        deps.registry.cancel(id);
        return `Error: failed to send approval request: ${(e as Error).message}`;
      }

      const decision = await promise;
      return `decision: ${decision}`;
    },
  };
}
