/**
 * `opencode-channels init` — Dead-simple one-command setup.
 *
 * Auto-detects everything it can, asks only what it must.
 *
 * Flow:
 *   1. Auto-detect OpenCode server (try common ports)
 *   2. Ask: which platform? (Slack for now)
 *   3. Ask: paste your bot token + signing secret
 *   4. Validate credentials instantly
 *   5. Auto-detect ngrok tunnel
 *   6. Optional: paste Slack App ID + config token for auto-manifest
 *   7. Write .env — done.
 */

import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

// ─── Helpers ────────────────────────────────────────────────────────────────

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      res(answer.trim());
    });
  });
}

async function askYN(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await ask(`${question} ${hint} `);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

async function probeUrl(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function detectOpenCode(): Promise<string | null> {
  // Try common ports
  const candidates = [
    'http://localhost:4096',  // OpenCode default
    'http://localhost:1707',  // Common custom
    'http://localhost:8000',  // Fallback
    'http://localhost:3000',  // Another common
  ];

  for (const url of candidates) {
    const ok = await probeUrl(`${url}/global/health`);
    if (ok) return url;
  }
  return null;
}

async function detectNgrokUrl(): Promise<string | null> {
  try {
    const res = await fetch('http://127.0.0.1:4040/api/tunnels', {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tunnels: Array<{ public_url: string; proto: string }> };
    const https = data.tunnels.find((t) => t.proto === 'https');
    return https?.public_url || data.tunnels[0]?.public_url || null;
  } catch {
    return null;
  }
}

// ─── .env helpers ───────────────────────────────────────────────────────────

function readEnv(path: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(path)) return map;
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    map.set(t.slice(0, eq), t.slice(eq + 1));
  }
  return map;
}

function writeEnv(path: string, entries: Map<string, string>): void {
  const lines = ['# opencode-channels config', `# Generated: ${new Date().toISOString()}`, ''];
  for (const [k, v] of entries) {
    lines.push(`${k}=${v}`);
  }
  writeFileSync(path, lines.join('\n') + '\n');
}

// ─── Command ────────────────────────────────────────────────────────────────

export const initCommand = new Command('init')
  .description('Set up opencode-channels in 30 seconds')
  .option('--env-file <path>', 'Path to write .env file', '.env')
  .action(async (options) => {
    const envPath = resolve(process.cwd(), options.envFile);
    const existing = readEnv(envPath);
    const env = new Map(existing);

    console.log('');
    console.log('  opencode-channels init');
    console.log('  =====================');
    console.log('');

    // ── Step 1: Find OpenCode ──────────────────────────────────────────

    console.log('  Looking for OpenCode server...');
    let opencodeUrl = existing.get('OPENCODE_URL') || null;

    if (opencodeUrl) {
      const ok = await probeUrl(`${opencodeUrl}/global/health`);
      if (ok) {
        console.log(`  Found OpenCode at ${opencodeUrl}`);
      } else {
        console.log(`  ${opencodeUrl} not responding, scanning...`);
        opencodeUrl = await detectOpenCode();
      }
    } else {
      opencodeUrl = await detectOpenCode();
    }

    if (!opencodeUrl) {
      opencodeUrl = await ask('  OpenCode URL (e.g. http://localhost:4096): ');
      if (!opencodeUrl) {
        console.log('  ERROR: OpenCode server is required. Start it with: opencode serve');
        process.exit(1);
      }
    } else {
      console.log(`  OpenCode: ${opencodeUrl}`);
    }
    env.set('OPENCODE_URL', opencodeUrl);

    // ── Step 2: Slack credentials ──────────────────────────────────────

    console.log('');
    console.log('  Slack Setup');
    console.log('  -----------');
    console.log('  Create a Slack app at: https://api.slack.com/apps');
    console.log('');

    let botToken = existing.get('SLACK_BOT_TOKEN') || '';
    if (!botToken || !botToken.startsWith('xoxb-')) {
      botToken = await ask('  Bot Token (xoxb-...): ');
    } else {
      console.log(`  Bot Token: ${botToken.slice(0, 15)}...`);
    }

    if (!botToken.startsWith('xoxb-')) {
      console.log('  ERROR: Token must start with xoxb-');
      process.exit(1);
    }

    let signingSecret = existing.get('SLACK_SIGNING_SECRET') || '';
    if (!signingSecret) {
      signingSecret = await ask('  Signing Secret: ');
    } else {
      console.log(`  Signing Secret: ${signingSecret.slice(0, 8)}...`);
    }

    if (!signingSecret) {
      console.log('  ERROR: Signing secret is required');
      process.exit(1);
    }

    // Validate
    console.log('');
    console.log('  Validating credentials...');

    try {
      const { SlackAdapter } = await import('@opencode-channels/slack');
      const adapter = new SlackAdapter({
        getConfigByTeamId: () => undefined,
        getClient: () => { throw new Error('unused'); },
      });
      const result = await adapter.validateCredentials({ botToken, signingSecret });
      if (!result.valid) {
        console.log(`  ERROR: ${result.error}`);
        process.exit(1);
      }
      console.log('  Credentials valid!');
    } catch (err) {
      console.log(`  WARNING: Could not validate (${err instanceof Error ? err.message : String(err)})`);
    }

    env.set('SLACK_BOT_TOKEN', botToken);
    env.set('SLACK_SIGNING_SECRET', signingSecret);

    // ── Step 3: Tunnel detection ───────────────────────────────────────

    console.log('');
    console.log('  Checking for tunnel...');
    const ngrokUrl = await detectNgrokUrl();

    if (ngrokUrl) {
      console.log(`  ngrok: ${ngrokUrl}`);

      // ── Step 4: Optional manifest auto-config ────────────────────────

      const wantManifest = await askYN('  Auto-configure Slack app URLs?');
      if (wantManifest) {
        let appId = existing.get('SLACK_APP_ID') || '';
        if (!appId) {
          appId = await ask('  Slack App ID (from app settings): ');
        }

        let refreshToken = existing.get('SLACK_CONFIG_REFRESH_TOKEN') || '';
        if (!refreshToken) {
          console.log('  Get a config token at: https://api.slack.com/authentication/config-tokens');
          refreshToken = await ask('  Config Refresh Token (xoxe-...): ');
        }

        if (appId && refreshToken) {
          env.set('SLACK_APP_ID', appId);

          console.log('  Configuring Slack app...');
          try {
            const { setupSlackApp } = await import('@opencode-channels/slack');
            const result = await setupSlackApp({
              appId,
              refreshToken,
              baseUrl: ngrokUrl,
            });

            if (result.newRefreshToken) {
              env.set('SLACK_CONFIG_REFRESH_TOKEN', result.newRefreshToken);
            }

            if (result.ok) {
              console.log('  Slack app configured! URLs are live.');
            } else {
              console.log(`  WARNING: ${result.error}`);
              console.log('  Set URLs manually in the Slack app dashboard.');
            }
          } catch (err) {
            console.log(`  WARNING: Manifest update failed — set URLs manually`);
          }
        }
      }
    } else {
      console.log('  No tunnel detected.');
      console.log('  Start one before running: ngrok http 3456');
    }

    // ── Step 5: Server config ──────────────────────────────────────────

    const port = existing.get('CHANNELS_PORT') || '3456';
    env.set('CHANNELS_PORT', port);

    // ── Write .env ─────────────────────────────────────────────────────

    writeEnv(envPath, env);

    console.log('');
    console.log('  =====================');
    console.log(`  Config saved to ${envPath}`);
    console.log('');
    console.log('  To start:');
    console.log('');
    console.log('    npx opencode-channels start');
    console.log('');
    console.log('  That\'s it. @mention the bot in Slack and it just works.');
    console.log('');
  });
