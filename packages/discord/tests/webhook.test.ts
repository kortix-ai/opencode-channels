import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  verifyDiscordSignature,
  handleDiscordInteraction,
  handleDiscordEvent,
} from '../src/webhook.js';
import type { ChannelConfig } from '@opencode-channels/core';
import type { ChannelEngine } from '@opencode-channels/core';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a mock Hono Context. */
function createMockContext(options: {
  body?: string;
  json?: unknown;
  headers?: Record<string, string>;
}): any {
  const headers = options.headers ?? {};
  const rawBody = options.body ?? (options.json ? JSON.stringify(options.json) : '{}');

  // Track responses produced by c.json(...)
  const jsonResponses: Array<{ body: unknown; status?: number }> = [];

  return {
    req: {
      text: () => Promise.resolve(rawBody),
      json: () => Promise.resolve(options.json ?? JSON.parse(rawBody)),
      header: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? '',
    },
    json: (body: unknown, status?: number) => {
      jsonResponses.push({ body, status });
      return { body, status } as unknown as Response;
    },
    // Expose for assertions
    _jsonResponses: jsonResponses,
  };
}

function createMockConfig(overrides?: Partial<ChannelConfig>): ChannelConfig {
  return {
    id: 'cfg-1',
    channelType: 'discord',
    name: 'Test',
    enabled: true,
    credentials: {
      botToken: 'test-token',
      publicKey: 'a'.repeat(64),
      applicationId: 'app-123',
    },
    platformConfig: {},
    metadata: {},
    sessionStrategy: 'per-user',
    systemPrompt: null,
    agentName: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockEngine(): ChannelEngine {
  return {
    processMessage: vi.fn().mockResolvedValue(undefined),
    resetSession: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── verifyDiscordSignature ─────────────────────────────────────────────────

describe('verifyDiscordSignature', () => {
  it('returns false for malformed hex in publicKey (catch path)', async () => {
    // 'zz' is not valid hex — will fail inside crypto.subtle.importKey
    const result = await verifyDiscordSignature(
      'zz'.repeat(32),
      'a'.repeat(128),
      '1234567890',
      '{}',
    );
    expect(result).toBe(false);
  });

  it('returns false for empty string inputs', async () => {
    const result = await verifyDiscordSignature('', '', '', '');
    expect(result).toBe(false);
  });

  it('returns false for valid-length hex but wrong signature', async () => {
    // Valid 64-char hex public key, valid 128-char hex signature,
    // but signature doesn't match — should return false
    const result = await verifyDiscordSignature(
      'ab'.repeat(32), // 64-char hex
      'cd'.repeat(64), // 128-char hex
      '1234567890',
      '{"type":1}',
    );
    expect(result).toBe(false);
  });
});

// ─── handleDiscordInteraction ───────────────────────────────────────────────

describe('handleDiscordInteraction', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 when signature headers are missing', async () => {
    const config = createMockConfig();
    const engine = createMockEngine();
    const c = createMockContext({
      json: { type: 1 },
      headers: {},
    });

    const res = await handleDiscordInteraction(c, engine, config);
    const response = res as unknown as { body: unknown; status: number };

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Missing signature headers' });
  });

  it('returns PONG for PING interaction (type=1) when no publicKey', async () => {
    // Config without publicKey — skips signature verification
    const config = createMockConfig({
      credentials: { botToken: 'test-token' },
    });
    const engine = createMockEngine();
    const c = createMockContext({
      json: { type: 1 },
    });

    const res = await handleDiscordInteraction(c, engine, config);
    const response = res as unknown as { body: unknown; status?: number };

    expect(response.body).toEqual({ type: 1 });
  });

  it('returns 202 and fires processMessage for APPLICATION_COMMAND (type=2)', async () => {
    const config = createMockConfig({
      credentials: { botToken: 'test-token' },
    });
    const engine = createMockEngine();

    const interaction = {
      id: 'int-1',
      application_id: 'app-123',
      type: 2,
      data: { name: 'ask', options: [{ name: 'query', type: 3, value: 'hello world' }] },
      channel_id: 'chan-1',
      guild_id: 'guild-1',
      member: {
        user: { id: 'u-1', username: 'tester', discriminator: '0', global_name: 'Tester' },
        roles: [],
        joined_at: '2024-01-01',
        permissions: '0',
      },
      token: 'interaction-token',
      version: 1,
    };

    const c = createMockContext({
      json: interaction,
    });

    const res = await handleDiscordInteraction(c, engine, config);
    const response = res as unknown as { body: unknown; status: number };

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ ok: true });

    // Wait for the async handler to fire
    await vi.waitFor(() => {
      expect(engine.processMessage).toHaveBeenCalledOnce();
    });
  });

  it('returns 202 for MESSAGE_COMPONENT (type=3)', async () => {
    const config = createMockConfig({
      credentials: { botToken: 'test-token' },
    });
    const engine = createMockEngine();

    const interaction = {
      id: 'int-2',
      application_id: 'app-123',
      type: 3,
      data: { custom_id: 'some_button', component_type: 2 },
      channel_id: 'chan-1',
      member: {
        user: { id: 'u-1', username: 'tester', discriminator: '0' },
        roles: [],
        joined_at: '2024-01-01',
        permissions: '0',
      },
      token: 'interaction-token',
      version: 1,
    };

    const c = createMockContext({
      json: interaction,
    });

    const res = await handleDiscordInteraction(c, engine, config);
    const response = res as unknown as { body: unknown; status: number };

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ ok: true });
  });

  it('returns 200 for unhandled interaction types', async () => {
    const config = createMockConfig({
      credentials: { botToken: 'test-token' },
    });
    const engine = createMockEngine();

    const interaction = {
      id: 'int-3',
      application_id: 'app-123',
      type: 99, // Unknown type
      token: 'interaction-token',
      version: 1,
    };

    const c = createMockContext({
      json: interaction,
    });

    const res = await handleDiscordInteraction(c, engine, config);
    const response = res as unknown as { body: unknown; status?: number };

    // No explicit status → 200 default
    expect(response.body).toEqual({ ok: true });
    expect(response.status).toBeUndefined();
  });

  it('returns 400 for invalid JSON body', async () => {
    const config = createMockConfig({
      credentials: { botToken: 'test-token' },
    });
    const engine = createMockEngine();

    const c = createMockContext({
      body: 'not valid json {{{',
    });

    const res = await handleDiscordInteraction(c, engine, config);
    const response = res as unknown as { body: unknown; status: number };

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid JSON body' });
  });

  it('handles the /reset command for APPLICATION_COMMAND', async () => {
    const config = createMockConfig({
      credentials: { botToken: 'test-token' },
    });
    const engine = createMockEngine();

    const interaction = {
      id: 'int-reset',
      application_id: 'app-123',
      type: 2,
      data: { name: 'reset' },
      channel_id: 'chan-1',
      member: {
        user: { id: 'u-1', username: 'resetter', discriminator: '0' },
        roles: [],
        joined_at: '2024-01-01',
        permissions: '0',
      },
      token: 'reset-token',
      version: 1,
    };

    const c = createMockContext({ json: interaction });

    const res = await handleDiscordInteraction(c, engine, config);
    const response = res as unknown as { body: unknown; status: number };

    expect(response.status).toBe(202);

    // Wait for async handler — the reset command calls resetSession + createInteractionResponse
    await vi.waitFor(() => {
      expect(engine.resetSession).toHaveBeenCalledOnce();
    });
  });
});

// ─── handleDiscordEvent ─────────────────────────────────────────────────────

describe('handleDiscordEvent', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok for non-MESSAGE_CREATE events', async () => {
    const config = createMockConfig();
    const engine = createMockEngine();
    const c = createMockContext({
      json: { t: 'GUILD_CREATE', d: {} },
    });

    const res = await handleDiscordEvent(c, engine, config);
    const response = res as unknown as { body: unknown };

    expect(response.body).toEqual({ ok: true });
    expect(engine.processMessage).not.toHaveBeenCalled();
  });

  it('ignores bot authors', async () => {
    const config = createMockConfig();
    const engine = createMockEngine();
    const c = createMockContext({
      json: {
        t: 'MESSAGE_CREATE',
        d: {
          id: 'msg-1',
          channel_id: 'chan-1',
          author: { id: 'bot-1', username: 'SomeBot', bot: true },
          content: 'hello from bot',
        },
      },
    });

    const res = await handleDiscordEvent(c, engine, config);
    const response = res as unknown as { body: unknown };

    expect(response.body).toEqual({ ok: true });
    expect(engine.processMessage).not.toHaveBeenCalled();
  });

  it('ignores messages with empty content', async () => {
    const config = createMockConfig();
    const engine = createMockEngine();
    const c = createMockContext({
      json: {
        t: 'MESSAGE_CREATE',
        d: {
          id: 'msg-2',
          channel_id: 'chan-1',
          author: { id: 'u-1', username: 'User' },
          content: '',
        },
      },
    });

    const res = await handleDiscordEvent(c, engine, config);
    const response = res as unknown as { body: unknown };

    expect(response.body).toEqual({ ok: true });
    expect(engine.processMessage).not.toHaveBeenCalled();
  });

  it('ignores group messages without mention when requireMention=true', async () => {
    const config = createMockConfig({
      credentials: { botToken: 'test-token', botUserId: 'bot-99' },
      platformConfig: { requireMention: true },
    });
    const engine = createMockEngine();
    const c = createMockContext({
      json: {
        t: 'MESSAGE_CREATE',
        d: {
          id: 'msg-3',
          channel_id: 'chan-1',
          guild_id: 'guild-1',
          author: { id: 'u-1', username: 'User' },
          content: 'hello everyone',
          mentions: [],
        },
      },
    });

    const res = await handleDiscordEvent(c, engine, config);
    const response = res as unknown as { body: unknown };

    expect(response.body).toEqual({ ok: true });
    expect(engine.processMessage).not.toHaveBeenCalled();
  });

  it('ignores group messages without mention when requireMention is default (not explicitly false)', async () => {
    const config = createMockConfig({
      credentials: { botToken: 'test-token', botUserId: 'bot-99' },
      platformConfig: {}, // default: requireMention !== false → true
    });
    const engine = createMockEngine();
    const c = createMockContext({
      json: {
        t: 'MESSAGE_CREATE',
        d: {
          id: 'msg-4',
          channel_id: 'chan-1',
          guild_id: 'guild-1',
          author: { id: 'u-1', username: 'User' },
          content: 'no mention here',
          mentions: [],
        },
      },
    });

    const res = await handleDiscordEvent(c, engine, config);
    expect(engine.processMessage).not.toHaveBeenCalled();
  });

  it('processes a regular DM message', async () => {
    const config = createMockConfig({
      credentials: { botToken: 'test-token' },
    });
    const engine = createMockEngine();
    const c = createMockContext({
      json: {
        t: 'MESSAGE_CREATE',
        d: {
          id: 'msg-5',
          channel_id: 'chan-dm',
          type: 1, // DM channel type
          author: {
            id: 'u-1',
            username: 'realuser',
            global_name: 'Real User',
            avatar: 'abc123',
          },
          content: 'Hello agent!',
          mentions: [],
        },
      },
    });

    const res = await handleDiscordEvent(c, engine, config);
    const response = res as unknown as { body: unknown };

    expect(response.body).toEqual({ ok: true });

    // processMessage is called async — wait for it
    await vi.waitFor(() => {
      expect(engine.processMessage).toHaveBeenCalledOnce();
    });

    const normalized = (engine.processMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(normalized.externalId).toBe('msg-5');
    expect(normalized.channelType).toBe('discord');
    expect(normalized.chatType).toBe('dm');
    expect(normalized.content).toBe('Hello agent!');
    expect(normalized.platformUser.id).toBe('u-1');
    expect(normalized.platformUser.name).toBe('Real User');
    expect(normalized.platformUser.avatar).toContain('cdn.discordapp.com');
  });

  it('processes a group message with mention', async () => {
    const config = createMockConfig({
      credentials: { botToken: 'test-token', botUserId: 'bot-42' },
      platformConfig: { requireMention: true },
    });
    const engine = createMockEngine();
    const c = createMockContext({
      json: {
        t: 'MESSAGE_CREATE',
        d: {
          id: 'msg-6',
          channel_id: 'chan-general',
          guild_id: 'guild-1',
          author: { id: 'u-2', username: 'mentioner' },
          content: '<@bot-42> what time is it?',
          mentions: [{ id: 'bot-42' }],
        },
      },
    });

    await handleDiscordEvent(c, engine, config);

    await vi.waitFor(() => {
      expect(engine.processMessage).toHaveBeenCalledOnce();
    });

    const normalized = (engine.processMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(normalized.chatType).toBe('group');
    expect(normalized.isMention).toBe(true);
    // The mention should be stripped from content
    expect(normalized.content).toBe('what time is it?');
    expect(normalized.groupId).toBe('chan-general');
  });

  it('processes group messages when requireMention is explicitly false', async () => {
    const config = createMockConfig({
      credentials: { botToken: 'test-token', botUserId: 'bot-42' },
      platformConfig: { requireMention: false },
    });
    const engine = createMockEngine();
    const c = createMockContext({
      json: {
        t: 'MESSAGE_CREATE',
        d: {
          id: 'msg-7',
          channel_id: 'chan-general',
          guild_id: 'guild-1',
          author: { id: 'u-3', username: 'chatter' },
          content: 'just chatting, no mention',
          mentions: [],
        },
      },
    });

    await handleDiscordEvent(c, engine, config);

    await vi.waitFor(() => {
      expect(engine.processMessage).toHaveBeenCalledOnce();
    });

    const normalized = (engine.processMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(normalized.isMention).toBe(false);
    expect(normalized.content).toBe('just chatting, no mention');
  });

  it('returns 400 for invalid JSON body', async () => {
    const config = createMockConfig();
    const engine = createMockEngine();
    const c = createMockContext({ body: '{{invalid json' });

    // Override req.json to reject
    c.req.json = () => Promise.reject(new Error('invalid'));

    const res = await handleDiscordEvent(c, engine, config);
    const response = res as unknown as { body: unknown; status: number };

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid JSON body' });
  });
});
