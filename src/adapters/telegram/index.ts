import { createTelegramAdapter } from '@chat-adapter/telegram';
import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { Chat } from 'chat';
import type { AdapterModule, TelegramCredentials } from '../types.js';

const telegramModule: AdapterModule<TelegramCredentials> = {
  name: 'telegram',

  readCredentialsFromEnv() {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken) {
      return {
        botToken,
        secretToken: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        botUsername: process.env.TELEGRAM_BOT_USERNAME,
        apiBaseUrl: process.env.TELEGRAM_API_BASE_URL,
      };
    }
    return undefined;
  },

  createAdapter(credentials: TelegramCredentials) {
    return createTelegramAdapter({
      botToken: credentials.botToken,
      secretToken: credentials.secretToken,
      userName: credentials.botUsername,
      apiBaseUrl: credentials.apiBaseUrl,
      // Webhook mode — Telegram pushes updates to our server via ngrok,
      // exactly like Slack. No polling.
      mode: 'webhook',
    });
  },

  registerRoutes(app: Hono, getBot: () => Chat | null) {
    const handle = async (c: Context) => {
      const bot = getBot();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (bot as any)?.webhooks?.telegram;
      if (!handler) return c.text('Telegram adapter not configured', 404);
      return handler(c.req.raw, {
        waitUntil: (task: Promise<unknown>) => { task.catch(console.error); },
      });
    };

    app.post('/telegram/webhook', handle);
  },
};

export default telegramModule;
