/**
 * Agent — the Claude tool loop.
 *
 * Streams a response, executes tool calls, loops until the model says it's
 * done or hits a turn budget.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Brain } from './brain.js';
import type { BrainConfig } from './config.js';
import type { ToolHandler } from './types.js';
import { buildSystemPrompt } from './system-prompt.js';

const MAX_ITERATIONS = 20;

export interface AgentDeps {
  client: Anthropic;
  brain: Brain;
  brainConfig: BrainConfig;
  tools: ToolHandler[];
  taskSummary: () => string;
}

export interface RunOpts {
  chatId: number;
  /** User message text. Empty for autonomous wakes — use systemNotices instead. */
  userMessage: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  onTextChunk?: (chunk: string) => void;
  systemNotices?: string;
  model?: string;
  /** True when invoked by the router (no user input). Changes the user message wrapping. */
  autonomous?: boolean;
}

export interface RunResult {
  text: string;
  toolCalls: number;
  iterations: number;
  hitLimit: boolean;
  error?: string;
}

function getPdtHour(): number {
  return parseInt(
    new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hour12: false }),
    10
  );
}

function getPdtTime(): string {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function timeVibe(hour: number): string {
  if (hour < 8) return 'Night (quiet hours)';
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  if (hour < 21) return 'Evening';
  return 'Late night';
}

export class Agent {
  private deps: AgentDeps;

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  private toolDefsForApi() {
    return this.deps.tools.map((t) => t.def);
  }

  private toolList(): string {
    return this.deps.tools.map((t) => `- ${t.def.name}: ${t.def.description?.split('\n')[0]}`).join('\n');
  }

  async run(opts: RunOpts): Promise<RunResult> {
    const { chatId, userMessage, history, onTextChunk, autonomous } = opts;
    // Autonomous wakes: prepend the system notices into the user slot as a
    // fake "trigger" message so Claude gets context but can refuse to act.
    const triggerMessage = autonomous
      ? `[AUTONOMOUS WAKE — no user input]\n\n${opts.systemNotices || '(no notices)'}\n\nDecide: synthesize a 1-3 line update for the user, run a verification tool then update them, or stay silent. You were not asked anything — only respond if there's something user-visible to add.`
      : userMessage;
    const messages: Anthropic.MessageParam[] = [
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: triggerMessage },
    ];
    const hour = getPdtHour();
    const isQuietHour = hour >= 0 && hour < 8;
    const recentBlock = this.deps.brain.recentSaves({ hours: 48, maxEntries: 8, maxCharsPerEntry: 400 });
    const system = buildSystemPrompt({
      brain: this.deps.brain,
      brainConfig: this.deps.brainConfig,
      toolList: this.toolList(),
      taskSummary: this.deps.taskSummary(),
      recentBlock,
      pdtTime: getPdtTime(),
      timeVibe: timeVibe(hour),
      isQuietHour,
      systemNotices: opts.systemNotices || '',
    });

    let finalText = '';
    let toolCalls = 0;
    let iterations = 0;
    const model = opts.model || 'claude-sonnet-4-20250514';

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      let response: Anthropic.Message;
      try {
        const stream = this.deps.client.messages.stream({
          model,
          max_tokens: 4096,
          system,
          tools: this.toolDefsForApi(),
          messages,
        });
        if (onTextChunk) {
          stream.on('text', (chunk) => onTextChunk(chunk));
        }
        response = await stream.finalMessage();
      } catch (e) {
        return { text: finalText, toolCalls, iterations, hitLimit: false, error: (e as Error).message };
      }

      const textBlocks = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (textBlocks) finalText = textBlocks;

      if (response.stop_reason === 'end_turn') break;

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (toolUses.length === 0) break;

      messages.push({ role: 'assistant', content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tool of toolUses) {
        toolCalls++;
        const handler = this.deps.tools.find((t) => t.def.name === tool.name);
        if (!handler) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tool.id,
            content: `Error: unknown tool "${tool.name}"`,
            is_error: true,
          });
          continue;
        }
        try {
          const result = await handler.execute(tool.input as Record<string, unknown>, { chatId });
          const content = typeof result === 'string' ? result : result.content;
          toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content });
        } catch (e) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tool.id,
            content: `Tool execution error: ${(e as Error).message}`,
            is_error: true,
          });
        }
      }
      messages.push({ role: 'user', content: toolResults });
    }

    return {
      text: finalText || '(no text response)',
      toolCalls,
      iterations,
      hitLimit: iterations >= MAX_ITERATIONS,
    };
  }
}
