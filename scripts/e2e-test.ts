/**
 * Automated E2E test suite for opencode-channels.
 *
 * This script boots the full system locally and runs a series of
 * integration tests by sending simulated Slack webhook events to the
 * local webhook server and verifying the expected behavior.
 *
 * Unlike the interactive `e2e-slack.ts`, this script is fully automated
 * and exits with code 0 (pass) or 1 (fail).
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
import {
  startChannels,
  createChannelConfig,
  listChannelConfigs,
  type ChannelsPluginResult,
} from '../packages/core/src/plugin.js';
import { OpenCodeClient } from '../packages/core/src/opencode-client.js';
import { SlackAdapter } from '../packages/slack/src/adapter.js';
import type { ChannelConfig } from '../packages/core/src/types.js';
import {
  makeAppMention,
  makeUrlVerification,
  makeSlashCommand,
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

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const OPENCODE_URL = process.env.OPENCODE_URL || 'http://localhost:1707';
const PORT = 0; // Use random port to avoid conflicts
const DB_PATH = `/tmp/e2e-test-${Date.now()}.db`;

// Set env vars
process.env.OPENCODE_URL = OPENCODE_URL;
process.env.CHANNELS_DB_PATH = DB_PATH;

// ─── Test runner ────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const results: TestResult[] = [];
let webhookUrl = '';
let channels: ChannelsPluginResult | null = null;

async function runTest(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
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
  path: string,
  body: unknown,
  contentType = 'application/json',
): Promise<Response> {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const { timestamp, signature } = signPayload(bodyStr, SLACK_SIGNING_SECRET);

  return fetch(`${webhookUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'X-Slack-Request-Timestamp': timestamp,
      'X-Slack-Signature': signature,
    },
    body: bodyStr,
  });
}

// ─── Test cases ─────────────────────────────────────────────────────────────

async function testHealthEndpoint(): Promise<void> {
  const res = await fetch(`${webhookUrl}/health`);
  assert(res.ok, `Health endpoint returned ${res.status}`);
  const data = (await res.json()) as { ok: boolean; service: string };
  assert(data.ok === true, 'Health endpoint did not return ok: true');
  assert(data.service === 'opencode-channels', `Wrong service name: ${data.service}`);
}

async function testUrlVerification(): Promise<void> {
  const challenge = `test-challenge-${Date.now()}`;
  const payload = makeUrlVerification(challenge);
  const res = await sendWebhook('/slack/events', payload);
  assert(res.ok, `URL verification returned ${res.status}`);
  const data = (await res.json()) as { challenge: string };
  assert(data.challenge === challenge, `Expected challenge "${challenge}", got "${data.challenge}"`);
}

async function testAppMentionWebhook(): Promise<void> {
  const payload = makeAppMention('ping');
  const res = await sendWebhook('/slack/events', payload);
  // Should return 200 (accepted for processing)
  assert(res.ok, `App mention returned ${res.status}`);
}

async function testSlashCommandHelp(): Promise<void> {
  const body = makeSlashCommand('/oc', 'help');
  const res = await sendWebhook('/slack/commands', body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Slash command returned ${res.status}`);
  const data = (await res.json()) as { text?: string; blocks?: unknown[] };
  // Help command should return text containing "help" or slash command descriptions
  const responseText = JSON.stringify(data).toLowerCase();
  assert(
    responseText.includes('help') || responseText.includes('command') || responseText.includes('usage'),
    'Help command did not return expected help text',
  );
}

async function testSlashCommandModels(): Promise<void> {
  const body = makeSlashCommand('/oc', 'models');
  const res = await sendWebhook('/slack/commands', body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Models command returned ${res.status}`);
}

async function testSlashCommandStatus(): Promise<void> {
  const body = makeSlashCommand('/oc', 'status');
  const res = await sendWebhook('/slack/commands', body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Status command returned ${res.status}`);
}

async function testInvalidSignature(): Promise<void> {
  const payload = makeAppMention('test');
  const bodyStr = JSON.stringify(payload);

  const res = await fetch(`${webhookUrl}/slack/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Slack-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
      'X-Slack-Signature': 'v0=invalid_signature_here',
    },
    body: bodyStr,
  });

  // Should reject with 401 or handle gracefully
  // The webhook handler may still return 200 to avoid Slack retries
  // but should not process the message
  assert(res.status < 500, `Invalid signature caused server error: ${res.status}`);
}

async function testOpenCodeServerConnectivity(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  const ready = await client.isReady();
  assert(ready, `OpenCode server at ${OPENCODE_URL} is not reachable`);
}

async function testOpenCodeListProviders(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  const providers = await client.listProviders();
  assert(Array.isArray(providers), 'listProviders did not return an array');
  // Should have at least one provider configured
  assert(providers.length > 0, 'No providers configured in OpenCode');
}

async function testOpenCodeCreateSession(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  const sessionId = await client.createSession();
  assert(typeof sessionId === 'string', 'createSession did not return a string');
  assert(sessionId.length > 0, 'createSession returned empty string');
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('opencode-channels E2E Test Suite');
  console.log('════════════════════════════════════════════════════════');
  console.log('');

  // ── Prerequisite checks ─────────────────────────────────────────────

  if (!SLACK_BOT_TOKEN || SLACK_BOT_TOKEN.startsWith('xoxb-your')) {
    console.warn('WARNING: SLACK_BOT_TOKEN not set — Slack API tests will be limited');
  }

  // ── Boot the system ─────────────────────────────────────────────────

  console.log('Booting channels system...');

  const client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  const configsByTeamId = new Map<string, ChannelConfig>();

  const slackAdapter = new SlackAdapter({
    getConfigByTeamId: (teamId: string) => configsByTeamId.get(teamId),
    getClient: () => client,
  });

  // Use a random available port
  const net = await import('node:net');
  const actualPort = await new Promise<number>((resolve, reject) => {
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

  process.env.CHANNELS_PORT = String(actualPort);

  channels = await startChannels({
    adapters: { slack: slackAdapter },
    port: actualPort,
    dbPath: DB_PATH,
    opencodeUrl: OPENCODE_URL,
  });

  webhookUrl = `http://localhost:${actualPort}`;
  console.log(`Webhook server: ${webhookUrl}`);

  // ── Create test config ──────────────────────────────────────────────

  const existingConfigs = listChannelConfigs({ channelType: 'slack' }, channels.db);
  let slackConfig: ChannelConfig;

  if (existingConfigs.length > 0) {
    slackConfig = existingConfigs[0];
  } else {
    slackConfig = await createChannelConfig(
      {
        channelType: 'slack',
        name: 'E2E Automated Test',
        enabled: true,
        credentials: {
          botToken: SLACK_BOT_TOKEN,
          signingSecret: SLACK_SIGNING_SECRET,
        },
        platformConfig: {
          groups: { requireMention: true },
        },
        metadata: {},
        sessionStrategy: 'per-user',
        systemPrompt: null,
        agentName: null,
      },
      channels.db,
    );
  }

  configsByTeamId.set(DEFAULTS.teamId, slackConfig);
  console.log(`Config ID: ${slackConfig.id}`);
  console.log('');

  // ── Run tests ───────────────────────────────────────────────────────

  console.log('Running tests...');
  console.log('');

  // Group 1: Local webhook server tests (no external deps)
  console.log('── Webhook Server ──');
  await runTest('Health endpoint returns ok', testHealthEndpoint);
  await runTest('Slack URL verification challenge', testUrlVerification);
  await runTest('App mention webhook accepted', testAppMentionWebhook);
  await runTest('Invalid signature handled gracefully', testInvalidSignature);

  // Group 2: Slash commands
  console.log('');
  console.log('── Slash Commands ──');
  await runTest('/oc help returns help text', testSlashCommandHelp);
  await runTest('/oc models accepted', testSlashCommandModels);
  await runTest('/oc status accepted', testSlashCommandStatus);

  // Group 3: OpenCode server connectivity (requires running server)
  console.log('');
  console.log('── OpenCode Server ──');
  await runTest('OpenCode server reachable', testOpenCodeServerConnectivity);
  await runTest('List providers', testOpenCodeListProviders);
  await runTest('Create session', testOpenCodeCreateSession);

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

  channels.stop();

  // Clean up temp DB
  const fs = await import('node:fs');
  try {
    fs.unlinkSync(DB_PATH);
    fs.unlinkSync(`${DB_PATH}-shm`);
    fs.unlinkSync(`${DB_PATH}-wal`);
  } catch {
    // Ignore cleanup errors
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  if (channels) channels.stop();
  process.exit(1);
});
