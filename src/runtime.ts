/**
 * Runtime entry point. Boots damson.
 */

import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, BrainConfig } from './config.js';
import { Brain } from './brain.js';
import { Pairing } from './pairing.js';
import { ConversationStore } from './conversations.js';
import { EventBus } from './event-bus.js';
import { buildTools } from './tools.js';
import { Agent } from './agent.js';
import { startBot } from './bot.js';

async function main() {
  console.log('[boot] damson 0.1.0 starting...');
  const config = loadConfig();
  console.log(`[boot] brain: ${config.brainDir}`);
  console.log(`[boot] repos: ${config.reposDir}`);

  const brain = new Brain(config.brainDir);
  const brainConfig = new BrainConfig(config.brainDir);
  const pairing = new Pairing(config.brainDir);
  const conversations = new ConversationStore(config.brainDir);
  const bus = new EventBus();

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const tools = buildTools({ brain, brainConfig, reposDir: config.reposDir });

  const agent = new Agent({
    client,
    brain,
    brainConfig,
    tools,
    taskSummary: () => 'No active or recent tasks.', // placeholder until tasks are wired
  });

  const { bot, printPairingDeeplinkOnBoot } = startBot({
    agent,
    pairing,
    conversations,
    config,
  });

  await printPairingDeeplinkOnBoot();
  bus.emit({ type: 'boot', source: 'runtime', payload: {} });

  await bot.start({
    onStart: (info) => {
      console.log(`[boot] connected to telegram as @${info.username}`);
    },
  });
}

main().catch((e) => {
  console.error(`[fatal] ${e.message}`);
  process.exit(1);
});

// Graceful shutdown — leave background tasks running where possible.
process.on('SIGINT', () => {
  console.log('\n[shutdown] SIGINT received');
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('[shutdown] SIGTERM received');
  process.exit(0);
});
