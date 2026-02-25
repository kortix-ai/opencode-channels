/**
 * `opencode-channels start` — Boot the webhook server with configured adapters.
 *
 * Reads .env for credentials, spins up the core engine + webhook server,
 * registers all configured platform adapters, and optionally auto-configures
 * Slack via the Manifest API.
 */

import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── .env loader ────────────────────────────────────────────────────────────

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = value;
  }
}

function persistRefreshToken(envPath: string, newToken: string): void {
  if (!existsSync(envPath)) return;
  let content = readFileSync(envPath, 'utf-8');
  if (content.includes('SLACK_CONFIG_REFRESH_TOKEN=')) {
    content = content.replace(
      /SLACK_CONFIG_REFRESH_TOKEN=.*/,
      `SLACK_CONFIG_REFRESH_TOKEN=${newToken}`,
    );
  } else {
    content += `\nSLACK_CONFIG_REFRESH_TOKEN=${newToken}\n`;
  }
  writeFileSync(envPath, content);
}

// ─── Command definition ─────────────────────────────────────────────────────

export const startCommand = new Command('start')
  .description('Start the webhook server with all configured adapters')
  .option('--env-file <path>', 'Path to .env file', '.env')
  .option('--port <port>', 'Override webhook server port')
  .option('--host <host>', 'Override webhook server host')
  .option('--db <path>', 'Override SQLite database path')
  .option('--opencode-url <url>', 'Override OpenCode server URL')
  .option('--no-auto-manifest', 'Skip Slack manifest auto-configuration on start')
  .action(async (options) => {
    const envPath = resolve(process.cwd(), options.envFile);
    loadEnvFile(envPath);

    // Apply option overrides to env
    if (options.port) process.env.CHANNELS_PORT = options.port;
    if (options.host) process.env.CHANNELS_HOST = options.host;
    if (options.db) process.env.CHANNELS_DB_PATH = options.db;
    if (options.opencodeUrl) process.env.OPENCODE_URL = options.opencodeUrl;

    const {
      startChannels,
      createChannelConfig,
      listChannelConfigs,
      OpenCodeClient,
    } = await import('@opencode-channels/core');

    const port = Number(process.env.CHANNELS_PORT) || 3456;
    const opencodeUrl = process.env.OPENCODE_URL || 'http://localhost:8000';

    // ── Verify OpenCode is reachable ────────────────────────────────────
    const client = new OpenCodeClient({ baseUrl: opencodeUrl });
    const ready = await client.isReady();
    if (!ready) {
      console.error(`OpenCode server at ${opencodeUrl} is not responding.`);
      console.error('Start it with: opencode serve');
      process.exit(1);
    }
    console.log(`OpenCode server ready at ${opencodeUrl}`);

    // ── Build adapters ──────────────────────────────────────────────────
    const adapters: Record<string, unknown> = {};
    const configsByTeamId = new Map<string, unknown>();

    // Slack
    const slackBotToken = process.env.SLACK_BOT_TOKEN;
    const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;

    if (slackBotToken && slackSigningSecret) {
      const { SlackAdapter } = await import('@opencode-channels/slack');
      const { SlackApi } = await import('@opencode-channels/slack');

      const slackAdapter = new SlackAdapter({
        getConfigByTeamId: (teamId: string) =>
          configsByTeamId.get(teamId) as ReturnType<typeof listChannelConfigs>[number] | undefined,
        getClient: () => client,
      });

      adapters.slack = slackAdapter;
      console.log('Slack adapter configured');
    }

    if (Object.keys(adapters).length === 0) {
      console.error('No adapters configured. Run "opencode-channels setup slack" first.');
      process.exit(1);
    }

    // ── Start the channels system ───────────────────────────────────────
    const channels = await startChannels({
      adapters: adapters as Record<string, any>,
      port,
      opencodeUrl,
    });

    console.log(`Webhook server listening on port ${port}`);

    // ── Ensure Slack config in DB ───────────────────────────────────────
    if (slackBotToken && slackSigningSecret) {
      const existingConfigs = listChannelConfigs({ channelType: 'slack' }, channels.db);
      let slackConfig: ReturnType<typeof listChannelConfigs>[number];

      if (existingConfigs.length > 0) {
        slackConfig = existingConfigs[0];
        console.log(`Using existing Slack config: ${slackConfig.id}`);
      } else {
        slackConfig = await createChannelConfig(
          {
            channelType: 'slack',
            name: 'Slack',
            enabled: true,
            credentials: {
              botToken: slackBotToken,
              signingSecret: slackSigningSecret,
            },
            platformConfig: { groups: { requireMention: true } },
            metadata: {},
            sessionStrategy: 'per-user',
            systemPrompt: null,
            agentName: null,
          },
          channels.db,
        );
        console.log(`Created Slack config: ${slackConfig.id}`);
      }

      // Build team_id lookup
      const { SlackApi } = await import('@opencode-channels/slack');
      const api = new SlackApi(slackBotToken);
      const authResult = await api.authTest();

      if (authResult.ok && authResult.team_id) {
        configsByTeamId.set(authResult.team_id as string, slackConfig);
        console.log(`Slack team: ${authResult.team_id} (bot: ${authResult.user_id})`);
      } else {
        console.error('Slack auth.test failed — bot may not respond to events');
      }

      // ── Manifest auto-config ──────────────────────────────────────────
      if (options.autoManifest !== false) {
        const appId = process.env.SLACK_APP_ID;
        const refreshToken = process.env.SLACK_CONFIG_REFRESH_TOKEN;

        if (appId && refreshToken) {
          const { detectNgrokUrl, setupSlackApp } = await import('@opencode-channels/slack');
          const ngrokUrl = await detectNgrokUrl();

          if (ngrokUrl) {
            console.log(`ngrok detected: ${ngrokUrl}`);
            console.log('Auto-configuring Slack app manifest...');

            const result = await setupSlackApp({
              appId,
              refreshToken,
              baseUrl: ngrokUrl,
            });

            if (result.newRefreshToken) {
              persistRefreshToken(envPath, result.newRefreshToken);
            }

            if (result.ok) {
              console.log('Slack manifest updated — URLs are live!');
            } else {
              console.error(`Manifest update failed: ${result.error}`);
              console.log(`Set URLs manually to: ${ngrokUrl}/slack/...`);
            }
          } else {
            console.log('ngrok not detected — skipping manifest auto-config');
            console.log('Start ngrok with: ngrok http ' + port);
          }
        }
      }
    }

    // ── Ready ───────────────────────────────────────────────────────────
    console.log('');
    console.log('opencode-channels is running');
    console.log(`  Health: http://localhost:${port}/health`);
    console.log('');
    console.log('Press Ctrl+C to stop.');

    // ── Graceful shutdown ───────────────────────────────────────────────
    const shutdown = () => {
      console.log('\nStopping...');
      channels.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
