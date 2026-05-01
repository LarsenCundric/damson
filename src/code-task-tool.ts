/**
 * The `code_task` tool — spawn a Claude Code worker for focused real work.
 *
 * Architecture: damson orchestrates, CC executes. When Claude (running as
 * damson) decides a task needs many tool calls or > 30s of work, it calls
 * code_task. We spawn a detached `claude -p ...` via the supervisor, track
 * it via the task manager, and let lifecycle events (done/stall/frozen)
 * flow through the EventBus.
 *
 * The session router decides cold vs reuse based on cwd + topic + recency.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { ToolHandler, ToolInput } from './types.ts';
import type { TaskManager } from './tasks.ts';
import type { SessionManager } from './sessions.ts';
import type { EventBus } from './event-bus.ts';
import type { Brain } from './brain.ts';
import type { BrainConfig } from './config.ts';
import type { SupervisedRun } from './supervisor.ts';
import { spawnSupervised } from './supervisor.ts';

const MAX_CONCURRENT = 3;
const PATH_ENV = `${homedir()}/.local/bin:${homedir()}/.smux/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;

export interface CodeTaskDeps {
  tasks: TaskManager;
  sessions: SessionManager;
  bus: EventBus;
  brain: Brain;
  brainConfig: BrainConfig;
  reposDir: string;
  taskDir: string;
  defaultModel: string;
  activeRuns: Map<string, SupervisedRun>;
}

export function buildCodeTaskTool(deps: CodeTaskDeps): ToolHandler {
  return {
    def: {
      name: 'code_task',
      description: `Spawn Claude Code for focused real work — multi-file edits, debugging, research, anything that needs many tool calls or runs >30s. Detached subprocess; survives damson restarts. You'll get a system event when it finishes.

Session reuse: if you spawn a follow-up in the same cwd within 15min on a related topic, damson auto-reuses the previous CC session (preserves the worker's reasoning). Override with session: "new" to force cold.

Required: \`claude\` CLI on PATH (separate from damson; user must \`claude /login\` once).`,
      input_schema: {
        type: 'object' as const,
        properties: {
          prompt: { type: 'string', description: 'What the worker should do. Be specific. Single task per spawn.' },
          cwd: { type: 'string', description: 'Working directory (absolute path). Default: REPOS_DIR.' },
          task_id: {
            type: 'string',
            description: 'Short kebab-case id used for filenames and references.',
          },
          max_turns: { type: 'number', description: 'Max CC iterations (default 50, range 5-200).' },
          timeout_minutes: { type: 'number', description: 'Hard-kill after N min (default 20, max 120).' },
          stall_minutes: { type: 'number', description: 'No-output stall notice threshold (default 8). Notice only — does not kill.' },
          model: { type: 'string', description: 'opus | sonnet | haiku, or full model id. Default from DEFAULT_CC_MODEL.' },
          session: {
            type: 'string',
            description: '"new" forces cold session; a UUID forces resume of that exact session; omit for auto-detect.',
          },
        },
        required: ['prompt', 'task_id'],
      },
    },
    execute: async (input: ToolInput) => {
      const taskId = String(input.task_id || '').trim();
      if (!taskId) return 'Error: task_id is required';
      if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
        return 'Error: task_id must match /^[a-zA-Z0-9_-]+$/';
      }
      const prompt = String(input.prompt || '');
      if (!prompt.trim()) return 'Error: prompt is required';

      const cwd = String(input.cwd || deps.reposDir);
      if (!existsSync(cwd)) return `Error: cwd does not exist: ${cwd}`;

      if (deps.activeRuns.size >= MAX_CONCURRENT) {
        const ids = [...deps.activeRuns.keys()].join(', ');
        return `Refused: ${MAX_CONCURRENT} code_tasks already running (${ids}). Wait or cancel one.`;
      }
      if (deps.activeRuns.has(taskId)) {
        return `Refused: task "${taskId}" already running.`;
      }

      const maxTurns = Math.min(Math.max(Number(input.max_turns) || 50, 5), 200);
      const timeoutMs = Math.min(
        Math.max((Number(input.timeout_minutes) || 20) * 60_000, 60_000),
        120 * 60_000
      );
      const stallMs = Math.min(
        Math.max((Number(input.stall_minutes) || 8) * 60_000, 30_000),
        30 * 60_000
      );

      // Session router decision
      let sessionId: string;
      let sessionFlag: string;
      let sessionReason: string;
      const sessionPref = String(input.session || '').trim();
      if (sessionPref === 'new') {
        const r = deps.sessions.create(cwd, prompt);
        sessionId = r.sessionId;
        sessionFlag = `--session-id ${sessionId}`;
        sessionReason = 'forced new';
      } else if (/^[0-9a-f-]{36}$/i.test(sessionPref)) {
        sessionId = sessionPref;
        sessionFlag = `--resume ${sessionId}`;
        sessionReason = `forced resume ${sessionId.slice(0, 8)}`;
      } else {
        const match = deps.sessions.findMatch(cwd, prompt);
        if (match) {
          sessionId = match.sessionId;
          sessionFlag = `--resume ${sessionId}`;
          sessionReason = `auto-reuse (${match.reason})`;
        } else {
          const r = deps.sessions.create(cwd, prompt);
          sessionId = r.sessionId;
          sessionFlag = `--session-id ${sessionId}`;
          sessionReason = 'cold (no match)';
        }
      }
      deps.sessions.touch(sessionId, taskId, prompt);
      console.log(`[code_task] ${taskId} session ${sessionId.slice(0, 8)} — ${sessionReason}`);

      // Build worker prompt — prepend hard config rules so the worker sees them too
      let enrichedPrompt = prompt;
      const configBlock = deps.brainConfig.formatForPrompt();
      if (configBlock) {
        enrichedPrompt = `## Hard rules from user (always obey):\n${configBlock}\n\n## Task:\n${prompt}`;
      }

      const model = String(input.model || deps.defaultModel).replace(/[^a-zA-Z0-9._-]/g, '');
      const claudeCmd = `claude --print --model ${model} --dangerously-skip-permissions --output-format stream-json --verbose --max-turns ${maxTurns} ${sessionFlag} ${JSON.stringify(enrichedPrompt)}`;

      // Record task in manager
      deps.tasks.create(taskId, prompt.slice(0, 200), cwd, 'code');

      let run: SupervisedRun;
      try {
        run = spawnSupervised({
          id: taskId,
          command: claudeCmd,
          cwd,
          env: { HOME: homedir(), PATH: PATH_ENV },
          taskDir: deps.taskDir,
          timeoutMs,
          noOutputMs: stallMs,
        });
      } catch (e) {
        deps.tasks.complete(taskId, 'spawn-error', -1, (e as Error).message);
        return `Error: spawn failed: ${(e as Error).message}`;
      }
      deps.activeRuns.set(taskId, run);
      deps.tasks.start(taskId, run.pid);

      // Wire lifecycle to bus
      run.on('progress', (e) => {
        deps.tasks.updateProgress(taskId, e.step, e.kind === 'tool_use' ? `${e.tool} ${e.args}` : 'result');
        deps.bus.emit({
          type: 'task.progress',
          source: 'supervisor',
          payload: { taskId, ...e },
          hints: { suppressAnnounce: true },
        });
      });

      run.on('stall', (e) => {
        deps.tasks.markStalled(taskId, e.tail);
        deps.bus.emit({
          type: 'task.stall',
          source: 'supervisor',
          payload: { taskId, ...e },
        });
      });

      run.on('frozen', (e) => {
        deps.bus.emit({
          type: 'task.frozen',
          source: 'supervisor',
          payload: { taskId, ...e },
        });
      });

      run.on('done', (e) => {
        deps.activeRuns.delete(taskId);
        const success = e.reason === 'exit' && e.exitCode === 0;

        // Best-effort summary extraction from the stream-json output
        let summary = '';
        try {
          const lines = e.output.split('\n').filter(Boolean);
          for (let i = lines.length - 1; i >= 0; i--) {
            const ev = JSON.parse(lines[i]);
            if (ev.type === 'result' && typeof ev.result === 'string') {
              summary = ev.result;
              break;
            }
          }
          if (!summary) {
            // Fallback: gather all assistant text blocks
            const texts: string[] = [];
            for (const line of lines) {
              try {
                const ev = JSON.parse(line);
                if (ev.type === 'assistant' && ev.message?.content) {
                  for (const b of ev.message.content) {
                    if (b.type === 'text') texts.push(b.text);
                  }
                }
              } catch {}
            }
            summary = texts.join('\n').trim();
          }
        } catch {}
        if (summary.length > 5000) summary = summary.slice(0, 2500) + '\n...(truncated)...\n' + summary.slice(-2500);
        if (!summary) summary = e.stderr ? `(no prose)\nstderr tail:\n${e.stderr.slice(-500)}` : '(no output)';

        deps.tasks.complete(taskId, e.reason, e.exitCode, summary);

        // Auto-save substantial outputs to brain
        if (success && summary.length > 500) {
          const slug = taskId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60);
          const content = `# Task: ${taskId}\n\n**Completed**: ${new Date().toISOString()}\n**Duration**: ${Math.round(e.durationMs / 60_000)}m\n**cwd**: ${cwd}\n**Prompt**: ${prompt.slice(0, 300)}\n\n---\n\n${summary}`;
          deps.brain.save('projects', `task-${slug}`, content);
        }

        // Session router bookkeeping
        if (success) {
          deps.sessions.touch(sessionId, taskId, prompt);
        } else {
          deps.sessions.invalidate(sessionId);
        }

        deps.bus.emit({
          type: success ? 'task.done.success' : 'task.done.failure',
          source: 'supervisor',
          payload: {
            taskId,
            reason: e.reason,
            exitCode: e.exitCode,
            durationMin: Math.round(e.durationMs / 60_000),
            userSummary: summary,
            stderrTail: e.stderr.slice(-500),
            oomKilled: e.oomKilled,
            toolCount: e.toolCount,
          },
        });
      });

      return `Spawned "${taskId}" (PID ${run.pid}, session ${sessionId.slice(0, 8)}). Max ${Math.round(timeoutMs / 60_000)}m. You'll get a system event on completion.`;
    },
  };
}

/**
 * cancel_task tool — kill an active code_task by id.
 */
export function buildCancelTaskTool(deps: { activeRuns: Map<string, SupervisedRun> }): ToolHandler {
  return {
    def: {
      name: 'cancel_task',
      description: 'Cancel an active background task by id. Only when user explicitly asks, OR task is stalled past 75% of its timeout.',
      input_schema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'string' },
          reason: { type: 'string', description: 'Why' },
        },
        required: ['task_id'],
      },
    },
    execute: (input: ToolInput) => {
      const id = String(input.task_id || '');
      const run = deps.activeRuns.get(id);
      if (!run) return `Error: no active task "${id}"`;
      const reason = String(input.reason || 'cancelled by agent');
      run.cancel('manual-cancel');
      return `Cancelled "${id}" (${reason}).`;
    },
  };
}

/**
 * list_tasks tool — return current active + recent state.
 */
export function buildListTasksTool(deps: { tasks: TaskManager }): ToolHandler {
  return {
    def: {
      name: 'list_tasks',
      description: 'Show active and recent code_tasks. Call this BEFORE answering any question about task state — never guess from memory.',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    },
    execute: () => {
      const summary = deps.tasks.getSummary();
      return summary || 'No active or recent tasks.';
    },
  };
}
