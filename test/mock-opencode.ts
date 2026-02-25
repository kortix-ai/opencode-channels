/**
 * Mock OpenCode server for isolated E2E testing.
 *
 * Implements the minimum OpenCode API surface needed by opencode-channels:
 *   GET  /global/health           → { healthy: true }
 *   POST /session                 → { id: "ses_mock_..." }
 *   POST /session/:id/prompt_async → 204 (fires SSE events)
 *   GET  /event                   → SSE stream with message deltas
 *   GET  /config/providers        → mock providers list
 *   GET  /agent                   → mock agents list
 *   GET  /file/status             → []
 *   GET  /session/:id/diff        → empty diff
 *   POST /session/:id/share       → mock share URL
 *   POST /session/:id/abort       → 200
 *
 * The mock responds to prompts with a configurable canned response,
 * streamed character-by-character via SSE to simulate real behavior.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// ─── Configuration ──────────────────────────────────────────────────────────

export interface MockOpenCodeConfig {
  port: number;
  /** The text response the mock returns for any prompt. Default: "Mock response from OpenCode." */
  response?: string;
  /** Delay between SSE chunks in ms. Default: 10 */
  chunkDelayMs?: number;
  /** If set, prompts will fail with this error message */
  errorResponse?: string;
}

// ─── State ──────────────────────────────────────────────────────────────────

let sessionCounter = 0;
const activeSessions = new Map<string, { agent?: string }>();
const sseClients: Set<ServerResponse> = new Set();
let defaultResponse = 'Mock response from OpenCode.';
let chunkDelayMs = 10;
let errorResponse: string | undefined;

// ─── Helpers ────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendSSE(data: Record<string, unknown>): void {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { /* client disconnected */ }
  }
}

async function streamResponse(sessionId: string, text: string): Promise<void> {
  const msgId = `msg_mock_${Date.now()}`;

  // session.busy — use session.status so the client sets sawBusy=true
  sendSSE({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });

  // Stream text in small chunks
  const chunkSize = 8;
  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize);
    sendSSE({
      type: 'message.part.delta',
      properties: {
        sessionID: sessionId,
        delta: chunk,
        part: { sessionID: sessionId, messageID: msgId, type: 'text' },
      },
    });
    if (chunkDelayMs > 0) {
      await new Promise((r) => setTimeout(r, chunkDelayMs));
    }
  }

  // message.part.updated (final — no delta, signals completion)
  sendSSE({
    type: 'message.part.updated',
    properties: {
      sessionID: sessionId,
      part: { sessionID: sessionId, messageID: msgId, type: 'text' },
    },
  });

  // session.idle
  sendSSE({ type: 'session.idle', properties: { sessionID: sessionId } });
}

async function streamError(sessionId: string, error: string): Promise<void> {
  sendSSE({
    type: 'session.error',
    properties: { sessionID: sessionId, error },
  });
  sendSSE({ type: 'session.idle', properties: { sessionID: sessionId } });
}

// ─── Mock providers / agents ────────────────────────────────────────────────

const MOCK_PROVIDERS = [
  {
    id: 'mock-provider',
    name: 'MockProvider',
    models: [
      { id: 'mock/fast-model', name: 'Fast Model' },
      { id: 'mock/smart-model', name: 'Smart Model' },
    ],
  },
];

const MOCK_AGENTS = [
  { name: 'coder', description: 'General purpose coding agent' },
  { name: 'researcher', description: 'Research and analysis agent' },
];

// ─── Route handler ──────────────────────────────────────────────────────────

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || '/', `http://localhost`);
  const method = req.method || 'GET';
  const path = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /global/health
  if (method === 'GET' && path === '/global/health') {
    json(res, { healthy: true, version: '0.0.0-mock' });
    return;
  }

  // GET /event → SSE
  if (method === 'GET' && path === '/event') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':ok\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // POST /session → create session
  if (method === 'POST' && path === '/session') {
    const id = `ses_mock_${++sessionCounter}`;
    readBody(req).then((body) => {
      try {
        const parsed = JSON.parse(body || '{}');
        activeSessions.set(id, { agent: parsed.agent });
      } catch {
        activeSessions.set(id, {});
      }
      json(res, { id });
    });
    return;
  }

  // POST /session/:id/prompt_async
  const promptMatch = path.match(/^\/session\/([^/]+)\/prompt_async$/);
  if (method === 'POST' && promptMatch) {
    const sessionId = promptMatch[1];
    res.writeHead(204);
    res.end();

    // Stream response asynchronously
    readBody(req).then(() => {
      if (errorResponse) {
        streamError(sessionId, errorResponse);
      } else {
        streamResponse(sessionId, defaultResponse);
      }
    });
    return;
  }

  // POST /session/:id/abort
  const abortMatch = path.match(/^\/session\/([^/]+)\/abort$/);
  if (method === 'POST' && abortMatch) {
    json(res, { ok: true });
    return;
  }

  // GET /config/providers
  if (method === 'GET' && path === '/config/providers') {
    json(res, MOCK_PROVIDERS);
    return;
  }

  // GET /agent
  if (method === 'GET' && path === '/agent') {
    json(res, MOCK_AGENTS);
    return;
  }

  // GET /file/status
  if (method === 'GET' && path === '/file/status') {
    json(res, []);
    return;
  }

  // GET /session/:id/diff
  const diffMatch = path.match(/^\/session\/([^/]+)\/diff$/);
  if (method === 'GET' && diffMatch) {
    json(res, { diff: '' });
    return;
  }

  // POST /session/:id/share
  const shareMatch = path.match(/^\/session\/([^/]+)\/share$/);
  if (method === 'POST' && shareMatch) {
    json(res, { url: `https://share.mock/${shareMatch[1]}` });
    return;
  }

  // GET /file/content
  if (method === 'GET' && path === '/file/content') {
    json(res, { content: '' });
    return;
  }

  // 404
  json(res, { error: 'not found', path }, 404);
}

// ─── Server lifecycle ───────────────────────────────────────────────────────

export function createMockOpenCode(config: MockOpenCodeConfig) {
  defaultResponse = config.response ?? 'Mock response from OpenCode.';
  chunkDelayMs = config.chunkDelayMs ?? 10;
  errorResponse = config.errorResponse;
  sessionCounter = 0;
  activeSessions.clear();
  sseClients.clear();

  const server = createServer(handleRequest);

  return {
    start(): Promise<void> {
      return new Promise((resolve) => {
        server.listen(config.port, '0.0.0.0', () => resolve());
      });
    },
    stop(): Promise<void> {
      for (const client of sseClients) {
        try { client.end(); } catch { /* ignore */ }
      }
      sseClients.clear();
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
    /** Update the canned response for subsequent prompts */
    setResponse(text: string) { defaultResponse = text; },
    /** Make subsequent prompts fail with an error */
    setError(error: string | undefined) { errorResponse = error; },
    /** Get the number of sessions created */
    get sessionCount() { return sessionCounter; },
    /** Get active SSE client count */
    get sseClientCount() { return sseClients.size; },
  };
}
