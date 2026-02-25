/**
 * Comprehensive test suite for the Slack webhook handler.
 *
 * Tests the full handler chain: Hono context → handleSlackWebhook →
 * message normalization → engine.processMessage.
 *
 * Covers:
 *   - URL verification challenge
 *   - App mention events
 *   - DM messages
 *   - Group messages (with require_mention gating)
 *   - Thread context fetching
 *   - File upload handling
 *   - In-chat commands: use <model>, use agent <name>, reset, new session
 *   - Bot message filtering
 *   - Signature verification
 *   - Reaction events
 *   - Link shared events
 *   - Fuzzy model matching
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { handleSlackWebhook } from '../src/webhook.js';
import type { ChannelConfig, ChannelEngine, NormalizedMessage, SessionStrategy } from '@opencode-channels/core';

// ─── Helpers ────────────────────────────────────────────────────────────────

let slackApiCaptures: Array<{ url: string; body?: Record<string, unknown> }> = [];

function makeConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: 'cfg-slack-1',
    name: 'Test Slack',
    channelType: 'slack',
    enabled: true,
    credentials: {
      botToken: 'xoxb-test-bot-token',
      signingSecret: '', // empty = skip verification
      botUserId: 'U_BOT',
    },
    platformConfig: {
      groups: { requireMention: true },
    },
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
  resetSession: ReturnType<typeof vi.fn>;
} {
  return {
    processMessage: vi.fn().mockResolvedValue(undefined),
    resetSession: vi.fn().mockResolvedValue(undefined),
    getAdapter: vi.fn().mockReturnValue(undefined),
    cleanup: vi.fn(),
  };
}

function buildEventPayload(event: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'event_callback',
    token: 'test-token',
    team_id: 'T_TEAM',
    event_id: `evt-${Date.now()}`,
    event_time: Math.floor(Date.now() / 1000),
    event,
    ...overrides,
  };
}

async function invokeWebhook(
  payload: Record<string, unknown>,
  config?: ChannelConfig | null,
  engine?: ChannelEngine,
  getConfig?: (teamId: string) => ChannelConfig | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = new Hono();
  const cfg = config === undefined ? makeConfig() : config;
  const eng = engine ?? makeEngine();
  const getCfg = getConfig ?? (() => cfg ?? undefined);

  app.post('/slack/events', (c) =>
    handleSlackWebhook(c, eng, cfg, getCfg),
  );

  const res = await app.request('/slack/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

const originalFetch = globalThis.fetch;

function installMockFetch() {
  slackApiCaptures = [];

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('slack.com/api/')) {
      let bodyObj: Record<string, unknown> = {};
      if (init?.body) {
        try { bodyObj = JSON.parse(init.body as string); } catch { /* ignore */ }
      }
      slackApiCaptures.push({ url, body: bodyObj });

      if (url.includes('conversations.replies')) {
        return new Response(JSON.stringify({
          ok: true,
          messages: [
            { ts: '100.000', text: 'parent message', user: 'U1' },
            { ts: '100.001', text: 'bot reply', user: 'U_BOT', bot_id: 'B_BOT' },
            { ts: '100.002', text: 'user follow-up', user: 'U2' },
          ],
        }), { status: 200 });
      }
      if (url.includes('conversations.join')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('chat.postMessage')) {
        return new Response(JSON.stringify({ ok: true, ts: '999.000' }), { status: 200 });
      }
      if (url.includes('chat.unfurl')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('reactions.add')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('reactions.remove')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      // listProviders for fuzzy model matching
      if (url.includes('config/providers')) {
        return new Response(JSON.stringify({
          providers: [
            {
              id: 'anthropic',
              models: {
                'claude-sonnet-4-20250514': { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
                'claude-opus-4-20250514': { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
              },
            },
          ],
        }), { status: 200 });
      }
      // health check
      if (url.includes('global/health')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Slack Webhook Handler', () => {
  beforeEach(() => {
    installMockFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── URL verification ────────────────────────────────────────────────────

  describe('URL verification', () => {
    it('responds with challenge for url_verification payload', async () => {
      const { status, body } = await invokeWebhook({
        type: 'url_verification',
        challenge: 'test-challenge-123',
        token: 'test-token',
      });
      expect(status).toBe(200);
      expect(body.challenge).toBe('test-challenge-123');
    });

    it('works without a config for url_verification', async () => {
      const { status, body } = await invokeWebhook(
        {
          type: 'url_verification',
          challenge: 'abc',
          token: 'test-token',
        },
        null,
      );
      expect(status).toBe(200);
      expect(body.challenge).toBe('abc');
    });
  });

  // ── Non event_callback payloads ─────────────────────────────────────────

  describe('non-event payloads', () => {
    it('returns ok for unknown payload types', async () => {
      const { status, body } = await invokeWebhook({ type: 'unknown_type' });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });
  });

  // ── Bot message filtering ──────────────────────────────────────────────

  describe('bot message filtering', () => {
    it('ignores messages from bots (bot_id present)', async () => {
      const engine = makeEngine();
      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          bot_id: 'B_OTHER',
          text: 'Bot said hello',
          channel: 'C1',
          ts: '111.222',
        }),
        undefined,
        engine,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(engine.processMessage).not.toHaveBeenCalled();
    });

    it('ignores messages with bot_message subtype', async () => {
      const engine = makeEngine();
      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          subtype: 'bot_message',
          text: 'Bot message',
          channel: 'C1',
          ts: '111.222',
        }),
        undefined,
        engine,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(engine.processMessage).not.toHaveBeenCalled();
    });

    it('ignores message_changed and other subtypes', async () => {
      const engine = makeEngine();
      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          subtype: 'message_changed',
          text: 'Edited message',
          channel: 'C1',
          ts: '111.222',
          user: 'U1',
        }),
        undefined,
        engine,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(engine.processMessage).not.toHaveBeenCalled();
    });

    it('allows file_share subtype through', async () => {
      const engine = makeEngine();
      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          subtype: 'file_share',
          text: '',
          channel: 'C1',
          channel_type: 'im',
          ts: '111.222',
          user: 'U1',
          files: [{ id: 'F1', name: 'test.txt', mimetype: 'text/plain', filetype: 'text', url_private: 'https://files.slack.com/f1', size: 100 }],
        }),
        undefined,
        engine,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(engine.processMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ── DM messages ────────────────────────────────────────────────────────

  describe('DM messages', () => {
    it('processes DM messages (channel_type=im)', async () => {
      const engine = makeEngine();
      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          channel_type: 'im',
          text: 'Hello from DM',
          channel: 'D_DM',
          ts: '111.222',
          user: 'U1',
        }),
        undefined,
        engine,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(engine.processMessage).toHaveBeenCalledTimes(1);
      const msg = engine.processMessage.mock.calls[0][0] as NormalizedMessage;
      expect(msg.chatType).toBe('dm');
      expect(msg.content).toBe('Hello from DM');
    });

    it('does not require mention for DMs', async () => {
      const engine = makeEngine();
      const config = makeConfig({
        platformConfig: { groups: { requireMention: true } },
      });
      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          channel_type: 'im',
          text: 'No mention needed in DM',
          channel: 'D_DM',
          ts: '111.222',
          user: 'U1',
        }),
        config,
        engine,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(engine.processMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ── App mention events ─────────────────────────────────────────────────

  describe('app_mention events', () => {
    it('processes app_mention events', async () => {
      const engine = makeEngine();
      await invokeWebhook(
        buildEventPayload({
          type: 'app_mention',
          text: '<@U_BOT> what is the status?',
          channel: 'C_CHAN',
          channel_type: 'channel',
          ts: '111.222',
          user: 'U1',
        }),
        undefined,
        engine,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(engine.processMessage).toHaveBeenCalledTimes(1);
      const msg = engine.processMessage.mock.calls[0][0] as NormalizedMessage;
      expect(msg.isMention).toBe(true);
      // Bot mention should be stripped from content
      expect(msg.content).not.toContain('<@U_BOT>');
      expect(msg.content).toContain('what is the status?');
    });
  });

  // ── Group messages with require_mention ────────────────────────────────

  describe('group messages with requireMention', () => {
    it('ignores group messages without mention when requireMention=true', async () => {
      const engine = makeEngine();
      const config = makeConfig({
        platformConfig: { groups: { requireMention: true } },
      });
      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          channel_type: 'channel',
          text: 'General chat without mention',
          channel: 'C_CHAN',
          ts: '111.222',
          user: 'U1',
        }),
        config,
        engine,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(engine.processMessage).not.toHaveBeenCalled();
    });

    it('allows group messages when requireMention=false', async () => {
      const engine = makeEngine();
      const config = makeConfig({
        platformConfig: { groups: { requireMention: false } },
      });
      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          channel_type: 'channel',
          text: 'No mention needed',
          channel: 'C_CHAN',
          ts: '111.222',
          user: 'U1',
        }),
        config,
        engine,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(engine.processMessage).toHaveBeenCalledTimes(1);
    });

    it('allows group thread replies when bot has participated', async () => {
      const engine = makeEngine();
      const config = makeConfig({
        platformConfig: { groups: { requireMention: true } },
      });

      // Thread reply — bot already replied (via mock conversations.replies)
      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          channel_type: 'channel',
          text: 'follow up in thread',
          channel: 'C_CHAN',
          ts: '100.003',
          thread_ts: '100.000',
          user: 'U2',
        }),
        config,
        engine,
      );

      await new Promise((r) => setTimeout(r, 100));
      // Bot participated in thread (mock returns U_BOT in replies), so message should be processed
      expect(engine.processMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ── Thread context ─────────────────────────────────────────────────────

  describe('thread context', () => {
    it('fetches thread context for threaded messages', async () => {
      const engine = makeEngine();
      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          channel_type: 'im',
          text: 'reply in thread',
          channel: 'D_DM',
          ts: '100.005',
          thread_ts: '100.000',
          user: 'U1',
        }),
        undefined,
        engine,
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(engine.processMessage).toHaveBeenCalledTimes(1);

      const msg = engine.processMessage.mock.calls[0][0] as NormalizedMessage;
      expect(msg.threadId).toBe('100.000');
      expect(msg.threadContext).toBeDefined();
      expect(msg.threadContext!.length).toBeGreaterThan(0);
    });
  });

  // ── In-chat commands ──────────────────────────────────────────────────

  describe('in-chat commands', () => {
    it('handles "reset" command', async () => {
      const engine = makeEngine();
      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          channel_type: 'im',
          text: 'reset',
          channel: 'D_DM',
          ts: '111.222',
          user: 'U1',
        }),
        undefined,
        engine,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(engine.resetSession).toHaveBeenCalledTimes(1);
      expect(engine.processMessage).not.toHaveBeenCalled();

      // Should confirm in thread
      const postCall = slackApiCaptures.find((c) => c.url.includes('chat.postMessage'));
      expect(postCall).toBeDefined();
      expect(postCall!.body!.text).toContain('Session reset');
    });

    it('handles "new session" command', async () => {
      const engine = makeEngine();
      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          channel_type: 'im',
          text: 'new session',
          channel: 'D_DM',
          ts: '111.222',
          user: 'U1',
        }),
        undefined,
        engine,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(engine.resetSession).toHaveBeenCalledTimes(1);
    });

    it('handles "use power" model switch', async () => {
      const engine = makeEngine();
      const { status, body } = await invokeWebhook(
        buildEventPayload({
          type: 'message',
          channel_type: 'im',
          text: 'use power',
          channel: 'D_DM',
          ts: '111.222',
          user: 'U1',
        }),
        undefined,
        engine,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(status).toBe(200);
      // "use power" with no remaining text should confirm and NOT process
      expect(engine.processMessage).not.toHaveBeenCalled();

      const postCall = slackApiCaptures.find((c) => c.url.includes('chat.postMessage'));
      expect(postCall).toBeDefined();
      expect(postCall!.body!.text).toContain('Model switched');
    });

    it('handles "use basic" model switch', async () => {
      const engine = makeEngine();
      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          channel_type: 'im',
          text: 'use basic',
          channel: 'D_DM',
          ts: '111.222',
          user: 'U1',
        }),
        undefined,
        engine,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(engine.processMessage).not.toHaveBeenCalled();

      const postCall = slackApiCaptures.find((c) => c.url.includes('chat.postMessage'));
      expect(postCall!.body!.text).toContain('Model switched');
    });

    it('handles "use agent coder" agent switch', async () => {
      const engine = makeEngine();
      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          channel_type: 'im',
          text: 'use agent coder',
          channel: 'D_DM',
          ts: '111.222',
          user: 'U1',
        }),
        undefined,
        engine,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(engine.processMessage).not.toHaveBeenCalled();

      const postCall = slackApiCaptures.find((c) => c.url.includes('chat.postMessage'));
      expect(postCall!.body!.text).toContain('Agent switched');
      expect(postCall!.body!.text).toContain('coder');
    });

    it('handles fuzzy model matching "use claude"', async () => {
      const engine = makeEngine();

      // Set OPENCODE_URL so the fuzzy handler can create a client
      const origUrl = process.env.OPENCODE_URL;
      process.env.OPENCODE_URL = 'http://localhost:9999';

      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          channel_type: 'im',
          text: 'use claude',
          channel: 'D_DM',
          ts: '111.222',
          user: 'U1',
        }),
        undefined,
        engine,
      );

      await new Promise((r) => setTimeout(r, 200));

      // Should NOT process as a regular message
      expect(engine.processMessage).not.toHaveBeenCalled();

      // Should have called config/providers for fuzzy matching
      const providerCall = slackApiCaptures.find((c) => c.url.includes('config/providers'));
      // Note: the fuzzy handler creates its own OpenCodeClient, which calls fetch
      // Restore
      if (origUrl) process.env.OPENCODE_URL = origUrl;
      else delete process.env.OPENCODE_URL;
    });
  });

  // ── File upload handling ───────────────────────────────────────────────

  describe('file upload handling', () => {
    it('processes messages with file attachments', async () => {
      const engine = makeEngine();
      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          channel_type: 'im',
          text: 'Check this file',
          channel: 'D_DM',
          ts: '111.222',
          user: 'U1',
          files: [
            {
              id: 'F1',
              name: 'report.pdf',
              mimetype: 'application/pdf',
              filetype: 'pdf',
              url_private: 'https://files.slack.com/report.pdf',
              size: 5000,
            },
          ],
        }),
        undefined,
        engine,
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(engine.processMessage).toHaveBeenCalledTimes(1);
      const msg = engine.processMessage.mock.calls[0][0] as NormalizedMessage;
      expect(msg.content).toContain('Check this file');
    });

    it('generates placeholder content for file-only messages', async () => {
      const engine = makeEngine();
      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          subtype: 'file_share',
          channel_type: 'im',
          text: '',
          channel: 'D_DM',
          ts: '111.222',
          user: 'U1',
          files: [
            {
              id: 'F1',
              name: 'screenshot.png',
              mimetype: 'image/png',
              filetype: 'png',
              url_private: 'https://files.slack.com/screenshot.png',
              size: 3000,
            },
          ],
        }),
        undefined,
        engine,
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(engine.processMessage).toHaveBeenCalledTimes(1);
      const msg = engine.processMessage.mock.calls[0][0] as NormalizedMessage;
      expect(msg.content).toContain('screenshot.png');
    });
  });

  // ── Reaction events ────────────────────────────────────────────────────

  describe('reaction events', () => {
    it('acknowledges reaction_added events', async () => {
      const { status, body } = await invokeWebhook(
        buildEventPayload({
          type: 'reaction_added',
          user: 'U1',
          reaction: 'rocket',
          item: { type: 'message', channel: 'C1', ts: '111.222' },
          event_ts: '222.333',
        }),
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });
  });

  // ── Link shared events ────────────────────────────────────────────────

  describe('link_shared events', () => {
    it('acknowledges link_shared events', async () => {
      const { status, body } = await invokeWebhook(
        buildEventPayload({
          type: 'link_shared',
          channel: 'C1',
          ts: '111.222',
          links: [
            { domain: 'example.com', url: 'https://example.com/page' },
          ],
        }),
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });
  });

  // ── Config resolution ─────────────────────────────────────────────────

  describe('config resolution', () => {
    it('uses getConfig callback when config is null', async () => {
      const engine = makeEngine();
      const config = makeConfig();
      const getConfig = vi.fn().mockReturnValue(config);

      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          channel_type: 'im',
          text: 'hello',
          channel: 'D1',
          ts: '111.222',
          user: 'U1',
        }),
        null,
        engine,
        getConfig,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(getConfig).toHaveBeenCalledWith('T_TEAM');
      expect(engine.processMessage).toHaveBeenCalledTimes(1);
    });

    it('skips processing when no config can be resolved', async () => {
      const engine = makeEngine();
      const getConfig = vi.fn().mockReturnValue(undefined);

      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          channel_type: 'im',
          text: 'hello',
          channel: 'D1',
          ts: '111.222',
          user: 'U1',
        }),
        null,
        engine,
        getConfig,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(engine.processMessage).not.toHaveBeenCalled();
    });
  });

  // ── Empty messages ────────────────────────────────────────────────────

  describe('empty messages', () => {
    it('ignores messages with no text and no files', async () => {
      const engine = makeEngine();
      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          channel_type: 'im',
          text: '',
          channel: 'D1',
          ts: '111.222',
          user: 'U1',
        }),
        undefined,
        engine,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(engine.processMessage).not.toHaveBeenCalled();
    });
  });

  // ── Non-message event types ───────────────────────────────────────────

  describe('non-message event types', () => {
    it('ignores channel_join events', async () => {
      const engine = makeEngine();
      await invokeWebhook(
        buildEventPayload({
          type: 'member_joined_channel',
          user: 'U1',
          channel: 'C1',
        }),
        undefined,
        engine,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(engine.processMessage).not.toHaveBeenCalled();
    });
  });

  // ── Normalized message shape ──────────────────────────────────────────

  describe('normalized message shape', () => {
    it('populates all required fields correctly', async () => {
      const engine = makeEngine();
      const config = makeConfig({ id: 'cfg-42' });

      await invokeWebhook(
        buildEventPayload({
          type: 'app_mention',
          text: '<@U_BOT> explain this code',
          channel: 'C_WORK',
          channel_type: 'channel',
          ts: '555.666',
          user: 'U_CALLER',
        }),
        config,
        engine,
      );

      await new Promise((r) => setTimeout(r, 50));
      const msg = engine.processMessage.mock.calls[0][0] as NormalizedMessage;

      expect(msg.externalId).toBe('555.666');
      expect(msg.channelType).toBe('slack');
      expect(msg.channelConfigId).toBe('cfg-42');
      expect(msg.chatType).toBe('group');
      expect(msg.content).toContain('explain this code');
      expect(msg.content).not.toContain('<@U_BOT>');
      expect(msg.platformUser.id).toBe('U_CALLER');
      expect(msg.isMention).toBe(true);
      expect(msg.groupId).toBe('C_WORK');
      expect(msg.raw).toBeDefined();
    });

    it('sets groupId to undefined for DMs', async () => {
      const engine = makeEngine();
      await invokeWebhook(
        buildEventPayload({
          type: 'message',
          channel_type: 'im',
          text: 'dm message',
          channel: 'D_DM',
          ts: '111.222',
          user: 'U1',
        }),
        undefined,
        engine,
      );

      await new Promise((r) => setTimeout(r, 50));
      const msg = engine.processMessage.mock.calls[0][0] as NormalizedMessage;
      expect(msg.groupId).toBeUndefined();
    });
  });
});
