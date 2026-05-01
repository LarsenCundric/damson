/**
 * damson CLI — `damson init`, `damson reset`, etc.
 *
 * Kept deliberately small. Anything more interactive happens via the
 * Telegram bot, not the CLI.
 */

import { readFileSync, existsSync, copyFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const cmd = process.argv[2];

function repoRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return join(here, '..', '..');
}

function brainDir(): string {
  // Same resolution rule as runtime: env var wins, else ./brain.
  return resolve(process.env.BRAIN_DIR || join(repoRoot(), 'brain'));
}

function init() {
  const root = repoRoot();
  const envExample = join(root, '.env.example');
  const envFile = join(root, '.env');
  if (existsSync(envFile)) {
    console.log('.env already exists. Edit it to update config.');
  } else if (existsSync(envExample)) {
    copyFileSync(envExample, envFile);
    console.log(`Created .env from .env.example at ${envFile}`);
    console.log('Open it and fill in ANTHROPIC_API_KEY and BOT_TOKEN.');
  }
  console.log('');
  console.log('Then run:  npm start');
  console.log('On first boot, damson prints a pairing link. Tap it from your phone.');
}

/**
 * Wipe brain state without touching the bootstrap templates or the README.
 *
 * Deletes:
 *   - allowed-users.txt (pairing record)
 *   - .onboarding.json, .tasks.json, .task-history.json, .sessions.json,
 *     .schedules.json
 *   - soul.md, self.md, config.json (bootstrap-copies; will be re-copied
 *     from templates/ on next boot)
 *   - daily/, decisions/, digests/, people/, projects/, transcripts/,
 *     watchers/ (everything except watchers/<name>.yaml the user wrote
 *     themselves — those go too, they're personal)
 *
 * Preserves:
 *   - templates/ (tracked in git, used to bootstrap)
 *   - README.md (tracked in git)
 *   - .gitkeep
 */
async function reset(opts: { yes?: boolean }) {
  const dir = brainDir();
  if (!existsSync(dir)) {
    console.log(`brain/ does not exist at ${dir} — nothing to reset.`);
    return;
  }

  const TO_DELETE_FILES = [
    'allowed-users.txt',
    '.onboarding.json',
    '.tasks.json',
    '.task-history.json',
    '.sessions.json',
    '.schedules.json',
    '.access-log.jsonl',
    'soul.md',
    'self.md',
    'config.json',
  ];
  const TO_DELETE_DIRS = ['daily', 'decisions', 'digests', 'people', 'projects', 'transcripts', 'watchers', '.task-runs'];
  const PRESERVED = ['templates', 'README.md', '.gitkeep'];

  const present: string[] = [];
  for (const f of TO_DELETE_FILES) if (existsSync(join(dir, f))) present.push(f);
  for (const d of TO_DELETE_DIRS) if (existsSync(join(dir, d))) present.push(d + '/');

  if (present.length === 0) {
    console.log(`brain/ at ${dir} is already clean (only templates remain).`);
    return;
  }

  console.log(`About to remove from ${dir}:`);
  for (const p of present) console.log(`  - ${p}`);
  console.log('');
  console.log(`Preserved: ${PRESERVED.join(', ')}`);
  console.log('');

  if (!opts.yes) {
    const ok = await confirm('Proceed? [y/N] ');
    if (!ok) {
      console.log('Aborted.');
      return;
    }
  }

  for (const f of TO_DELETE_FILES) {
    const p = join(dir, f);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  for (const d of TO_DELETE_DIRS) {
    const p = join(dir, d);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  console.log('✓ brain reset complete. Templates preserved.');
  console.log('');
  console.log('Next: npm start  →  tap the new pairing link from your phone.');
}

async function status() {
  const dir = brainDir();
  console.log(`brain dir: ${dir}`);
  if (!existsSync(dir)) {
    console.log('  (does not exist — fresh boot will bootstrap)');
    return;
  }
  const interesting = [
    'soul.md',
    'self.md',
    'config.json',
    '.onboarding.json',
    'allowed-users.txt',
    '.tasks.json',
    '.sessions.json',
    '.schedules.json',
  ];
  for (const f of interesting) {
    const p = join(dir, f);
    if (!existsSync(p)) {
      console.log(`  ${f.padEnd(22)} (missing)`);
    } else {
      const s = statSync(p);
      console.log(`  ${f.padEnd(22)} ${s.size}b   modified ${new Date(s.mtimeMs).toISOString().slice(0, 19)}`);
    }
  }
  // Subdir counts
  for (const d of ['daily', 'decisions', 'digests', 'people', 'projects', 'transcripts', 'watchers']) {
    const p = join(dir, d);
    if (existsSync(p)) {
      const count = readdirSync(p).length;
      console.log(`  ${d.padEnd(22)} ${count} entries`);
    }
  }
}

function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

function help() {
  console.log('damson — proactive personal agent');
  console.log('');
  console.log('Usage:');
  console.log('  damson init           Create .env from .env.example');
  console.log('  damson reset [-y]     Wipe brain state (pairing, onboarding, transcripts).');
  console.log('                        Preserves templates/. Add -y to skip the confirm.');
  console.log('  damson status         Show what state is currently in brain/');
  console.log('  damson help           This');
  console.log('');
  console.log('To run damson: npm start');
}

const yesFlag = process.argv.includes('-y') || process.argv.includes('--yes');

switch (cmd) {
  case 'init':
    init();
    break;
  case 'reset':
    await reset({ yes: yesFlag });
    break;
  case 'status':
    await status();
    break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    help();
    break;
  default:
    console.log(`Unknown command: ${cmd}`);
    help();
    process.exit(1);
}
