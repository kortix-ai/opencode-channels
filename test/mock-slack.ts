/**
 * Mock Slack API server for isolated E2E testing.
 *
 * Intercepts Slack Web API calls that the Chat SDK makes:
 *   POST /api/auth.test              → bot identity
 *   POST /api/chat.postMessage       → post message
 *   POST /api/chat.update            → edit message
 *   POST /api/reactions.add          → add reaction
 *   POST /api/reactions.remove       → remove reaction
 *   POST /api/chat.delete            → delete message
 *   POST /api/files.uploadV2         → file upload
 *   POST /api/assistant.threads.setStatus → typing indicator
 *   POST /api/conversations.info     → channel info
 *   POST /api/users.info             → user info
 *
 * Records all API calls for assertion in tests.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SlackApiCall {
  method: string;
  path: string;
  body: Record<string, unknown>;
  timestamp: number;
}

export interface MockSlackConfig {
  port: number;
  botUserId?: string;
  botId?: string;
  teamId?: string;
}

// ─── State ──────────────────────────────────────────────────────────────────

let messageCounter = 0;
const calls: SlackApiCall[] = [];

// ─── Helpers ────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

function parseBody(body: string, contentType: string): Record<string, unknown> {
  if (contentType.includes('application/json')) {
    try { return JSON.parse(body); } catch { return {}; }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(body));
  }
  // Multipart (simplified — just return raw)
  return { raw: body };
}

function json(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ─── Route handler ──────────────────────────────────────────────────────────

function createHandler(config: MockSlackConfig) {
  const botUserId = config.botUserId ?? 'U_MOCK_BOT';
  const botId = config.botId ?? 'B_MOCK_BOT';
  const teamId = config.teamId ?? 'T_MOCK_TEAM';

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const contentType = req.headers['content-type'] || '';
    const body = await readBody(req);
    const parsed = parseBody(body, contentType);

    // Record the call
    calls.push({ method: req.method || 'POST', path, body: parsed, timestamp: Date.now() });

    // POST /api/auth.test
    if (path === '/api/auth.test') {
      json(res, {
        ok: true,
        user_id: botUserId,
        bot_id: botId,
        team_id: teamId,
        user: 'mockbot',
        team: 'Mock Team',
      });
      return;
    }

    // POST /api/chat.postMessage
    if (path === '/api/chat.postMessage') {
      const ts = `${Math.floor(Date.now() / 1000)}.${String(++messageCounter).padStart(6, '0')}`;
      json(res, {
        ok: true,
        channel: parsed.channel || 'C_MOCK',
        ts,
        message: { text: parsed.text || '', ts, user: botUserId },
      });
      return;
    }

    // POST /api/chat.update
    if (path === '/api/chat.update') {
      json(res, {
        ok: true,
        channel: parsed.channel || 'C_MOCK',
        ts: parsed.ts || '0',
        text: parsed.text || '',
      });
      return;
    }

    // POST /api/reactions.add
    if (path === '/api/reactions.add') {
      json(res, { ok: true });
      return;
    }

    // POST /api/reactions.remove
    if (path === '/api/reactions.remove') {
      json(res, { ok: true });
      return;
    }

    // POST /api/chat.delete
    if (path === '/api/chat.delete') {
      json(res, { ok: true });
      return;
    }

    // POST /api/files.uploadV2
    if (path === '/api/files.uploadV2' || path === '/api/files.upload') {
      json(res, { ok: true, file: { id: `F_MOCK_${messageCounter}` } });
      return;
    }

    // POST /api/assistant.threads.setStatus
    if (path === '/api/assistant.threads.setStatus') {
      json(res, { ok: true });
      return;
    }

    // POST /api/conversations.info
    if (path === '/api/conversations.info') {
      json(res, {
        ok: true,
        channel: {
          id: parsed.channel || 'C_MOCK',
          name: 'mock-channel',
          is_channel: true,
          is_im: false,
        },
      });
      return;
    }

    // POST /api/users.info
    if (path === '/api/users.info') {
      json(res, {
        ok: true,
        user: {
          id: parsed.user || 'U_MOCK',
          name: 'mockuser',
          real_name: 'Mock User',
          is_bot: false,
        },
      });
      return;
    }

    // Catch-all for unknown endpoints
    json(res, { ok: true });
  };
}

// ─── Server lifecycle ───────────────────────────────────────────────────────

export function createMockSlack(config: MockSlackConfig) {
  messageCounter = 0;
  calls.length = 0;

  const server = createServer(createHandler(config));

  return {
    start(): Promise<void> {
      return new Promise((resolve) => {
        server.listen(config.port, '0.0.0.0', () => resolve());
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
    /** All recorded Slack API calls */
    get calls(): readonly SlackApiCall[] { return calls; },
    /** Clear recorded calls */
    clearCalls() { calls.length = 0; },
    /** Find calls to a specific endpoint */
    callsTo(endpoint: string): SlackApiCall[] {
      return calls.filter((c) => c.path === `/api/${endpoint}`);
    },
    /** Get the last call to a specific endpoint */
    lastCallTo(endpoint: string): SlackApiCall | undefined {
      const matching = calls.filter((c) => c.path === `/api/${endpoint}`);
      return matching[matching.length - 1];
    },
    /** Get count of calls to a specific endpoint */
    callCount(endpoint: string): number {
      return calls.filter((c) => c.path === `/api/${endpoint}`).length;
    },
  };
}
