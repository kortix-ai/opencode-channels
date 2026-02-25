/**
 * Webhook server — Hono-based HTTP server that delegates to Chat SDK.
 *
 * Routes:
 *   POST /api/webhooks/slack  — Slack Events API + commands + interactivity
 *   GET  /health              — Health check
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { Chat, Adapter } from 'chat';

export interface ServerConfig {
  port?: number;
  host?: string;
}

export function createServer(
  bot: Chat<Record<string, Adapter>>,
  config: ServerConfig = {},
) {
  const port = config.port ?? (process.env.PORT ? Number(process.env.PORT) : 3456);
  const host = config.host ?? '0.0.0.0';

  const app = new Hono();

  // Health check
  app.get('/health', (c) =>
    c.json({ ok: true, service: 'opencode-channels', adapters: ['slack'] }),
  );

  // Slack webhooks — events, commands, interactivity all go through one route
  app.post('/api/webhooks/slack', async (c) => {
    const handler = bot.webhooks.slack;
    if (!handler) {
      return c.text('Slack adapter not configured', 404);
    }

    // Chat SDK expects a standard Request object
    return handler(c.req.raw, {
      waitUntil: (task) => {
        // In Node.js (non-serverless), just let it run
        task.catch((err) => {
          console.error('[opencode-channels] Background task failed:', err);
        });
      },
    });
  });

  // Legacy routes (for backwards compatibility with existing Slack app configs)
  app.post('/slack/events', async (c) => {
    const handler = bot.webhooks.slack;
    if (!handler) return c.text('Slack adapter not configured', 404);
    return handler(c.req.raw, {
      waitUntil: (task) => { task.catch(console.error); },
    });
  });

  app.post('/slack/commands', async (c) => {
    const handler = bot.webhooks.slack;
    if (!handler) return c.text('Slack adapter not configured', 404);
    return handler(c.req.raw, {
      waitUntil: (task) => { task.catch(console.error); },
    });
  });

  app.post('/slack/interactivity', async (c) => {
    const handler = bot.webhooks.slack;
    if (!handler) return c.text('Slack adapter not configured', 404);
    return handler(c.req.raw, {
      waitUntil: (task) => { task.catch(console.error); },
    });
  });

  // Start
  const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(`[opencode-channels] Server listening on ${host}:${info.port}`);
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
