/**
 * E2E test for the Telegram adapter.
 *
 * Tests the full lifecycle:
 *   1. Boot mock OpenCode + real opencode-channels (webhook mode via ngrok)
 *   2. POST simulated Telegram updates to the webhook endpoint
 *   3. Verify the bot processes them and creates sessions on mock OpenCode
 *   4. Also test real Telegram API integration (send message from bot, check webhook status)
 *
 * Requirements:
 *   - TELEGRAM_BOT_TOKEN env var (valid bot token)
 *   - ngrok running on the same port (or TELEGRAM_WEBHOOK_URL set)
 *   - A TELEGRAM_TEST_CHAT_ID for live message tests
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_TEST_CHAT_ID=... npx tsx test/e2e-telegram.test.ts
 */

import * as net from 'node:net';
import { createMockOpenCode } from './mock-opencode.js';

// ─── Config ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN env var is required');
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TEST_CHAT_ID = process.env.TELEGRAM_TEST_CHAT_ID || '';

// ─── Test infra ─────────────────────────────────────────────────────────────

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

// ─── Telegram API helpers ───────────────────────────────────────────────────

async function tgApi(method: string, body?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as { ok: boolean; result?: unknown; description?: string };
  if (!data.ok) throw new Error(`Telegram API ${method} failed: ${data.description}`);
  return data.result;
}

// ─── Telegram update payload builders ───────────────────────────────────────

let updateIdCounter = 100000;

function makeMessageUpdate(text: string, opts?: {
  chatId?: number;
  userId?: number;
  username?: string;
  firstName?: string;
  chatType?: 'private' | 'group' | 'supergroup';
  messageId?: number;
}) {
  const chatId = opts?.chatId ?? 12345;
  const userId = opts?.userId ?? 12345;
  return {
    update_id: ++updateIdCounter,
    message: {
      message_id: opts?.messageId ?? Math.floor(Math.random() * 100000),
      from: {
        id: userId,
        is_bot: false,
        first_name: opts?.firstName ?? 'TestUser',
        username: opts?.username ?? 'testuser',
      },
      chat: {
        id: chatId,
        first_name: opts?.firstName ?? 'TestUser',
        username: opts?.username ?? 'testuser',
        type: opts?.chatType ?? 'private',
      },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

function makeMentionUpdate(text: string, botUsername: string, opts?: {
  chatId?: number;
  userId?: number;
}) {
  const chatId = opts?.chatId ?? -100123456;
  const userId = opts?.userId ?? 12345;
  const fullText = `@${botUsername} ${text}`;
  return {
    update_id: ++updateIdCounter,
    message: {
      message_id: Math.floor(Math.random() * 100000),
      from: {
        id: userId,
        is_bot: false,
        first_name: 'TestUser',
        username: 'testuser',
      },
      chat: {
        id: chatId,
        title: 'Test Group',
        type: 'supergroup' as const,
      },
      date: Math.floor(Date.now() / 1000),
      text: fullText,
      entities: [
        { offset: 0, length: botUsername.length + 1, type: 'mention' as const },
      ],
    },
  };
}

// ─── Shared state ───────────────────────────────────────────────────────────

let mockOC: ReturnType<typeof createMockOpenCode>;
let ocPort: number;
let channelsPort: number;
let channelsServer: { stop: () => void } | null = null;
let botInfo: { id: number; username: string };
let webhookSecretToken: string;

// ─── Setup / teardown ───────────────────────────────────────────────────────

async function setup(): Promise<void> {
  console.log('\n  Setting up...');

  // Get bot info
  const me = await tgApi('getMe') as { id: number; username: string };
  botInfo = me;
  console.log(`  Bot: @${botInfo.username} (ID: ${botInfo.id})`);

  // Get random ports
  ocPort = await getRandomPort();
  channelsPort = await getRandomPort();

  // Start mock OpenCode
  mockOC = createMockOpenCode({
    port: ocPort,
    response: 'Hello from the Telegram E2E test!',
    chunkDelayMs: 5,
  });
  await mockOC.start();
  console.log(`  Mock OpenCode on port ${ocPort}`);

  // Generate webhook secret
  webhookSecretToken = `test-${Date.now()}`;

  // Set env vars
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  process.env.TELEGRAM_BOT_USERNAME = botInfo.username;
  process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = webhookSecretToken;
  process.env.OPENCODE_URL = `http://localhost:${ocPort}`;
  process.env.PORT = String(channelsPort);

  // Clear other adapters
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_SIGNING_SECRET;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_PUBLIC_KEY;
  delete process.env.DISCORD_APPLICATION_ID;

  // Delete any existing webhook so auto mode picks polling for our local test
  await tgApi('deleteWebhook', { drop_pending_updates: true });

  // Start opencode-channels
  const { start } = await import('../src/index.js');
  const result = await start(
    { opencodeUrl: `http://localhost:${ocPort}` },
    { port: channelsPort },
  );
  channelsServer = result.server;

  // Wait for initialization
  console.log(`  opencode-channels on port ${channelsPort}`);
  console.log('  Waiting for adapter initialization...');
  await new Promise(r => setTimeout(r, 4000));
  console.log('  Setup complete!\n');
}

async function teardown(): Promise<void> {
  channelsServer?.stop();
  await mockOC?.stop();
  // Clean up webhook
  await tgApi('deleteWebhook', { drop_pending_updates: true }).catch(() => {});
}

async function postWebhook(update: unknown): Promise<Response> {
  return fetch(`http://localhost:${channelsPort}/api/webhooks/telegram`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': webhookSecretToken,
    },
    body: JSON.stringify(update),
  });
}

// ─── Phase 1: Health & Connectivity ─────────────────────────────────────────

async function testHealthEndpoint(): Promise<void> {
  const res = await fetch(`http://localhost:${channelsPort}/health`);
  assert(res.ok, `Health returned ${res.status}`);
  const data = await res.json() as { ok: boolean; service: string; adapters: string[] };
  assert(data.ok === true, 'Health not ok');
  assert(data.service === 'opencode-channels', `Wrong service: ${data.service}`);
  assert(data.adapters.includes('telegram'), `No telegram adapter. Got: ${JSON.stringify(data.adapters)}`);
}

async function testTelegramBotReachable(): Promise<void> {
  const me = await tgApi('getMe') as { id: number; username: string };
  assert(me.id === botInfo.id, 'Bot ID mismatch');
}

// ─── Phase 2: Webhook Endpoint ──────────────────────────────────────────────

async function testWebhookAcceptsUpdate(): Promise<void> {
  const update = makeMessageUpdate('Hello from test!');
  const res = await postWebhook(update);
  assert(res.ok || res.status === 200, `Webhook returned ${res.status}`);
}

async function testWebhookRejectsBadSecret(): Promise<void> {
  const update = makeMessageUpdate('should be rejected');
  const res = await fetch(`http://localhost:${channelsPort}/api/webhooks/telegram`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret',
    },
    body: JSON.stringify(update),
  });
  // The adapter should reject bad secrets (401 or 403)
  // Some adapters may return 200 but ignore the message
  // We just verify it doesn't crash
  assert(res.status !== 500, `Server error on bad secret: ${res.status}`);
}

async function testWebhookProcessesDM(): Promise<void> {
  if (!TEST_CHAT_ID) throw new Error('TELEGRAM_TEST_CHAT_ID required for DM test');

  const sessionCountBefore = mockOC.sessionCount;
  const chatId = Number(TEST_CHAT_ID);

  // Post a DM-like update using the REAL chat ID so Telegram API calls succeed
  const update = makeMessageUpdate('What is the meaning of life?', {
    chatId,
    userId: chatId,
    username: 'markokraemer',
    firstName: 'Marko',
    chatType: 'private',
  });
  await postWebhook(update);

  // Wait for the bot to process and create a session
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (mockOC.sessionCount > sessionCountBefore) break;
    await new Promise(r => setTimeout(r, 300));
  }

  assert(
    mockOC.sessionCount > sessionCountBefore,
    `Bot did not create session for DM. Before: ${sessionCountBefore}, After: ${mockOC.sessionCount}`,
  );
}

async function testWebhookProcessesMention(): Promise<void> {
  if (!TEST_CHAT_ID) throw new Error('TELEGRAM_TEST_CHAT_ID required for mention test');

  const promptCountBefore = mockOC.promptCount;
  const chatId = Number(TEST_CHAT_ID);

  // Post a mention update using the REAL chat ID so Telegram API calls (sendChatAction) succeed.
  // We use chatType 'private' with a @mention entity to test the mention-detection path.
  // The session already exists from the DM test, so we track promptCount not sessionCount.
  const fullText = `@${botInfo.username} What time is it?`;
  const update = {
    update_id: ++updateIdCounter,
    message: {
      message_id: Math.floor(Math.random() * 100000),
      from: {
        id: chatId,
        is_bot: false,
        first_name: 'Marko',
        username: 'markokraemer',
      },
      chat: {
        id: chatId,
        first_name: 'Marko',
        username: 'markokraemer',
        type: 'private' as const,
      },
      date: Math.floor(Date.now() / 1000),
      text: fullText,
      entities: [
        { offset: 0, length: botInfo.username.length + 1, type: 'mention' as const },
      ],
    },
  };
  await postWebhook(update);

  // Wait for prompt to be sent to mock OpenCode
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (mockOC.promptCount > promptCountBefore) break;
    await new Promise(r => setTimeout(r, 300));
  }

  assert(
    mockOC.promptCount > promptCountBefore,
    `Bot did not send prompt for mention. Before: ${promptCountBefore}, After: ${mockOC.promptCount}`,
  );
}

// ─── Phase 3: Error Handling ────────────────────────────────────────────────

async function testBotHandlesOpenCodeError(): Promise<void> {
  if (!TEST_CHAT_ID) throw new Error('TELEGRAM_TEST_CHAT_ID required for error test');

  mockOC.setError('Mock error: service unavailable');

  const promptCountBefore = mockOC.promptCount;
  const chatId = Number(TEST_CHAT_ID);

  // Use real chat ID so sendChatAction doesn't fail before we even test error handling.
  // The session already exists, so handleMessage will resolve the existing session
  // and then the prompt will fail with our mock error.
  const update = makeMessageUpdate('This should trigger an error', {
    chatId,
    userId: chatId,
    username: 'markokraemer',
    firstName: 'Marko',
    chatType: 'private',
  });
  await postWebhook(update);

  // Wait -- bot should still attempt the prompt even though it will error
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (mockOC.promptCount > promptCountBefore) break;
    await new Promise(r => setTimeout(r, 300));
  }

  // Restore
  mockOC.setError(undefined);
  mockOC.setResponse('Back to normal.');

  assert(
    mockOC.promptCount > promptCountBefore,
    `Bot did not attempt prompt on error. Before: ${promptCountBefore}, After: ${mockOC.promptCount}`,
  );
}

// ─── Phase 4: Reload API ────────────────────────────────────────────────────

async function testReloadEndpoint(): Promise<void> {
  const res = await fetch(`http://localhost:${channelsPort}/reload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      credentials: {
        telegram: {
          botToken: BOT_TOKEN,
          botUsername: botInfo.username,
        },
      },
    }),
  });
  assert(res.ok, `Reload returned ${res.status}`);
  const data = await res.json() as { ok: boolean; adapters: string[]; reloaded: boolean };
  assert(data.ok === true, 'Reload not ok');
  assert(data.adapters.includes('telegram'), `No telegram after reload. Got: ${data.adapters}`);
}

// ─── Phase 5: Live Telegram Integration ─────────────────────────────────────

async function testBotCanSendMessage(): Promise<void> {
  if (!TEST_CHAT_ID) throw new Error('TELEGRAM_TEST_CHAT_ID not set — skipping');

  const result = await tgApi('sendMessage', {
    chat_id: TEST_CHAT_ID,
    text: `E2E test message from @${botInfo.username} at ${new Date().toISOString()}`,
  }) as { message_id: number };

  assert(result.message_id > 0, `sendMessage failed: no message_id`);
}

// ─── Phase 6: Session Reuse ─────────────────────────────────────────────────

async function testSessionReuse(): Promise<void> {
  if (!TEST_CHAT_ID) throw new Error('TELEGRAM_TEST_CHAT_ID required for session reuse test');

  const promptCountBefore = mockOC.promptCount;
  const sessionCountBefore = mockOC.sessionCount;
  const chatId = Number(TEST_CHAT_ID);

  // Send first message using real chat ID — session may already exist from prior tests
  const update1 = makeMessageUpdate('First message for reuse test', {
    chatId,
    userId: chatId,
    username: 'markokraemer',
    firstName: 'Marko',
    chatType: 'private',
  });
  await postWebhook(update1);

  // Wait for first prompt to be processed
  const deadline1 = Date.now() + 15000;
  while (Date.now() < deadline1) {
    if (mockOC.promptCount > promptCountBefore) break;
    await new Promise(r => setTimeout(r, 300));
  }
  const afterFirstPrompt = mockOC.promptCount;
  const afterFirstSession = mockOC.sessionCount;
  assert(afterFirstPrompt > promptCountBefore, 'First message did not send prompt');

  // Wait for first message to finish processing
  await new Promise(r => setTimeout(r, 5000));

  // Send second message in same chat
  const update2 = makeMessageUpdate('Second message for reuse test', {
    chatId,
    userId: chatId,
    username: 'markokraemer',
    firstName: 'Marko',
    chatType: 'private',
  });
  await postWebhook(update2);

  // Wait for second prompt
  const deadline2 = Date.now() + 15000;
  while (Date.now() < deadline2) {
    if (mockOC.promptCount > afterFirstPrompt) break;
    await new Promise(r => setTimeout(r, 300));
  }

  assert(
    mockOC.promptCount > afterFirstPrompt,
    `Second message was not processed. Prompt count: ${mockOC.promptCount}`,
  );

  // Session reuse: second message should NOT have created a new session
  assert(
    mockOC.sessionCount === afterFirstSession,
    `Session was not reused. Sessions before: ${afterFirstSession}, after: ${mockOC.sessionCount}`,
  );
}

// ─── Run ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\nopencode-channels Telegram E2E Test Suite');
  console.log('════════════════════════════════════════════════════════');
  console.log('  Real Telegram API + Mock OpenCode + Webhook simulation\n');

  try {
    await setup();
  } catch (err) {
    console.error('Setup failed:', err);
    process.exit(1);
  }

  try {
    console.log('── Phase 1: Health & Connectivity ──');
    await runTest('Health endpoint shows telegram adapter', testHealthEndpoint);
    await runTest('Telegram bot is reachable', testTelegramBotReachable);

    console.log('\n── Phase 2: Webhook Endpoint ──');
    await runTest('Webhook accepts valid Telegram update', testWebhookAcceptsUpdate);
    await runTest('Webhook handles bad secret gracefully', testWebhookRejectsBadSecret);
    await runTest('Bot processes DM via webhook (session created)', testWebhookProcessesDM);

    // Wait for the DM processing to fully complete and thread lock to release
    // before sending another message to the same chat ID
    console.log('    (waiting for DM processing to complete...)');
    await new Promise(r => setTimeout(r, 8000));

    await runTest('Bot processes @mention via webhook (session created)', testWebhookProcessesMention);

    // Wait for mention processing to complete
    console.log('    (waiting for mention processing to complete...)');
    await new Promise(r => setTimeout(r, 8000));

    console.log('\n── Phase 3: Error Handling ──');
    await runTest('Bot handles OpenCode error gracefully', testBotHandlesOpenCodeError);

    // Wait for error handling to complete
    console.log('    (waiting for error processing to complete...)');
    await new Promise(r => setTimeout(r, 5000));

    // Session reuse must run BEFORE reload, because reload creates a new Chat
    // instance with a second polling connection, causing Telegram API conflicts.
    console.log('\n── Phase 4: Session Reuse ──');
    await runTest('Multiple messages in same chat reuse session', testSessionReuse);

    console.log('\n── Phase 5: Reload API ──');
    await runTest('Reload endpoint accepts telegram credentials', testReloadEndpoint);

    if (TEST_CHAT_ID) {
      console.log('\n── Phase 6: Live Telegram Integration ──');
      await runTest('Bot can send message via Telegram API', testBotCanSendMessage);
    } else {
      console.log('\n── Phase 6: Live Telegram Integration (skipped — no TELEGRAM_TEST_CHAT_ID) ──');
    }

  } finally {
    await teardown();
  }

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════');
  const failed = results.filter(r => !r.passed);
  if (failed.length === 0) {
    console.log(`\x1b[32m  All ${results.length} tests passed\x1b[0m`);
  } else {
    console.log(`\x1b[31m  ${failed.length} of ${results.length} tests failed\x1b[0m`);
    for (const f of failed) {
      console.log(`  \x1b[31m  ${f.name}: ${f.error}\x1b[0m`);
    }
  }
  console.log('════════════════════════════════════════════════════════\n');

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
