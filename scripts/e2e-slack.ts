/**
 * Interactive Setup Wizard for opencode-channels.
 *
 * For NEW users (no tokens yet):
 *   Step 1: Check prerequisites
 *   Step 2: Detect ngrok / ask for public URL
 *   Step 3: Choose bot name + generate manifest JSON
 *   Step 4: User creates Slack app from manifest, copies tokens back
 *   Step 5: Verify OpenCode server
 *   Step 6: Boot the bot (Slack verifies webhook URL automatically)
 *   Step 7: Smoke test + dashboard
 *
 * For RETURNING users (tokens already in .env.test):
 *   Step 1: Check prerequisites + load tokens
 *   Step 2: Detect ngrok / ask for public URL
 *   Step 3: Verify OpenCode server
 *   Step 4: Auto-update manifest URLs (if config tokens available)
 *   Step 5: Boot the bot
 *   Step 6: Smoke test + dashboard
 *
 * Usage:
 *   pnpm e2e:slack
 *   pnpm e2e:slack --url https://your-server.com
 *   pnpm e2e:slack --name "My Bot"
 *   pnpm e2e:slack --port 4000
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
const CLI_NAME = getArg('name');
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

function waitForEnter(message: string): Promise<void> {
  return new Promise((resolve) => {
    rl.question(`  ${c.magenta}>${c.reset} ${message}`, () => resolve());
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

// ─── Prerequisites ──────────────────────────────────────────────────────────

function checkPrerequisites(): boolean {
  let allGood = true;

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

  try {
    execSync('npx tsx --version', { encoding: 'utf-8', stdio: 'pipe' });
    ok('tsx available');
  } catch {
    warn('tsx not found (will install on first run)');
  }

  return allGood;
}

// ─── Tunnel detection ───────────────────────────────────────────────────────

async function detectNgrokUrl(): Promise<{ url: string; forwardPort: number | null } | null> {
  try {
    const res = await fetch('http://127.0.0.1:4040/api/tunnels', {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      tunnels: Array<{ public_url: string; proto: string; config?: { addr?: string } }>;
    };
    const httpsTunnel = data.tunnels.find((t) => t.proto === 'https');
    const tunnel = httpsTunnel ?? data.tunnels[0];
    if (!tunnel) return null;

    // Extract forwarding port from config.addr (e.g. "http://localhost:3456" → 3456)
    let forwardPort: number | null = null;
    if (tunnel.config?.addr) {
      const portMatch = tunnel.config.addr.match(/:(\d+)$/);
      if (portMatch) forwardPort = Number(portMatch[1]);
    }
    return { url: tunnel.public_url, forwardPort };
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

  info('Looking for ngrok tunnel...');
  const existing = await detectNgrokUrl();
  if (existing) {
    ok(`Found ngrok tunnel: ${existing.url}`);
    if (existing.forwardPort && existing.forwardPort !== port) {
      warn(`ngrok is forwarding to port ${existing.forwardPort}, but bot will listen on port ${port}.`);
      warn(`You'll get 502 errors. Fix: restart ngrok with "ngrok http ${port}" or use --port ${existing.forwardPort}`);
    }
    return existing.url;
  }

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

      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const result = await detectNgrokUrl();
        if (result) {
          ok(`ngrok started: ${result.url}`);
          return result.url;
        }
      }
      fail('ngrok started but tunnel URL not detected after 15s.');
    }
  } else {
    info('ngrok is not installed. Options:');
    info('  brew install ngrok   (macOS)');
    info('  https://ngrok.com/download');
    info('  Or use any public URL (Cloudflare Tunnel, server IP, etc.)');
    console.log('');
  }

  const manualUrl = await ask('Enter your public URL');
  if (!manualUrl) {
    fail('A public URL is required for Slack webhooks.');
    process.exit(1);
  }
  return manualUrl;
}

// ─── Manifest generation ────────────────────────────────────────────────────

function generateManifest(webhookUrl: string, botName: string): string {
  const fullUrl = `${webhookUrl}/api/webhooks/slack`;
  const manifest = {
    display_information: { name: botName },
    features: {
      bot_user: { display_name: botName, always_online: true },
      slash_commands: [
        {
          command: '/oc',
          url: fullUrl,
          description: `${botName} slash command`,
          usage_hint: '/oc [command] [args]',
          should_escape: false,
        },
        {
          command: '/opencode',
          url: fullUrl,
          description: `${botName} slash command`,
          usage_hint: '/opencode [command] [args]',
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: [
          'app_mentions:read', 'assistant:write',
          'channels:history', 'channels:read',
          'chat:write', 'chat:write.public', 'commands',
          'files:read', 'files:write',
          'groups:history', 'groups:read',
          'im:history', 'im:read', 'im:write',
          'mpim:history', 'mpim:read',
          'reactions:read', 'reactions:write', 'users:read',
        ],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: fullUrl,
        bot_events: [
          'app_mention', 'message.channels', 'message.groups',
          'message.im', 'message.mpim', 'reaction_added',
        ],
      },
      interactivity: { is_enabled: true, request_url: fullUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
  return JSON.stringify(manifest, null, 2);
}

// ─── Slack manifest auto-update (returning users) ───────────────────────────

async function updateSlackManifest(baseUrl: string): Promise<boolean> {
  const appId = process.env.SLACK_APP_ID;
  const refreshToken = process.env.SLACK_CONFIG_REFRESH_TOKEN;

  if (!appId || !refreshToken) return false;
  if (SKIP_MANIFEST) {
    info('Skipping manifest update (--skip-manifest)');
    return false;
  }

  const SLACK_API = 'https://slack.com/api';
  const webhookUrl = `${baseUrl}/api/webhooks/slack`;

  info('Rotating config token...');
  const rotateRes = await fetch(`${SLACK_API}/tooling.tokens.rotate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refreshToken }),
  });
  const rotateData = (await rotateRes.json()) as Record<string, unknown>;
  if (!rotateData.ok) {
    fail(`Token rotation failed: ${rotateData.error}`);
    warn('Refresh token may be expired. Generate a new one from the Slack dashboard.');
    return false;
  }

  const accessToken = rotateData.token as string;
  const newRefreshToken = rotateData.refresh_token as string;
  setEnvVar('SLACK_CONFIG_REFRESH_TOKEN', newRefreshToken);

  info('Exporting current manifest...');
  const exportRes = await fetch(`${SLACK_API}/apps.manifest.export`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId }),
  });
  const exportData = (await exportRes.json()) as Record<string, unknown>;
  if (!exportData.ok) {
    fail(`Manifest export failed: ${exportData.error}`);
    return false;
  }

  const manifest = exportData.manifest as Record<string, unknown>;
  const settings = (manifest.settings || {}) as Record<string, unknown>;
  settings.event_subscriptions = {
    request_url: webhookUrl,
    bot_events: ['app_mention', 'message.channels', 'message.groups', 'message.im', 'message.mpim', 'reaction_added'],
  };
  settings.interactivity = { is_enabled: true, request_url: webhookUrl };
  settings.socket_mode_enabled = false;
  manifest.settings = settings;

  const features = (manifest.features || {}) as Record<string, unknown>;
  features.slash_commands = [
    { command: '/oc', description: 'OpenCode slash command', url: webhookUrl, usage_hint: '/oc [command] [args]', should_escape: false },
    { command: '/opencode', description: 'OpenCode slash command', url: webhookUrl, usage_hint: '/opencode [command] [args]', should_escape: false },
  ];
  if (!features.bot_user) features.bot_user = { display_name: 'OpenCode', always_online: true };
  manifest.features = features;

  // Ensure assistant:write scope is present (for assistant.threads.setStatus)
  const oauth = (manifest.oauth_config || {}) as Record<string, unknown>;
  const scopes = (oauth.scopes || {}) as Record<string, unknown>;
  const botScopes = (scopes.bot || []) as string[];
  if (!botScopes.includes('assistant:write')) {
    botScopes.push('assistant:write');
    scopes.bot = botScopes;
    oauth.scopes = scopes;
    manifest.oauth_config = oauth;
    info('Added assistant:write scope (you may need to reinstall the app)');
  }

  info(`Setting webhook URL: ${webhookUrl}`);
  const updateRes = await fetch(`${SLACK_API}/apps.manifest.update`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, manifest }),
  });
  const updateData = (await updateRes.json()) as Record<string, unknown>;
  if (!updateData.ok) {
    fail(`Manifest update failed: ${JSON.stringify(updateData.errors || updateData.error)}`);
    return false;
  }

  ok('Slack app manifest updated with new URLs');
  return true;
}

// ─── OpenCode check ─────────────────────────────────────────────────────────

async function checkOpenCode(): Promise<OpenCodeClient> {
  const url = process.env.OPENCODE_URL || 'http://localhost:1707';
  info(`Checking ${url}...`);

  const client = new OpenCodeClient({ baseUrl: url });
  const ready = await client.isReady();

  if (ready) {
    ok(`OpenCode server is ready at ${url}`);
    const providers = await client.listProviders();
    if (providers.length > 0) {
      const modelCount = providers.reduce((sum, p) => sum + p.models.length, 0);
      ok(`${providers.length} provider(s), ${modelCount} model(s) available`);
    }
    return client;
  }

  fail(`OpenCode server at ${url} is not responding.`);
  console.log('');
  info('Start it with:  opencode serve --port 1707');
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

// ─── Smoke test ─────────────────────────────────────────────────────────────

async function smokeTest(port: number): Promise<void> {
  const baseUrl = `http://localhost:${port}`;

  info('Health check...');
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) ok('Health endpoint responds');
    else warn(`Health returned ${res.status}`);
  } catch (err) {
    fail(`Health endpoint failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const secret = process.env.SLACK_SIGNING_SECRET!;
  const challenge = `wizard-${Date.now()}`;
  const body = JSON.stringify({ token: 'test', challenge, type: 'url_verification' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;

  info('Webhook signature verification...');
  try {
    const res = await fetch(`${baseUrl}/api/webhooks/slack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Slack-Request-Timestamp': timestamp, 'X-Slack-Signature': sig },
      body,
    });
    if (res.ok) {
      const data = (await res.json()) as { challenge?: string };
      if (data.challenge === challenge) ok('Webhook verification working');
      else warn('Challenge response mismatch');
    } else {
      warn(`Webhook returned ${res.status}`);
    }
  } catch (err) {
    fail(`Webhook test failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

function showDashboard(port: number, tunnelUrl: string, opencodeUrl: string): void {
  console.log('');
  console.log(`${c.bold}${c.green}  ╔══════════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.green}  ║       opencode-channels is RUNNING                      ║${c.reset}`);
  console.log(`${c.bold}${c.green}  ╚══════════════════════════════════════════════════════════╝${c.reset}`);
  console.log('');
  console.log(`  ${c.bold}Local:${c.reset}     http://localhost:${port}`);
  console.log(`  ${c.bold}Public:${c.reset}    ${tunnelUrl}`);
  console.log(`  ${c.bold}Webhook:${c.reset}   ${tunnelUrl}/api/webhooks/slack`);
  console.log(`  ${c.bold}OpenCode:${c.reset}  ${opencodeUrl}`);
  console.log(`  ${c.bold}Health:${c.reset}    ${tunnelUrl}/health`);
  console.log('');
  console.log(`  ${c.bold}Try it:${c.reset}`);
  console.log(`    1. @mention the bot in any Slack channel`);
  console.log(`    2. Try: /oc help, /oc models, /oc status`);
  console.log(`    3. Reply in threads for multi-turn conversations`);
  console.log('');
  console.log(`  ${c.dim}Press Ctrl+C to stop${c.reset}`);
  console.log('');
}

// ─── Help ───────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`
${c.bold}opencode-channels Setup Wizard${c.reset}

${c.bold}Usage:${c.reset}
  pnpm e2e:slack [options]

${c.bold}Options:${c.reset}
  --url <url>        Public URL (skip ngrok detection)
  --name <name>      Bot display name (default: OpenCode)
  --port <port>      Webhook server port (default: 3456)
  --skip-ngrok       Don't auto-detect ngrok, prompt for URL
  --skip-manifest    Don't auto-update the Slack app manifest
  --help, -h         Show this help

${c.bold}First-time setup:${c.reset}
  1. Start ngrok:     ngrok http 3456  (or have a public URL ready)
  2. Start OpenCode:  opencode serve --port 1707
  3. Run wizard:      pnpm e2e:slack

  The wizard generates a personalized Slack app manifest with your
  URL and bot name, walks you through creating the app, then boots.

${c.bold}Returning users:${c.reset}
  Just run:  pnpm e2e:slack
  Tokens are loaded from .env.test, URLs auto-updated if possible.
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

  // ── Step 1: Prerequisites ──
  step(1, 'Checking prerequisites');
  const prereqsOk = checkPrerequisites();
  if (!prereqsOk) {
    fail('Fix the above issues and try again.');
    process.exit(1);
  }

  // Load existing env
  const fileEnv = loadEnvFile();
  for (const [key, value] of Object.entries(fileEnv)) {
    if (!process.env[key]) process.env[key] = value;
  }
  if (Object.keys(fileEnv).length > 0) {
    ok(`Loaded .env.test (${Object.keys(fileEnv).length} vars)`);
  }

  const isFirstTime = !process.env.SLACK_BOT_TOKEN || !process.env.SLACK_SIGNING_SECRET;

  // ── Step 2: Public URL (needed before manifest) ──
  step(2, 'Public URL');
  info('Slack needs to reach your bot over the internet.');
  const tunnelUrl = await setupTunnel(port);
  writeFileSync(resolve(__dirname, '../ngrok-url.txt'), tunnelUrl);

  // ═══════════════════════════════════════════════════════════════════════════
  // FIRST-TIME SETUP
  // ═══════════════════════════════════════════════════════════════════════════
  if (isFirstTime) {

    // ── Step 3: Generate manifest ──
    step(3, 'Create your Slack app');
    const botName = CLI_NAME || await ask('What should the bot be called?', 'OpenCode');
    console.log('');

    const manifestJson = generateManifest(tunnelUrl, botName);

    // Save to file
    const manifestPath = resolve(__dirname, '../slack-manifest.json');
    writeFileSync(manifestPath, manifestJson + '\n');
    ok(`Manifest saved to slack-manifest.json`);
    console.log('');

    // Print instructions + manifest
    console.log(`${c.bold}${c.cyan}  ┌──────────────────────────────────────────────────────────┐${c.reset}`);
    console.log(`${c.bold}${c.cyan}  │                                                          │${c.reset}`);
    console.log(`${c.bold}${c.cyan}  │  Now create your Slack app:                              │${c.reset}`);
    console.log(`${c.bold}${c.cyan}  │                                                          │${c.reset}`);
    console.log(`${c.bold}${c.cyan}  │  1. Open ${c.bold}https://api.slack.com/apps${c.reset}${c.bold}${c.cyan}                    │${c.reset}`);
    console.log(`${c.bold}${c.cyan}  │  2. Click ${c.bold}"Create New App"${c.reset}${c.bold}${c.cyan} → ${c.bold}"From a manifest"${c.reset}${c.bold}${c.cyan}       │${c.reset}`);
    console.log(`${c.bold}${c.cyan}  │  3. Select your workspace, click Next                    │${c.reset}`);
    console.log(`${c.bold}${c.cyan}  │  4. The default tab is JSON — paste the JSON below       │${c.reset}`);
    console.log(`${c.bold}${c.cyan}  │  5. Click ${c.bold}"Next"${c.reset}${c.bold}${c.cyan} → review → ${c.bold}"Create"${c.reset}${c.bold}${c.cyan}                     │${c.reset}`);
    console.log(`${c.bold}${c.cyan}  │  6. Click ${c.bold}"Install to Workspace"${c.reset}${c.bold}${c.cyan} → ${c.bold}"Allow"${c.reset}${c.bold}${c.cyan}              │${c.reset}`);
    console.log(`${c.bold}${c.cyan}  │                                                          │${c.reset}`);
    console.log(`${c.bold}${c.cyan}  └──────────────────────────────────────────────────────────┘${c.reset}`);
    console.log('');
    console.log(c.dim + '─'.repeat(62) + c.reset);
    console.log(manifestJson);
    console.log(c.dim + '─'.repeat(62) + c.reset);
    console.log('');

    await waitForEnter(`Done? Press Enter when you've created and installed the app...`);

    // ── Step 4: Collect tokens ──
    step(4, 'Copy tokens from your new Slack app');
    console.log('');
    console.log(`  ${c.bold}Where to find them:${c.reset}`);
    console.log(`    Bot Token:      ${c.cyan}OAuth & Permissions${c.reset} → Bot User OAuth Token (xoxb-...)`);
    console.log(`    Signing Secret: ${c.cyan}Basic Information${c.reset} → App Credentials → Signing Secret`);
    console.log('');

    const botToken = await ask('Paste your Bot Token (xoxb-...)');
    if (!botToken || !botToken.startsWith('xoxb-')) {
      fail('Bot token is required and must start with xoxb-');
      process.exit(1);
    }
    setEnvVar('SLACK_BOT_TOKEN', botToken);
    ok(`SLACK_BOT_TOKEN saved`);

    const signingSecret = await ask('Paste your Signing Secret');
    if (!signingSecret) {
      fail('Signing secret is required.');
      process.exit(1);
    }
    setEnvVar('SLACK_SIGNING_SECRET', signingSecret);
    ok(`SLACK_SIGNING_SECRET saved`);

    // Optional: App ID + Config Refresh Token for future auto-updates
    console.log('');
    info('Optional: save your App ID and Config Refresh Token so the wizard');
    info('can auto-update manifest URLs on future runs (e.g. when ngrok changes).');
    console.log('');
    info(`App ID:         ${c.cyan}Basic Information${c.reset} → App ID (starts with A...)`);
    info(`Refresh Token:  ${c.cyan}https://api.slack.com/apps${c.reset} → scroll to bottom`);
    info(`                → "Your App Configuration Tokens" → Generate Token`);
    info(`                → copy the ${c.bold}Refresh Token${c.reset} value`);
    console.log('');
    const appId = await ask('App ID (or Enter to skip)');
    if (appId) {
      setEnvVar('SLACK_APP_ID', appId);
      ok(`SLACK_APP_ID saved`);

      const configRefreshToken = await ask('Config Refresh Token (or Enter to skip)');
      if (configRefreshToken) {
        setEnvVar('SLACK_CONFIG_REFRESH_TOKEN', configRefreshToken);
        ok(`SLACK_CONFIG_REFRESH_TOKEN saved — manifest URLs will auto-update on future runs`);
      } else {
        warn('Without a refresh token, you\'ll need to manually update URLs when your tunnel changes.');
      }
    }

    // ── Step 5: OpenCode server ──
    step(5, 'OpenCode server');
    await checkOpenCode();

    // ── Step 6: Boot ──
    step(6, 'Starting the bot');

  } else {
    // ═════════════════════════════════════════════════════════════════════════
    // RETURNING USER
    // ═════════════════════════════════════════════════════════════════════════
    ok(`SLACK_BOT_TOKEN: ${process.env.SLACK_BOT_TOKEN!.slice(0, 15)}...`);
    ok(`SLACK_SIGNING_SECRET: ${process.env.SLACK_SIGNING_SECRET!.slice(0, 8)}...`);
    if (process.env.SLACK_APP_ID) ok(`SLACK_APP_ID: ${process.env.SLACK_APP_ID}`);

    // ── Step 3: OpenCode server ──
    step(3, 'OpenCode server');
    await checkOpenCode();

    // ── Step 4: Auto-update manifest URLs ──
    if (process.env.SLACK_APP_ID && process.env.SLACK_CONFIG_REFRESH_TOKEN) {
      step(4, 'Auto-update manifest URLs');
      await updateSlackManifest(tunnelUrl);
    }

    // ── Step 5: Boot ──
    step(process.env.SLACK_APP_ID && process.env.SLACK_CONFIG_REFRESH_TOKEN ? 5 : 4, 'Starting the bot');
  }

  // ── Boot ──
  info('Booting Chat SDK bot + Hono webhook server...');

  const { server } = await start(
    { opencodeUrl: process.env.OPENCODE_URL || opencodeUrl },
    { port },
  );
  ok(`Server listening on port ${port}`);

  // ── Smoke test ──
  console.log('');
  info('Running smoke test...');
  await smokeTest(port);

  rl.close();

  // ── Dashboard ──
  showDashboard(port, tunnelUrl, process.env.OPENCODE_URL || opencodeUrl);

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
