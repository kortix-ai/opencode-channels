import { createTelegramAdapter } from '@chat-adapter/telegram';
import type { AdapterModule, TelegramCredentials } from '../types.js';

const telegramModule: AdapterModule<TelegramCredentials> = {
  name: 'telegram',

  readCredentialsFromEnv() {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken) {
      return {
        botToken,
        secretToken: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
      };
    }
    return undefined;
  },

  createAdapter(credentials: TelegramCredentials) {
    return createTelegramAdapter({
      botToken: credentials.botToken,
      secretToken: credentials.secretToken,
    });
  },
};

export default telegramModule;
