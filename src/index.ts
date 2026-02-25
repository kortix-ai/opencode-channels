/**
 * opencode-channels — Entry point.
 *
 * Usage:
 *   npx tsx src/index.ts
 *
 * Environment variables:
 *   OPENCODE_URL          — OpenCode server URL (default: http://localhost:1707)
 *   SLACK_BOT_TOKEN       — Slack bot token (xoxb-...)
 *   SLACK_SIGNING_SECRET  — Slack signing secret
 *   PORT                  — Webhook server port (default: 3456)
 */

import { createBot, type BotConfig } from './bot.js';
import { createServer, type ServerConfig } from './server.js';

export { createBot, type BotConfig } from './bot.js';
export { createServer, type ServerConfig } from './server.js';
export { OpenCodeClient, type OpenCodeClientConfig, type FileOutput } from './opencode.js';
export { SessionManager, type SessionStrategy } from './sessions.js';

/**
 * Start opencode-channels with default configuration.
 * Reads all config from environment variables.
 */
export async function start(
  botConfig?: BotConfig,
  serverConfig?: ServerConfig,
) {
  const { bot, client, sessions } = createBot(botConfig);

  // Verify OpenCode is reachable
  const ready = await client.isReady();
  if (ready) {
    console.log(`[opencode-channels] OpenCode server is ready`);
  } else {
    console.warn(`[opencode-channels] OpenCode server not reachable — will retry on first message`);
  }

  const server = createServer(bot, serverConfig);

  // Periodic session cleanup
  const cleanupInterval = setInterval(() => {
    sessions.cleanup();
  }, 5 * 60 * 1000);
  cleanupInterval.unref?.();

  return { bot, client, server };
}

// ── CLI entry point ─────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  start().catch((err) => {
    console.error('[opencode-channels] Fatal:', err);
    process.exit(1);
  });
}
