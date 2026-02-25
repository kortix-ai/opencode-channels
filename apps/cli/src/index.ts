#!/usr/bin/env node

/**
 * opencode-channels CLI
 *
 * Dead-simple setup for connecting OpenCode to Slack/Discord/Telegram.
 *
 * Usage:
 *   npx opencode-channels init      # one-time setup (~30 seconds)
 *   npx opencode-channels start     # run the webhook server
 *   npx opencode-channels status    # check what's running
 */

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { setupCommand } from './commands/setup.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';

const program = new Command();

program
  .name('opencode-channels')
  .description('Connect OpenCode to Slack, Discord, and Telegram')
  .version('0.1.0');

program.addCommand(initCommand);     // Simple one-step setup
program.addCommand(setupCommand);    // Advanced per-platform setup
program.addCommand(startCommand);    // Boot the server
program.addCommand(statusCommand);   // Check status

program.parse();
