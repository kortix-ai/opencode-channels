import { Hono } from 'hono';
import { serve } from '@hono/node-server';

import type { ChannelsService } from './service.js';
import type { ReloadRequest } from './types.js';
import { adapterModules } from './adapters/registry.js';

export interface ServerConfig {
  port?: number;
  host?: string;
}

export function createServer(
  service: ChannelsService,
  config: ServerConfig = {},
) {
  const port = config.port ?? (process.env.PORT ? Number(process.env.PORT) : 3456);
  const host = config.host ?? '0.0.0.0';

  const app = new Hono();

  app.get('/health', (c) =>
    c.json({
      ok: true,
      service: 'opencode-channels',
      adapters: service.activeAdapters,
    }),
  );

  app.post('/reload', async (c) => {
    try {
      const body = await c.req.json() as ReloadRequest;
      if (!body?.credentials) {
        return c.json({ error: 'Missing credentials' }, 400);
      }
      const result = service.reload(body.credentials);
      return c.json(result);
    } catch (err) {
      console.error('[opencode-channels] Reload failed:', err);
      return c.json({ error: 'Reload failed' }, 500);
    }
  });

  for (const mod of adapterModules) {
    app.post(`/api/webhooks/${mod.name}`, async (c) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (service.bot as any)?.webhooks?.[mod.name];
      if (!handler) {
        return c.text(`${mod.name} adapter not configured`, 404);
      }

      return handler(c.req.raw, {
        waitUntil: (task: Promise<unknown>) => {
          task.catch((err: unknown) => {
            console.error('[opencode-channels] Background task failed:', err);
          });
        },
      });
    });

    mod.registerRoutes?.(app, () => service.bot);
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
