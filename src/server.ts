import type { Chat } from 'chat';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

import { readAdaptersFromEnv } from './bot.js';
import type { ChannelsService } from './service.js';
import type { ReloadRequest } from './types.js';
import { adapterModules } from './adapters/registry.js';
import { sendMessageDirect, type TelegramDirectConfig } from './telegram-api.js';

type ServerInput = ChannelsService | Chat | Promise<Chat | null> | null;

function isChannelsService(input: ServerInput): input is ChannelsService {
  return !!input && typeof input === 'object'
    && 'reload' in input
    && 'sessions' in input
    && 'activeAdapters' in input;
}

export interface ServerConfig {
  port?: number;
  host?: string;
}

export function createServer(
  input: ServerInput,
  config: ServerConfig = {},
) {
  const port = config.port ?? (process.env.PORT ? Number(process.env.PORT) : 3456);
  const host = config.host ?? '0.0.0.0';

  const app = new Hono();
  let legacyBotCache: Chat | null = null;

  if (!isChannelsService(input) && input) {
    Promise.resolve(input).then((bot) => {
      legacyBotCache = bot;
    }).catch((err) => {
      console.error('[opencode-channels] Bot initialization failed:', err);
    });
  }

  const getBot = () => (isChannelsService(input) ? input.bot : legacyBotCache);
  const getAdapterNames = () => (isChannelsService(input)
    ? input.activeAdapters
    : Object.keys(readAdaptersFromEnv()));
  const getActiveSessions = () => (isChannelsService(input) ? input.sessions.size : 0);
  const getCredentials = () => (isChannelsService(input) ? input.credentials : readAdaptersFromEnv());
  const resolveBot = async () => {
    if (isChannelsService(input)) return input.bot;
    if (legacyBotCache) return legacyBotCache;
    legacyBotCache = await Promise.resolve(input);
    return legacyBotCache;
  };

  app.get('/health', (c) =>
    c.json({
      ok: true,
      service: 'opencode-channels',
      adapters: getAdapterNames(),
      activeSessions: getActiveSessions(),
    }),
  );

  // ── Wizard helper: detect public URL (ngrok) ─────────────────────────────
  app.get('/wizard/detect-url', async (c) => {
    try {
      const res = await fetch('http://127.0.0.1:4040/api/tunnels', {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json() as { tunnels: Array<{ public_url: string; config: { addr: string } }> };
        const tunnel = data.tunnels?.find(t => t.public_url?.startsWith('https://'));
        if (tunnel) {
          return c.json({ detected: true, url: tunnel.public_url, source: 'ngrok' });
        }
      }
    } catch { /* ngrok not running */ }
    return c.json({ detected: false, url: '', source: 'none' });
  });

  app.post('/reload', async (c) => {
    if (!isChannelsService(input)) {
      return c.json({ error: 'Reload requires a ChannelsService instance' }, 501);
    }
    try {
      const body = await c.req.json() as ReloadRequest;
      if (!body?.credentials) {
        return c.json({ error: 'Missing credentials' }, 400);
      }
      const result = await input.reload(body.credentials);
      return c.json(result);
    } catch (err) {
      console.error('[opencode-channels] Reload failed:', err);
      return c.json({ error: 'Reload failed' }, 500);
    }
  });

  // ── Outbound /send endpoint ───────────────────────────────────────────────
  // The simplest way for the agent to send proactive messages to any platform.
  // No CLI needed — just: curl -X POST localhost:3456/send -d '{"platform":"telegram","to":"123","text":"hi"}'
  app.post('/send', async (c) => {
    try {
      const credentials = getCredentials();
      const body = await c.req.json() as {
        platform: string;
        to: string;
        text: string;
        threadTs?: string;
        replyTo?: number;
      };

      if (!body.platform || !body.to || !body.text) {
        return c.json({ ok: false, error: 'platform, to, and text are required' }, 400);
      }

      const platform = body.platform.toLowerCase();

      if (platform === 'slack') {
        const token = (credentials.slack as { botToken?: string } | undefined)?.botToken
          ?? process.env.SLACK_BOT_TOKEN;
        if (!token) return c.json({ ok: false, error: 'SLACK_BOT_TOKEN not configured' }, 400);
        const slackApiBase = process.env.SLACK_API_URL?.replace(/\/$/, '') || 'https://slack.com/api';

        const slackBody: Record<string, unknown> = {
          channel: body.to,
          text: body.text,
          mrkdwn: true,
        };
        if (body.threadTs) slackBody.thread_ts = body.threadTs;

        const res = await fetch(`${slackApiBase}/chat.postMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(slackBody),
          signal: AbortSignal.timeout(15_000),
        });
        const data = await res.json() as { ok: boolean; ts?: string; error?: string };
        if (!data.ok) return c.json({ ok: false, error: data.error, platform: 'slack' });
        return c.json({ ok: true, platform: 'slack', messageId: data.ts });
      }

      if (platform === 'telegram') {
        const botToken = (credentials.telegram as { botToken?: string } | undefined)?.botToken
          ?? process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) return c.json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not configured' }, 400);

        const tgConfig: TelegramDirectConfig = {
          botToken,
          apiBaseUrl: process.env.TELEGRAM_API_BASE_URL,
        };
        try {
          const sent = await sendMessageDirect(tgConfig, body.to, body.text, body.replyTo);
          return c.json({ ok: true, platform: 'telegram', messageId: String(sent.messageId), chatId: body.to });
        } catch (err) {
          return c.json({ ok: false, error: err instanceof Error ? err.message : 'telegram send failed', platform: 'telegram' });
        }
      }

      if (platform === 'discord') {
        const token = (credentials.discord as { botToken?: string } | undefined)?.botToken
          ?? process.env.DISCORD_BOT_TOKEN;
        if (!token) return c.json({ ok: false, error: 'DISCORD_BOT_TOKEN not configured' }, 400);
        const discordApiBase = process.env.DISCORD_API_BASE_URL?.replace(/\/$/, '') || 'https://discord.com/api/v10';

        const text = body.text.length > 2000 ? body.text.slice(0, 2000) : body.text;
        const res = await fetch(`${discordApiBase}/channels/${body.to}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
          body: JSON.stringify({ content: text }),
          signal: AbortSignal.timeout(15_000),
        });
        const data = await res.json() as { id?: string; message?: string };
        if (!res.ok) return c.json({ ok: false, error: data.message, platform: 'discord' });
        return c.json({ ok: true, platform: 'discord', messageId: data.id });
      }

      return c.json({ ok: false, error: `unsupported platform: ${platform}` }, 400);
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : 'send failed' }, 500);
    }
  });

  const waitUntilOpts = {
    waitUntil: (task: Promise<unknown>) => {
      task.catch((err: unknown) => {
        console.error('[opencode-channels] Background task failed:', err);
      });
    },
  };

  for (const mod of adapterModules) {
    app.post(`/api/webhooks/${mod.name}`, async (c) => {
      const bot = await resolveBot();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (bot as any)?.webhooks?.[mod.name];
      if (!handler) {
        return c.text(`${mod.name} adapter not configured`, 404);
      }

      return handler(c.req.raw, waitUntilOpts);
    });

    // Telegram needs a GET handler for webhook verification
    if (mod.name === 'telegram') {
      app.get(`/api/webhooks/${mod.name}`, async (c) => {
        const bot = await resolveBot();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const adapter = (bot as any)?.adapters?.[mod.name];
        if (!adapter?.handleWebhook) {
          return c.text(`${mod.name} adapter not configured`, 404);
        }
        return adapter.handleWebhook(c.req.raw, waitUntilOpts);
      });
    }

    mod.registerRoutes?.(app, getBot);
  }

  const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(`[opencode-channels] Server listening on ${host}:${info.port}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[opencode-channels] Port ${port} is already in use.\n` +
        `  Try: PORT=${port + 1} pnpm start  (or kill the process using port ${port})`
      );
      process.exit(1);
    }
    throw err;
  });

  return {
    app,
    server,
    stop: () => {
      server.close();
      console.log('[opencode-channels] Server stopped');
    },
  };
}
