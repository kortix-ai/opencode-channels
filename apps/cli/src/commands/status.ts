/**
 * `opencode-channels status` — Show the current state of the system.
 *
 * Checks:
 *   - Whether OpenCode is reachable
 *   - Configured adapters (from .env)
 *   - Database stats (configs, sessions, messages)
 *   - Webhook server health (if running)
 *   - ngrok tunnel status
 */

import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── .env loader ────────────────────────────────────────────────────────────

function loadEnvFile(path: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(path)) return map;
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    map.set(trimmed.slice(0, eqIdx), trimmed.slice(eqIdx + 1));
  }
  return map;
}

// ─── Status checks ──────────────────────────────────────────────────────────

async function checkOpenCode(url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { OpenCodeClient } = await import('@opencode-channels/core');
    const client = new OpenCodeClient({ baseUrl: url });
    const ready = await client.isReady();
    return { ok: ready };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function checkNgrok(): Promise<string | null> {
  try {
    const { detectNgrokUrl } = await import('@opencode-channels/slack');
    return await detectNgrokUrl();
  } catch {
    return null;
  }
}

async function checkHealth(port: number): Promise<{ ok: boolean; data?: Record<string, unknown> }> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as Record<string, unknown>;
    return { ok: true, data };
  } catch {
    return { ok: false };
  }
}

async function getDbStats(dbPath: string): Promise<{
  configs: number;
  sessions: number;
  messages: number;
} | null> {
  try {
    if (!existsSync(dbPath)) return null;
    const { createDatabase } = await import('@opencode-channels/core');
    const { channelConfigs, channelSessions, channelMessages } = await import(
      '@opencode-channels/core'
    );
    const db = createDatabase(dbPath);
    const configs = db.select().from(channelConfigs).all().length;
    const sessions = db.select().from(channelSessions).all().length;
    const messages = db.select().from(channelMessages).all().length;
    return { configs, sessions, messages };
  } catch {
    return null;
  }
}

// ─── Command definition ─────────────────────────────────────────────────────

export const statusCommand = new Command('status')
  .description('Show the current status of the opencode-channels system')
  .option('--env-file <path>', 'Path to .env file', '.env')
  .action(async (options) => {
    const envPath = resolve(process.cwd(), options.envFile);
    const env = loadEnvFile(envPath);

    const port = Number(env.get('CHANNELS_PORT') || process.env.CHANNELS_PORT) || 3456;
    const opencodeUrl =
      env.get('OPENCODE_URL') || process.env.OPENCODE_URL || 'http://localhost:8000';
    const dbPath =
      env.get('CHANNELS_DB_PATH') || process.env.CHANNELS_DB_PATH || './channels.db';

    console.log('');
    console.log('opencode-channels status');
    console.log('========================');
    console.log('');

    // 1. Environment file
    if (existsSync(envPath)) {
      console.log(`  .env file:     ${envPath}`);
    } else {
      console.log(`  .env file:     ${envPath} (NOT FOUND)`);
    }

    // 2. Adapters configured
    console.log('');
    console.log('  Adapters:');
    const hasSlack = env.has('SLACK_BOT_TOKEN');
    const hasTelegram = env.has('TELEGRAM_BOT_TOKEN');
    const hasDiscord = env.has('DISCORD_BOT_TOKEN');

    console.log(
      `    Slack:       ${hasSlack ? 'configured' : 'not configured'}`,
    );
    console.log(
      `    Telegram:    ${hasTelegram ? 'configured' : 'not configured'}`,
    );
    console.log(
      `    Discord:     ${hasDiscord ? 'configured' : 'not configured'}`,
    );

    if (hasSlack && env.has('SLACK_APP_ID') && env.has('SLACK_CONFIG_REFRESH_TOKEN')) {
      console.log('    Slack Manifest API: enabled');
    }

    // 3. OpenCode server
    console.log('');
    const ocStatus = await checkOpenCode(opencodeUrl);
    console.log(
      `  OpenCode:      ${ocStatus.ok ? 'reachable' : 'NOT REACHABLE'} (${opencodeUrl})`,
    );

    // 4. Webhook server
    const healthResult = await checkHealth(port);
    console.log(
      `  Webhook:       ${healthResult.ok ? 'running' : 'not running'} (port ${port})`,
    );

    if (healthResult.ok && healthResult.data) {
      const adapters = healthResult.data.adapters as string[] | undefined;
      if (adapters?.length) {
        console.log(`    Adapters:    ${adapters.join(', ')}`);
      }
    }

    // 5. ngrok tunnel
    const ngrokUrl = await checkNgrok();
    console.log(`  ngrok:         ${ngrokUrl || 'not detected'}`);

    // 6. Database
    console.log('');
    const dbStats = await getDbStats(resolve(process.cwd(), dbPath));
    if (dbStats) {
      console.log(`  Database:      ${dbPath}`);
      console.log(`    Configs:     ${dbStats.configs}`);
      console.log(`    Sessions:    ${dbStats.sessions}`);
      console.log(`    Messages:    ${dbStats.messages}`);
    } else {
      console.log(`  Database:      ${dbPath} (not found or empty)`);
    }

    console.log('');
  });
