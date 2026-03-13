/**
 * Minimal webhook test — does the Chat SDK Telegram webhook actually trigger handlers?
 */
import { Chat } from 'chat';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { createMemoryState } from '@chat-adapter/state-memory';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const BOT_TOKEN = '8789735802:AAHl7ifYLJRs0_F8CQKd1_9Zat9Psfo26q8';
const CHAT_ID = '923868872';
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

console.log('[test] Creating adapter with mode: webhook...');
const adapter = createTelegramAdapter({
  botToken: BOT_TOKEN,
  userName: 'TEd123123Bot',
  mode: 'webhook',
});

const bot = new Chat({
  userName: 'test-bot',
  adapters: { telegram: adapter } as any,
  state: createMemoryState(),
  logger: 'debug',
});

bot.onNewMessage(/[\s\S]*/, async (thread, message) => {
  console.log(`[test] *** onNewMessage: "${message.text}" from ${message.author.userName}`);
  // Echo back via direct API
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: `Echo: ${message.text}` }),
  });
  console.log('[test] Echo sent!');
});

bot.onNewMention(async (thread, message) => {
  console.log(`[test] *** onNewMention: "${message.text}"`);
});

console.log('[test] Initializing...');
await bot.initialize();
console.log('[test] Initialized!');

// Set up Hono server with webhook route
const app = new Hono();

app.post('/telegram/webhook', async (c) => {
  console.log('[test] Webhook POST received');
  const handler = (bot as any).webhooks?.telegram;
  if (!handler) {
    console.log('[test] No webhook handler!');
    return c.text('No handler', 500);
  }
  const resp = await handler(c.req.raw, {
    waitUntil: (task: Promise<unknown>) => {
      task.catch((err: unknown) => console.error('[test] waitUntil error:', err));
    },
  });
  console.log('[test] Webhook handler returned:', resp.status);
  return resp;
});

const server = serve({ fetch: app.fetch, port: 3456 }, () => {
  console.log('[test] Server listening on port 3456');
  console.log('[test] Send a message to @TEd123123Bot');
});
