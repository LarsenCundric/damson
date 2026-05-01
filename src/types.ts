/**
 * Shared type definitions for damson.
 */

// ==================== EVENTS ====================

export type EventType =
  | 'user.message'
  | 'user.reply'
  | 'user.reaction'
  | 'task.done.success'
  | 'task.done.failure'
  | 'task.progress'
  | 'task.stall'
  | 'task.frozen'
  | 'task.mismatch'
  | 'task.done.filesystem'
  | 'schedule.fire'
  | 'self_edit.unpushed'
  | 'src.updated'
  | 'boot'
  // watcher-fired events use this prefix; the suffix is the watcher name
  | `watcher.${string}`;

export interface Event<P = Record<string, unknown>> {
  id: string;
  type: EventType;
  source: string;
  ts: number;
  payload: P;
  hints?: {
    suppressAnnounce?: boolean;
    userWaiting?: boolean;
    [k: string]: unknown;
  };
}

// ==================== TASKS ====================

export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stalled' | 'lost';
export type TaskKind = 'code' | 'agent' | 'bash';

export interface Task {
  id: string;
  description: string;
  cwd: string;
  kind: TaskKind;
  state: TaskState;
  pid?: number;
  startedAt?: string;
  completedAt?: string;
  reason?: string;
  exitCode?: number;
  summary?: string;
  outputPreview?: string;
  step?: number;
}

// ==================== TOOLS ====================

import type Anthropic from '@anthropic-ai/sdk';

export type ToolDef = Anthropic.Tool;
export type ToolInput = Record<string, unknown>;
export type ToolResult = string | { content: string; isError?: boolean };

export interface ToolHandler {
  def: ToolDef;
  execute: (input: ToolInput, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

export interface ToolContext {
  chatId: number;
  // populated lazily as the runtime grows
}

// ==================== CONFIG ====================

export interface DamsonConfig {
  anthropicApiKey: string;
  botToken: string;
  brainDir: string;
  reposDir: string;
  defaultCcModel: string;
  quietHours: { start: number; end: number };
  heartbeatIntervalMin: number;
}
