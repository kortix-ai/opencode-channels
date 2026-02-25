import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramAdapter } from '../src/adapter.js';
import type { ChannelConfig, NormalizedMessage, AgentResponse } from '@opencode-channels/core';

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

function makeMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    externalId: '1',
    channelType: 'telegram',
    channelConfigId: 'cfg-1',
    chatType: 'dm',
    content: 'Hello',
    attachments: [],
    platformUser: { id: '100', name: 'Alice' },
    raw: {
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 200, type: 'private' },
        from: { id: 100, is_bot: false, first_name: 'Alice' },
        date: 0,
        text: 'Hello',
      },
    },
    ...overrides,
  };
}

function makeResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    content: 'Hi there!',
    sessionId: 'sess-1',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new TelegramAdapter();
    fetchSpy = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, result: { message_id: 42 } }),
    });
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Static properties ───────────────────────────────────────────────────

  describe('type and name', () => {
    it('should have type "telegram"', () => {
      expect(adapter.type).toBe('telegram');
    });

    it('should have name "Telegram"', () => {
      expect(adapter.name).toBe('Telegram');
    });
  });

  // ── Capabilities ────────────────────────────────────────────────────────

  describe('capabilities', () => {
    it('should have textChunkLimit of 4096', () => {
      expect(adapter.capabilities.textChunkLimit).toBe(4096);
    });

    it('should support rich text', () => {
      expect(adapter.capabilities.supportsRichText).toBe(true);
    });

    it('should support editing', () => {
      expect(adapter.capabilities.supportsEditing).toBe(true);
    });

    it('should support typing indicator', () => {
      expect(adapter.capabilities.supportsTypingIndicator).toBe(true);
    });

    it('should support attachments', () => {
      expect(adapter.capabilities.supportsAttachments).toBe(true);
    });

    it('should have webhook connection type', () => {
      expect(adapter.capabilities.connectionType).toBe('webhook');
    });
  });

  // ── validateCredentials ─────────────────────────────────────────────────

  describe('validateCredentials', () => {
    it('should return invalid when botToken is missing', async () => {
      const result = await adapter.validateCredentials({});
      expect(result).toEqual({ valid: false, error: 'botToken is required' });
    });

    it('should return invalid when botToken is empty string', async () => {
      const result = await adapter.validateCredentials({ botToken: '' });
      expect(result).toEqual({ valid: false, error: 'botToken is required' });
    });

    it('should return valid when getMe succeeds', async () => {
      fetchSpy.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            ok: true,
            result: { id: 999, username: 'TestBot', first_name: 'Test' },
          }),
      });

      const result = await adapter.validateCredentials({ botToken: 'valid-token' });
      expect(result).toEqual({ valid: true });

      // Verify it called getMe
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.telegram.org/botvalid-token/getMe',
        { method: 'GET' },
      );
    });

    it('should return invalid when getMe returns ok: false', async () => {
      fetchSpy.mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: false, description: 'Unauthorized' }),
      });

      const result = await adapter.validateCredentials({ botToken: 'bad-token' });
      expect(result).toEqual({ valid: false, error: 'Invalid bot token' });
    });

    it('should return invalid when fetch throws an error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network error'));

      const result = await adapter.validateCredentials({ botToken: 'some-token' });
      expect(result).toEqual({ valid: false, error: 'Failed to validate bot token' });
    });
  });

  // ── sendResponse ────────────────────────────────────────────────────────

  describe('sendResponse', () => {
    it('should return early when botToken is missing', async () => {
      const config = makeConfig({ credentials: {} });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await adapter.sendResponse(config, makeMessage(), makeResponse());

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith('[TELEGRAM] No bot token in credentials');
    });

    it('should send a message with correct chat_id from raw message', async () => {
      const config = makeConfig();
      const message = makeMessage();

      await adapter.sendResponse(config, message, makeResponse({ content: 'Response text' }));

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage');
      expect(options.method).toBe('POST');

      const body = JSON.parse(options.body);
      expect(body.chat_id).toBe(200);
      expect(body.text).toBe('Response text');
    });

    it('should include reply_to_message_id for group messages', async () => {
      const config = makeConfig();
      const message = makeMessage({
        chatType: 'group',
        externalId: '55',
        raw: {
          update_id: 1,
          message: {
            message_id: 55,
            chat: { id: 300, type: 'group' },
            from: { id: 100, is_bot: false, first_name: 'Alice' },
            date: 0,
            text: 'Hello',
          },
        },
      });

      await adapter.sendResponse(config, message, makeResponse());

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.reply_to_message_id).toBe(55);
    });

    it('should NOT include reply_to_message_id for DM messages', async () => {
      const config = makeConfig();
      const message = makeMessage({ chatType: 'dm' });

      await adapter.sendResponse(config, message, makeResponse());

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.reply_to_message_id).toBeUndefined();
    });

    it('should include message_thread_id when threadId is set', async () => {
      const config = makeConfig();
      const message = makeMessage({ threadId: '42' });

      await adapter.sendResponse(config, message, makeResponse());

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.message_thread_id).toBe(42);
    });

    it('should send multiple chunks for long messages', async () => {
      const config = makeConfig();
      const message = makeMessage();
      // Create a response longer than 4096 chars to trigger splitting
      const longContent = 'A'.repeat(4097);

      await adapter.sendResponse(config, message, makeResponse({ content: longContent }));

      // splitMessage should split this into 2 chunks
      expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('should log error when sendMessage fails', async () => {
      fetchSpy.mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: false, description: 'Chat not found' }),
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const config = makeConfig();
      await adapter.sendResponse(config, makeMessage(), makeResponse());

      expect(consoleSpy).toHaveBeenCalledWith('[TELEGRAM] sendMessage failed: Chat not found');
    });

    it('should return early when chatId cannot be extracted', async () => {
      const config = makeConfig();
      const message = makeMessage({ raw: {} });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await adapter.sendResponse(config, message, makeResponse());

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        '[TELEGRAM] Cannot determine chat ID from message',
      );
    });
  });

  // ── sendTypingIndicator ─────────────────────────────────────────────────

  describe('sendTypingIndicator', () => {
    it('should call sendChatAction with "typing"', async () => {
      const config = makeConfig();
      const message = makeMessage();

      await adapter.sendTypingIndicator(config, message);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.telegram.org/bottest-token/sendChatAction');
      expect(options.method).toBe('POST');

      const body = JSON.parse(options.body);
      expect(body.chat_id).toBe(200);
      expect(body.action).toBe('typing');
    });

    it('should not call fetch when botToken is missing', async () => {
      const config = makeConfig({ credentials: {} });

      await adapter.sendTypingIndicator(config, makeMessage());

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should not call fetch when chatId cannot be extracted', async () => {
      const config = makeConfig();
      const message = makeMessage({ raw: {} });

      await adapter.sendTypingIndicator(config, message);

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
