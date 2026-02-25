/**
 * Webhook Server — Hono-based HTTP server for receiving inbound
 * webhooks from messaging platforms (Telegram, Slack, Discord, etc.).
 *
 * Provides:
 *   - GET /health — readiness probe
 *   - Dynamic adapter routes registered via registerRoutes()
 *   - Graceful start/stop lifecycle
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WebhookServerConfig {
  port: number;
  host?: string;
}

export interface WebhookServer {
  /** The Hono application — register additional routes here before start(). */
  app: Hono;

  /**
   * Start the HTTP server. Returns a promise that resolves once the server
   * is listening.
   */
  start: () => Promise<void>;

  /**
   * Gracefully stop the HTTP server.
   */
  stop: () => void;
}

// ─── Bun type definitions (for non-Bun environments) ────────────────────────

interface BunServeOptions {
  port: number;
  hostname: string;
  fetch: (req: Request) => Response | Promise<Response>;
}

interface BunServer {
  stop: () => void;
}

interface BunGlobal {
  serve: (options: BunServeOptions) => BunServer;
}

declare global {
  // eslint-disable-next-line no-var
  var Bun: BunGlobal | undefined;
}

// ─── Adapter name tracking ──────────────────────────────────────────────────

const registeredAdapters: string[] = [];

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a webhook server. Does NOT start listening until `start()` is called.
 */
export function createWebhookServer(config: WebhookServerConfig): WebhookServer {
  const { port, host = '0.0.0.0' } = config;
  const app = new Hono();

  // ── Middleware ──────────────────────────────────────────────────────────
  app.use('*', cors());
  app.use('*', logger());

  // ── Health endpoint ────────────────────────────────────────────────────
  app.get('/health', (c) =>
    c.json({
      ok: true,
      service: 'opencode-channels',
      adapters: [...registeredAdapters],
      timestamp: new Date().toISOString(),
    }),
  );

  // ── Server lifecycle ───────────────────────────────────────────────────

  let server: BunServer | { close: () => void } | null = null;

  const start = async (): Promise<void> => {
    const bunRuntime = globalThis.Bun;

    // Try Bun.serve first (Bun runtime), fall back to Node http
    if (bunRuntime) {
      server = bunRuntime.serve({
        port,
        hostname: host,
        fetch: app.fetch,
      });
      console.log(`[webhook-server] Listening on ${host}:${port} (Bun)`);
    } else {
      // Node.js fallback — use native http module with Hono's fetch adapter
      const http = await import('node:http');
      const nodeServer = http.createServer(async (req, res) => {
        // Build a standard Request from the Node IncomingMessage
        const protocol = 'http';
        const url = `${protocol}://${req.headers.host || `${host}:${port}`}${req.url || '/'}`;

        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value) {
            const vals = Array.isArray(value) ? value : [value];
            for (const v of vals) {
              headers.append(key, v);
            }
          }
        }

        const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
        const body = hasBody
          ? await new Promise<Buffer>((resolve) => {
              const chunks: Buffer[] = [];
              req.on('data', (chunk: Buffer) => chunks.push(chunk));
              req.on('end', () => resolve(Buffer.concat(chunks)));
            })
          : undefined;

        const request = new Request(url, {
          method: req.method,
          headers,
          body: body ? body : undefined,
        });

        try {
          const response = await app.fetch(request);
          res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
          const responseBody = await response.arrayBuffer();
          res.end(Buffer.from(responseBody));
        } catch (err) {
          console.error('[webhook-server] Request handling error:', err);
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      });

      await new Promise<void>((resolve, reject) => {
        nodeServer.listen(port, host, () => {
          console.log(`[webhook-server] Listening on ${host}:${port} (Node)`);
          resolve();
        });
        nodeServer.on('error', reject);
      });

      server = nodeServer;
    }
  };

  const stop = (): void => {
    if (!server) return;

    if ('stop' in server && typeof server.stop === 'function') {
      server.stop();
    } else if ('close' in server && typeof server.close === 'function') {
      server.close();
    }

    server = null;
    console.log('[webhook-server] Stopped');
  };

  return { app, start, stop };
}

/**
 * Register an adapter name (for the /health endpoint).
 * Call this from each adapter's initialization code.
 */
export function registerAdapter(name: string): void {
  if (!registeredAdapters.includes(name)) {
    registeredAdapters.push(name);
  }
}
