/**
 * Telegram bot wiring. grammY based.
 */

import { Bot, GrammyError, HttpError } from 'grammy';
import type { Context } from 'grammy';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from './agent.js';
import type { Pairing } from './pairing.js';
import type { ConversationStore } from './conversations.js';
import type { DamsonConfig } from './types.js';
import type { SystemEventQueue } from './system-events.js';
import { redactSecrets, KIND_TO_ENV } from './secrets.js';

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
      await ctx.reply(
        `✓ linked. chat id ${chatId} is now this damson's owner.\n\nsend me a message to start.`
      );
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

  // ============ Built-in commands ============
  bot.command('version', (ctx) => ctx.reply(`damson 0.1.0`));
  bot.command('clear', (ctx) => {
    deps.conversations.clear(ctx.chat.id);
    ctx.reply('🧹 conversation cleared.');
  });

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
