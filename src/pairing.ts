/**
 * Telegram pairing — the bux pattern.
 *
 * On first run, damson generates a setup token and prints a deeplink:
 *   https://t.me/<bot_username>?start=<token>
 *
 * The user taps it from their phone. Telegram sends `/start <token>` to the
 * bot. The first chat_id whose token matches gets bound. Token is then
 * invalidated and the chat_id is written to brain/allowed-users.txt.
 *
 * Subsequent unauthorized chats are silently dropped — no error message,
 * no DM trail.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export class Pairing {
  private file: string;
  private setupToken: string | null;
  private setupTokenBurned = false;

  constructor(brainDir: string) {
    this.file = join(brainDir, 'allowed-users.txt');
    mkdirSync(brainDir, { recursive: true });
    // Generate a setup token only if the allowlist is empty
    if (this.loadAllowed().size === 0) {
      this.setupToken = randomBytes(6).toString('hex');
      console.log(`[pairing] no users paired yet. setup token = ${this.setupToken}`);
    } else {
      this.setupToken = null;
    }
  }

  hasPairedUsers(): boolean {
    return this.loadAllowed().size > 0;
  }

  /**
   * Returns the deeplink the user must tap, or null if pairing is already done.
   */
  pairingDeeplink(botUsername: string): string | null {
    if (!this.setupToken) return null;
    return `https://t.me/${botUsername}?start=${this.setupToken}`;
  }

  loadAllowed(): Set<number> {
    if (!existsSync(this.file)) return new Set();
    return new Set(
      readFileSync(this.file, 'utf-8')
        .split('\n')
        .map((x) => parseInt(x.trim(), 10))
        .filter((id) => !isNaN(id))
    );
  }

  isAllowed(chatId: number): boolean {
    return this.loadAllowed().has(chatId);
  }

  /**
   * Try to bind a chat to damson via /start payload.
   * Returns: 'bound' | 'already_paired' | 'invalid'
   */
  tryBind(chatId: number, tokenFromMessage: string | null | undefined): 'bound' | 'already_paired' | 'invalid' {
    if (this.isAllowed(chatId)) return 'already_paired';
    if (this.setupTokenBurned || !this.setupToken) return 'invalid';
    if (!tokenFromMessage || tokenFromMessage !== this.setupToken) return 'invalid';
    this.addAllowed(chatId);
    this.setupTokenBurned = true;
    this.setupToken = null;
    return 'bound';
  }

  private addAllowed(chatId: number): void {
    const users = this.loadAllowed();
    users.add(chatId);
    writeFileSync(this.file, [...users].join('\n') + '\n');
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // best-effort on platforms where chmod is a no-op
    }
  }
}
