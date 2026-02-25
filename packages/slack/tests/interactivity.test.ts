/**
 * Tests for the Slack interactivity handler.
 *
 * Covers:
 *   - Permission approve/reject buttons
 *   - Message actions (ask_kortix, export_thread)
 *   - Unknown payload types
 *   - Missing payload handling
 *   - Config resolution via getConfig
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { handleSlackInteractivity } from '../src/interactivity.js';
import { createPermissionRequest, replyPermissionRequest } from '@opencode-channels/core';
import type { ChannelConfig, ChannelEngine, SessionStrategy } from '@opencode-channels/core';

// ─── Helpers ────────────────────────────────────────────────────────────────

let fetchCaptures: Array<{ url: string; body?: Record<string, unknown> }> = [];

function makeConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: 'cfg-int-1',
    name: 'Test Slack',
    channelType: 'slack',
    enabled: true,
    credentials: {
      botToken: 'xoxb-test-bot-token',
      signingSecret: '', // skip verification
    },
    platformConfig: {},
    metadata: {},
    sessionStrategy: 'per-user' as SessionStrategy,
    systemPrompt: null,
    agentName: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeEngine(): ChannelEngine & {
  processMessage: ReturnType<typeof vi.fn>;
} {
  return {
    processMessage: vi.fn().mockResolvedValue(undefined),
    resetSession: vi.fn().mockResolvedValue(undefined),
    getAdapter: vi.fn().mockReturnValue(undefined),
    cleanup: vi.fn(),
  };
}

function buildInteractivityBody(payload: Record<string, unknown>): string {
  const params = new URLSearchParams({
    payload: JSON.stringify(payload),
  });
  return params.toString();
}

async function invokeInteractivity(
  payload: Record<string, unknown>,
  config?: ChannelConfig | null,
  engine?: ChannelEngine,
  getConfig?: (teamId: string) => ChannelConfig | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = new Hono();
  const eng = engine ?? makeEngine();
  const cfg = config === undefined ? makeConfig() : config;
  const getCfg = getConfig ?? (() => cfg ?? undefined);

  app.post('/slack/interactivity', (c) =>
    handleSlackInteractivity(c, eng, getCfg),
  );

  const rawBody = buildInteractivityBody(payload);
  const res = await app.request('/slack/interactivity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: rawBody,
  });

  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

const originalFetch = globalThis.fetch;

function installMockFetch() {
  fetchCaptures = [];

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    let bodyObj: Record<string, unknown> = {};
    if (init?.body) {
      try { bodyObj = JSON.parse(init.body as string); } catch { /* ignore */ }
    }
    fetchCaptures.push({ url, body: bodyObj });

    if (url.includes('conversations.replies')) {
      return new Response(JSON.stringify({
        ok: true,
        messages: [{ ts: '100.000', text: 'thread msg', user: 'U1' }],
      }), { status: 200 });
    }
    if (url.includes('files.getUploadURLExternal')) {
      return new Response(JSON.stringify({
        ok: true,
        upload_url: 'https://files.slack.com/upload/xxx',
        file_id: 'F1',
      }), { status: 200 });
    }
    if (url.includes('files.slack.com')) {
      return new Response('OK', { status: 200 });
    }
    if (url.includes('files.completeUploadExternal')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Slack Interactivity Handler', () => {
  beforeEach(() => {
    installMockFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── Missing payload ────────────────────────────────────────────────────

  describe('missing/invalid payload', () => {
    it('returns 400 for missing payload', async () => {
      const app = new Hono();
      const engine = makeEngine();

      app.post('/slack/interactivity', (c) =>
        handleSlackInteractivity(c, engine, () => undefined),
      );

      const res = await app.request('/slack/interactivity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'no_payload_here=true',
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toContain('Missing payload');
    });

    it('returns 400 for invalid JSON payload', async () => {
      const app = new Hono();
      const engine = makeEngine();

      app.post('/slack/interactivity', (c) =>
        handleSlackInteractivity(c, engine, () => undefined),
      );

      const params = new URLSearchParams({ payload: 'not-json{' });
      const res = await app.request('/slack/interactivity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      expect(res.status).toBe(400);
    });
  });

  // ── Permission approve/reject ──────────────────────────────────────────

  describe('permission actions', () => {
    it('handles permission_approve button click', async () => {
      // Create a pending permission
      const { resolve } = createPermissionRequest('perm-123');

      const { status, body } = await invokeInteractivity({
        type: 'block_actions',
        team: { id: 'T_TEAM' },
        user: { id: 'U1', username: 'admin' },
        actions: [
          {
            action_id: 'permission_approve',
            value: 'perm-123',
            block_id: 'perm_perm-123',
          },
        ],
        response_url: 'https://hooks.slack.com/response-url',
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      // Should have posted to response_url with approval message
      const responseUrlCall = fetchCaptures.find((c) => c.url.includes('hooks.slack.com'));
      expect(responseUrlCall).toBeDefined();
      expect(responseUrlCall!.body!.text).toContain('Approved');
    });

    it('handles permission_reject button click', async () => {
      const { resolve } = createPermissionRequest('perm-456');

      const { status } = await invokeInteractivity({
        type: 'block_actions',
        team: { id: 'T_TEAM' },
        user: { id: 'U1', username: 'admin' },
        actions: [
          {
            action_id: 'permission_reject',
            value: 'perm-456',
          },
        ],
        response_url: 'https://hooks.slack.com/response-url',
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(status).toBe(200);

      const responseUrlCall = fetchCaptures.find((c) => c.url.includes('hooks.slack.com'));
      expect(responseUrlCall).toBeDefined();
      expect(responseUrlCall!.body!.text).toContain('Rejected');
    });

    it('shows expired message when permission request not found', async () => {
      const { status } = await invokeInteractivity({
        type: 'block_actions',
        team: { id: 'T_TEAM' },
        user: { id: 'U1', username: 'admin' },
        actions: [
          {
            action_id: 'permission_approve',
            value: 'perm-nonexistent',
          },
        ],
        response_url: 'https://hooks.slack.com/response-url',
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(status).toBe(200);

      const responseUrlCall = fetchCaptures.find((c) => c.url.includes('hooks.slack.com'));
      expect(responseUrlCall!.body!.text).toContain('expired');
    });

    it('ignores permission actions with empty value', async () => {
      const { status } = await invokeInteractivity({
        type: 'block_actions',
        team: { id: 'T_TEAM' },
        user: { id: 'U1' },
        actions: [
          {
            action_id: 'permission_approve',
            value: '',
          },
        ],
      });

      expect(status).toBe(200);
    });

    it('ignores link_instance button actions', async () => {
      const { status } = await invokeInteractivity({
        type: 'block_actions',
        team: { id: 'T_TEAM' },
        actions: [
          { action_id: 'link_instance', value: 'some-url' },
        ],
      });

      expect(status).toBe(200);
    });
  });

  // ── Message actions ────────────────────────────────────────────────────

  describe('message actions', () => {
    it('handles ask_kortix message action', async () => {
      const engine = makeEngine();
      const config = makeConfig();
      const getConfig = vi.fn().mockReturnValue(config);

      const { status } = await invokeInteractivity(
        {
          type: 'message_action',
          callback_id: 'ask_kortix',
          team: { id: 'T_TEAM' },
          user: { id: 'U1', username: 'tester' },
          channel: { id: 'C_CHAN' },
          message: {
            ts: '111.222',
            thread_ts: '111.000',
            text: 'Analyze this deployment log',
          },
        },
        null,
        engine,
        getConfig,
      );

      await new Promise((r) => setTimeout(r, 100));

      expect(status).toBe(200);
      expect(engine.processMessage).toHaveBeenCalledTimes(1);

      const msg = engine.processMessage.mock.calls[0][0];
      expect(msg.content).toContain('Analyze this message');
      expect(msg.content).toContain('Analyze this deployment log');
    });

    it('handles export_thread message action', async () => {
      const config = makeConfig();
      const getConfig = vi.fn().mockReturnValue(config);

      const { status } = await invokeInteractivity(
        {
          type: 'message_action',
          callback_id: 'export_thread',
          team: { id: 'T_TEAM' },
          user: { id: 'U1' },
          channel: { id: 'C_CHAN' },
          message: {
            ts: '111.222',
            thread_ts: '111.000',
            text: 'Some thread message',
          },
        },
        null,
        undefined,
        getConfig,
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(status).toBe(200);

      // Should have called conversations.replies for the thread export
      const repliesCall = fetchCaptures.find((c) => c.url.includes('conversations.replies'));
      expect(repliesCall).toBeDefined();
    });
  });

  // ── Unknown payload types ──────────────────────────────────────────────

  describe('unknown payload types', () => {
    it('returns ok for unhandled payload types', async () => {
      const { status, body } = await invokeInteractivity({
        type: 'dialog_submission',
        team: { id: 'T_TEAM' },
      });

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });
  });
});
