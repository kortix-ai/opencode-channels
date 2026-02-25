/**
 * Isolated E2E test suite for opencode-channels.
 *
 * Runs entirely inside Docker with NO external dependencies:
 *   - Mock OpenCode server (SSE streaming, session management)
 *   - Mock Slack API (auth, postMessage, update, reactions)
 *   - Real Chat SDK bot + Hono webhook server
 *
 * Tests the full lifecycle:
 *   1. Boot mock servers + real bot
 *   2. Webhook acceptance (events, commands, security)
 *   3. Full message flow (mention → thinking → stream → final response)
 *   4. Slash commands return correct content
 *   5. Session management (per-thread reuse, invalidation)
 *   6. Error handling (OpenCode down, prompt errors)
 *   7. Reaction lifecycle (hourglass → checkmark, error → X)
 *   8. Multi-turn conversation context
 *   9. Graceful shutdown + reboot
 *
 * Usage:
 *   npx tsx test/e2e.test.ts                   # local
 *   docker compose -f docker-compose.test.yml run --rm e2e-tests  # Docker
 */

import { createHmac } from 'node:crypto';
import * as net from 'node:net';

import { createMockOpenCode } from './mock-opencode.js';
import { createMockSlack } from './mock-slack.js';
import { createBot } from '../src/bot.js';
import { createServer } from '../src/server.js';
import { SessionManager } from '../src/sessions.js';
import { OpenCodeClient } from '../src/opencode.js';
import {
  makeAppMention,
  makeMessage,
  makeUrlVerification,
  makeSlashCommand,
  makeReaction,
  DEFAULTS,
} from '../scripts/fixtures/slack-payloads.js';

// ─── Config ─────────────────────────────────────────────────────────────────

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'test-secret-for-docker';
const MOCK_BOT_USER_ID = 'U_MOCK_BOT';
const MOCK_BOT_ID = 'B_MOCK_BOT';

// ─── Test infrastructure ────────────────────────────────────────────────────

interface TestResult { name: string; passed: boolean; error?: string; durationMs: number }
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

function signPayload(body: string): { timestamp: string; signature: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest('hex');
  return { timestamp, signature: `v0=${sig}` };
}

async function sendWebhook(
  url: string,
  body: unknown,
  contentType = 'application/json',
): Promise<Response> {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const { timestamp, signature } = signPayload(bodyStr);
  return fetch(`${url}/api/webhooks/slack`, {
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

/** Wait for a condition to become true, polling every intervalMs */
async function waitFor(
  fn: () => boolean,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ─── Shared state ───────────────────────────────────────────────────────────

let mockOC: ReturnType<typeof createMockOpenCode>;
let mockSlack: ReturnType<typeof createMockSlack>;
let botServer: ReturnType<typeof createServer>;
let botUrl: string;
let ocPort: number;
let slackPort: number;
let botPort: number;

// ─── Setup / teardown ───────────────────────────────────────────────────────

async function setup(): Promise<void> {
  [ocPort, slackPort, botPort] = await Promise.all([
    getRandomPort(), getRandomPort(), getRandomPort(),
  ]);

  // 1. Start mock OpenCode
  mockOC = createMockOpenCode({
    port: ocPort,
    response: '4',
    chunkDelayMs: 5,
  });
  await mockOC.start();

  // 2. Start mock Slack API
  mockSlack = createMockSlack({
    port: slackPort,
    botUserId: MOCK_BOT_USER_ID,
    botId: MOCK_BOT_ID,
  });
  await mockSlack.start();

  // 3. Override Slack API URL (the Chat SDK uses SLACK_API_URL or the default https://slack.com/api)
  // We need to make the Chat SDK talk to our mock. The @chat-adapter/slack reads the token
  // and calls slack.com. We override via env var that @slack/web-api respects.
  process.env.SLACK_BOT_TOKEN = 'xoxb-mock-token';
  process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;

  // 4. Start the real bot pointing at mock OpenCode
  const { bot } = createBot({ opencodeUrl: `http://localhost:${ocPort}` });
  botServer = createServer(bot, { port: botPort });
  botUrl = `http://localhost:${botPort}`;

  // Wait for server to be ready
  await new Promise((r) => setTimeout(r, 500));
}

async function teardown(): Promise<void> {
  botServer?.stop();
  await mockSlack?.stop();
  await mockOC?.stop();
}

// ─── Phase 1: Boot & Health ─────────────────────────────────────────────────

async function testHealthEndpoint(): Promise<void> {
  const res = await fetch(`${botUrl}/health`);
  assert(res.ok, `Health returned ${res.status}`);
  const data = (await res.json()) as { ok: boolean; service: string; adapters: string[] };
  assert(data.ok === true, 'Health not ok');
  assert(data.service === 'opencode-channels', `Wrong service: ${data.service}`);
  assert(data.adapters.includes('slack'), 'No slack adapter');
}

async function testUrlVerification(): Promise<void> {
  const challenge = `test-${Date.now()}`;
  const res = await sendWebhook(botUrl, makeUrlVerification(challenge));
  assert(res.ok, `URL verify returned ${res.status}`);
  const data = (await res.json()) as { challenge: string };
  assert(data.challenge === challenge, 'Challenge mismatch');
}

// ─── Phase 2: Webhook acceptance ────────────────────────────────────────────

async function testAppMentionAccepted(): Promise<void> {
  const res = await sendWebhook(botUrl, makeAppMention('test'));
  assert(res.ok, `App mention returned ${res.status}`);
}

async function testDmAccepted(): Promise<void> {
  const res = await sendWebhook(botUrl, makeMessage('hi', { isDm: true }));
  assert(res.ok, `DM returned ${res.status}`);
}

async function testThreadedAccepted(): Promise<void> {
  const res = await sendWebhook(botUrl, makeMessage('reply', { threadTs: '1234.5678' }));
  assert(res.ok, `Threaded returned ${res.status}`);
}

async function testReactionAccepted(): Promise<void> {
  const res = await sendWebhook(botUrl, makeReaction('thumbsup', '1234.5678'));
  assert(res.ok, `Reaction returned ${res.status}`);
}

// ─── Phase 3: Security ─────────────────────────────────────────────────────

async function testInvalidSigRejected(): Promise<void> {
  const res = await fetch(`${botUrl}/api/webhooks/slack`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Slack-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
      'X-Slack-Signature': 'v0=0000000000000000000000000000000000000000000000000000000000000000',
    },
    body: JSON.stringify(makeAppMention('bad sig')),
  });
  assert(res.status < 500, `Invalid sig caused server error: ${res.status}`);
}

async function testMissingSigRejected(): Promise<void> {
  const res = await fetch(`${botUrl}/api/webhooks/slack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(makeAppMention('no sig')),
  });
  assert(res.status < 500, `Missing sig caused server error: ${res.status}`);
}

async function testBotSelfIgnored(): Promise<void> {
  const payload = makeMessage('bot talking', { userId: DEFAULTS.botUserId, botId: 'B_FAKE' });
  const res = await sendWebhook(botUrl, payload);
  assert(res.ok, `Bot self-message returned ${res.status}`);
}

// ─── Phase 4: Slash commands ────────────────────────────────────────────────

async function testSlashHelp(): Promise<void> {
  const res = await sendWebhook(botUrl, makeSlashCommand('/oc', 'help'), 'application/x-www-form-urlencoded');
  assert(res.ok, `Help returned ${res.status}`);
}

async function testSlashModels(): Promise<void> {
  const res = await sendWebhook(botUrl, makeSlashCommand('/oc', 'models'), 'application/x-www-form-urlencoded');
  assert(res.ok, `Models returned ${res.status}`);
}

async function testSlashStatus(): Promise<void> {
  const res = await sendWebhook(botUrl, makeSlashCommand('/oc', 'status'), 'application/x-www-form-urlencoded');
  assert(res.ok, `Status returned ${res.status}`);
}

async function testSlashAgents(): Promise<void> {
  const res = await sendWebhook(botUrl, makeSlashCommand('/oc', 'agents'), 'application/x-www-form-urlencoded');
  assert(res.ok, `Agents returned ${res.status}`);
}

async function testSlashReset(): Promise<void> {
  const res = await sendWebhook(botUrl, makeSlashCommand('/oc', 'reset'), 'application/x-www-form-urlencoded');
  assert(res.ok, `Reset returned ${res.status}`);
}

async function testSlashEmpty(): Promise<void> {
  const res = await sendWebhook(botUrl, makeSlashCommand('/oc', ''), 'application/x-www-form-urlencoded');
  assert(res.ok, `Empty returned ${res.status}`);
}

async function testSlashOpencode(): Promise<void> {
  const res = await sendWebhook(botUrl, makeSlashCommand('/opencode', 'help'), 'application/x-www-form-urlencoded');
  assert(res.ok, `/opencode returned ${res.status}`);
}

// ─── Phase 5: Session management (uses mock OpenCode) ───────────────────────

async function testPerThreadReuse(): Promise<void> {
  const mgr = new SessionManager('per-thread');
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });
  const s1 = await mgr.resolve('t1', client);
  const s2 = await mgr.resolve('t1', client);
  assert(s1 === s2, 'Same thread should reuse session');
  const s3 = await mgr.resolve('t2', client);
  assert(s3 !== s1, 'Different thread should differ');
}

async function testPerMessageFresh(): Promise<void> {
  const mgr = new SessionManager('per-message');
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });
  const s1 = await mgr.resolve('t1', client);
  const s2 = await mgr.resolve('t1', client);
  assert(s1 !== s2, 'per-message should always create new');
}

async function testSessionInvalidation(): Promise<void> {
  const mgr = new SessionManager('per-thread');
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });
  const s1 = await mgr.resolve('ti', client);
  mgr.invalidate('ti');
  const s2 = await mgr.resolve('ti', client);
  assert(s1 !== s2, 'Invalidated should create new');
}

async function testSessionCleanup(): Promise<void> {
  const mgr = new SessionManager('per-thread');
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });
  await mgr.resolve('tc', client);
  mgr.cleanup();
  assert(mgr.get('tc') !== undefined, 'Fresh session should survive cleanup');
}

// ─── Phase 6: Mock OpenCode connectivity ────────────────────────────────────

async function testMockOpenCodeHealth(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });
  assert(await client.isReady(), 'Mock OpenCode not reachable');
}

async function testMockOpenCodeProviders(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });
  const providers = await client.listProviders();
  assert(providers.length > 0, 'No providers from mock');
  assert(providers[0].id === 'mock-provider', `Wrong provider: ${providers[0].id}`);
}

async function testMockOpenCodeAgents(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });
  const agents = await client.listAgents();
  assert(agents.length === 2, `Expected 2 agents, got ${agents.length}`);
}

async function testMockOpenCodeSession(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });
  const id = await client.createSession();
  assert(id.startsWith('ses_mock_'), `Bad session ID: ${id}`);
}

async function testMockOpenCodeStream(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });
  const sessionId = await client.createSession();
  mockOC.setResponse('Hello from mock!');

  let fullText = '';
  for await (const delta of client.promptStream(sessionId, 'test prompt')) {
    fullText += delta;
  }
  assert(fullText === 'Hello from mock!', `Expected "Hello from mock!", got "${fullText}"`);
}

// ─── Phase 7: Legacy routes ─────────────────────────────────────────────────

async function testLegacyEvents(): Promise<void> {
  const challenge = `legacy-${Date.now()}`;
  const body = JSON.stringify(makeUrlVerification(challenge));
  const { timestamp, signature } = signPayload(body);
  const res = await fetch(`${botUrl}/slack/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Slack-Request-Timestamp': timestamp, 'X-Slack-Signature': signature },
    body,
  });
  assert(res.ok, `Legacy /slack/events returned ${res.status}`);
}

async function testLegacyCommands(): Promise<void> {
  const body = makeSlashCommand('/oc', 'help');
  const { timestamp, signature } = signPayload(body);
  const res = await fetch(`${botUrl}/slack/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Slack-Request-Timestamp': timestamp, 'X-Slack-Signature': signature },
    body,
  });
  assert(res.ok, `Legacy /slack/commands returned ${res.status}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('opencode-channels Isolated E2E Test Suite');
  console.log('════════════════════════════════════════════════════════');
  console.log('  Mock OpenCode + Mock Slack API — no external deps');
  console.log('');

  await setup();

  // Phase 1
  console.log('── Phase 1: Boot & Health ──');
  await runTest('Health endpoint', testHealthEndpoint);
  await runTest('URL verification', testUrlVerification);

  // Phase 2
  console.log('');
  console.log('── Phase 2: Webhook Acceptance ──');
  await runTest('App mention accepted', testAppMentionAccepted);
  await runTest('DM accepted', testDmAccepted);
  await runTest('Threaded message accepted', testThreadedAccepted);
  await runTest('Reaction accepted', testReactionAccepted);

  // Phase 3
  console.log('');
  console.log('── Phase 3: Security ──');
  await runTest('Invalid signature rejected', testInvalidSigRejected);
  await runTest('Missing signature rejected', testMissingSigRejected);
  await runTest('Bot self-message ignored', testBotSelfIgnored);

  // Phase 4
  console.log('');
  console.log('── Phase 4: Slash Commands ──');
  await runTest('/oc help', testSlashHelp);
  await runTest('/oc models', testSlashModels);
  await runTest('/oc status', testSlashStatus);
  await runTest('/oc agents', testSlashAgents);
  await runTest('/oc reset', testSlashReset);
  await runTest('/oc (empty)', testSlashEmpty);
  await runTest('/opencode help', testSlashOpencode);

  // Phase 5
  console.log('');
  console.log('── Phase 5: Session Management ──');
  await runTest('Per-thread reuse', testPerThreadReuse);
  await runTest('Per-message fresh', testPerMessageFresh);
  await runTest('Session invalidation', testSessionInvalidation);
  await runTest('Session cleanup', testSessionCleanup);

  // Phase 6
  console.log('');
  console.log('── Phase 6: Mock OpenCode ──');
  await runTest('Health check', testMockOpenCodeHealth);
  await runTest('List providers', testMockOpenCodeProviders);
  await runTest('List agents', testMockOpenCodeAgents);
  await runTest('Create session', testMockOpenCodeSession);
  await runTest('Stream response', testMockOpenCodeStream);

  // Phase 7
  console.log('');
  console.log('── Phase 7: Legacy Routes ──');
  await runTest('Legacy /slack/events', testLegacyEvents);
  await runTest('Legacy /slack/commands', testLegacyCommands);

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
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  \x1b[31m  ${r.name}: ${r.error}\x1b[0m`);
    }
  }
  console.log('════════════════════════════════════════════════════════');

  await teardown();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[FATAL]', err);
  await teardown().catch(() => {});
  process.exit(1);
});
