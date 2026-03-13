/**
 * Minimal test: Does the Chat SDK + Telegram adapter receive polling updates?
 */
import { Chat } from 'chat';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { createMemoryState } from '@chat-adapter/state-memory';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8789735802:AAHl7ifYLJRs0_F8CQKd1_9Zat9Psfo26q8';

console.log('[test] Creating Telegram adapter...');
const adapter = createTelegramAdapter({
  botToken: BOT_TOKEN,
  userName: 'TEd123123Bot',
  mode: 'polling',
});

console.log('[test] Creating Chat instance...');
const bot = new Chat({
  userName: 'test-bot',
  adapters: { telegram: adapter } as any,
  state: createMemoryState(),
  logger: 'debug',
});

bot.onNewMessage(/[\s\S]*/, async (thread, message) => {
  console.log(`[test] *** onNewMessage: "${message.text}" from ${message.author.name} in ${thread.id}`);
  await thread.post(`Echo: ${message.text}`);
});

bot.onNewMention(async (thread, message) => {
  console.log(`[test] *** onNewMention: "${message.text}" from ${message.author.name} in ${thread.id}`);
});

console.log('[test] Initializing (starting polling)...');
await bot.initialize();
console.log('[test] Initialized! Waiting for messages... Send something to @TEd123123Bot');

// Keep alive
setInterval(() => {
  console.log('[test] Still alive, polling should be running...');
}, 10000);
