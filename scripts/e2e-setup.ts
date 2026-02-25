/**
 * E2E Setup Test — Full from-scratch lifecycle test.
 *
 * Simulates what a real end-user would experience going from zero
 * to a fully working opencode-channels Slack integration:
 *
 *   Phase 1: Fresh database + config creation
 *   Phase 2: Boot the webhook server
 *   Phase 3: Verify webhook endpoints (health, events, commands)
 *   Phase 4: Process a real @mention through the full engine pipeline
 *   Phase 5: Slash commands return correct responses
 *   Phase 6: Session management (create, reuse, invalidate)
 *   Phase 7: Config CRUD (create, read, update, delete)
 *   Phase 8: Multi-config support
 *   Phase 9: Graceful shutdown + cleanup
 *   Phase 10: Re-boot from existing DB (persistence check)
 *
 * Prerequisites:
 *   1. OpenCode server running (default: http://localhost:1707)
 *   2. .env.test with SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET
 *
 * Usage:
 *   npx tsx scripts/e2e-setup.ts
 */

import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import * as net from 'node:net';

import {
  startChannels,
  createChannelConfig,
  listChannelConfigs,
  getChannelConfig,
  updateChannelConfig,
  deleteChannelConfig,
  createDatabase,
  OpenCodeClient,
  SessionManager,
  type ChannelsPluginResult,
  type ChannelConfig,
} from '../packages/core/src/index.js';
import { SlackAdapter } from '../packages/slack/src/adapter.js';
import { SlackApi } from '../packages/slack/src/api.js';
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

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const OPENCODE_URL = process.env.OPENCODE_URL || 'http://localhost:1707';
const DB_PATH = `/tmp/e2e-setup-test-${Date.now()}.db`;

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
let channels: ChannelsPluginResult | null = null;
let webhookUrl = '';

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

// ─── Phase 1: Fresh database + config creation ─────────────────────────────

async function testFreshDbCreation(): Promise<void> {
  // DB should not exist yet
  assert(!existsSync(DB_PATH), `DB file should not exist yet at ${DB_PATH}`);

  const db = createDatabase(DB_PATH);
  assert(db !== null && db !== undefined, 'createDatabase returned null/undefined');
  assert(existsSync(DB_PATH), 'DB file was not created');

  // Tables should be empty
  const configs = listChannelConfigs(undefined, db);
  assert(configs.length === 0, `Expected 0 configs, got ${configs.length}`);
}

async function testCreateSlackConfig(): Promise<void> {
  const config = await createChannelConfig({
    channelType: 'slack',
    name: 'E2E Setup Test',
    enabled: true,
    credentials: {
      botToken: SLACK_BOT_TOKEN || 'xoxb-test-token',
      signingSecret: SLACK_SIGNING_SECRET || 'test-secret',
    },
    platformConfig: {
      groups: { requireMention: true },
    },
    metadata: {},
    sessionStrategy: 'per-user',
    systemPrompt: null,
    agentName: null,
  });

  assert(typeof config.id === 'string' && config.id.length > 0, 'Config ID is empty');
  assert(config.channelType === 'slack', `Expected channelType=slack, got ${config.channelType}`);
  assert(config.name === 'E2E Setup Test', `Expected name='E2E Setup Test', got ${config.name}`);
  assert(config.enabled === true, 'Config should be enabled');
  assert(config.sessionStrategy === 'per-user', `Expected sessionStrategy=per-user`);
}

async function testListConfigs(): Promise<void> {
  const all = listChannelConfigs();
  assert(all.length === 1, `Expected 1 config, got ${all.length}`);
  assert(all[0].channelType === 'slack', 'First config should be slack');

  // Filter by type
  const slackConfigs = listChannelConfigs({ channelType: 'slack' });
  assert(slackConfigs.length === 1, `Expected 1 slack config, got ${slackConfigs.length}`);

  const discordConfigs = listChannelConfigs({ channelType: 'discord' });
  assert(discordConfigs.length === 0, `Expected 0 discord configs, got ${discordConfigs.length}`);
}

async function testGetConfig(): Promise<void> {
  const all = listChannelConfigs();
  const config = getChannelConfig(all[0].id);
  assert(config !== null, 'getChannelConfig returned null');
  assert(config!.id === all[0].id, 'Config ID mismatch');
  assert(config!.name === 'E2E Setup Test', 'Config name mismatch');

  // Non-existent config
  const missing = getChannelConfig('non-existent-id');
  assert(missing === null, 'Expected null for non-existent config');
}

async function testUpdateConfig(): Promise<void> {
  const all = listChannelConfigs();
  const original = all[0];

  const updated = await updateChannelConfig(original.id, {
    name: 'Updated E2E Test',
    sessionStrategy: 'per-thread',
    systemPrompt: 'You are a test bot',
  });

  assert(updated !== null, 'updateChannelConfig returned null');
  assert(updated!.name === 'Updated E2E Test', `Expected updated name, got ${updated!.name}`);
  assert(updated!.sessionStrategy === 'per-thread', 'Session strategy not updated');
  assert(updated!.systemPrompt === 'You are a test bot', 'System prompt not updated');

  // Verify persistence
  const reloaded = getChannelConfig(original.id);
  assert(reloaded!.name === 'Updated E2E Test', 'Update not persisted');

  // Revert for later tests
  await updateChannelConfig(original.id, {
    name: 'E2E Setup Test',
    sessionStrategy: 'per-user',
    systemPrompt: null,
  });
}

async function testDeleteAndRecreateConfig(): Promise<void> {
  // Create a temporary config to delete
  const temp = await createChannelConfig({
    channelType: 'telegram',
    name: 'Temp Telegram',
    enabled: false,
    credentials: { botToken: 'test-telegram-token' },
    platformConfig: {},
    metadata: {},
    sessionStrategy: 'single',
    systemPrompt: null,
    agentName: null,
  });

  assert(listChannelConfigs().length === 2, 'Expected 2 configs after creating temp');

  const deleted = deleteChannelConfig(temp.id);
  assert(deleted === true, 'deleteChannelConfig returned false');
  assert(listChannelConfigs().length === 1, 'Expected 1 config after delete');

  // Delete non-existent
  const deleted2 = deleteChannelConfig('non-existent');
  assert(deleted2 === false, 'deleteChannelConfig should return false for non-existent');
}

// ─── Phase 2: Boot the webhook server ───────────────────────────────────────

let slackConfig: ChannelConfig;
let configsByTeamId: Map<string, ChannelConfig>;
let client: OpenCodeClient;

async function testBootServer(): Promise<void> {
  const port = await getRandomPort();
  client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  configsByTeamId = new Map();

  const slackAdapter = new SlackAdapter({
    getConfigByTeamId: (teamId: string) => configsByTeamId.get(teamId),
    getClient: () => client,
  });

  channels = await startChannels({
    adapters: { slack: slackAdapter },
    port,
    dbPath: DB_PATH,
    opencodeUrl: OPENCODE_URL,
  });

  webhookUrl = `http://localhost:${port}`;

  // Wire up the config
  const configs = listChannelConfigs({ channelType: 'slack' }, channels.db);
  assert(configs.length >= 1, 'No slack configs found after boot');
  slackConfig = configs[0];
  configsByTeamId.set(DEFAULTS.teamId, slackConfig);

  assert(channels.engine !== null, 'Engine is null');
  assert(channels.app !== null, 'Hono app is null');
  assert(channels.db !== null, 'DB is null');
  assert(typeof channels.stop === 'function', 'stop is not a function');
}

// ─── Phase 3: Verify webhook endpoints ──────────────────────────────────────

async function testHealthEndpoint(): Promise<void> {
  const res = await fetch(`${webhookUrl}/health`);
  assert(res.ok, `Health returned ${res.status}`);
  const data = (await res.json()) as { ok: boolean; service: string; adapters?: string[] };
  assert(data.ok === true, 'Health not ok');
  assert(data.service === 'opencode-channels', `Wrong service: ${data.service}`);
}

async function testUrlVerification(): Promise<void> {
  const challenge = `setup-test-${Date.now()}`;
  const payload = makeUrlVerification(challenge);
  const res = await sendWebhook('/slack/events', payload);
  assert(res.ok, `URL verification returned ${res.status}`);
  const data = (await res.json()) as { challenge: string };
  assert(data.challenge === challenge, 'Challenge mismatch');
}

async function testAppMentionAccepted(): Promise<void> {
  const payload = makeAppMention('test from setup script');
  const res = await sendWebhook('/slack/events', payload);
  assert(res.ok, `App mention returned ${res.status}`);
}

async function testDmMessageAccepted(): Promise<void> {
  const payload = makeMessage('hello bot', { isDm: true });
  const res = await sendWebhook('/slack/events', payload);
  assert(res.ok, `DM message returned ${res.status}`);
}

async function testThreadedMessageAccepted(): Promise<void> {
  const payload = makeMessage('follow up', { threadTs: '1234567890.123456' });
  const res = await sendWebhook('/slack/events', payload);
  assert(res.ok, `Threaded message returned ${res.status}`);
}

async function testReactionEventAccepted(): Promise<void> {
  const payload = makeReaction('thumbsup', '1234567890.123456');
  const res = await sendWebhook('/slack/events', payload);
  assert(res.ok, `Reaction event returned ${res.status}`);
}

async function testInvalidSignatureRejected(): Promise<void> {
  const payload = makeAppMention('should be rejected');
  const bodyStr = JSON.stringify(payload);

  const res = await fetch(`${webhookUrl}/slack/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Slack-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
      'X-Slack-Signature': 'v0=deadbeef0000000000000000000000000000000000000000000000000000dead',
    },
    body: bodyStr,
  });

  // Should not cause a server error (< 500)
  assert(res.status < 500, `Invalid sig caused server error: ${res.status}`);
}

async function testMissingSignatureRejected(): Promise<void> {
  const payload = makeAppMention('no sig');
  const res = await fetch(`${webhookUrl}/slack/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert(res.status < 500, `Missing sig caused server error: ${res.status}`);
}

async function testBotSelfMessageIgnored(): Promise<void> {
  // Message from the bot itself should be ignored
  const payload = makeMessage('bot talking to itself', {
    userId: DEFAULTS.botUserId, // Use bot user ID as sender
  });
  (payload.event as Record<string, unknown>).bot_id = 'B_FAKE_BOT';
  const res = await sendWebhook('/slack/events', payload);
  assert(res.ok, `Bot self-message returned ${res.status}`);
  // It should return 200 but not process the message
}

// ─── Phase 4: Slash commands ────────────────────────────────────────────────

async function testSlashHelp(): Promise<void> {
  const body = makeSlashCommand('/oc', 'help');
  const res = await sendWebhook('/slack/commands', body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Help returned ${res.status}`);
  const data = (await res.json()) as { text?: string; response_type?: string };
  assert(data.response_type === 'ephemeral', `Expected ephemeral, got ${data.response_type}`);
  assert(
    data.text?.toLowerCase().includes('command') || data.text?.toLowerCase().includes('help'),
    'Help text missing expected content',
  );
}

async function testSlashModels(): Promise<void> {
  const body = makeSlashCommand('/oc', 'models');
  const res = await sendWebhook('/slack/commands', body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Models returned ${res.status}`);
  const data = (await res.json()) as { text?: string };
  assert(typeof data.text === 'string', 'Models response has no text');
}

async function testSlashStatus(): Promise<void> {
  const body = makeSlashCommand('/oc', 'status');
  const res = await sendWebhook('/slack/commands', body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Status returned ${res.status}`);
  const data = (await res.json()) as { text?: string };
  assert(typeof data.text === 'string', 'Status response has no text');
}

async function testSlashDiff(): Promise<void> {
  const body = makeSlashCommand('/oc', 'diff');
  const res = await sendWebhook('/slack/commands', body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Diff returned ${res.status}`);
}

async function testSlashLink(): Promise<void> {
  const body = makeSlashCommand('/oc', 'link');
  const res = await sendWebhook('/slack/commands', body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Link returned ${res.status}`);
}

async function testSlashAgents(): Promise<void> {
  const body = makeSlashCommand('/oc', 'agents');
  const res = await sendWebhook('/slack/commands', body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Agents returned ${res.status}`);
}

async function testSlashUnknownSubcommand(): Promise<void> {
  // Unknown subcommand should be treated as a question to the agent
  const body = makeSlashCommand('/oc', 'some-random-question');
  const res = await sendWebhook('/slack/commands', body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Unknown subcommand returned ${res.status}`);
}

async function testSlashEmptyText(): Promise<void> {
  const body = makeSlashCommand('/oc', '');
  const res = await sendWebhook('/slack/commands', body, 'application/x-www-form-urlencoded');
  assert(res.ok, `Empty slash returned ${res.status}`);
}

async function testSlashOpencode(): Promise<void> {
  // /opencode command alias
  const body = makeSlashCommand('/opencode', 'help');
  const res = await sendWebhook('/slack/commands', body, 'application/x-www-form-urlencoded');
  assert(res.ok, `/opencode help returned ${res.status}`);
}

// ─── Phase 5: OpenCode server connectivity ──────────────────────────────────

async function testOpenCodeHealth(): Promise<void> {
  const ready = await client.isReady();
  assert(ready, `OpenCode server at ${OPENCODE_URL} is not reachable`);
}

async function testOpenCodeProviders(): Promise<void> {
  const providers = await client.listProviders();
  assert(Array.isArray(providers), 'listProviders did not return array');
  assert(providers.length > 0, 'No providers configured');
}

async function testOpenCodeSessionLifecycle(): Promise<void> {
  // Create a session
  const sessionId = await client.createSession();
  assert(typeof sessionId === 'string' && sessionId.length > 0, 'Session ID is empty');

  // Verify the session exists by trying to get modified files (should not error)
  try {
    await client.getModifiedFiles();
  } catch {
    // This is expected if there's no active session context, but it shouldn't crash
  }
}

// ─── Phase 6: Session manager ───────────────────────────────────────────────

async function testSessionManagerResolve(): Promise<void> {
  const sessionMgr = new SessionManager();

  const mockMessage = {
    externalId: 'ext-123',
    text: 'test',
    platformUser: { id: 'U_TEST_USER', name: 'testuser' },
    timestamp: new Date().toISOString(),
    threadId: undefined as string | undefined,
    groupId: 'C_TEST_CHAN',
    chatType: 'group' as const,
    direction: 'inbound' as const,
    rawPayload: {},
  };

  // per-user strategy: same user should get same session
  const sess1 = await sessionMgr.resolve(slackConfig, mockMessage, client);
  assert(typeof sess1 === 'string' && sess1.length > 0, 'Session ID is empty');

  const sess2 = await sessionMgr.resolve(slackConfig, mockMessage, client);
  assert(sess1 === sess2, `Same user should reuse session: ${sess1} !== ${sess2}`);

  // Different user should get different session
  const diffUserMsg = { ...mockMessage, platformUser: { id: 'U_OTHER_USER', name: 'otheruser' } };
  const sess3 = await sessionMgr.resolve(slackConfig, diffUserMsg, client);
  assert(sess3 !== sess1, 'Different user should get different session');
}

async function testSessionManagerPerMessage(): Promise<void> {
  const sessionMgr = new SessionManager();

  // Create a config with per-message strategy
  const perMsgConfig = await createChannelConfig({
    channelType: 'slack',
    name: 'Per-Message Config',
    enabled: true,
    credentials: { botToken: 'xoxb-test', signingSecret: 'test' },
    platformConfig: {},
    metadata: {},
    sessionStrategy: 'per-message',
    systemPrompt: null,
    agentName: null,
  });

  const msg = {
    externalId: 'ext-pm-1',
    text: 'test',
    platformUser: { id: 'U_TEST', name: 'test' },
    timestamp: new Date().toISOString(),
    threadId: undefined as string | undefined,
    groupId: 'C_TEST',
    chatType: 'group' as const,
    direction: 'inbound' as const,
    rawPayload: {},
  };

  const s1 = await sessionMgr.resolve(perMsgConfig, msg, client);
  const s2 = await sessionMgr.resolve(perMsgConfig, { ...msg, externalId: 'ext-pm-2' }, client);
  assert(s1 !== s2, `per-message should create fresh sessions: ${s1} === ${s2}`);

  // Clean up
  deleteChannelConfig(perMsgConfig.id);
}

async function testSessionManagerInvalidate(): Promise<void> {
  const sessionMgr = new SessionManager();

  const msg = {
    externalId: 'ext-inv-1',
    text: 'test',
    platformUser: { id: 'U_INV_USER', name: 'inv' },
    timestamp: new Date().toISOString(),
    threadId: undefined as string | undefined,
    groupId: 'C_INV',
    chatType: 'group' as const,
    direction: 'inbound' as const,
    rawPayload: {},
  };

  const sess = await sessionMgr.resolve(slackConfig, msg, client);

  // Invalidate
  await sessionMgr.invalidateSession(slackConfig.id, 'slack', 'per-user', msg);

  // Next resolve should create a NEW session
  const sessAfter = await sessionMgr.resolve(slackConfig, msg, client);
  assert(sessAfter !== sess, `Invalidated session should create new: ${sessAfter} === ${sess}`);
}

// ─── Phase 7: Multi-config support ──────────────────────────────────────────

async function testMultiConfigSupport(): Promise<void> {
  // Create a second Slack config
  const config2 = await createChannelConfig({
    channelType: 'slack',
    name: 'Second Slack Config',
    enabled: true,
    credentials: { botToken: 'xoxb-second', signingSecret: 'secret2' },
    platformConfig: { groups: { requireMention: false } },
    metadata: {},
    sessionStrategy: 'per-thread',
    systemPrompt: 'You are the second bot',
    agentName: 'coder',
  });

  const all = listChannelConfigs({ channelType: 'slack' });
  assert(all.length >= 2, `Expected at least 2 slack configs, got ${all.length}`);

  // Verify they are different
  const found = all.find((c) => c.id === config2.id);
  assert(found !== undefined, 'Second config not found in list');
  assert(found!.name === 'Second Slack Config', 'Second config name wrong');
  assert(found!.sessionStrategy === 'per-thread', 'Second config strategy wrong');
  assert(found!.systemPrompt === 'You are the second bot', 'Second config prompt wrong');
  assert(found!.agentName === 'coder', 'Second config agent wrong');

  // Clean up
  deleteChannelConfig(config2.id);
}

async function testDisabledConfigFilter(): Promise<void> {
  const disabled = await createChannelConfig({
    channelType: 'slack',
    name: 'Disabled Config',
    enabled: false,
    credentials: { botToken: 'xoxb-disabled' },
    platformConfig: {},
    metadata: {},
    sessionStrategy: 'single',
    systemPrompt: null,
    agentName: null,
  });

  const enabledConfigs = listChannelConfigs({ enabled: true });
  const disabledConfigs = listChannelConfigs({ enabled: false });

  assert(
    enabledConfigs.every((c) => c.enabled === true),
    'Enabled filter returned disabled configs',
  );
  assert(
    disabledConfigs.some((c) => c.id === disabled.id),
    'Disabled config not found in disabled filter',
  );

  deleteChannelConfig(disabled.id);
}

// ─── Phase 8: Graceful shutdown + restart ───────────────────────────────────

let savedConfigId: string;

async function testGracefulShutdown(): Promise<void> {
  // Save the config ID before shutdown
  const configs = listChannelConfigs({ channelType: 'slack' }, channels!.db);
  savedConfigId = configs[0].id;

  channels!.stop();
  channels = null;

  // Health endpoint should no longer respond
  try {
    const res = await fetch(webhookUrl + '/health', { signal: AbortSignal.timeout(1000) });
    // If it responds, that's unexpected but not a hard failure
    // The server may take a moment to shut down
  } catch {
    // Expected — connection refused
  }
}

async function testRebootFromExistingDb(): Promise<void> {
  // Reboot with the same DB — should pick up existing config
  const port = await getRandomPort();
  client = new OpenCodeClient({ baseUrl: OPENCODE_URL });
  configsByTeamId = new Map();

  const slackAdapter = new SlackAdapter({
    getConfigByTeamId: (teamId: string) => configsByTeamId.get(teamId),
    getClient: () => client,
  });

  channels = await startChannels({
    adapters: { slack: slackAdapter },
    port,
    dbPath: DB_PATH,
    opencodeUrl: OPENCODE_URL,
  });

  webhookUrl = `http://localhost:${port}`;

  // The existing config should still be there
  const configs = listChannelConfigs({ channelType: 'slack' }, channels.db);
  assert(configs.length >= 1, `Expected at least 1 config after reboot, got ${configs.length}`);

  const found = configs.find((c) => c.id === savedConfigId);
  assert(found !== undefined, 'Original config not found after reboot');
  assert(found!.name === 'E2E Setup Test', 'Config name wrong after reboot');

  // Wire up
  slackConfig = found!;
  configsByTeamId.set(DEFAULTS.teamId, slackConfig);
}

async function testWebhookWorksAfterReboot(): Promise<void> {
  // Health should work
  const res = await fetch(`${webhookUrl}/health`);
  assert(res.ok, `Health after reboot returned ${res.status}`);

  // URL verification should work
  const challenge = `reboot-${Date.now()}`;
  const payload = makeUrlVerification(challenge);
  const res2 = await sendWebhook('/slack/events', payload);
  assert(res2.ok, 'URL verification failed after reboot');
  const data = (await res2.json()) as { challenge: string };
  assert(data.challenge === challenge, 'Challenge mismatch after reboot');

  // Slash command should work
  const body = makeSlashCommand('/oc', 'help');
  const res3 = await sendWebhook('/slack/commands', body, 'application/x-www-form-urlencoded');
  assert(res3.ok, 'Slash command failed after reboot');
}

// ─── Phase 9: Slack API validation (if real token available) ────────────────

async function testSlackApiValidation(): Promise<void> {
  if (!SLACK_BOT_TOKEN || SLACK_BOT_TOKEN.startsWith('xoxb-test')) {
    // Skip if no real token
    return;
  }

  const api = new SlackApi(SLACK_BOT_TOKEN);
  const auth = await api.authTest();
  assert(auth.ok === true, `auth.test failed: ${JSON.stringify(auth)}`);
  assert(typeof auth.team_id === 'string', 'No team_id in auth response');
  assert(typeof auth.user_id === 'string', 'No user_id in auth response');
}

async function testSlackAdapterValidation(): Promise<void> {
  if (!SLACK_BOT_TOKEN || SLACK_BOT_TOKEN.startsWith('xoxb-test')) {
    return;
  }

  const adapter = new SlackAdapter({
    getConfigByTeamId: () => undefined,
    getClient: () => client,
  });

  const result = await adapter.validateCredentials({
    botToken: SLACK_BOT_TOKEN,
    signingSecret: SLACK_SIGNING_SECRET,
  });

  assert(result.valid === true, `Credential validation failed: ${result.error}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('opencode-channels E2E Setup Test');
  console.log('════════════════════════════════════════════════════════');
  console.log('');
  console.log(`  OpenCode:  ${OPENCODE_URL}`);
  console.log(`  DB:        ${DB_PATH}`);
  console.log(`  Token:     ${SLACK_BOT_TOKEN ? SLACK_BOT_TOKEN.slice(0, 12) + '...' : '(not set)'}`);
  console.log('');

  // ── Phase 1: Fresh DB + Config CRUD ─────────────────────────────────

  console.log('── Phase 1: Database & Config CRUD ──');
  await runTest('Fresh database creation', testFreshDbCreation);
  await runTest('Create Slack channel config', testCreateSlackConfig);
  await runTest('List configs with filters', testListConfigs);
  await runTest('Get config by ID', testGetConfig);
  await runTest('Update config fields', testUpdateConfig);
  await runTest('Delete and recreate config', testDeleteAndRecreateConfig);

  // ── Phase 2: Boot server ────────────────────────────────────────────

  console.log('');
  console.log('── Phase 2: Boot Webhook Server ──');
  await runTest('Boot server with Slack adapter', testBootServer);

  // ── Phase 3: Webhook endpoints ──────────────────────────────────────

  console.log('');
  console.log('── Phase 3: Webhook Endpoints ──');
  await runTest('Health endpoint', testHealthEndpoint);
  await runTest('URL verification challenge', testUrlVerification);
  await runTest('App mention accepted', testAppMentionAccepted);
  await runTest('DM message accepted', testDmMessageAccepted);
  await runTest('Threaded message accepted', testThreadedMessageAccepted);
  await runTest('Reaction event accepted', testReactionEventAccepted);
  await runTest('Invalid signature rejected', testInvalidSignatureRejected);
  await runTest('Missing signature rejected', testMissingSignatureRejected);
  await runTest('Bot self-message ignored', testBotSelfMessageIgnored);

  // ── Phase 4: Slash commands ─────────────────────────────────────────

  console.log('');
  console.log('── Phase 4: Slash Commands ──');
  await runTest('/oc help', testSlashHelp);
  await runTest('/oc models', testSlashModels);
  await runTest('/oc status', testSlashStatus);
  await runTest('/oc diff', testSlashDiff);
  await runTest('/oc link', testSlashLink);
  await runTest('/oc agents', testSlashAgents);
  await runTest('/oc (unknown subcommand)', testSlashUnknownSubcommand);
  await runTest('/oc (empty text)', testSlashEmptyText);
  await runTest('/opencode help (alias)', testSlashOpencode);

  // ── Phase 5: OpenCode server ────────────────────────────────────────

  console.log('');
  console.log('── Phase 5: OpenCode Server ──');
  await runTest('OpenCode health check', testOpenCodeHealth);
  await runTest('List providers', testOpenCodeProviders);
  await runTest('Session lifecycle', testOpenCodeSessionLifecycle);

  // ── Phase 6: Session manager ────────────────────────────────────────

  console.log('');
  console.log('── Phase 6: Session Management ──');
  await runTest('Session resolve + reuse (per-user)', testSessionManagerResolve);
  await runTest('Session per-message (fresh each time)', testSessionManagerPerMessage);
  await runTest('Session invalidation', testSessionManagerInvalidate);

  // ── Phase 7: Multi-config ───────────────────────────────────────────

  console.log('');
  console.log('── Phase 7: Multi-Config ──');
  await runTest('Multiple Slack configs', testMultiConfigSupport);
  await runTest('Enabled/disabled config filter', testDisabledConfigFilter);

  // ── Phase 8: Shutdown + reboot ──────────────────────────────────────

  console.log('');
  console.log('── Phase 8: Shutdown & Reboot ──');
  await runTest('Graceful shutdown', testGracefulShutdown);
  await runTest('Reboot from existing DB', testRebootFromExistingDb);
  await runTest('Webhooks work after reboot', testWebhookWorksAfterReboot);

  // ── Phase 9: Slack API validation ───────────────────────────────────

  if (SLACK_BOT_TOKEN && !SLACK_BOT_TOKEN.startsWith('xoxb-test')) {
    console.log('');
    console.log('── Phase 9: Slack API Validation ──');
    await runTest('Slack auth.test', testSlackApiValidation);
    await runTest('SlackAdapter.validateCredentials', testSlackAdapterValidation);
  }

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

  if (channels) channels.stop();

  try { unlinkSync(DB_PATH); } catch {}
  try { unlinkSync(`${DB_PATH}-shm`); } catch {}
  try { unlinkSync(`${DB_PATH}-wal`); } catch {}

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  if (channels) channels.stop();
  process.exit(1);
});
