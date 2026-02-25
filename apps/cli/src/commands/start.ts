/**
 * `opencode-channels start` — Boot the webhook server.
 *
 * Reads .env, validates everything, starts the server, done.
 * Designed to be zero-friction after `init`.
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

// ─── Command ────────────────────────────────────────────────────────────────

export const startCommand = new Command('start')
  .description('Start the webhook server')
  .option('--env-file <path>', 'Path to .env file', '.env')
  .option('--port <port>', 'Override port')
  .option('--opencode-url <url>', 'Override OpenCode URL')
  .option('--no-auto-manifest', 'Skip Slack manifest auto-config')
  .action(async (options) => {
    const envPath = resolve(process.cwd(), options.envFile);
    loadEnvFile(envPath);

    if (options.port) process.env.CHANNELS_PORT = options.port;
    if (options.opencodeUrl) process.env.OPENCODE_URL = options.opencodeUrl;

    const {
      startChannels,
      createChannelConfig,
      listChannelConfigs,
      OpenCodeClient,
    } = await import('@opencode-channels/core');

    const port = Number(process.env.CHANNELS_PORT) || 3456;
    const opencodeUrl = process.env.OPENCODE_URL || 'http://localhost:4096';
    const slackBotToken = process.env.SLACK_BOT_TOKEN;
    const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;

    // ── Quick checks ────────────────────────────────────────────────────

    if (!slackBotToken) {
      console.log('No SLACK_BOT_TOKEN found. Run "opencode-channels init" first.');
      process.exit(1);
    }

    const client = new OpenCodeClient({ baseUrl: opencodeUrl });
    const ready = await client.isReady();
    if (!ready) {
      console.log(`OpenCode not responding at ${opencodeUrl}`);
      console.log('Start it:  opencode serve');
      process.exit(1);
    }

    // ── Build adapters ──────────────────────────────────────────────────

    const configsByTeamId = new Map<string, ReturnType<typeof listChannelConfigs>[number]>();

    const { SlackAdapter, SlackApi } = await import('@opencode-channels/slack');
    const slackAdapter = new SlackAdapter({
      getConfigByTeamId: (teamId: string) => configsByTeamId.get(teamId),
      getClient: () => client,
    });

    // ── Start ───────────────────────────────────────────────────────────

    const channels = await startChannels({
      adapters: { slack: slackAdapter },
      port,
      opencodeUrl,
    });

    // ── Ensure Slack config in DB ───────────────────────────────────────

    const existingConfigs = listChannelConfigs({ channelType: 'slack' }, channels.db);
    let slackConfig: ReturnType<typeof listChannelConfigs>[number];

    if (existingConfigs.length > 0) {
      slackConfig = existingConfigs[0];
    } else {
      slackConfig = await createChannelConfig(
        {
          channelType: 'slack',
          name: 'Slack',
          enabled: true,
          credentials: {
            botToken: slackBotToken,
            signingSecret: slackSigningSecret || '',
          },
          platformConfig: { groups: { requireMention: true } },
          metadata: {},
          sessionStrategy: 'per-user',
          systemPrompt: null,
          agentName: null,
        },
        channels.db,
      );
    }

    // ── Team lookup ─────────────────────────────────────────────────────

    const api = new SlackApi(slackBotToken);
    const authResult = await api.authTest();
    if (authResult.ok && authResult.team_id) {
      configsByTeamId.set(authResult.team_id as string, slackConfig);
    }

    // ── Manifest auto-config ────────────────────────────────────────────

    if (options.autoManifest !== false) {
      const appId = process.env.SLACK_APP_ID;
      const refreshToken = process.env.SLACK_CONFIG_REFRESH_TOKEN;

      if (appId && refreshToken) {
        try {
          const { detectNgrokUrl, setupSlackApp } = await import('@opencode-channels/slack');
          const ngrokUrl = await detectNgrokUrl();

          if (ngrokUrl) {
            const result = await setupSlackApp({ appId, refreshToken, baseUrl: ngrokUrl });
            if (result.newRefreshToken) {
              persistRefreshToken(envPath, result.newRefreshToken);
            }
            if (result.ok) {
              console.log(`Slack URLs auto-configured via ${ngrokUrl}`);
            }
          }
        } catch {
          // Silent — manifest config is optional
        }
      }
    }

    // ── Ready ───────────────────────────────────────────────────────────

    const botName = authResult.ok ? (authResult.user as string || 'bot') : 'bot';
    const teamName = authResult.ok ? (authResult.team as string || '') : '';

    console.log('');
    console.log(`  opencode-channels running`);
    console.log(`  Webhook:  http://localhost:${port}`);
    console.log(`  OpenCode: ${opencodeUrl}`);
    if (teamName) console.log(`  Slack:    @${botName} in ${teamName}`);
    console.log('');
    console.log('  @mention the bot in Slack to chat.');
    console.log('  Press Ctrl+C to stop.');
    console.log('');

    // ── Graceful shutdown ───────────────────────────────────────────────

    const shutdown = () => {
      console.log('\nStopped.');
      channels.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
