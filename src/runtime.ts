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
import { Agent } from './agent.js';
import { startBot } from './bot.js';
import { Heartbeat } from './heartbeat.js';
import { WatcherRegistry, registerWatcherType } from './watchers.js';
import { registerBuiltinWatchers } from './watcher-types.js';
import { Onboarding } from './onboarding.js';
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
  const tools = [...baseTools, codeTaskTool, cancelTaskTool, listTasksTool];

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
  const { bot, printPairingDeeplinkOnBoot } = startBot({
    agent,
    pairing,
    conversations,
    config,
    systemEvents,
    tasks,
    activeRuns,
    version: VERSION,
  });

  // === Router (after bot is created — needs it for announces) ===
  const announceQueue = new AnnounceQueue(bot, await pickPrimaryChatId(pairing));
  const primaryChatId = await pickPrimaryChatId(pairing);

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

  // === Heartbeat ===
  const heartbeat = new Heartbeat({
    tasks,
    bus,
    taskRunsDir: join(config.brainDir, '.task-runs'),
    activeRuns,
    intervalMs: config.heartbeatIntervalMin * 60_000,
  });
  heartbeat.addHook(() => watchers.tick());
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
