/**
 * E2E Slack test — boots the full opencode-channels system, auto-detects
 * the ngrok tunnel, and auto-configures the Slack app manifest.
 *
 * Zero manual URL configuration needed.
 *
 * Prerequisites:
 *   1. OpenCode server running (default: http://localhost:1707)
 *   2. ngrok tunnel running: ngrok http 3456
 *   3. .env.test with SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET,
 *      SLACK_APP_ID, and SLACK_CONFIG_REFRESH_TOKEN
 *
 * Usage:
 *   npx tsx scripts/e2e-slack.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startChannels,
  createChannelConfig,
  listChannelConfigs,
  type ChannelsPluginResult,
} from '../packages/core/src/plugin.js';
import { OpenCodeClient } from '../packages/core/src/opencode-client.js';
import { SlackAdapter } from '../packages/slack/src/adapter.js';
import { setupSlackApp, detectNgrokUrl } from '../packages/slack/src/setup.js';
import type { ChannelConfig } from '../packages/core/src/types.js';

// ── Load .env.test ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const envTestPath = resolve(__dirname, '../.env.test');

const envPaths = [
  envTestPath,
  resolve(__dirname, '../../../.opencode/packages/opencode-chat-sdk/.env.test'),
];

let loadedEnvPath: string | undefined;
for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      const value = trimmed.slice(eqIdx + 1);
      if (!process.env[key]) process.env[key] = value;
    }
    loadedEnvPath = envPath;
    console.log(`[env] Loaded ${envPath}`);
    break;
  }
}

// ── Config ──────────────────────────────────────────────────────────────────

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET!;
const SLACK_APP_ID = process.env.SLACK_APP_ID;
const SLACK_CONFIG_REFRESH_TOKEN = process.env.SLACK_CONFIG_REFRESH_TOKEN;
const OPENCODE_URL = process.env.OPENCODE_URL || 'http://localhost:1707';
const PORT = Number(process.env.CHANNELS_PORT) || 3456;
const DB_PATH = process.env.CHANNELS_DB_PATH || '/tmp/e2e-channels-test.db';

if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET) {
  console.error('Missing SLACK_BOT_TOKEN and/or SLACK_SIGNING_SECRET');
  console.error('Create a .env.test file with these values');
  process.exit(1);
}

// Set env vars that the engine reads
process.env.OPENCODE_URL = OPENCODE_URL;
process.env.CHANNELS_PORT = String(PORT);
process.env.CHANNELS_DB_PATH = DB_PATH;

console.log('[config] SLACK_BOT_TOKEN:', SLACK_BOT_TOKEN.slice(0, 15) + '...');
console.log('[config] SLACK_SIGNING_SECRET:', SLACK_SIGNING_SECRET.slice(0, 8) + '...');
console.log('[config] SLACK_APP_ID:', SLACK_APP_ID || '(not set — manifest auto-update disabled)');
console.log('[config] SLACK_CONFIG_REFRESH_TOKEN:', SLACK_CONFIG_REFRESH_TOKEN ? SLACK_CONFIG_REFRESH_TOKEN.slice(0, 12) + '...' : '(not set)');
console.log('[config] OPENCODE_URL:', OPENCODE_URL);
console.log('[config] PORT:', PORT);
console.log('[config] DB_PATH:', DB_PATH);

// ── Helper: persist rotated refresh token ───────────────────────────────────

function persistRefreshToken(newToken: string): void {
  // Update .env.test file with the new refresh token
  const targetPath = loadedEnvPath ?? envTestPath;

  if (!existsSync(targetPath)) {
    console.warn(`[env] Cannot persist refresh token — ${targetPath} not found`);
    return;
  }

  let content = readFileSync(targetPath, 'utf-8');

  if (content.includes('SLACK_CONFIG_REFRESH_TOKEN=')) {
    content = content.replace(
      /SLACK_CONFIG_REFRESH_TOKEN=.*/,
      `SLACK_CONFIG_REFRESH_TOKEN=${newToken}`,
    );
  } else {
    content += `\nSLACK_CONFIG_REFRESH_TOKEN=${newToken}\n`;
  }

  writeFileSync(targetPath, content);
  console.log(`[env] Persisted new refresh token to ${targetPath}`);
}

// ── Boot ────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Detect ngrok URL
  console.log('[boot] Detecting ngrok tunnel...');
  const ngrokUrl = await detectNgrokUrl();
  if (!ngrokUrl) {
    console.error('[ERROR] ngrok is not running. Start it with: ngrok http 3456');
    process.exit(1);
  }
  console.log(`[boot] ngrok URL: ${ngrokUrl}`);

  // Save ngrok URL to file for convenience
  writeFileSync(resolve(__dirname, '../ngrok-url.txt'), ngrokUrl + '\n');

  // 2. Auto-configure Slack app manifest (if tokens available)
  if (SLACK_APP_ID && SLACK_CONFIG_REFRESH_TOKEN) {
    console.log('[boot] Auto-configuring Slack app manifest...');
    const setupResult = await setupSlackApp({
      appId: SLACK_APP_ID,
      refreshToken: SLACK_CONFIG_REFRESH_TOKEN,
      baseUrl: ngrokUrl,
    });

    // CRITICAL: always persist the new refresh token — the old one is
    // invalidated the moment rotation succeeds, even if later steps fail.
    if (setupResult.newRefreshToken) {
      persistRefreshToken(setupResult.newRefreshToken);
    }

    if (!setupResult.ok) {
      console.error(`[ERROR] Slack manifest update failed: ${setupResult.error}`);
      console.error('        Falling back to manual URL configuration.');
      console.error(`        Set your Slack app URLs to: ${ngrokUrl}/slack/...`);
    } else {
      console.log('[boot] Slack app manifest updated — URLs are live!');
    }
  } else {
    console.log('[boot] Manifest auto-update skipped (no SLACK_APP_ID or SLACK_CONFIG_REFRESH_TOKEN)');
    console.log(`       To enable, add these to your .env.test:`);
    console.log(`         SLACK_APP_ID=A0AGVEKGHFG`);
    console.log(`         SLACK_CONFIG_REFRESH_TOKEN=xoxe-...`);
    console.log(`       Get the config token at: https://api.slack.com/authentication/config-tokens`);
  }

  // 3. Check OpenCode server is reachable
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  const ready = await client.isReady();
  if (!ready) {
    console.error(`[ERROR] OpenCode server at ${OPENCODE_URL} is not responding.`);
    console.error('       Start it with: opencode serve --port 1707 --print-logs');
    process.exit(1);
  }
  console.log('[boot] OpenCode server is ready');

  // 4. Config store: in-memory map backed by SQLite
  const configsByTeamId = new Map<string, ChannelConfig>();

  // 5. Create SlackAdapter
  const slackAdapter = new SlackAdapter({
    getConfigByTeamId: (teamId: string) => configsByTeamId.get(teamId),
    getClient: (_config: ChannelConfig) => client,
  });

  // 6. Start the channels system
  let channels: ChannelsPluginResult;
  try {
    channels = await startChannels({
      adapters: { slack: slackAdapter },
      port: PORT,
      dbPath: DB_PATH,
      opencodeUrl: OPENCODE_URL,
    });
  } catch (err) {
    console.error('[ERROR] Failed to start channels:', err);
    process.exit(1);
  }

  console.log('[boot] Channels system started');

  // 7. Ensure a Slack config exists in the DB
  const existingConfigs = listChannelConfigs({ channelType: 'slack' }, channels.db);
  let slackConfig: ChannelConfig;

  if (existingConfigs.length > 0) {
    slackConfig = existingConfigs[0];
    console.log(`[boot] Using existing Slack config: ${slackConfig.id}`);
  } else {
    // Validate credentials first
    const validation = await slackAdapter.validateCredentials({
      botToken: SLACK_BOT_TOKEN,
      signingSecret: SLACK_SIGNING_SECRET,
    });

    if (!validation.valid) {
      console.error(`[ERROR] Slack credentials invalid: ${validation.error}`);
      channels.stop();
      process.exit(1);
    }

    console.log('[boot] Slack credentials validated');

    slackConfig = await createChannelConfig(
      {
        channelType: 'slack',
        name: 'E2E Test Slack',
        enabled: true,
        credentials: {
          botToken: SLACK_BOT_TOKEN,
          signingSecret: SLACK_SIGNING_SECRET,
        },
        platformConfig: {
          groups: { requireMention: true },
        },
        metadata: {},
        sessionStrategy: 'per-user',
        systemPrompt: null,
        agentName: null,
      },
      channels.db,
    );
    console.log(`[boot] Created Slack config: ${slackConfig.id}`);
  }

  // 8. Build the team_id → config lookup
  const { SlackApi } = await import('../packages/slack/src/api.js');
  const api = new SlackApi(SLACK_BOT_TOKEN);
  const authResult = await api.authTest();

  if (!authResult.ok) {
    console.error('[ERROR] Slack auth.test failed:', authResult.error);
    channels.stop();
    process.exit(1);
  }

  const teamId = authResult.team_id as string;
  const botUserId = authResult.user_id as string;
  configsByTeamId.set(teamId, slackConfig);

  console.log(`[boot] Slack team_id: ${teamId}`);
  console.log(`[boot] Slack bot user: ${botUserId}`);

  // ── Ready ────────────────────────────────────────────────────────────────

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  opencode-channels E2E test is RUNNING');
  console.log('');
  console.log(`  Webhook:   http://localhost:${PORT}`);
  console.log(`  ngrok:     ${ngrokUrl}`);
  console.log(`  OpenCode:  ${OPENCODE_URL}`);
  console.log(`  Health:    ${ngrokUrl}/health`);
  console.log('');
  if (SLACK_APP_ID && SLACK_CONFIG_REFRESH_TOKEN) {
    console.log('  Slack app URLs auto-configured via Manifest API');
  } else {
    console.log('  Set your Slack app URLs to:');
    console.log(`    Events:        ${ngrokUrl}/slack/events`);
    console.log(`    Commands:      ${ngrokUrl}/slack/commands`);
    console.log(`    Interactivity: ${ngrokUrl}/slack/interactivity`);
  }
  console.log('');
  console.log('  @mention the bot in Slack to test!');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  // ── Graceful shutdown ────────────────────────────────────────────────────

  const shutdown = () => {
    console.log('\n[shutdown] Stopping...');
    channels.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
