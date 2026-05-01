/**
 * Runtime entry point. Wires everything together.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, BrainConfig } from './config.js';
import { Brain } from './brain.js';
import { Pairing } from './pairing.js';
import { ConversationStore } from './conversations.js';
import { EventBus } from './event-bus.js';
import { TaskManager } from './tasks.js';
import { SessionManager } from './sessions.js';
import { EventRouter } from './event-router.js';
import { SystemEventQueue } from './system-events.js';
import { AnnounceQueue } from './announce-queue.js';
import { buildTools } from './tools.js';
import { buildCodeTaskTool, buildCancelTaskTool, buildListTasksTool } from './code-task-tool.js';
import { buildScheduleTools } from './schedule-tools.js';
import { Agent } from './agent.js';
import { startBot } from './bot.js';
import { Heartbeat } from './heartbeat.js';
import { WatcherRegistry, registerWatcherType } from './watchers.js';
import { registerBuiltinWatchers } from './watcher-types.js';
import { Onboarding } from './onboarding.js';
import {
  ScheduleManager,
  executeBashSchedule,
  executeAiSchedule,
  executeAgentSchedule,
} from './schedules.js';
import { collectSources, archiveConsumedDigests, buildBriefPrompt } from './morning-brief.js';
import { ApprovalRegistry } from './approvals.js';
import { buildApprovalTool } from './approval-tool.js';
import type { SupervisedRun } from './supervisor.js';

function readVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    // dist/runtime.js → repo root is two levels up
    const candidates = [
      join(here, '..', '..', 'package.json'),
      join(here, '..', 'package.json'),
    ];
    for (const c of candidates) {
      try {
        const pkg = JSON.parse(readFileSync(c, 'utf-8'));
        if (pkg.name === 'damson' && pkg.version) return pkg.version;
      } catch {}
    }
  } catch {}
  return '0.0.0-dev';
}

async function main() {
  const VERSION = readVersion();
  console.log(`[boot] damson ${VERSION} starting...`);
  const config = loadConfig();
  console.log(`[boot] brain: ${config.brainDir}`);
  console.log(`[boot] repos: ${config.reposDir}`);

  // === State ===
  const brain = new Brain(config.brainDir);
  const brainConfig = new BrainConfig(config.brainDir);
  const pairing = new Pairing(config.brainDir);
  const conversations = new ConversationStore(config.brainDir);
  const tasks = new TaskManager(config.brainDir);
  const sessions = SessionManager.fromBrainDir(config.brainDir);
  const schedules = new ScheduleManager(config.brainDir);
  const approvals = new ApprovalRegistry();
  const bus = new EventBus();
  const systemEvents = new SystemEventQueue();
  const activeRuns = new Map<string, SupervisedRun>();

  // === Tools ===
  const baseTools = buildTools({ brain, brainConfig, reposDir: config.reposDir });
  const codeTaskTool = buildCodeTaskTool({
    tasks,
    sessions,
    bus,
    brain,
    brainConfig,
    reposDir: config.reposDir,
    taskDir: join(config.brainDir, '.task-runs'),
    defaultModel: config.defaultCcModel,
    activeRuns,
  });
  const cancelTaskTool = buildCancelTaskTool({ activeRuns });
  const listTasksTool = buildListTasksTool({ tasks });
  const scheduleTools = buildScheduleTools({ schedules });
  // approvalTool is built later — needs the bot instance — and added to the
  // tools array via mutation. Agent reads tools by reference each turn so
  // late registration works.
  const tools: typeof baseTools = [...baseTools, codeTaskTool, cancelTaskTool, listTasksTool, ...scheduleTools];

  // === Agent ===
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const onboarding = new Onboarding(config.brainDir);
  const agent = new Agent({
    client,
    brain,
    brainConfig,
    onboarding,
    tools,
    taskSummary: () => tasks.getSummary(),
  });

  // === Bot ===
  // primaryChatId — declared early so it's in scope for closures below.
  // 0 means "no paired user yet" — closures gracefully degrade to no-op.
  const primaryChatId = await pickPrimaryChatId(pairing);

  // Brief handler — collects sources, runs the agent, archives consumed digests
  const briefHandler = async (): Promise<string> => {
    if (primaryChatId === 0) return '(no paired user yet)';
    const sources = collectSources(brain, tasks);
    const prompt = buildBriefPrompt(sources);
    const result = await agent.run({
      chatId: primaryChatId,
      userMessage: prompt,
      history: [],
    });
    archiveConsumedDigests(brain, sources.digests.map((d) => d.name));
    return result.text || '(no output)';
  };

  const { bot, printPairingDeeplinkOnBoot } = startBot({
    agent,
    pairing,
    conversations,
    config,
    systemEvents,
    tasks,
    activeRuns,
    schedules,
    approvals,
    version: VERSION,
    briefHandler,
  });

  // Register the approval tool now that we have the bot instance + chat id
  if (primaryChatId !== 0) {
    tools.push(buildApprovalTool({ registry: approvals, bot, chatId: primaryChatId }));
  }

  // === Router (after bot is created — needs it for announces) ===
  const announceQueue = new AnnounceQueue(bot, primaryChatId);

  // Autonomous wake — fires when router decides agent should respond to a
  // background event. Coalesces, rate-limits, defers during quiet hours.
  const COOLDOWN_MS = 60_000;
  let lastAutoAt = 0;
  let autoTimer: NodeJS.Timeout | null = null;
  const pendingReasons = new Set<string>();

  const triggerAgentWake = (reasons: string[]): void => {
    if (primaryChatId === 0) {
      console.log(`[autonomous] skip — no paired user yet (reasons: ${reasons.join(',')})`);
      return;
    }
    for (const r of reasons) pendingReasons.add(r);
    if (autoTimer) return;
    const sinceLast = Date.now() - lastAutoAt;
    const debounce = Math.max(2_000, COOLDOWN_MS - sinceLast);
    autoTimer = setTimeout(() => fireAutonomous(), debounce);
  };

  async function fireAutonomous(): Promise<void> {
    autoTimer = null;
    const reasons = [...pendingReasons];
    pendingReasons.clear();
    if (reasons.length === 0) return;
    lastAutoAt = Date.now();

    // Quiet-hours check
    const hour = parseInt(
      new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hour12: false }),
      10
    );
    const inQuiet = hour >= config.quietHours.start && hour < config.quietHours.end;
    if (inQuiet) {
      console.log(`[autonomous] quiet hours — events queued for morning (reasons: ${reasons.join(',')})`);
      // System events stay queued; user gets them when they message in the morning
      return;
    }

    const sysEvents = systemEvents.drain(primaryChatId);
    const notices =
      sysEvents.length > 0
        ? sysEvents.map((e) => `[${e.type}]\n${e.msg}`).join('\n\n---\n\n')
        : `Reasons: ${reasons.join(', ')}`;

    console.log(`[autonomous] thinking, reasons: ${reasons.join(', ')}`);
    try {
      const result = await agent.run({
        chatId: primaryChatId,
        userMessage: '',
        autonomous: true,
        systemNotices: notices,
        history: conversations.recent(primaryChatId, 20).map((t) => ({ role: t.role, content: t.content })),
      });
      if (result.text && result.text.trim() && result.text !== '(no text response)') {
        await bot.api.sendMessage(primaryChatId, '🤖 ' + result.text.slice(0, 4000));
        conversations.append(primaryChatId, 'assistant', result.text);
      }
    } catch (e) {
      console.error(`[autonomous] error: ${(e as Error).message}`);
    }
  }

  new EventRouter({
    bus,
    triggerAgentWake,
    announceQueue,
    enqueueSystemEvent: (chatId, msg, type) => systemEvents.enqueue(chatId, msg, type),
    chatId: primaryChatId,
  });

  // === Watchers ===
  registerBuiltinWatchers(registerWatcherType);
  const watchers = new WatcherRegistry(config.brainDir, bus);
  watchers.load();

  // === Schedule dispatch ===
  // type=agent schedules invoke this — runs a full agent turn with the
  // schedule's prompt as the trigger message, returns the synthesized text.
  const scheduleAgentRunner = async (prompt: string): Promise<string> => {
    if (primaryChatId === 0) return '(no paired user yet)';
    try {
      const result = await agent.run({
        chatId: primaryChatId,
        userMessage: prompt,
        history: conversations.recent(primaryChatId, 10).map((t) => ({ role: t.role, content: t.content })),
      });
      return result.text || '(no output)';
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  };

  async function dispatchDueSchedules(): Promise<void> {
    const due = schedules.getDue();
    for (const s of due) {
      schedules.markRun(s.name);
      let output = '';
      try {
        if (s.type === 'bash') {
          output = await executeBashSchedule(s, config.reposDir);
        } else if (s.type === 'agent') {
          output = await executeAgentSchedule(s, scheduleAgentRunner);
        } else if (s.type === 'ai') {
          const ctx = `Today: ${brain.read(`daily/${brain.today()}.md`) || '(empty)'}\nSelf: ${brain.read('self.md')?.slice(0, 500) || '(empty)'}`;
          output = await executeAiSchedule(s, client, ctx);
        }
      } catch (e) {
        output = `Schedule error: ${(e as Error).message}`;
      }

      const trimmed = (output || '').trim();
      if (!trimmed) continue;

      console.log(`[schedule] fired "${s.name}" (${s.type}) — ${trimmed.length} chars`);

      // Delivery
      const delivery = s.delivery || 'telegram';
      if (s.silent || delivery === 'silent_unless_flagged') {
        if (/\bFLAG:|ALERT:|⚠️/i.test(trimmed)) {
          // Promote flagged silent → telegram
          await bot.api.sendMessage(primaryChatId, `📋 ${s.name}\n\n${trimmed.slice(0, 4000)}`).catch(() => {});
        } else {
          // Land in brain digest
          brain.save('digests', s.name, `## ${new Date().toISOString()}\n\n${trimmed}`);
        }
      } else if (delivery === 'brain_file') {
        brain.save('digests', s.name, `## ${new Date().toISOString()}\n\n${trimmed}`);
      } else {
        // telegram — default
        await bot.api.sendMessage(primaryChatId, `📋 ${s.name}\n\n${trimmed.slice(0, 4000)}`).catch(() => {});
      }
    }
  }

  // === Heartbeat ===
  const heartbeat = new Heartbeat({
    tasks,
    bus,
    taskRunsDir: join(config.brainDir, '.task-runs'),
    activeRuns,
    intervalMs: config.heartbeatIntervalMin * 60_000,
  });
  heartbeat.addHook(() => watchers.tick());
  heartbeat.addHook(() => dispatchDueSchedules());
  heartbeat.start();

  // === Boot ===
  await printPairingDeeplinkOnBoot();
  bus.emit({ type: 'boot', source: 'runtime', payload: {} });

  await bot.start({
    onStart: (info) => {
      console.log(`[boot] connected to telegram as @${info.username}`);
    },
  });
}

async function pickPrimaryChatId(pairing: Pairing): Promise<number> {
  // For v0.x single-user: just take the first paired chat. Later we can
  // route to the chat that emitted the triggering event.
  const allowed = [...pairing.loadAllowed()];
  return allowed[0] || 0;
}

main().catch((e) => {
  console.error(`[fatal] ${(e as Error).message}`);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[shutdown] SIGINT received');
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('[shutdown] SIGTERM received');
  process.exit(0);
});
