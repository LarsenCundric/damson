/**
 * damson CLI — for `damson init`, `damson pair`, etc.
 *
 * For 0.1, init prints the .env.example contents and tells the user what to do.
 * Real interactive setup comes in 0.2.
 */

import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cmd = process.argv[2];

function repoRoot(): string {
  // dist/cli.js → repo root is one level up
  const here = fileURLToPath(import.meta.url);
  return join(here, '..', '..');
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

function help() {
  console.log('damson — proactive personal agent');
  console.log('');
  console.log('Usage:');
  console.log('  damson init      Set up .env');
  console.log('  damson help      Show this');
  console.log('');
  console.log('To run damson: npm start');
}

switch (cmd) {
  case 'init':
    init();
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
