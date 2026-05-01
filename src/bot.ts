/**
 * Telegram bot wiring. grammY based.
 */

import { Bot, GrammyError, HttpError } from 'grammy';
import type { Context } from 'grammy';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from './agent.ts';
import type { Pairing } from './pairing.ts';
import type { ConversationStore } from './conversations.ts';
import type { DamsonConfig } from './types.ts';
import type { SystemEventQueue } from './system-events.ts';
import type { TaskManager } from './tasks.ts';
import type { SupervisedRun } from './supervisor.ts';
import type { ScheduleManager } from './schedules.ts';
import type { ApprovalRegistry } from './approvals.ts';
import { safeSendMessage } from './tg-safe-send.ts';
import { redactSecrets, KIND_TO_ENV } from './secrets.ts';

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const CRITICAL_ENV = new Set(['BOT_TOKEN', 'TELEGRAM_USER_ID', 'ANTHROPIC_API_KEY']);

interface PendingSecret {
  value: string;
  at: number;
}

export interface BotDeps {
  agent: Agent;
  pairing: Pairing;
  conversations: ConversationStore;
  config: DamsonConfig;
  systemEvents: SystemEventQueue;
  tasks: TaskManager;
  activeRuns: Map<string, SupervisedRun>;
  schedules: ScheduleManager;
  approvals: ApprovalRegistry;
  version: string;
  /** Optional callback for /brief command. Returns the brief text. */
  briefHandler?: () => Promise<string>;
  /**
   * Optional. Fires once per chat right after a successful /start pairing.
   * Used to kick off the onboarding conversation without waiting for the
   * user to send another message. Returns text to post as the bot's first
   * authored message; if it returns falsy, no follow-up is sent.
   */
  onPaired?: (chatId: number) => Promise<string | null | undefined>;
}

export function startBot(deps: BotDeps): { bot: Bot; printPairingDeeplinkOnBoot: () => Promise<void> } {
  const bot = new Bot(deps.config.botToken);
  const pendingSecret = new Map<number, PendingSecret>();
  const PENDING_TTL_MS = 120_000;

  function storeSecretToEnv(name: string, value: string): void {
    const envPath = '.env';
    let cur = '';
    try {
      cur = readFileSync(envPath, 'utf-8');
    } catch {}
    const line = `${name}=${value}`;
    const re = new RegExp(`^${name}=.*$`, 'm');
    const next = re.test(cur)
      ? cur.replace(re, line)
      : (cur.endsWith('\n') || cur === '' ? cur : cur + '\n') + line + '\n';
    writeFileSync(envPath, next);
    try {
      chmodSync(envPath, 0o600);
    } catch {}
    process.env[name] = value;
  }

  // ============ /start (pairing) ============
  bot.command('start', async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message?.text || '';
    const parts = text.trim().split(/\s+/);
    const token = parts[1];

    const result = deps.pairing.tryBind(chatId, token);
    if (result === 'already_paired') {
      await ctx.reply('✓ already linked. send me a message.');
    } else if (result === 'bound') {
      await ctx.reply(`✓ linked. chat id ${chatId} is yours.`);
      // Fire the onboarding kickoff so the user doesn't have to send another
      // message just to get started. Telegram requires the user to message
      // the bot first (which /start counts as) before the bot can DM — once
      // /start has been received, we can freely message back.
      if (deps.onPaired) {
        try {
          const greeting = await deps.onPaired(chatId);
          if (greeting && greeting.trim()) {
            await safeSendMessage(bot, chatId, greeting.trim());
          }
        } catch (e) {
          console.error(`[onPaired] error: ${(e as Error).message}`);
        }
      }
    } else {
      // 'invalid' — silent drop (don't tell strangers anything)
    }
  });

  // ============ Auth gate ============
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (ctx.message?.text?.startsWith('/start')) return; // already handled
    if (!deps.pairing.isAllowed(chatId)) {
      // Silent drop. No DM to strangers.
      console.log(`[bot] dropped message from unauthorized chat ${chatId}`);
      return;
    }
    await next();
  });

  // ============ Approval callbacks ============
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data || '';
    const m = /^(approve|deny):([a-f0-9]+)$/.exec(data);
    if (!m) {
      await ctx.answerCallbackQuery();
      return;
    }
    const decision = m[1] === 'approve' ? 'approved' : 'denied';
    const id = m[2];
    const ok = deps.approvals.decide(id, decision);
    await ctx.answerCallbackQuery({ text: ok ? `✓ ${decision}` : 'expired or unknown' });
    if (ctx.callbackQuery.message) {
      const original = (ctx.callbackQuery.message as { text?: string }).text || '';
      const newText =
        decision === 'approved'
          ? `✅ approved\n\n${original.replace(/^🔐 approval needed:\n\n/, '')}`
          : `❌ denied\n\n${original.replace(/^🔐 approval needed:\n\n/, '')}`;
      try {
        await ctx.editMessageText(newText.slice(0, 4000));
      } catch {}
    }
  });

  // ============ Built-in commands ============
  bot.command('version', (ctx) => ctx.reply(`damson ${deps.version}`));

  bot.command('clear', (ctx) => {
    deps.conversations.clear(ctx.chat.id);
    ctx.reply('🧹 conversation cleared.');
  });

  bot.command('tasks', async (ctx) => {
    const summary = deps.tasks.getSummary();
    await safeSendMessage(bot, ctx.chat.id, summary || 'No active or recent tasks.');
  });

  bot.command('schedules', async (ctx) => {
    await safeSendMessage(bot, ctx.chat.id, deps.schedules.formatList());
  });

  bot.command('brief', async (ctx) => {
    if (!deps.briefHandler) return ctx.reply('brief handler not wired');
    await ctx.reply('🌅 generating morning brief...');
    try {
      const text = await deps.briefHandler();
      await safeSendMessage(bot, ctx.chat.id, text);
    } catch (e) {
      await ctx.reply(`Error: ${(e as Error).message}`);
    }
  });

  bot.command('kill', (ctx) => {
    const taskId = (ctx.match || '').toString().trim();
    if (!taskId) {
      return ctx.reply('Usage: `/kill <task_id>`. See active tasks with /tasks.', { parse_mode: 'Markdown' });
    }
    const run = deps.activeRuns.get(taskId);
    if (!run) {
      return ctx.reply(`No active task "${taskId}".`);
    }
    run.cancel('manual-cancel');
    return ctx.reply(`🛑 cancelled "${taskId}".`);
  });

  bot.command('help', (ctx) =>
    ctx.reply(
      [
        'damson commands:',
        '/version — show version',
        '/tasks — active + recent code_task state',
        '/kill <id> — cancel an active task',
        '/schedules — list active schedules',
        '/brief — generate the morning brief on demand',
        '/secret — store an API key (`/secret NAME VALUE` or `/secret VALUE` to be asked)',
        '/clear — wipe conversation history (brain unaffected)',
        '/help — this',
      ].join('\n')
    )
  );

  bot.command('secret', (ctx) => {
    const chatId = ctx.chat.id;
    const msgId = ctx.message?.message_id;
    if (msgId) bot.api.deleteMessage(chatId, msgId).catch(() => {});

    const payload = (ctx.match || '').toString().trim();
    if (!payload) {
      return ctx.reply('Usage: `/secret <name> <value>` or `/secret <value>` (I\'ll ask the name).', {
        parse_mode: 'Markdown',
      });
    }

    const parts = payload.split(/\s+/);
    let name: string | null = null;
    let value: string | null = null;
    if (parts.length === 1) {
      value = parts[0];
    } else {
      const firstIsName = ENV_NAME_RE.test(parts[0]);
      const lastIsName = ENV_NAME_RE.test(parts[parts.length - 1]);
      if (firstIsName && !lastIsName) {
        name = parts[0];
        value = parts.slice(1).join(' ');
      } else if (lastIsName && !firstIsName) {
        name = parts[parts.length - 1];
        value = parts.slice(0, -1).join(' ');
      } else if (firstIsName && lastIsName) {
        name = parts[0];
        value = parts.slice(1).join(' ');
      } else {
        value = payload;
      }
    }

    if (value && !name) {
      pendingSecret.set(chatId, { value, at: Date.now() });
      return ctx.reply('🔑 got the value. reply with the env var name (e.g. `OPENAI_API_KEY`).', {
        parse_mode: 'Markdown',
      });
    }
    if (!value || value.length < 4) return ctx.reply('Error: value too short.');
    if (CRITICAL_ENV.has(name!))
      return ctx.reply(`Refused: ${name} is critical. Edit .env by hand if you really need to.`);
    try {
      storeSecretToEnv(name!, value);
      console.log(`[/secret] stored ${name}`);
      return ctx.reply(`✅ stored \`${name}\` in .env.`, { parse_mode: 'Markdown' });
    } catch (e) {
      return ctx.reply(`Error writing .env: ${(e as Error).message}`);
    }
  });

  // ============ Text messages ============
  bot.on('message:text', async (ctx) => {
    if (!ctx.message?.text || ctx.message.text.startsWith('/')) return;
    const chatId = ctx.chat.id;
    let text = ctx.message.text;

    // Pending /secret follow-up: short message that's a valid env var name
    const pending = pendingSecret.get(chatId);
    if (pending && Date.now() - pending.at < PENDING_TTL_MS) {
      const candidate = text.trim();
      if (ENV_NAME_RE.test(candidate)) {
        if (ctx.message.message_id)
          bot.api.deleteMessage(chatId, ctx.message.message_id).catch(() => {});
        pendingSecret.delete(chatId);
        if (CRITICAL_ENV.has(candidate)) {
          await ctx.reply(`Refused: ${candidate} is critical.`);
          return;
        }
        try {
          storeSecretToEnv(candidate, pending.value);
          await ctx.reply(`✅ stored \`${candidate}\` in .env.`, { parse_mode: 'Markdown' });
        } catch (e) {
          await ctx.reply(`Error: ${(e as Error).message}`);
        }
        return;
      }
    } else if (pending) {
      pendingSecret.delete(chatId);
    }

    // Redaction at ingress
    const redaction = redactSecrets(text);
    if (redaction.found.length > 0) {
      const kinds = redaction.found.map((f) => f.kind).join(', ');
      console.log(`[secrets] redacted ${redaction.found.length}: ${kinds}`);
      const rawText = text;
      text = redaction.text;
      if (ctx.message.message_id)
        bot.api.deleteMessage(chatId, ctx.message.message_id).catch(() => {});

      // Auto-store on ingress if user said store/save/use/etc.
      const storeIntent = /\b(store|save|use|set|add|here[''\s]?s)\b/i.test(rawText);
      const stored: string[] = [];
      if (storeIntent) {
        for (const f of redaction.found) {
          const envName = KIND_TO_ENV[f.kind];
          if (!envName || CRITICAL_ENV.has(envName)) continue;
          // Re-extract raw value (very simple — matches the prefix pattern)
          const m = rawText.match(/[A-Za-z_-]{2,}_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+|df_[A-Za-z0-9]+|bu_[A-Za-z0-9_-]+/);
          if (m) {
            try {
              storeSecretToEnv(envName, m[0]);
              stored.push(envName);
            } catch {}
          }
        }
      }
      const lines = [`🔒 redacted (${kinds}). original message deleted.`];
      if (stored.length > 0)
        lines.push(`✅ auto-stored: ${stored.join(', ')}`);
      else
        lines.push(`To save it, send /secret with a name (e.g. /secret OPENAI_API_KEY).`);
      await ctx.reply(lines.join('\n\n'));
      return;
    }

    // Send to agent
    deps.conversations.append(chatId, 'user', text);
    const history = deps.conversations.recent(chatId, 30).slice(0, -1);
    let placeholder = await ctx.reply('…');
    const placeholderId = placeholder.message_id;
    let lastEdit = '';
    let pendingText = '';
    let editTimer: NodeJS.Timeout | null = null;

    const flushEdit = async () => {
      if (pendingText === lastEdit || !pendingText.trim()) return;
      const text = pendingText.slice(0, 4000);
      try {
        await bot.api.editMessageText(chatId, placeholderId, text);
        lastEdit = pendingText;
      } catch {
        // Telegram rate-limits or markdown parse errors — ignore, retry on next flush
      }
    };

    // Drain any queued system events from the router (task completions etc.)
    // and prepend to the user message so the agent sees them in context.
    const sysEvents = deps.systemEvents.drain(chatId);
    const systemNotices =
      sysEvents.length > 0
        ? sysEvents.map((e) => `[${e.type}]\n${e.msg}`).join('\n\n---\n\n')
        : undefined;

    try {
      const result = await deps.agent.run({
        chatId,
        userMessage: text,
        systemNotices,
        history: history.map((t) => ({ role: t.role, content: t.content })),
        onTextChunk: (chunk) => {
          pendingText += chunk;
          if (editTimer) return;
          editTimer = setTimeout(() => {
            editTimer = null;
            flushEdit();
          }, 800);
        },
      });
      if (editTimer) clearTimeout(editTimer);
      pendingText = result.text;
      await flushEdit();
      deps.conversations.append(chatId, 'assistant', result.text);
      if (result.error) console.error(`[agent] error: ${result.error}`);
    } catch (e) {
      try {
        await bot.api.editMessageText(chatId, placeholderId, `❌ ${(e as Error).message.slice(0, 200)}`);
      } catch {}
    }
  });

  // ============ Errors ============
  bot.catch((err) => {
    if (err.error instanceof GrammyError) {
      console.error(`[bot] telegram error: ${err.error.description}`);
    } else if (err.error instanceof HttpError) {
      console.error(`[bot] http error: ${err.error.message}`);
    } else {
      console.error(`[bot] unknown error: ${err.error}`);
    }
  });

  async function printPairingDeeplinkOnBoot(): Promise<void> {
    if (deps.pairing.hasPairedUsers()) {
      console.log(`[pairing] ${deps.pairing.loadAllowed().size} user(s) already paired`);
      return;
    }
    const me = await bot.api.getMe();
    const link = deps.pairing.pairingDeeplink(me.username || 'unknown');
    if (link) {
      console.log('');
      console.log('======================================================================');
      console.log('  damson is unpaired. Tap this link from your phone to pair:');
      console.log('  ' + link);
      console.log('======================================================================');
      console.log('');
    }
  }

  return { bot, printPairingDeeplinkOnBoot };
}
