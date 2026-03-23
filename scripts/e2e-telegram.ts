/**
 * Interactive Setup Wizard for opencode-channels — Telegram.
 *
 * For NEW users (no tokens yet):
 *   Step 1: Check prerequisites
 *   Step 2: Detect ngrok / ask for public URL
 *   Step 3: Ask for Bot Token (from BotFather)
 *   Step 4: Set Telegram webhook to point at our server
 *   Step 5: Verify OpenCode server
 *   Step 6: Boot the bot
 *   Step 7: Smoke test + dashboard
 *
 * For RETURNING users (tokens already in .env.test):
 *   Step 1: Check prerequisites + load tokens
 *   Step 2: Detect ngrok / ask for public URL
 *   Step 3: Update webhook URL
 *   Step 4: Verify OpenCode server
 *   Step 5: Boot the bot
 *   Step 6: Smoke test + dashboard
 *
 * Usage:
 *   pnpm e2e:telegram
 *   pnpm e2e:telegram --url https://your-server.com
 *   pnpm e2e:telegram --port 3456
 *   pnpm e2e:telegram --polling   (skip webhook setup, use polling mode)
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { start } from '../src/index.js';
import { OpenCodeClient } from '../src/opencode.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '../.env.test');
const ENV_EXAMPLE_PATH = resolve(__dirname, '../.env.example');
const TELEGRAM_API = 'https://api.telegram.org';

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
const USE_POLLING = hasFlag('polling');
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
  console.log(`${c.bold}${c.cyan}  ║  opencode-channels  Telegram Setup Wizard   ║${c.reset}`);
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

  if (USE_POLLING) {
    info('Polling mode — no public URL needed.');
    return '';
  }

  if (SKIP_NGROK) {
    const url = await ask('Enter your public webhook URL');
    if (!url) {
      fail('A public URL is required for Telegram webhooks.');
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
      warn(`Fix: restart ngrok with "ngrok http ${port}" or use --port ${existing.forwardPort}`);
    }
    return existing.url;
  }

  warn('No ngrok tunnel detected.');
  console.log('');

  if (isNgrokInstalled()) {
    info('ngrok is installed on this machine.');
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
  } else {
    info('ngrok is not installed. Options:');
    info('  brew install ngrok   (macOS)');
    info('  https://ngrok.com/download');
    info('  Or use --polling for local development without a public URL');
    console.log('');
  }

  const manualUrl = await ask('Enter your public URL (or leave empty for polling mode)');
  return manualUrl;
}

// ─── Telegram API helpers ───────────────────────────────────────────────────

async function tgApi(token: string, method: string, body?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as { ok: boolean; result?: unknown; description?: string };
  if (!data.ok) throw new Error(`Telegram API ${method} failed: ${data.description}`);
  return data.result;
}

async function verifyBotToken(token: string): Promise<{ id: number; username: string; firstName: string }> {
  const result = await tgApi(token, 'getMe') as { id: number; username: string; first_name: string };
  return { id: result.id, username: result.username, firstName: result.first_name };
}

async function setWebhook(token: string, webhookUrl: string, secretToken?: string): Promise<void> {
  const body: Record<string, unknown> = {
    url: webhookUrl,
    allowed_updates: ['message', 'edited_message', 'callback_query', 'message_reaction'],
    drop_pending_updates: true,
  };
  if (secretToken) body.secret_token = secretToken;
  await tgApi(token, 'setWebhook', body);
}

async function deleteWebhook(token: string): Promise<void> {
  await tgApi(token, 'deleteWebhook', { drop_pending_updates: true });
}

async function getWebhookInfo(token: string): Promise<{ url: string; pending_update_count: number; last_error_message?: string }> {
  return tgApi(token, 'getWebhookInfo') as Promise<{ url: string; pending_update_count: number; last_error_message?: string }>;
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

async function smokeTest(port: number, botToken: string, webhookUrl: string): Promise<void> {
  const baseUrl = `http://localhost:${port}`;

  info('Health check...');
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json() as { ok: boolean; adapters: string[] };
      if (data.adapters.includes('telegram')) {
        ok('Health endpoint OK — telegram adapter active');
      } else {
        warn(`Health OK but telegram not in adapters: ${data.adapters}`);
      }
    } else {
      warn(`Health returned ${res.status}`);
    }
  } catch (err) {
    fail(`Health endpoint failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  if (webhookUrl) {
    info('Checking Telegram webhook status...');
    try {
      const whInfo = await getWebhookInfo(botToken);
      if (whInfo.url === `${webhookUrl}/api/webhooks/telegram`) {
        ok('Telegram webhook is correctly set');
      } else if (whInfo.url) {
        warn(`Webhook URL mismatch: ${whInfo.url}`);
      } else {
        warn('No webhook set — using polling mode');
      }
      if (whInfo.last_error_message) {
        warn(`Last webhook error: ${whInfo.last_error_message}`);
      }
      if (whInfo.pending_update_count > 0) {
        info(`${whInfo.pending_update_count} pending update(s)`);
      }
    } catch (err) {
      warn(`Could not check webhook: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Test the webhook endpoint locally
  info('Testing webhook endpoint with a simulated update...');
  try {
    const fakeUpdate = {
      update_id: 999999999,
      message: {
        message_id: 1,
        from: { id: 12345, is_bot: false, first_name: 'Test', username: 'testuser' },
        chat: { id: 12345, first_name: 'Test', username: 'testuser', type: 'private' as const },
        date: Math.floor(Date.now() / 1000),
        text: 'smoke test',
      },
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN) {
      headers['X-Telegram-Bot-Api-Secret-Token'] = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
    }

    const res = await fetch(`${baseUrl}/api/webhooks/telegram`, {
      method: 'POST',
      headers,
      body: JSON.stringify(fakeUpdate),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok || res.status === 200) {
      ok('Webhook endpoint accepts Telegram updates');
    } else {
      warn(`Webhook returned ${res.status}: ${await res.text().catch(() => '')}`);
    }
  } catch (err) {
    warn(`Webhook test failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

function showDashboard(port: number, tunnelUrl: string, opencodeUrl: string, botUsername: string, usePolling: boolean): void {
  console.log('');
  console.log(`${c.bold}${c.green}  ╔══════════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.green}  ║       opencode-channels Telegram is RUNNING             ║${c.reset}`);
  console.log(`${c.bold}${c.green}  ╚══════════════════════════════════════════════════════════╝${c.reset}`);
  console.log('');
  console.log(`  ${c.bold}Bot:${c.reset}       @${botUsername}`);
  console.log(`  ${c.bold}Mode:${c.reset}      ${usePolling ? 'Polling' : 'Webhook'}`);
  console.log(`  ${c.bold}Local:${c.reset}     http://localhost:${port}`);
  if (tunnelUrl) {
    console.log(`  ${c.bold}Public:${c.reset}    ${tunnelUrl}`);
    console.log(`  ${c.bold}Webhook:${c.reset}   ${tunnelUrl}/api/webhooks/telegram`);
  }
  console.log(`  ${c.bold}OpenCode:${c.reset}  ${opencodeUrl}`);
  console.log(`  ${c.bold}Health:${c.reset}    http://localhost:${port}/health`);
  console.log('');
  console.log(`  ${c.bold}Try it:${c.reset}`);
  console.log(`    1. Open Telegram and DM @${botUsername}`);
  console.log(`    2. Send any message — the bot will respond via OpenCode`);
  console.log(`    3. In groups, @${botUsername} to mention the bot`);
  console.log('');
  console.log(`  ${c.dim}Press Ctrl+C to stop${c.reset}`);
  console.log('');
}

// ─── Help ───────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`
${c.bold}opencode-channels Telegram Setup Wizard${c.reset}

${c.bold}Usage:${c.reset}
  pnpm e2e:telegram [options]

${c.bold}Options:${c.reset}
  --url <url>        Public URL (skip ngrok detection)
  --port <port>      Webhook server port (default: 3456)
  --polling          Use polling mode (no public URL needed)
  --skip-ngrok       Don't auto-detect ngrok, prompt for URL
  --help, -h         Show this help

${c.bold}First-time setup:${c.reset}
  1. Create a bot via @BotFather on Telegram (/newbot)
  2. Start ngrok:     ngrok http 3456  (or use --polling)
  3. Start OpenCode:  opencode serve --port 1707
  4. Run wizard:      pnpm e2e:telegram

${c.bold}Returning users:${c.reset}
  Just run:  pnpm e2e:telegram
  Token is loaded from .env.test, webhook auto-updated.
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

  const isFirstTime = !process.env.TELEGRAM_BOT_TOKEN;

  // ── Step 2: Public URL ──
  let tunnelUrl = '';
  let usePolling = USE_POLLING;

  if (!usePolling) {
    step(2, 'Public URL');
    info('Telegram needs to reach your bot over the internet (webhook mode).');
    info('Or use --polling to skip this (no public URL needed).');
    tunnelUrl = await setupTunnel(port);
    if (!tunnelUrl) {
      info('No URL provided — falling back to polling mode.');
      usePolling = true;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIRST-TIME SETUP
  // ═══════════════════════════════════════════════════════════════════════════
  if (isFirstTime) {

    // ── Step 3: Bot token ──
    step(usePolling ? 2 : 3, 'Telegram Bot Token');
    console.log('');
    console.log(`${c.bold}${c.cyan}  ┌──────────────────────────────────────────────────────────┐${c.reset}`);
    console.log(`${c.bold}${c.cyan}  │                                                          │${c.reset}`);
    console.log(`${c.bold}${c.cyan}  │  Create a Telegram bot:                                  │${c.reset}`);
    console.log(`${c.bold}${c.cyan}  │                                                          │${c.reset}`);
    console.log(`${c.bold}${c.cyan}  │  1. Open Telegram and DM ${c.bold}@BotFather${c.reset}${c.bold}${c.cyan}                     │${c.reset}`);
    console.log(`${c.bold}${c.cyan}  │  2. Send ${c.bold}/newbot${c.reset}${c.bold}${c.cyan} and follow the prompts               │${c.reset}`);
    console.log(`${c.bold}${c.cyan}  │  3. Copy the bot token (looks like 123456:ABC...)        │${c.reset}`);
    console.log(`${c.bold}${c.cyan}  │                                                          │${c.reset}`);
    console.log(`${c.bold}${c.cyan}  └──────────────────────────────────────────────────────────┘${c.reset}`);
    console.log('');

    const botToken = await ask('Paste your Bot Token');
    if (!botToken || !botToken.includes(':')) {
      fail('Bot token is required and should contain a colon (e.g. 123456:ABC...)');
      process.exit(1);
    }

    // Verify token
    info('Verifying bot token...');
    let botInfo: { id: number; username: string; firstName: string };
    try {
      botInfo = await verifyBotToken(botToken);
    } catch (err) {
      fail(`Invalid token: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    ok(`Bot verified: @${botInfo.username} (${botInfo.firstName})`);

    setEnvVar('TELEGRAM_BOT_TOKEN', botToken);
    setEnvVar('TELEGRAM_BOT_USERNAME', botInfo.username);
    ok('Saved to .env.test');

    // Generate a webhook secret
    const secretToken = `oc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    setEnvVar('TELEGRAM_WEBHOOK_SECRET_TOKEN', secretToken);

    // Set webhook if we have a URL
    if (tunnelUrl) {
      const nextStep = usePolling ? 3 : 4;
      step(nextStep, 'Setting Telegram webhook');
      const webhookUrl = `${tunnelUrl}/api/webhooks/telegram`;
      info(`Setting webhook to: ${webhookUrl}`);
      try {
        await setWebhook(botToken, webhookUrl, secretToken);
        ok('Webhook set successfully');
      } catch (err) {
        fail(`Failed to set webhook: ${err instanceof Error ? err.message : err}`);
        warn('Will fall back to polling mode.');
        usePolling = true;
      }
    }

    // OpenCode
    const ocStep = tunnelUrl ? (usePolling ? 4 : 5) : 3;
    step(ocStep, 'OpenCode server');
    await checkOpenCode();

    // Boot
    step(ocStep + 1, 'Starting the bot');

  } else {
    // ═════════════════════════════════════════════════════════════════════════
    // RETURNING USER
    // ═════════════════════════════════════════════════════════════════════════
    const botToken = process.env.TELEGRAM_BOT_TOKEN!;
    info('Verifying existing bot token...');
    let botInfo: { id: number; username: string; firstName: string };
    try {
      botInfo = await verifyBotToken(botToken);
      ok(`Bot: @${botInfo.username} (${botInfo.firstName})`);
    } catch (err) {
      fail(`Token verification failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    // Update webhook if we have a URL
    if (tunnelUrl) {
      step(3, 'Updating Telegram webhook');
      const webhookUrl = `${tunnelUrl}/api/webhooks/telegram`;
      info(`Setting webhook to: ${webhookUrl}`);
      try {
        const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN || `oc-${Date.now()}`;
        await setWebhook(botToken, webhookUrl, secretToken);
        if (!process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN) {
          setEnvVar('TELEGRAM_WEBHOOK_SECRET_TOKEN', secretToken);
        }
        ok('Webhook updated');
      } catch (err) {
        fail(`Failed to set webhook: ${err instanceof Error ? err.message : err}`);
        warn('Will fall back to polling mode.');
        usePolling = true;
      }
    } else if (!usePolling) {
      info('No public URL — using polling mode.');
      usePolling = true;
      await deleteWebhook(botToken).catch(() => {});
    }

    // OpenCode
    step(tunnelUrl ? 4 : 3, 'OpenCode server');
    await checkOpenCode();

    // Boot
    step(tunnelUrl ? 5 : 4, 'Starting the bot');
  }

  // ── Boot ──
  info('Booting Chat SDK bot + Hono server...');

  // If polling mode, ensure no webhook is set
  if (usePolling) {
    info('Clearing webhook for polling mode...');
    await deleteWebhook(process.env.TELEGRAM_BOT_TOKEN!).catch(() => {});
  }

  const { server } = await start(
    { opencodeUrl: process.env.OPENCODE_URL || opencodeUrl },
    { port },
  );
  ok(`Server listening on port ${port}`);

  // Wait for adapter initialization
  info('Waiting for Telegram adapter to initialize...');
  await new Promise((r) => setTimeout(r, 3000));

  // ── Smoke test ──
  console.log('');
  info('Running smoke test...');
  await smokeTest(port, process.env.TELEGRAM_BOT_TOKEN!, tunnelUrl);

  rl.close();

  // ── Dashboard ──
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'your-bot';
  showDashboard(port, tunnelUrl, process.env.OPENCODE_URL || opencodeUrl, botUsername, usePolling);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('');
    info('Shutting down...');
    server.stop();

    // Clean up webhook
    if (!usePolling && process.env.TELEGRAM_BOT_TOKEN) {
      info('Removing Telegram webhook...');
      await deleteWebhook(process.env.TELEGRAM_BOT_TOKEN).catch(() => {});
    }

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
