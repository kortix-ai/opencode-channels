import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleTelegramWebhook,
  detectChatType,
  detectMention,
  stripBotMention,
} from '../src/webhook.js';
import type { TelegramMessage } from '../src/webhook.js';
import type { ChannelConfig, ChannelEngine } from '@opencode-channels/core';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: 'cfg-1',
    channelType: 'telegram',
    name: 'Test',
    enabled: true,
    credentials: { botToken: 'test-token', botUsername: 'TestBot' },
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

function makeEngine(): ChannelEngine {
  return {
    processMessage: vi.fn().mockResolvedValue(undefined),
    resetSession: vi.fn().mockResolvedValue(undefined),
  };
}

function makeContext(update: unknown, headers: Record<string, string> = {}) {
  return {
    req: {
      header: vi.fn((name: string) => headers[name]),
      json: vi.fn().mockResolvedValue(update),
    },
    json: vi.fn((data: unknown, status?: number) =>
      new Response(JSON.stringify(data), { status: status || 200 }),
    ),
  } as any;
}

function makeTelegramMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1,
    from: {
      id: 100,
      is_bot: false,
      first_name: 'Alice',
      last_name: 'Smith',
      username: 'alice',
    },
    chat: { id: 200, type: 'private' },
    date: Math.floor(Date.now() / 1000),
    text: 'Hello bot',
    ...overrides,
  };
}

// ─── detectChatType ─────────────────────────────────────────────────────────

describe('detectChatType', () => {
  it('should map "private" to "dm"', () => {
    const msg = makeTelegramMessage({ chat: { id: 1, type: 'private' } });
    expect(detectChatType(msg)).toBe('dm');
  });

  it('should map "channel" to "channel"', () => {
    const msg = makeTelegramMessage({ chat: { id: 1, type: 'channel' } });
    expect(detectChatType(msg)).toBe('channel');
  });

  it('should map "group" to "group"', () => {
    const msg = makeTelegramMessage({ chat: { id: 1, type: 'group' } });
    expect(detectChatType(msg)).toBe('group');
  });

  it('should map "supergroup" to "group"', () => {
    const msg = makeTelegramMessage({ chat: { id: 1, type: 'supergroup' } });
    expect(detectChatType(msg)).toBe('group');
  });

  it('should default to "dm" for unknown types', () => {
    const msg = makeTelegramMessage({ chat: { id: 1, type: 'unknown' as any } });
    expect(detectChatType(msg)).toBe('dm');
  });
});

// ─── detectMention ──────────────────────────────────────────────────────────

describe('detectMention', () => {
  it('should return false when there are no entities', () => {
    const msg = makeTelegramMessage({ entities: undefined });
    expect(detectMention(msg, 999, 'TestBot')).toBe(false);
  });

  it('should return true for a mention entity matching botUsername', () => {
    const msg = makeTelegramMessage({
      text: '@TestBot hello',
      entities: [{ type: 'mention', offset: 0, length: 8 }],
    });
    expect(detectMention(msg, undefined, 'TestBot')).toBe(true);
  });

  it('should be case-insensitive when matching mention entity', () => {
    const msg = makeTelegramMessage({
      text: '@testbot hello',
      entities: [{ type: 'mention', offset: 0, length: 8 }],
    });
    expect(detectMention(msg, undefined, 'TestBot')).toBe(true);
  });

  it('should return false for a mention entity NOT matching botUsername', () => {
    const msg = makeTelegramMessage({
      text: '@OtherBot hello',
      entities: [{ type: 'mention', offset: 0, length: 9 }],
    });
    // Pass an explicit botId so the reply_to_message fallback doesn't match
    // (undefined === undefined would be true)
    expect(detectMention(msg, 999, 'TestBot')).toBe(false);
  });

  it('should return false for a mention entity when botUsername is undefined', () => {
    const msg = makeTelegramMessage({
      text: '@TestBot hello',
      entities: [{ type: 'mention', offset: 0, length: 8 }],
    });
    // Pass an explicit botId so the reply_to_message fallback doesn't match
    expect(detectMention(msg, 999, undefined)).toBe(false);
  });

  it('should return true for text_mention entity with matching botId', () => {
    const msg = makeTelegramMessage({
      text: 'Hello bot',
      entities: [{ type: 'text_mention', offset: 6, length: 3, user: { id: 999 } }],
    });
    expect(detectMention(msg, 999, 'TestBot')).toBe(true);
  });

  it('should return false for text_mention entity with non-matching botId', () => {
    const msg = makeTelegramMessage({
      text: 'Hello bot',
      entities: [{ type: 'text_mention', offset: 6, length: 3, user: { id: 888 } }],
    });
    expect(detectMention(msg, 999, 'TestBot')).toBe(false);
  });

  it('should return true when reply_to_message is from the bot', () => {
    const msg = makeTelegramMessage({
      entities: [],
      reply_to_message: {
        message_id: 50,
        from: { id: 999, is_bot: true, first_name: 'Bot' },
        chat: { id: 200, type: 'group' },
        date: 0,
      },
    });
    expect(detectMention(msg, 999, 'TestBot')).toBe(true);
  });

  it('should return false when reply_to_message is from another user', () => {
    const msg = makeTelegramMessage({
      entities: [],
      reply_to_message: {
        message_id: 50,
        from: { id: 555, is_bot: false, first_name: 'Bob' },
        chat: { id: 200, type: 'group' },
        date: 0,
      },
    });
    expect(detectMention(msg, 999, 'TestBot')).toBe(false);
  });
});

// ─── stripBotMention ────────────────────────────────────────────────────────

describe('stripBotMention', () => {
  it('should return original text when botUsername is undefined', () => {
    expect(stripBotMention('Hello @TestBot', undefined)).toBe('Hello @TestBot');
  });

  it('should strip @BotName from text', () => {
    expect(stripBotMention('@TestBot hello there', 'TestBot')).toBe('hello there');
  });

  it('should strip mention case-insensitively', () => {
    expect(stripBotMention('@testbot hello', 'TestBot')).toBe('hello');
    expect(stripBotMention('@TESTBOT hello', 'TestBot')).toBe('hello');
  });

  it('should strip multiple mentions', () => {
    expect(stripBotMention('@TestBot hello @TestBot world', 'TestBot')).toBe('hello  world');
  });

  it('should trim whitespace after stripping', () => {
    expect(stripBotMention('  @TestBot  ', 'TestBot')).toBe('');
  });

  it('should return text unchanged when mention is not present', () => {
    expect(stripBotMention('hello world', 'TestBot')).toBe('hello world');
  });
});

// ─── handleTelegramWebhook ──────────────────────────────────────────────────

describe('handleTelegramWebhook', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true }),
    });
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return 403 when webhook secret does not match', async () => {
    const config = makeConfig({
      credentials: {
        botToken: 'test-token',
        botUsername: 'TestBot',
        webhookSecret: 'correct-secret',
      },
    });
    const engine = makeEngine();
    const c = makeContext(
      { update_id: 1, message: makeTelegramMessage() },
      { 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' },
    );

    const response = await handleTelegramWebhook(c, engine, config);
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe('Invalid webhook secret token');
  });

  it('should pass when webhook secret matches', async () => {
    const config = makeConfig({
      credentials: {
        botToken: 'test-token',
        botUsername: 'TestBot',
        webhookSecret: 'correct-secret',
      },
    });
    const engine = makeEngine();
    const c = makeContext(
      { update_id: 1, message: makeTelegramMessage() },
      { 'X-Telegram-Bot-Api-Secret-Token': 'correct-secret' },
    );

    const response = await handleTelegramWebhook(c, engine, config);
    expect(response.status).toBe(200);
  });

  it('should pass when no webhook secret is configured', async () => {
    const config = makeConfig({
      credentials: { botToken: 'test-token', botUsername: 'TestBot' },
    });
    const engine = makeEngine();
    const c = makeContext(
      { update_id: 1, message: makeTelegramMessage() },
    );

    const response = await handleTelegramWebhook(c, engine, config);
    expect(response.status).toBe(200);
  });

  it('should ignore bot messages', async () => {
    const config = makeConfig();
    const engine = makeEngine();
    const msg = makeTelegramMessage({
      from: { id: 999, is_bot: true, first_name: 'OtherBot' },
    });
    const c = makeContext({ update_id: 1, message: msg });

    const response = await handleTelegramWebhook(c, engine, config);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(engine.processMessage).not.toHaveBeenCalled();
  });

  it('should ignore messages with empty content', async () => {
    const config = makeConfig();
    const engine = makeEngine();
    const msg = makeTelegramMessage({ text: undefined, caption: undefined });
    const c = makeContext({ update_id: 1, message: msg });

    const response = await handleTelegramWebhook(c, engine, config);
    expect(response.status).toBe(200);
    expect(engine.processMessage).not.toHaveBeenCalled();
  });

  it('should ignore updates with no message', async () => {
    const config = makeConfig();
    const engine = makeEngine();
    const c = makeContext({ update_id: 1 });

    const response = await handleTelegramWebhook(c, engine, config);
    expect(response.status).toBe(200);
    expect(engine.processMessage).not.toHaveBeenCalled();
  });

  it('should handle edited_message updates', async () => {
    const config = makeConfig();
    const engine = makeEngine();
    const msg = makeTelegramMessage({ text: 'edited content' });
    const c = makeContext({ update_id: 1, edited_message: msg });

    const response = await handleTelegramWebhook(c, engine, config);
    expect(response.status).toBe(200);
    expect(engine.processMessage).toHaveBeenCalled();
  });

  it('should handle channel_post updates', async () => {
    const config = makeConfig();
    const engine = makeEngine();
    const msg = makeTelegramMessage({
      text: 'channel post',
      chat: { id: 300, type: 'channel' },
      from: undefined,
    });
    // channel_post messages may not have `from`, content comes from text
    // The from?.is_bot check should not block when from is undefined
    const c = makeContext({ update_id: 1, channel_post: msg });

    const response = await handleTelegramWebhook(c, engine, config);
    expect(response.status).toBe(200);
    expect(engine.processMessage).toHaveBeenCalled();
  });

  // ── /new command ────────────────────────────────────────────────────────

  it('should reset session on /new command', async () => {
    const config = makeConfig();
    const engine = makeEngine();
    const msg = makeTelegramMessage({ text: '/new' });
    const c = makeContext({ update_id: 1, message: msg });

    const response = await handleTelegramWebhook(c, engine, config);
    expect(response.status).toBe(200);

    expect(engine.resetSession).toHaveBeenCalledOnce();
    expect(engine.resetSession).toHaveBeenCalledWith(
      'cfg-1',
      'telegram',
      'per-user',
      expect.objectContaining({
        channelType: 'telegram',
        channelConfigId: 'cfg-1',
      }),
    );

    // Should send confirmation message
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/sendMessage'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Session reset'),
      }),
    );

    expect(engine.processMessage).not.toHaveBeenCalled();
  });

  it('should reset session on /new@BotUsername command', async () => {
    const config = makeConfig();
    const engine = makeEngine();
    const msg = makeTelegramMessage({ text: '/new@TestBot' });
    const c = makeContext({ update_id: 1, message: msg });

    const response = await handleTelegramWebhook(c, engine, config);
    expect(response.status).toBe(200);
    expect(engine.resetSession).toHaveBeenCalledOnce();
  });

  // ── /help command ───────────────────────────────────────────────────────

  it('should send help on /help command', async () => {
    const config = makeConfig();
    const engine = makeEngine();
    const msg = makeTelegramMessage({ text: '/help' });
    const c = makeContext({ update_id: 1, message: msg });

    const response = await handleTelegramWebhook(c, engine, config);
    expect(response.status).toBe(200);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/sendMessage'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Available commands'),
      }),
    );
    expect(engine.processMessage).not.toHaveBeenCalled();
  });

  it('should send help on /help@BotUsername command', async () => {
    const config = makeConfig();
    const engine = makeEngine();
    const msg = makeTelegramMessage({ text: '/help@TestBot' });
    const c = makeContext({ update_id: 1, message: msg });

    const response = await handleTelegramWebhook(c, engine, config);
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/sendMessage'),
      expect.objectContaining({
        body: expect.stringContaining('Available commands'),
      }),
    );
  });

  // ── Group mention filtering ─────────────────────────────────────────────

  it('should ignore group messages without mention when requireMention is true', async () => {
    const config = makeConfig({
      credentials: { botToken: 'test-token', botUsername: 'TestBot', botId: 999 },
      platformConfig: { groups: { requireMention: true } },
    });
    const engine = makeEngine();
    const msg = makeTelegramMessage({
      text: 'Hello everyone',
      chat: { id: 300, type: 'group' },
      entities: [],
    });
    const c = makeContext({ update_id: 1, message: msg });

    const response = await handleTelegramWebhook(c, engine, config);
    expect(response.status).toBe(200);
    expect(engine.processMessage).not.toHaveBeenCalled();
  });

  it('should ignore group messages without mention when requireMention defaults to true', async () => {
    // requireMention defaults to true (groupConfig.requireMention !== false)
    // botId must be set so the reply_to_message fallback doesn't match undefined===undefined
    const config = makeConfig({
      credentials: { botToken: 'test-token', botUsername: 'TestBot', botId: 999 },
    });
    const engine = makeEngine();
    const msg = makeTelegramMessage({
      text: 'Hello everyone',
      chat: { id: 300, type: 'group' },
      entities: [],
    });
    const c = makeContext({ update_id: 1, message: msg });

    const response = await handleTelegramWebhook(c, engine, config);
    expect(response.status).toBe(200);
    expect(engine.processMessage).not.toHaveBeenCalled();
  });

  it('should process group messages without mention when requireMention is false', async () => {
    const config = makeConfig({
      platformConfig: { groups: { requireMention: false } },
    });
    const engine = makeEngine();
    const msg = makeTelegramMessage({
      text: 'Hello everyone',
      chat: { id: 300, type: 'group' },
      entities: [],
    });
    const c = makeContext({ update_id: 1, message: msg });

    const response = await handleTelegramWebhook(c, engine, config);
    expect(response.status).toBe(200);
    expect(engine.processMessage).toHaveBeenCalled();
  });

  it('should process group messages with mention regardless of requireMention', async () => {
    const config = makeConfig({
      credentials: { botToken: 'test-token', botUsername: 'TestBot', botId: 999 },
      platformConfig: { groups: { requireMention: true } },
    });
    const engine = makeEngine();
    const msg = makeTelegramMessage({
      text: '@TestBot hello',
      chat: { id: 300, type: 'group' },
      entities: [{ type: 'mention', offset: 0, length: 8 }],
    });
    const c = makeContext({ update_id: 1, message: msg });

    const response = await handleTelegramWebhook(c, engine, config);
    expect(response.status).toBe(200);
    expect(engine.processMessage).toHaveBeenCalled();
  });

  // ── Regular message processing ──────────────────────────────────────────

  it('should process a regular DM and call engine.processMessage', async () => {
    const config = makeConfig();
    const engine = makeEngine();
    const msg = makeTelegramMessage({ text: 'Hello bot!' });
    const update = { update_id: 1, message: msg };
    const c = makeContext(update);

    const response = await handleTelegramWebhook(c, engine, config);
    expect(response.status).toBe(200);

    expect(engine.processMessage).toHaveBeenCalledOnce();
    const normalized = (engine.processMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(normalized.externalId).toBe(String(msg.message_id));
    expect(normalized.channelType).toBe('telegram');
    expect(normalized.channelConfigId).toBe('cfg-1');
    expect(normalized.chatType).toBe('dm');
    expect(normalized.content).toBe('Hello bot!');
    expect(normalized.platformUser.id).toBe(String(msg.from!.id));
    expect(normalized.platformUser.name).toBe('Alice Smith');
    expect(normalized.raw).toEqual(update);
  });

  it('should strip bot mention from content in normalized message', async () => {
    const config = makeConfig();
    const engine = makeEngine();
    const msg = makeTelegramMessage({
      text: '@TestBot what is the weather?',
      chat: { id: 300, type: 'group' },
      entities: [{ type: 'mention', offset: 0, length: 8 }],
    });
    const c = makeContext({ update_id: 1, message: msg });

    await handleTelegramWebhook(c, engine, config);

    const normalized = (engine.processMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(normalized.content).toBe('what is the weather?');
    expect(normalized.isMention).toBe(true);
  });

  it('should set groupId for group messages', async () => {
    const config = makeConfig({
      platformConfig: { groups: { requireMention: false } },
    });
    const engine = makeEngine();
    const msg = makeTelegramMessage({
      text: 'Hello group',
      chat: { id: 300, type: 'group' },
    });
    const c = makeContext({ update_id: 1, message: msg });

    await handleTelegramWebhook(c, engine, config);

    const normalized = (engine.processMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(normalized.groupId).toBe('300');
    expect(normalized.chatType).toBe('group');
  });

  it('should not set groupId for DM messages', async () => {
    const config = makeConfig();
    const engine = makeEngine();
    const msg = makeTelegramMessage({ text: 'Hello' });
    const c = makeContext({ update_id: 1, message: msg });

    await handleTelegramWebhook(c, engine, config);

    const normalized = (engine.processMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(normalized.groupId).toBeUndefined();
  });

  it('should set threadId when message_thread_id is present', async () => {
    const config = makeConfig({
      platformConfig: { groups: { requireMention: false } },
    });
    const engine = makeEngine();
    const msg = makeTelegramMessage({
      text: 'Thread message',
      chat: { id: 300, type: 'supergroup' },
      message_thread_id: 42,
    });
    const c = makeContext({ update_id: 1, message: msg });

    await handleTelegramWebhook(c, engine, config);

    const normalized = (engine.processMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(normalized.threadId).toBe('42');
  });

  it('should use caption as content when text is absent', async () => {
    const config = makeConfig();
    const engine = makeEngine();
    const msg = makeTelegramMessage({ text: undefined, caption: 'Photo caption' });
    const c = makeContext({ update_id: 1, message: msg });

    await handleTelegramWebhook(c, engine, config);

    const normalized = (engine.processMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(normalized.content).toBe('Photo caption');
  });

  it('should use chat.id as platformUser.id when from is missing', async () => {
    const config = makeConfig();
    const engine = makeEngine();
    const msg = makeTelegramMessage({
      text: 'Channel post',
      from: undefined,
      chat: { id: 500, type: 'channel', title: 'My Channel' },
    });
    const c = makeContext({ update_id: 1, channel_post: msg });

    await handleTelegramWebhook(c, engine, config);

    const normalized = (engine.processMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(normalized.platformUser.id).toBe('500');
    expect(normalized.platformUser.name).toBe('My Channel');
  });
});
