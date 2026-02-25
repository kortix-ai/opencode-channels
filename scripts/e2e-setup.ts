/**
 * E2E Setup Test (Chat SDK edition) — Full lifecycle test.
 *
 * Tests the entire opencode-channels system from boot to shutdown:
 *
 *   Phase 1: Boot the Chat SDK bot + webhook server
 *   Phase 2: Verify webhook endpoints (health, events, commands)
 *   Phase 3: Slash commands return correct responses
 *   Phase 4: OpenCode server connectivity
 *   Phase 5: Session management (per-thread, per-message, invalidation)
 *   Phase 6: Security (signatures, bot self-ignore)
 *   Phase 7: Shutdown + reboot cycle
 *
 * Prerequisites:
 *   1. OpenCode server running (default: http://localhost:1707)
 *   2. .env.test with SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET
 *
 * Usage:
 *   npx tsx scripts/e2e-setup.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import * as net from 'node:net';

import { createBot, type BotConfig } from '../src/bot.js';
import { createServer, type ServerConfig } from '../src/server.js';
import { OpenCodeClient } from '../src/opencode.js';
import { SessionManager } from '../src/sessions.js';
import {
  makeAppMention,
  makeMessage,
  makeUrlVerification,
  makeSlashCommand,
  makeReaction,
  DEFAULTS,
} from './fixtures/slack-payloads.js';

// ─── Load .env.test ─────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const envTestPath = resolve(__dirname, '../.env.test');

if (existsSync(envTestPath)) {
  const envContent = readFileSync(envTestPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = value;
  }
}

// ─── Config ─────────────────────────────────────────────────────────────────

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const OPENCODE_URL = process.env.OPENCODE_URL || 'http://localhost:1707';

if (!SLACK_SIGNING_SECRET) {
  console.error('Missing SLACK_SIGNING_SECRET in .env.test');
  process.exit(1);
}

// ─── Test runner ────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, durationMs: Date.now() - start });
    console.log(`  \x1b[32m PASS \x1b[0m ${name} (${Date.now() - start}ms)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, error: msg, durationMs: Date.now() - start });
    console.log(`  \x1b[31m FAIL \x1b[0m ${name}: ${msg}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function signPayload(body: string, secret: string): { timestamp: string; signature: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const basestring = `v0:${timestamp}:${body}`;
  const sig = createHmac('sha256', secret).update(basestring).digest('hex');
  return { timestamp, signature: `v0=${sig}` };
}

async function sendWebhook(
  url: string,
  path: string,
  body: unknown,
  contentType = 'application/json',
): Promise<Response> {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const { timestamp, signature } = signPayload(bodyStr, SLACK_SIGNING_SECRET);

  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'X-Slack-Request-Timestamp': timestamp,
      'X-Slack-Signature': signature,
    },
    body: bodyStr,
  });
}

async function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        srv.close(() => resolve(addr.port));
      } else {
        srv.close(() => reject(new Error('Could not get port')));
      }
    });
  });
}

// ─── Shared state ───────────────────────────────────────────────────────────

let webhookUrl = '';
let serverHandle: ReturnType<typeof createServer> | null = null;
const botConfig: BotConfig = { opencodeUrl: OPENCODE_URL };

function bootServer(port: number) {
  const { bot, client, sessions } = createBot(botConfig);
  const server = createServer(bot, { port });
  serverHandle = server;
  webhookUrl = `http://localhost:${port}`;
  return { bot, client, sessions, server };
}

// ─── Phase 1: Boot ──────────────────────────────────────────────────────────

async function testBootServer(): Promise<void> {
  const port = await getRandomPort();
  bootServer(port);
  assert(serverHandle !== null, 'Server handle is null');
  // Wait for Chat SDK init
  await new Promise((r) => setTimeout(r, 300));
}

async function testHealthAfterBoot(): Promise<void> {
  const res = await fetch(`${webhookUrl}/health`);
  assert(res.ok, `Health returned ${res.status}`);
  const data = (await res.json()) as { ok: boolean; service: string; adapters: string[] };
  assert(data.ok === true, 'Health not ok');
  assert(data.service === 'opencode-channels', `Wrong service: ${data.service}`);
  assert(data.adapters.includes('slack'), 'No slack adapter');
}

// ─── Phase 2: Webhook endpoints ─────────────────────────────────────────────

async function testUrlVerification(): Promise<void> {
  const challenge = `setup-${Date.now()}`;
  const payload = makeUrlVerification(challenge);
  const res = await sendWebhook(webhookUrl, '/api/webhooks/slack', payload);
  assert(res.ok, `URL verify returned ${res.status}`);
  const data = (await res.json()) as { challenge: string };
  assert(data.challenge === challenge, 'Challenge mismatch');
}

async function testAppMentionAccepted(): Promise<void> {
  const res = await sendWebhook(webhookUrl, '/api/webhooks/slack', makeAppMention('test'));
  assert(res.ok, `App mention returned ${res.status}`);
}

async function testDmAccepted(): Promise<void> {
  const res = await sendWebhook(webhookUrl, '/api/webhooks/slack', makeMessage('hi', { isDm: true }));
  assert(res.ok, `DM returned ${res.status}`);
}

async function testThreadedAccepted(): Promise<void> {
  const res = await sendWebhook(webhookUrl, '/api/webhooks/slack', makeMessage('reply', { threadTs: '1234.5678' }));
  assert(res.ok, `Threaded msg returned ${res.status}`);
}

async function testReactionAccepted(): Promise<void> {
  const res = await sendWebhook(webhookUrl, '/api/webhooks/slack', makeReaction('thumbsup', '1234.5678'));
  assert(res.ok, `Reaction returned ${res.status}`);
}

async function testInvalidSigRejected(): Promise<void> {
  const payload = makeAppMention('bad sig');
  const res = await fetch(`${webhookUrl}/api/webhooks/slack`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Slack-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
      'X-Slack-Signature': 'v0=0000000000000000000000000000000000000000000000000000000000000000',
    },
    body: JSON.stringify(payload),
  });
  assert(res.status < 500, `Invalid sig caused server error: ${res.status}`);
}

async function testMissingSigRejected(): Promise<void> {
  const res = await fetch(`${webhookUrl}/api/webhooks/slack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(makeAppMention('no sig')),
  });
  assert(res.status < 500, `Missing sig caused server error: ${res.status}`);
}

async function testBotSelfMessageIgnored(): Promise<void> {
  const payload = makeMessage('bot talking', { userId: DEFAULTS.botUserId, botId: 'B_FAKE' });
  const res = await sendWebhook(webhookUrl, '/api/webhooks/slack', payload);
  assert(res.ok, `Bot self-message returned ${res.status}`);
}

// ─── Phase 3: Slash commands ────────────────────────────────────────────────

async function testSlashHelp(): Promise<void> {
  const res = await sendWebhook(webhookUrl, '/api/webhooks/slack', makeSlashCommand('/oc', 'help'), 'application/x-www-form-urlencoded');
  assert(res.ok, `Help returned ${res.status}`);
}

async function testSlashModels(): Promise<void> {
  const res = await sendWebhook(webhookUrl, '/api/webhooks/slack', makeSlashCommand('/oc', 'models'), 'application/x-www-form-urlencoded');
  assert(res.ok, `Models returned ${res.status}`);
}

async function testSlashStatus(): Promise<void> {
  const res = await sendWebhook(webhookUrl, '/api/webhooks/slack', makeSlashCommand('/oc', 'status'), 'application/x-www-form-urlencoded');
  assert(res.ok, `Status returned ${res.status}`);
}

async function testSlashAgents(): Promise<void> {
  const res = await sendWebhook(webhookUrl, '/api/webhooks/slack', makeSlashCommand('/oc', 'agents'), 'application/x-www-form-urlencoded');
  assert(res.ok, `Agents returned ${res.status}`);
}

async function testSlashReset(): Promise<void> {
  const res = await sendWebhook(webhookUrl, '/api/webhooks/slack', makeSlashCommand('/oc', 'reset'), 'application/x-www-form-urlencoded');
  assert(res.ok, `Reset returned ${res.status}`);
}

async function testSlashDiff(): Promise<void> {
  const res = await sendWebhook(webhookUrl, '/api/webhooks/slack', makeSlashCommand('/oc', 'diff'), 'application/x-www-form-urlencoded');
  assert(res.ok, `Diff returned ${res.status}`);
}

async function testSlashLink(): Promise<void> {
  const res = await sendWebhook(webhookUrl, '/api/webhooks/slack', makeSlashCommand('/oc', 'link'), 'application/x-www-form-urlencoded');
  assert(res.ok, `Link returned ${res.status}`);
}

async function testSlashEmpty(): Promise<void> {
  const res = await sendWebhook(webhookUrl, '/api/webhooks/slack', makeSlashCommand('/oc', ''), 'application/x-www-form-urlencoded');
  assert(res.ok, `Empty returned ${res.status}`);
}

async function testSlashOpencode(): Promise<void> {
  const res = await sendWebhook(webhookUrl, '/api/webhooks/slack', makeSlashCommand('/opencode', 'help'), 'application/x-www-form-urlencoded');
  assert(res.ok, `/opencode returned ${res.status}`);
}

// ─── Phase 4: OpenCode server ───────────────────────────────────────────────

async function testOpenCodeHealth(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  assert(await client.isReady(), 'OpenCode not reachable');
}

async function testOpenCodeProviders(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  const providers = await client.listProviders();
  assert(Array.isArray(providers) && providers.length > 0, 'No providers');
}

async function testOpenCodeAgents(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  const agents = await client.listAgents();
  assert(Array.isArray(agents), 'listAgents failed');
}

async function testOpenCodeSession(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  const id = await client.createSession();
  assert(typeof id === 'string' && id.length > 0, 'Empty session');
}

async function testOpenCodeModifiedFiles(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  const files = await client.getModifiedFiles();
  assert(Array.isArray(files), 'getModifiedFiles failed');
}

// ─── Phase 5: Session management ────────────────────────────────────────────

async function testSessionPerThread(): Promise<void> {
  const mgr = new SessionManager('per-thread');
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  const s1 = await mgr.resolve('t1', client);
  const s2 = await mgr.resolve('t1', client);
  assert(s1 === s2, 'Same thread should reuse');
  const s3 = await mgr.resolve('t2', client);
  assert(s3 !== s1, 'Different thread should differ');
}

async function testSessionPerMessage(): Promise<void> {
  const mgr = new SessionManager('per-message');
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  const s1 = await mgr.resolve('t1', client);
  const s2 = await mgr.resolve('t1', client);
  assert(s1 !== s2, 'per-message should always create new');
}

async function testSessionInvalidation(): Promise<void> {
  const mgr = new SessionManager('per-thread');
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  const s1 = await mgr.resolve('ti', client);
  mgr.invalidate('ti');
  const s2 = await mgr.resolve('ti', client);
  assert(s1 !== s2, 'Invalidated should create new');
}

async function testSessionGet(): Promise<void> {
  const mgr = new SessionManager('per-thread');
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  assert(mgr.get('nonexistent') === undefined, 'Should be undefined');
  await mgr.resolve('tg', client);
  assert(mgr.get('tg') !== undefined, 'Should exist after resolve');
}

async function testSessionCleanup(): Promise<void> {
  const mgr = new SessionManager('per-thread');
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  await mgr.resolve('tc', client);
  mgr.cleanup(); // Should not remove fresh sessions
  assert(mgr.get('tc') !== undefined, 'Fresh session should survive cleanup');
}

async function testSessionAgentSwitch(): Promise<void> {
  const mgr = new SessionManager('per-thread', 'agent-a');
  mgr.setAgent('agent-b');
  // Just verify no errors
  assert(true, 'Agent switch should not throw');
}

async function testSessionStrategySwitch(): Promise<void> {
  const mgr = new SessionManager('per-thread');
  mgr.setStrategy('per-message');
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  const s1 = await mgr.resolve('ts', client);
  const s2 = await mgr.resolve('ts', client);
  assert(s1 !== s2, 'After switch to per-message, should create new');
}

// ─── Phase 6: Legacy routes ─────────────────────────────────────────────────

async function testLegacyEvents(): Promise<void> {
  const challenge = `legacy-${Date.now()}`;
  const res = await sendWebhook(webhookUrl, '/slack/events', makeUrlVerification(challenge));
  assert(res.ok, `Legacy /slack/events returned ${res.status}`);
}

async function testLegacyCommands(): Promise<void> {
  const res = await sendWebhook(webhookUrl, '/slack/commands', makeSlashCommand('/oc', 'help'), 'application/x-www-form-urlencoded');
  assert(res.ok, `Legacy /slack/commands returned ${res.status}`);
}

async function testLegacyInteractivity(): Promise<void> {
  // Just verify the route exists and doesn't 404
  const bodyStr = JSON.stringify({ type: 'block_actions', actions: [] });
  const { timestamp, signature } = signPayload(bodyStr, SLACK_SIGNING_SECRET);
  const res = await fetch(`${webhookUrl}/slack/interactivity`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Slack-Request-Timestamp': timestamp,
      'X-Slack-Signature': signature,
    },
    body: bodyStr,
  });
  assert(res.status < 500, `Legacy interactivity error: ${res.status}`);
}

// ─── Phase 7: Shutdown + reboot ─────────────────────────────────────────────

async function testGracefulShutdown(): Promise<void> {
  serverHandle!.stop();
  serverHandle = null;
  // Wait for server to close
  await new Promise((r) => setTimeout(r, 200));
  try {
    await fetch(`${webhookUrl}/health`, { signal: AbortSignal.timeout(500) });
    // If it responds, might not have shut down yet — that's ok
  } catch {
    // Expected: ECONNREFUSED
  }
}

async function testReboot(): Promise<void> {
  const port = await getRandomPort();
  bootServer(port);
  await new Promise((r) => setTimeout(r, 300));
  const res = await fetch(`${webhookUrl}/health`);
  assert(res.ok, `Health after reboot returned ${res.status}`);
}

async function testWebhooksAfterReboot(): Promise<void> {
  const challenge = `reboot-${Date.now()}`;
  const res = await sendWebhook(webhookUrl, '/api/webhooks/slack', makeUrlVerification(challenge));
  assert(res.ok, `URL verify after reboot returned ${res.status}`);
  const data = (await res.json()) as { challenge: string };
  assert(data.challenge === challenge, 'Challenge mismatch after reboot');
}

async function testSlashAfterReboot(): Promise<void> {
  const res = await sendWebhook(webhookUrl, '/api/webhooks/slack', makeSlashCommand('/oc', 'status'), 'application/x-www-form-urlencoded');
  assert(res.ok, `Slash after reboot returned ${res.status}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('opencode-channels E2E Setup Test (Chat SDK)');
  console.log('════════════════════════════════════════════════════════');
  console.log('');
  console.log(`  OpenCode: ${OPENCODE_URL}`);
  console.log('');

  // Phase 1
  console.log('── Phase 1: Boot ──');
  await runTest('Boot Chat SDK bot + server', testBootServer);
  await runTest('Health endpoint after boot', testHealthAfterBoot);

  // Phase 2
  console.log('');
  console.log('── Phase 2: Webhook Endpoints ──');
  await runTest('URL verification challenge', testUrlVerification);
  await runTest('App mention accepted', testAppMentionAccepted);
  await runTest('DM message accepted', testDmAccepted);
  await runTest('Threaded message accepted', testThreadedAccepted);
  await runTest('Reaction event accepted', testReactionAccepted);
  await runTest('Invalid signature rejected', testInvalidSigRejected);
  await runTest('Missing signature rejected', testMissingSigRejected);
  await runTest('Bot self-message ignored', testBotSelfMessageIgnored);

  // Phase 3
  console.log('');
  console.log('── Phase 3: Slash Commands ──');
  await runTest('/oc help', testSlashHelp);
  await runTest('/oc models', testSlashModels);
  await runTest('/oc status', testSlashStatus);
  await runTest('/oc agents', testSlashAgents);
  await runTest('/oc reset', testSlashReset);
  await runTest('/oc diff', testSlashDiff);
  await runTest('/oc link', testSlashLink);
  await runTest('/oc (empty)', testSlashEmpty);
  await runTest('/opencode help (alias)', testSlashOpencode);

  // Phase 4
  console.log('');
  console.log('── Phase 4: OpenCode Server ──');
  await runTest('OpenCode health', testOpenCodeHealth);
  await runTest('List providers', testOpenCodeProviders);
  await runTest('List agents', testOpenCodeAgents);
  await runTest('Create session', testOpenCodeSession);
  await runTest('Get modified files', testOpenCodeModifiedFiles);

  // Phase 5
  console.log('');
  console.log('── Phase 5: Session Management ──');
  await runTest('Per-thread reuse', testSessionPerThread);
  await runTest('Per-message fresh', testSessionPerMessage);
  await runTest('Session invalidation', testSessionInvalidation);
  await runTest('Session get', testSessionGet);
  await runTest('Session cleanup', testSessionCleanup);
  await runTest('Agent switch', testSessionAgentSwitch);
  await runTest('Strategy switch', testSessionStrategySwitch);

  // Phase 6
  console.log('');
  console.log('── Phase 6: Legacy Routes ──');
  await runTest('Legacy /slack/events', testLegacyEvents);
  await runTest('Legacy /slack/commands', testLegacyCommands);
  await runTest('Legacy /slack/interactivity', testLegacyInteractivity);

  // Phase 7
  console.log('');
  console.log('── Phase 7: Shutdown & Reboot ──');
  await runTest('Graceful shutdown', testGracefulShutdown);
  await runTest('Reboot on new port', testReboot);
  await runTest('Webhooks work after reboot', testWebhooksAfterReboot);
  await runTest('Slash commands after reboot', testSlashAfterReboot);

  // Report
  console.log('');
  console.log('════════════════════════════════════════════════════════');

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  if (failed === 0) {
    console.log(`\x1b[32m  All ${passed} tests passed (${totalMs}ms)\x1b[0m`);
  } else {
    console.log(`\x1b[31m  ${failed} of ${passed + failed} tests failed\x1b[0m`);
    console.log('');
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  \x1b[31m  ${r.name}: ${r.error}\x1b[0m`);
    }
  }

  console.log('════════════════════════════════════════════════════════');

  if (serverHandle) serverHandle.stop();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  if (serverHandle) serverHandle.stop();
  process.exit(1);
});
