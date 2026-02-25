/**
 * Interactive Setup Wizard for opencode-channels.
 *
 * Guides you through the full setup process:
 *
 *   Step 1: Check prerequisites (Node.js, pnpm)
 *   Step 2: Check / prompt for environment variables
 *   Step 3: Verify OpenCode server connectivity
 *   Step 4: Detect or start ngrok tunnel (or accept manual URL)
 *   Step 5: Auto-configure Slack app manifest
 *   Step 6: Boot the Chat SDK bot
 *   Step 7: Run a quick smoke test
 *   Step 8: Show status dashboard and wait for Ctrl+C
 *
 * Usage:
 *   npx tsx scripts/e2e-slack.ts
 *   npx tsx scripts/e2e-slack.ts --url https://your-tunnel.ngrok.app
 *   npx tsx scripts/e2e-slack.ts --skip-ngrok
 *   npx tsx scripts/e2e-slack.ts --port 4000
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHmac } from 'node:crypto';

import { start } from '../src/index.js';
import { OpenCodeClient } from '../src/opencode.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '../.env.test');
const ENV_EXAMPLE_PATH = resolve(__dirname, '../.env.example');

const REQUIRED_ENV = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'] as const;
const OPTIONAL_ENV = ['SLACK_APP_ID', 'SLACK_CONFIG_REFRESH_TOKEN', 'OPENCODE_URL', 'PORT'] as const;

// ─── CLI args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const CLI_URL = getArg('url');
const CLI_PORT = getArg('port');
const SKIP_NGROK = hasFlag('skip-ngrok');
const SKIP_MANIFEST = hasFlag('skip-manifest');
const HELP = hasFlag('help') || hasFlag('h');

// ─── Formatting helpers ─────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
};

const ok = (msg: string) => console.log(`  ${c.green}[ok]${c.reset} ${msg}`);
const warn = (msg: string) => console.log(`  ${c.yellow}[!!]${c.reset} ${msg}`);
const fail = (msg: string) => console.log(`  ${c.red}[FAIL]${c.reset} ${msg}`);
const info = (msg: string) => console.log(`  ${c.dim}[..]${c.reset} ${msg}`);
const step = (n: number, title: string) => {
  console.log('');
  console.log(`${c.cyan}${c.bold}  Step ${n}: ${title}${c.reset}`);
  console.log(`  ${'─'.repeat(50)}`);
};

function banner() {
  console.log('');
  console.log(`${c.bold}${c.cyan}  ╔══════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.cyan}  ║     opencode-channels  Setup Wizard         ║${c.reset}`);
  console.log(`${c.bold}${c.cyan}  ╚══════════════════════════════════════════════╝${c.reset}`);
  console.log('');
}

// ─── Interactive prompt ─────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` ${c.dim}(${defaultValue})${c.reset}` : '';
  return new Promise((resolve) => {
    rl.question(`  ${c.magenta}?${c.reset} ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  return new Promise((resolve) => {
    rl.question(`  ${c.magenta}?${c.reset} ${question} ${c.dim}(${hint})${c.reset}: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === '') resolve(defaultYes);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

// ─── Env file helpers ───────────────────────────────────────────────────────

function loadEnvFile(): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(ENV_PATH)) return env;
  const content = readFileSync(ENV_PATH, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return env;
}

function setEnvVar(key: string, value: string): void {
  process.env[key] = value;

  if (!existsSync(ENV_PATH)) {
    // Create from example if available
    if (existsSync(ENV_EXAMPLE_PATH)) {
      const example = readFileSync(ENV_EXAMPLE_PATH, 'utf-8');
      writeFileSync(ENV_PATH, example);
    } else {
      writeFileSync(ENV_PATH, `# opencode-channels env\n`);
    }
  }

  let content = readFileSync(ENV_PATH, 'utf-8');
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
    writeFileSync(ENV_PATH, content);
  } else {
    appendFileSync(ENV_PATH, `\n${key}=${value}\n`);
  }
}

// ─── Step 1: Prerequisites ──────────────────────────────────────────────────

function checkPrerequisites(): boolean {
  let allGood = true;

  // Node.js
  try {
    const nodeVersion = execSync('node --version', { encoding: 'utf-8' }).trim();
    const major = parseInt(nodeVersion.replace('v', ''));
    if (major >= 18) {
      ok(`Node.js ${nodeVersion}`);
    } else {
      fail(`Node.js ${nodeVersion} — need v18+`);
      allGood = false;
    }
  } catch {
    fail('Node.js not found — install from https://nodejs.org');
    allGood = false;
  }

  // TypeScript runner
  try {
    execSync('npx tsx --version', { encoding: 'utf-8', stdio: 'pipe' });
    ok('tsx available');
  } catch {
    warn('tsx not found (will install on first run)');
  }

  return allGood;
}

// ─── Step 2: Environment variables ──────────────────────────────────────────

async function checkEnvVars(): Promise<void> {
  // Load existing
  const fileEnv = loadEnvFile();
  for (const [key, value] of Object.entries(fileEnv)) {
    if (!process.env[key]) process.env[key] = value;
  }

  if (Object.keys(fileEnv).length > 0) {
    ok(`Loaded .env.test (${Object.keys(fileEnv).length} vars)`);
  } else {
    warn('No .env.test found — will create one');
  }

  // Check required vars
  for (const key of REQUIRED_ENV) {
    if (process.env[key]) {
      const val = process.env[key]!;
      ok(`${key}: ${val.slice(0, 12)}...`);
    } else {
      const value = await ask(`Enter ${key}`);
      if (!value) {
        fail(`${key} is required. Cannot continue.`);
        process.exit(1);
      }
      setEnvVar(key, value);
      ok(`${key}: ${value.slice(0, 12)}... (saved to .env.test)`);
    }
  }

  // Check optional vars
  for (const key of OPTIONAL_ENV) {
    if (process.env[key]) {
      ok(`${key}: ${process.env[key]!.slice(0, 20)}`);
    } else {
      info(`${key}: not set (using default)`);
    }
  }

  // Prompt for Slack App ID if missing (needed for manifest auto-config)
  if (!process.env.SLACK_APP_ID) {
    console.log('');
    info('SLACK_APP_ID is needed for auto-configuring your Slack app.');
    info('Find it at https://api.slack.com/apps → your app → Basic Information');
    const appId = await ask('Enter SLACK_APP_ID (or press Enter to skip)');
    if (appId) {
      setEnvVar('SLACK_APP_ID', appId);
      ok(`SLACK_APP_ID: ${appId} (saved)`);
    }
  }

  if (!process.env.SLACK_CONFIG_REFRESH_TOKEN && process.env.SLACK_APP_ID) {
    console.log('');
    info('SLACK_CONFIG_REFRESH_TOKEN enables auto-updating your app manifest.');
    info('Get it from https://api.slack.com/apps → your app → Manage Distribution → Configuration Tokens');
    const token = await ask('Enter SLACK_CONFIG_REFRESH_TOKEN (or press Enter to skip)');
    if (token) {
      setEnvVar('SLACK_CONFIG_REFRESH_TOKEN', token);
      ok('SLACK_CONFIG_REFRESH_TOKEN saved');
    }
  }
}

// ─── Step 3: OpenCode server ────────────────────────────────────────────────

async function checkOpenCode(): Promise<OpenCodeClient> {
  const url = process.env.OPENCODE_URL || 'http://localhost:1707';
  info(`Checking ${url}...`);

  const client = new OpenCodeClient({ baseUrl: url });
  const ready = await client.isReady();

  if (ready) {
    ok(`OpenCode server is ready at ${url}`);

    // Show available providers
    const providers = await client.listProviders();
    if (providers.length > 0) {
      const modelCount = providers.reduce((sum, p) => sum + p.models.length, 0);
      ok(`${providers.length} provider(s), ${modelCount} model(s) available`);
    }

    return client;
  }

  fail(`OpenCode server at ${url} is not responding.`);
  console.log('');
  info('Start it with:');
  info('  opencode serve --port 1707');
  console.log('');

  const customUrl = await ask('Enter a different OpenCode URL (or press Enter to exit)');
  if (customUrl) {
    process.env.OPENCODE_URL = customUrl;
    setEnvVar('OPENCODE_URL', customUrl);
    const retryClient = new OpenCodeClient({ baseUrl: customUrl });
    if (await retryClient.isReady()) {
      ok(`OpenCode server is ready at ${customUrl}`);
      return retryClient;
    }
    fail(`Still not reachable at ${customUrl}`);
  }

  process.exit(1);
}

// ─── Step 4: Ngrok / tunnel ─────────────────────────────────────────────────

async function detectNgrokUrl(): Promise<string | null> {
  try {
    const res = await fetch('http://127.0.0.1:4040/api/tunnels', {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      tunnels: Array<{ public_url: string; proto: string; config?: { addr: string } }>;
    };
    const httpsTunnel = data.tunnels.find((t) => t.proto === 'https');
    return httpsTunnel?.public_url ?? data.tunnels[0]?.public_url ?? null;
  } catch {
    return null;
  }
}

function isNgrokInstalled(): boolean {
  try {
    execSync('which ngrok', { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function setupTunnel(port: number): Promise<string> {
  // If URL provided via CLI, use it
  if (CLI_URL) {
    ok(`Using provided URL: ${CLI_URL}`);
    return CLI_URL;
  }

  if (SKIP_NGROK) {
    const url = await ask('Enter your public webhook URL');
    if (!url) {
      fail('A public URL is required for Slack webhooks.');
      process.exit(1);
    }
    return url;
  }

  // Try to detect running ngrok
  info('Looking for ngrok tunnel...');
  const existing = await detectNgrokUrl();
  if (existing) {
    ok(`Found ngrok tunnel: ${existing}`);
    return existing;
  }

  // No ngrok running — offer options
  warn('No ngrok tunnel detected.');
  console.log('');

  if (isNgrokInstalled()) {
    info('ngrok is installed on this machine.');
    const startIt = await confirm(`Start ngrok on port ${port}?`);

    if (startIt) {
      info(`Starting ngrok http ${port}...`);
      const ngrokProc = spawn('ngrok', ['http', String(port)], {
        stdio: 'ignore',
        detached: true,
      });
      ngrokProc.unref();

      // Wait for ngrok to come up
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const url = await detectNgrokUrl();
        if (url) {
          ok(`ngrok started: ${url}`);
          return url;
        }
      }
      fail('ngrok started but tunnel URL not detected after 15s.');
    }
  } else {
    info('ngrok is not installed.');
    info('Install: https://ngrok.com/download');
    info('  brew install ngrok  (macOS)');
    info('  npm install -g ngrok (npm)');
    console.log('');
  }

  // Manual URL fallback
  const manualUrl = await ask('Enter your public webhook URL manually');
  if (!manualUrl) {
    fail('A public URL is required for Slack webhooks.');
    process.exit(1);
  }
  return manualUrl;
}

// ─── Step 5: Slack manifest auto-config ─────────────────────────────────────

function persistRefreshToken(newToken: string): void {
  setEnvVar('SLACK_CONFIG_REFRESH_TOKEN', newToken);
}

async function updateSlackManifest(baseUrl: string): Promise<boolean> {
  const appId = process.env.SLACK_APP_ID;
  const refreshToken = process.env.SLACK_CONFIG_REFRESH_TOKEN;

  if (!appId || !refreshToken) {
    warn('Skipping manifest auto-config (no SLACK_APP_ID or refresh token).');
    info('You can manually set your webhook URL in the Slack app dashboard:');
    info(`  ${baseUrl}/api/webhooks/slack`);
    return false;
  }

  if (SKIP_MANIFEST) {
    info('Skipping manifest update (--skip-manifest)');
    return false;
  }

  const SLACK_API = 'https://slack.com/api';
  const webhookUrl = `${baseUrl}/api/webhooks/slack`;

  // 1. Rotate token
  info('Rotating config token...');
  const rotateRes = await fetch(`${SLACK_API}/tooling.tokens.rotate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refreshToken }),
  });
  const rotateData = (await rotateRes.json()) as Record<string, unknown>;
  if (!rotateData.ok) {
    fail(`Token rotation failed: ${rotateData.error}`);
    warn('Your refresh token may be expired. Generate a new one from the Slack dashboard.');
    return false;
  }

  const accessToken = rotateData.token as string;
  const newRefreshToken = rotateData.refresh_token as string;
  persistRefreshToken(newRefreshToken);

  // 2. Export current manifest
  info('Exporting current manifest...');
  const exportRes = await fetch(`${SLACK_API}/apps.manifest.export`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ app_id: appId }),
  });
  const exportData = (await exportRes.json()) as Record<string, unknown>;
  if (!exportData.ok) {
    fail(`Manifest export failed: ${exportData.error}`);
    return false;
  }

  // 3. Patch URLs
  const manifest = exportData.manifest as Record<string, unknown>;
  const settings = (manifest.settings || {}) as Record<string, unknown>;
  settings.event_subscriptions = {
    request_url: webhookUrl,
    bot_events: [
      'app_mention',
      'message.channels',
      'message.groups',
      'message.im',
      'message.mpim',
      'reaction_added',
    ],
  };
  settings.interactivity = { is_enabled: true, request_url: webhookUrl };
  settings.socket_mode_enabled = false;
  manifest.settings = settings;

  const features = (manifest.features || {}) as Record<string, unknown>;
  features.slash_commands = [
    {
      command: '/oc',
      description: 'OpenCode slash command',
      url: webhookUrl,
      usage_hint: '/oc [command] [args]',
      should_escape: false,
    },
    {
      command: '/opencode',
      description: 'OpenCode slash command',
      url: webhookUrl,
      usage_hint: '/opencode [command] [args]',
      should_escape: false,
    },
  ];
  if (!features.bot_user) {
    features.bot_user = { display_name: 'OpenCode', always_online: true };
  }
  manifest.features = features;

  // 4. Update manifest
  info(`Setting webhook URL: ${webhookUrl}`);
  const updateRes = await fetch(`${SLACK_API}/apps.manifest.update`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ app_id: appId, manifest }),
  });
  const updateData = (await updateRes.json()) as Record<string, unknown>;
  if (!updateData.ok) {
    fail(`Manifest update failed: ${JSON.stringify(updateData.errors || updateData.error)}`);
    return false;
  }

  ok('Slack app manifest updated');
  return true;
}

// ─── Step 7: Smoke test ─────────────────────────────────────────────────────

async function smokeTest(port: number): Promise<void> {
  const baseUrl = `http://localhost:${port}`;

  // Health check
  info('Testing health endpoint...');
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      ok('Health endpoint responds');
    } else {
      warn(`Health returned ${res.status}`);
    }
  } catch (err) {
    fail(`Health endpoint failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  // Webhook signature verification
  const secret = process.env.SLACK_SIGNING_SECRET!;
  const challenge = `wizard-${Date.now()}`;
  const body = JSON.stringify({ token: 'test', challenge, type: 'url_verification' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;

  info('Testing webhook signature verification...');
  try {
    const res = await fetch(`${baseUrl}/api/webhooks/slack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': timestamp,
        'X-Slack-Signature': sig,
      },
      body,
    });
    if (res.ok) {
      const data = (await res.json()) as { challenge?: string };
      if (data.challenge === challenge) {
        ok('Webhook URL verification working');
      } else {
        warn('Challenge response mismatch');
      }
    } else {
      warn(`Webhook returned ${res.status}`);
    }
  } catch (err) {
    fail(`Webhook test failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ─── Status dashboard ───────────────────────────────────────────────────────

function showDashboard(port: number, tunnelUrl: string, opencodeUrl: string, manifestUpdated: boolean): void {
  console.log('');
  console.log(`${c.bold}${c.green}  ╔══════════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.green}  ║       opencode-channels is RUNNING                      ║${c.reset}`);
  console.log(`${c.bold}${c.green}  ╚══════════════════════════════════════════════════════════╝${c.reset}`);
  console.log('');
  console.log(`  ${c.bold}Local:${c.reset}     http://localhost:${port}`);
  console.log(`  ${c.bold}Tunnel:${c.reset}    ${tunnelUrl}`);
  console.log(`  ${c.bold}Webhook:${c.reset}   ${tunnelUrl}/api/webhooks/slack`);
  console.log(`  ${c.bold}OpenCode:${c.reset}  ${opencodeUrl}`);
  console.log(`  ${c.bold}Health:${c.reset}    ${tunnelUrl}/health`);
  console.log(`  ${c.bold}Manifest:${c.reset}  ${manifestUpdated ? `${c.green}auto-configured${c.reset}` : `${c.yellow}manual setup needed${c.reset}`}`);
  console.log('');
  console.log(`  ${c.bold}How to test:${c.reset}`);
  console.log(`    1. Go to Slack and @mention the bot in a channel`);
  console.log(`    2. Try slash commands: /oc help, /oc models, /oc status`);
  console.log(`    3. Reply in threads for multi-turn conversations`);
  console.log('');
  console.log(`  ${c.dim}Press Ctrl+C to stop${c.reset}`);
  console.log('');
}

// ─── Help text ──────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`
${c.bold}opencode-channels Setup Wizard${c.reset}

${c.bold}Usage:${c.reset}
  npx tsx scripts/e2e-slack.ts [options]

${c.bold}Options:${c.reset}
  --url <url>        Use a specific public URL (skip ngrok detection)
  --port <port>      Use a specific port (default: 3456)
  --skip-ngrok       Don't auto-detect ngrok, prompt for URL instead
  --skip-manifest    Don't auto-update the Slack app manifest
  --help, -h         Show this help

${c.bold}Prerequisites:${c.reset}
  1. OpenCode server running (opencode serve --port 1707)
  2. ngrok or another tunnel for public webhook URL
  3. Slack app with Bot Token and Signing Secret

${c.bold}Environment variables${c.reset} (in .env.test):
  SLACK_BOT_TOKEN              (required) xoxb-...
  SLACK_SIGNING_SECRET         (required) Your app's signing secret
  SLACK_APP_ID                 (optional) For auto-manifest config
  SLACK_CONFIG_REFRESH_TOKEN   (optional) For auto-manifest config
  OPENCODE_URL                 (optional) Default: http://localhost:1707
  PORT                         (optional) Default: 3456
`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (HELP) {
    showHelp();
    process.exit(0);
  }

  banner();

  const port = CLI_PORT ? Number(CLI_PORT) : Number(process.env.PORT) || 3456;
  const opencodeUrl = process.env.OPENCODE_URL || 'http://localhost:1707';

  // Step 1: Prerequisites
  step(1, 'Checking prerequisites');
  const prereqsOk = checkPrerequisites();
  if (!prereqsOk) {
    fail('Fix the above issues and try again.');
    process.exit(1);
  }

  // Step 2: Environment variables
  step(2, 'Environment variables');
  await checkEnvVars();

  // Step 3: OpenCode server
  step(3, 'OpenCode server');
  await checkOpenCode();

  // Step 4: Tunnel setup
  step(4, 'Public tunnel (ngrok)');
  const tunnelUrl = await setupTunnel(port);

  // Save the tunnel URL for reference
  writeFileSync(resolve(__dirname, '../ngrok-url.txt'), tunnelUrl);

  // Step 5: Slack manifest
  step(5, 'Slack app manifest');
  const manifestUpdated = await updateSlackManifest(tunnelUrl);

  // Step 6: Boot the bot
  step(6, 'Starting the bot');
  info('Booting Chat SDK bot + Hono webhook server...');

  const { server } = await start(
    { opencodeUrl: process.env.OPENCODE_URL || opencodeUrl },
    { port },
  );

  ok(`Server listening on port ${port}`);

  // Step 7: Smoke test
  step(7, 'Smoke test');
  await smokeTest(port);

  // Close readline so it doesn't block
  rl.close();

  // Step 8: Dashboard
  showDashboard(port, tunnelUrl, process.env.OPENCODE_URL || opencodeUrl, manifestUpdated);

  // Graceful shutdown
  const shutdown = () => {
    console.log('');
    info('Shutting down...');
    server.stop();
    ok('Server stopped. Goodbye!');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`\n${c.red}[FATAL]${c.reset}`, err);
  rl.close();
  process.exit(1);
});
