#!/usr/bin/env node

/**
 * opencode-channels CLI
 *
 * Commands:
 *   setup slack   — Interactive Slack setup (validates creds, auto-configures manifest)
 *   start         — Boot the webhook server with all configured adapters
 *   status        — Show running status, adapters, recent sessions
 */

import { Command } from 'commander';
import { setupCommand } from './commands/setup.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';

const program = new Command();

program
  .name('opencode-channels')
  .description('Multi-platform chatbot adapters for OpenCode')
  .version('0.1.0');

program.addCommand(setupCommand);
program.addCommand(startCommand);
program.addCommand(statusCommand);

program.parse();
