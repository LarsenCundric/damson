/**
 * tg-safe-send — guarded wrappers around Telegram bot.api.sendMessage and
 * editMessageText. Adds:
 *   - Markdown fallback: if Telegram rejects (parse error), retry plain
 *   - Chunking: messages over 4096 chars get split on paragraph/sentence
 *     boundaries
 *   - 429 retry-after handling
 *   - Generic transient-error retry (up to 2x)
 *
 * Without this, agent outputs that include unbalanced asterisks or are too
 * long silently fail to send. Boris hit this in production.
 */

import type { Bot, GrammyError } from 'grammy';

const TG_MAX_LEN = 4096;
const SAFE_LEN = 4000; // leave a little headroom

/**
 * Loosely-typed options. We cast to grammY's stricter type at the API call.
 * This lets callers pass `InlineKeyboard` instances or raw `{inline_keyboard:[[...]]}`
 * without TS complaining at every call site.
 */
export interface SendOpts {
  parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  reply_markup?: unknown;
  reply_to_message_id?: number;
  disable_web_page_preview?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyOpts = any;

function isMarkdownParseError(e: unknown): boolean {
  const err = e as GrammyError | Error;
  const desc = (err as GrammyError).description || (err as Error).message || '';
  return /can't parse entities|parse_mode/i.test(desc);
}

function isRateLimit(e: unknown): { retryAfterSec: number } | null {
  const err = e as GrammyError;
  const desc = err.description || '';
  if (err.error_code === 429 || /Too Many Requests/i.test(desc)) {
    const m = /retry after (\d+)/i.exec(desc);
    return { retryAfterSec: m ? parseInt(m[1], 10) : 5 };
  }
  return null;
}

function chunkText(text: string): string[] {
  if (text.length <= SAFE_LEN) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > SAFE_LEN) {
    // Prefer split on paragraph boundary; fall back to sentence; fall back to hard cut.
    let cutAt = remaining.lastIndexOf('\n\n', SAFE_LEN);
    if (cutAt < SAFE_LEN / 2) cutAt = remaining.lastIndexOf('\n', SAFE_LEN);
    if (cutAt < SAFE_LEN / 2) cutAt = remaining.lastIndexOf('. ', SAFE_LEN);
    if (cutAt < SAFE_LEN / 2) cutAt = SAFE_LEN;
    chunks.push(remaining.slice(0, cutAt).trimEnd());
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Send a single message safely. Returns the message_id of the *first* chunk
 * sent (or undefined if all attempts failed). Subsequent chunks are sent as
 * separate messages.
 */
export async function safeSendMessage(
  bot: Bot,
  chatId: number,
  text: string,
  opts: SendOpts = {}
): Promise<number | undefined> {
  const chunks = chunkText(text);
  let firstId: number | undefined;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const id = await sendOnce(bot, chatId, chunk, opts);
    if (i === 0) firstId = id;
  }
  return firstId;
}

async function sendOnce(bot: Bot, chatId: number, text: string, opts: SendOpts): Promise<number | undefined> {
  // Pass 1: with caller-requested options (incl. parse_mode if any)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const m = await bot.api.sendMessage(chatId, text, opts as AnyOpts);
      return m.message_id;
    } catch (e) {
      const rl = isRateLimit(e);
      if (rl) {
        await sleep(Math.min(rl.retryAfterSec, 30) * 1000);
        continue;
      }
      if (isMarkdownParseError(e) && opts.parse_mode) {
        // Strip parse_mode, retry as plain text
        try {
          const m = await bot.api.sendMessage(chatId, text, { ...opts, parse_mode: undefined } as AnyOpts);
          return m.message_id;
        } catch (e2) {
          const rl2 = isRateLimit(e2);
          if (rl2) {
            await sleep(Math.min(rl2.retryAfterSec, 30) * 1000);
            continue;
          }
          console.error(`[tg-safe-send] plain fallback failed: ${(e2 as Error).message}`);
          return undefined;
        }
      }
      // Other error — retry once with backoff, then give up
      if (attempt < 2) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      console.error(`[tg-safe-send] sendMessage failed (chat ${chatId}): ${(e as Error).message}`);
      return undefined;
    }
  }
  return undefined;
}

/**
 * Edit a message safely. Same fallback rules as send. Returns true on success.
 */
export async function safeEditMessage(
  bot: Bot,
  chatId: number,
  messageId: number,
  text: string,
  opts: SendOpts = {}
): Promise<boolean> {
  const truncated = text.length > SAFE_LEN ? text.slice(0, SAFE_LEN) + '\n…(truncated)' : text;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await bot.api.editMessageText(chatId, messageId, truncated, opts as AnyOpts);
      return true;
    } catch (e) {
      const rl = isRateLimit(e);
      if (rl) {
        await sleep(Math.min(rl.retryAfterSec, 30) * 1000);
        continue;
      }
      if (isMarkdownParseError(e) && opts.parse_mode) {
        try {
          await bot.api.editMessageText(chatId, messageId, truncated, { ...opts, parse_mode: undefined } as AnyOpts);
          return true;
        } catch {
          return false;
        }
      }
      // "message is not modified" is a benign error — treat as success
      const desc = (e as GrammyError).description || '';
      if (/message is not modified/i.test(desc)) return true;
      if (attempt < 2) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      console.error(`[tg-safe-send] editMessageText failed (chat ${chatId}, msg ${messageId}): ${(e as Error).message}`);
      return false;
    }
  }
  return false;
}

// Re-export the helpers used in tests
export const _internal = { chunkText, isMarkdownParseError, isRateLimit };
