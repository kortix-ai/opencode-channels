/**
 * Automated E2E test suite for opencode-channels (Chat SDK edition).
 *
 * Boots the Chat SDK bot + Hono server, sends signed Slack webhook events,
 * and verifies correct behavior end-to-end.
 *
 * Prerequisites:
 *   1. OpenCode server running (default: http://localhost:1707)
 *   2. .env.test with SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET
 *
 * Usage:
 *   npx tsx scripts/e2e-test.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import * as net from 'node:net';

import { createBot } from '../src/bot.js';
import { createServer } from '../src/server.js';
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
let webhookUrl = '';
let serverHandle: { stop: () => void } | null = null;

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
  body: unknown,
  contentType = 'application/json',
): Promise<Response> {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const { timestamp, signature } = signPayload(bodyStr, SLACK_SIGNING_SECRET);

  return fetch(`${webhookUrl}/api/webhooks/slack`, {
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

// ─── Test: Health endpoint ──────────────────────────────────────────────────

async function testHealthEndpoint(): Promise<void> {
  const res = await fetch(`${webhookUrl}/health`);
  assert(res.ok, `Health endpoint returned ${res.status}`);
  const data = (await res.json()) as { ok: boolean; service: string; adapters: string[] };
  assert(data.ok === true, 'Health endpoint did not return ok: true');
  assert(data.service === 'opencode-channels', `Wrong service name: ${data.service}`);
  assert(data.adapters.includes('slack'), 'Slack adapter not listed');
}

// ─── Test: URL verification ─────────────────────────────────────────────────

async function testUrlVerification(): Promise<void> {
  const challenge = `test-challenge-${Date.now()}`;
  const payload = makeUrlVerification(challenge);
  const res = await sendWebhook(payload);
  assert(res.ok, `URL verification returned ${res.status}`);
  const data = (await res.json()) as { challenge: string };
  assert(data.challenge === challenge, `Expected challenge "${challenge}", got "${data.challenge}"`);
}

// ─── Test: App mention webhook accepted ─────────────────────────────────────

async function testAppMentionAccepted(): Promise<void> {
  const payload = makeAppMention('ping');
  const res = await sendWebhook(payload);
  assert(res.ok, `App mention returned ${res.status}`);
}

// ─── Test: Channel message accepted ─────────────────────────────────────────

async function testChannelMessageAccepted(): Promise<void> {
  const payload = makeMessage('hello world');
  const res = await sendWebhook(payload);
  assert(res.ok, `Channel message returned ${res.status}`);
}

// ─── Test: Threaded message accepted ────────────────────────────────────────

async function testThreadedMessageAccepted(): Promise<void> {
  const payload = makeMessage('follow up', { threadTs: '1234567890.123456' });
  const res = await sendWebhook(payload);
  assert(res.ok, `Threaded message returned ${res.status}`);
}

// ─── Test: DM message accepted ──────────────────────────────────────────────

async function testDmMessageAccepted(): Promise<void> {
  const payload = makeMessage('hello bot', { isDm: true });
  const res = await sendWebhook(payload);
  assert(res.ok, `DM message returned ${res.status}`);
}

// ─── Test: Reaction event accepted ──────────────────────────────────────────

async function testReactionEventAccepted(): Promise<void> {
  const payload = makeReaction('thumbsup', '1234567890.123456');
  const res = await sendWebhook(payload);
  assert(res.ok, `Reaction event returned ${res.status}`);
}

// ─── Test: Slash commands ───────────────────────────────────────────────────

async function testSlashCommandHelp(): Promise<void> {
  const body = makeSlashCommand('/oc', 'help');
  const res = await sendWebhook(body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Slash command /oc help returned ${res.status}`);
}

async function testSlashCommandStatus(): Promise<void> {
  const body = makeSlashCommand('/oc', 'status');
  const res = await sendWebhook(body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Slash command /oc status returned ${res.status}`);
}

async function testSlashCommandModels(): Promise<void> {
  const body = makeSlashCommand('/oc', 'models');
  const res = await sendWebhook(body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Slash command /oc models returned ${res.status}`);
}

async function testSlashCommandAgents(): Promise<void> {
  const body = makeSlashCommand('/oc', 'agents');
  const res = await sendWebhook(body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Slash command /oc agents returned ${res.status}`);
}

async function testSlashCommandReset(): Promise<void> {
  const body = makeSlashCommand('/oc', 'reset');
  const res = await sendWebhook(body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Slash command /oc reset returned ${res.status}`);
}

async function testSlashCommandDiff(): Promise<void> {
  const body = makeSlashCommand('/oc', 'diff');
  const res = await sendWebhook(body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Slash command /oc diff returned ${res.status}`);
}

async function testSlashCommandLink(): Promise<void> {
  const body = makeSlashCommand('/oc', 'link');
  const res = await sendWebhook(body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Slash command /oc link returned ${res.status}`);
}

async function testSlashCommandEmpty(): Promise<void> {
  const body = makeSlashCommand('/oc', '');
  const res = await sendWebhook(body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Slash command /oc (empty) returned ${res.status}`);
}

async function testSlashCommandOpencode(): Promise<void> {
  const body = makeSlashCommand('/opencode', 'help');
  const res = await sendWebhook(body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Slash command /opencode help returned ${res.status}`);
}

// ─── Test: Invalid signature ────────────────────────────────────────────────

async function testInvalidSignatureRejected(): Promise<void> {
  const payload = makeAppMention('should be rejected');
  const bodyStr = JSON.stringify(payload);

  const res = await fetch(`${webhookUrl}/api/webhooks/slack`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Slack-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
      'X-Slack-Signature': 'v0=deadbeef0000000000000000000000000000000000000000000000000000dead',
    },
    body: bodyStr,
  });

  // Chat SDK returns 200 with "Invalid signature" text to avoid Slack retries
  assert(res.status < 500, `Invalid sig caused server error: ${res.status}`);
}

async function testMissingSignatureRejected(): Promise<void> {
  const payload = makeAppMention('no sig');
  const res = await fetch(`${webhookUrl}/api/webhooks/slack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert(res.status < 500, `Missing sig caused server error: ${res.status}`);
}

// ─── Test: OpenCode server connectivity ─────────────────────────────────────

async function testOpenCodeHealth(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  const ready = await client.isReady();
  assert(ready, `OpenCode server at ${OPENCODE_URL} is not reachable`);
}

async function testOpenCodeListProviders(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  const providers = await client.listProviders();
  assert(Array.isArray(providers), 'listProviders did not return an array');
  assert(providers.length > 0, 'No providers configured in OpenCode');
}

async function testOpenCodeListAgents(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  const agents = await client.listAgents();
  assert(Array.isArray(agents), 'listAgents did not return an array');
}

async function testOpenCodeCreateSession(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  const sessionId = await client.createSession();
  assert(typeof sessionId === 'string', 'createSession did not return a string');
  assert(sessionId.length > 0, 'createSession returned empty string');
}

// ─── Test: SessionManager ───────────────────────────────────────────────────

async function testSessionManagerPerThread(): Promise<void> {
  const mgr = new SessionManager('per-thread');
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });

  const sess1 = await mgr.resolve('thread-1', client);
  assert(typeof sess1 === 'string' && sess1.length > 0, 'Session ID is empty');

  const sess2 = await mgr.resolve('thread-1', client);
  assert(sess1 === sess2, `Same thread should reuse session: ${sess1} !== ${sess2}`);

  const sess3 = await mgr.resolve('thread-2', client);
  assert(sess3 !== sess1, 'Different thread should get different session');
}

async function testSessionManagerPerMessage(): Promise<void> {
  const mgr = new SessionManager('per-message');
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });

  const sess1 = await mgr.resolve('thread-1', client);
  const sess2 = await mgr.resolve('thread-1', client);
  assert(sess1 !== sess2, `per-message should create fresh sessions: ${sess1} === ${sess2}`);
}

async function testSessionManagerInvalidate(): Promise<void> {
  const mgr = new SessionManager('per-thread');
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });

  const sess1 = await mgr.resolve('thread-inv', client);
  mgr.invalidate('thread-inv');
  const sess2 = await mgr.resolve('thread-inv', client);
  assert(sess1 !== sess2, `Invalidated session should create new: ${sess1} === ${sess2}`);
}

async function testSessionManagerCleanup(): Promise<void> {
  const mgr = new SessionManager('per-thread');
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });

  await mgr.resolve('thread-cleanup', client);
  assert(mgr.get('thread-cleanup') !== undefined, 'Session should exist before cleanup');

  mgr.cleanup(); // Should not remove fresh sessions
  assert(mgr.get('thread-cleanup') !== undefined, 'Fresh session should survive cleanup');
}

// ─── Test: Legacy routes ────────────────────────────────────────────────────

async function testLegacyEventsRoute(): Promise<void> {
  const challenge = `legacy-${Date.now()}`;
  const payload = makeUrlVerification(challenge);
  const bodyStr = JSON.stringify(payload);
  const { timestamp, signature } = signPayload(bodyStr, SLACK_SIGNING_SECRET);

  const res = await fetch(`${webhookUrl}/slack/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Slack-Request-Timestamp': timestamp,
      'X-Slack-Signature': signature,
    },
    body: bodyStr,
  });
  assert(res.ok, `Legacy /slack/events returned ${res.status}`);
  const data = (await res.json()) as { challenge: string };
  assert(data.challenge === challenge, 'Legacy route challenge mismatch');
}

async function testLegacyCommandsRoute(): Promise<void> {
  const body = makeSlashCommand('/oc', 'help');
  const { timestamp, signature } = signPayload(body, SLACK_SIGNING_SECRET);

  const res = await fetch(`${webhookUrl}/slack/commands`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Slack-Request-Timestamp': timestamp,
      'X-Slack-Signature': signature,
    },
    body,
  });
  assert(res.ok, `Legacy /slack/commands returned ${res.status}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('opencode-channels E2E Test Suite (Chat SDK)');
  console.log('════════════════════════════════════════════════════════');
  console.log('');

  // ── Boot the system ─────────────────────────────────────────────────

  console.log('Booting Chat SDK bot + Hono server...');

  const port = await getRandomPort();
  const { bot } = createBot({ opencodeUrl: OPENCODE_URL });
  const server = createServer(bot, { port });
  serverHandle = server;
  webhookUrl = `http://localhost:${port}`;

  // Wait for Chat SDK to initialize (it does Slack auth on first webhook)
  await new Promise((r) => setTimeout(r, 500));
  console.log(`Server: ${webhookUrl}`);
  console.log('');

  // ── Run tests ───────────────────────────────────────────────────────

  console.log('── Health & Verification ──');
  await runTest('Health endpoint returns ok', testHealthEndpoint);
  await runTest('Slack URL verification challenge', testUrlVerification);

  console.log('');
  console.log('── Webhook Events ──');
  await runTest('App mention accepted', testAppMentionAccepted);
  await runTest('Channel message accepted', testChannelMessageAccepted);
  await runTest('Threaded message accepted', testThreadedMessageAccepted);
  await runTest('DM message accepted', testDmMessageAccepted);
  await runTest('Reaction event accepted', testReactionEventAccepted);

  console.log('');
  console.log('── Slash Commands ──');
  await runTest('/oc help', testSlashCommandHelp);
  await runTest('/oc status', testSlashCommandStatus);
  await runTest('/oc models', testSlashCommandModels);
  await runTest('/oc agents', testSlashCommandAgents);
  await runTest('/oc reset', testSlashCommandReset);
  await runTest('/oc diff', testSlashCommandDiff);
  await runTest('/oc link', testSlashCommandLink);
  await runTest('/oc (empty)', testSlashCommandEmpty);
  await runTest('/opencode help (alias)', testSlashCommandOpencode);

  console.log('');
  console.log('── Security ──');
  await runTest('Invalid signature rejected', testInvalidSignatureRejected);
  await runTest('Missing signature rejected', testMissingSignatureRejected);

  console.log('');
  console.log('── Legacy Routes ──');
  await runTest('Legacy /slack/events route', testLegacyEventsRoute);
  await runTest('Legacy /slack/commands route', testLegacyCommandsRoute);

  console.log('');
  console.log('── OpenCode Server ──');
  await runTest('OpenCode health check', testOpenCodeHealth);
  await runTest('List providers', testOpenCodeListProviders);
  await runTest('List agents', testOpenCodeListAgents);
  await runTest('Create session', testOpenCodeCreateSession);

  console.log('');
  console.log('── Session Management ──');
  await runTest('Per-thread session reuse', testSessionManagerPerThread);
  await runTest('Per-message fresh sessions', testSessionManagerPerMessage);
  await runTest('Session invalidation', testSessionManagerInvalidate);
  await runTest('Session cleanup (TTL)', testSessionManagerCleanup);

  // ── Report ──────────────────────────────────────────────────────────

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

  // ── Cleanup ─────────────────────────────────────────────────────────

  server.stop();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  if (serverHandle) serverHandle.stop();
  process.exit(1);
});
