/**
 * Runtime entry point. Wires everything together.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, BrainConfig } from './config.ts';
import { Brain } from './brain.ts';
import { Pairing } from './pairing.ts';
import { ConversationStore } from './conversations.ts';
import { EventBus } from './event-bus.ts';
import { TaskManager } from './tasks.ts';
import { SessionManager } from './sessions.ts';
import { EventRouter } from './event-router.ts';
import { SystemEventQueue } from './system-events.ts';
import { AnnounceQueue } from './announce-queue.ts';
import { buildTools } from './tools.ts';
import { buildCodeTaskTool, buildCancelTaskTool, buildListTasksTool } from './code-task-tool.ts';
import { buildScheduleTools } from './schedule-tools.ts';
import { Agent } from './agent.ts';
import { startBot } from './bot.ts';
import { Heartbeat } from './heartbeat.ts';
import { WatcherRegistry, registerWatcherType } from './watchers.ts';
import { registerBuiltinWatchers } from './watcher-types.ts';
import { Onboarding } from './onboarding.ts';
import { buildOnboardingTool } from './onboarding-tool.ts';
import {
  ScheduleManager,
  executeBashSchedule,
  executeAiSchedule,
  executeAgentSchedule,
} from './schedules.ts';
import { collectSources, archiveConsumedDigests, buildBriefPrompt } from './morning-brief.ts';
import { ApprovalRegistry } from './approvals.ts';
import { buildApprovalTool } from './approval-tool.ts';
import { CircuitBreaker } from './circuit-breaker.ts';
import { safeSendMessage } from './tg-safe-send.ts';
import type { SupervisedRun } from './supervisor.ts';

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
  const onboarding = new Onboarding(config.brainDir);
  const onboardingTool = buildOnboardingTool({ onboarding });
  // approvalTool is built later — needs the bot instance — and added to the
  // tools array via mutation. Agent reads tools by reference each turn so
  // late registration works.
  const tools: typeof baseTools = [...baseTools, codeTaskTool, cancelTaskTool, listTasksTool, ...scheduleTools, onboardingTool];

  // === Agent ===
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  // Circuit breaker around the Anthropic client. After 3 consecutive failures
  // we cool down 30s, doubling each subsequent reopening up to 10min cap.
  // Without this, an Anthropic outage = autonomous wakes crash-loop forever.
  const breaker = new CircuitBreaker({
    threshold: 3,
    baseCooldownMs: 30_000,
    maxCooldownMs: 10 * 60_000,
  });
  const agent = new Agent({
    client,
    brain,
    brainConfig,
    onboarding,
    tools,
    taskSummary: () => tasks.getSummary(),
    breaker,
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

  // Onboarding kickoff — fired by bot.ts on first successful /start. Runs the
  // agent with a synthetic "begin onboarding" trigger so the system prompt's
  // current onboarding stage block tells it to ask the first question.
  const onPaired = async (chatId: number): Promise<string | null> => {
    if (!onboarding.isActive()) {
      // Returning user, or self.md was already filled in — skip the
      // onboarding kickoff. They can just message us normally.
      return null;
    }
    try {
      const result = await agent.run({
        chatId,
        userMessage:
          '[damson just paired with this user. Trigger the onboarding flow per your system prompt — stage = start. Greet briefly and ask the one question for this stage. No tool calls yet.]',
        history: [],
      });
      return result.text || null;
    } catch (e) {
      console.error(`[onPaired] agent error: ${(e as Error).message}`);
      return `paired. send me a message to start. (onboarding kickoff failed: ${(e as Error).message})`;
    }
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
    onPaired,
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
    if (pendingReasons.size === 0) return;

    // Quiet-hours check FIRST — preserve reasons + don't burn cooldown if we
    // bail (Boris regression we hit at v5.16.x: dropping reasons here meant
    // any task that completed during quiet hours got the user a "you missed
    // X" silence the next morning).
    const hour = parseInt(
      new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hour12: false }),
      10
    );
    const inQuiet = hour >= config.quietHours.start && hour < config.quietHours.end;
    if (inQuiet) {
      console.log(`[autonomous] quiet hours — events stay queued (reasons: ${[...pendingReasons].join(',')})`);
      // Re-arm a 30min retry — by then it might be out of quiet hours
      autoTimer = setTimeout(() => fireAutonomous(), 30 * 60_000);
      return;
    }

    // Also defer if user is mid-conversation (last 30s of conversation
    // means they're typing back-and-forth; don't interrupt with autonomous).
    // We approximate this by checking if last message in transcript is < 30s old.
    const recent = conversations.recent(primaryChatId, 1);
    if (recent.length > 0 && recent[0].role === 'user') {
      const age = Date.now() - Date.parse(recent[0].ts);
      if (age < 30_000) {
        console.log(`[autonomous] deferring — user active ${Math.round(age / 1000)}s ago`);
        autoTimer = setTimeout(() => fireAutonomous(), 30_000);
        return;
      }
    }

    // Past the gates — actually run. Now drain reasons + bump cooldown.
    const reasons = [...pendingReasons];
    pendingReasons.clear();
    lastAutoAt = Date.now();

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
        await safeSendMessage(bot, primaryChatId, '🤖 ' + result.text);
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
          await safeSendMessage(bot, primaryChatId, `📋 ${s.name}\n\n${trimmed}`);
        } else {
          // Land in brain digest
          brain.save('digests', s.name, `## ${new Date().toISOString()}\n\n${trimmed}`);
        }
      } else if (delivery === 'brain_file') {
        brain.save('digests', s.name, `## ${new Date().toISOString()}\n\n${trimmed}`);
      } else {
        // telegram — default
        await safeSendMessage(bot, primaryChatId, `📋 ${s.name}\n\n${trimmed}`);
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
