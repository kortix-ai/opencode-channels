import { createSlackAdapter } from '@chat-adapter/slack';
import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { Chat } from 'chat';
import type { AdapterModule, SlackCredentials } from '../types.js';

const slackModule: AdapterModule<SlackCredentials> = {
  name: 'slack',

  readCredentialsFromEnv() {
    const botToken = process.env.SLACK_BOT_TOKEN;
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    if (botToken && signingSecret) {
      return { botToken, signingSecret };
    }
    return undefined;
  },

  createAdapter(credentials: SlackCredentials) {
    return createSlackAdapter({
      botToken: credentials.botToken,
      signingSecret: credentials.signingSecret,
    });
  },

  registerRoutes(app: Hono, getBot: () => Chat | null) {
    const handle = async (c: Context) => {
      const bot = getBot();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (bot as any)?.webhooks?.slack;
      if (!handler) return c.text('Slack adapter not configured', 404);
      return handler(c.req.raw, {
        waitUntil: (task: Promise<unknown>) => { task.catch(console.error); },
      });
    };

    app.post('/slack/events', handle);
    app.post('/slack/commands', handle);
    app.post('/slack/interactivity', handle);
  },
};

export default slackModule;
