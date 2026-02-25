import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackAdapter, type SlackAdapterOptions } from '../src/adapter.js';
import type {
  ChannelConfig,
  NormalizedMessage,
  AgentResponse,
} from '@opencode-channels/core';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createAdapter(overrides?: Partial<SlackAdapterOptions>): SlackAdapter {
  return new SlackAdapter({
    getConfigByTeamId: overrides?.getConfigByTeamId ?? (() => undefined),
    getClient: overrides?.getClient ?? (() => ({} as any)),
  });
}

function createChannelConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: 'config-1',
    name: 'Test Channel',
    channelType: 'slack',
    credentials: { botToken: 'xoxb-test-token-123' },
    agentName: 'default',
    sessionStrategy: 'per-user',
    metadata: {},
    platformConfig: {},
    ...overrides,
  } as ChannelConfig;
}

function createNormalizedMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    externalId: 'msg-123',
    channelType: 'slack',
    channelConfigId: 'config-1',
    chatType: 'channel',
    content: 'Hello',
    attachments: [],
    platformUser: { id: 'U123', name: 'testuser' },
    raw: {
      event: { channel: 'C123' },
    },
    ...overrides,
  } as NormalizedMessage;
}

function createAgentResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    content: 'This is the response',
    sessionId: 'session-abc',
    ...overrides,
  } as AgentResponse;
}

// ─── SlackAdapter ───────────────────────────────────────────────────────────

describe('SlackAdapter', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── Static properties ─────────────────────────────────────────────────

  describe('static properties', () => {
    it('has type "slack"', () => {
      const adapter = createAdapter();
      expect(adapter.type).toBe('slack');
    });

    it('has name "Slack"', () => {
      const adapter = createAdapter();
      expect(adapter.name).toBe('Slack');
    });
  });

  // ── Capabilities ──────────────────────────────────────────────────────

  describe('capabilities', () => {
    it('has textChunkLimit of 4000', () => {
      const adapter = createAdapter();
      expect(adapter.capabilities.textChunkLimit).toBe(4000);
    });

    it('supports rich text', () => {
      const adapter = createAdapter();
      expect(adapter.capabilities.supportsRichText).toBe(true);
    });

    it('supports editing', () => {
      const adapter = createAdapter();
      expect(adapter.capabilities.supportsEditing).toBe(true);
    });

    it('supports typing indicator', () => {
      const adapter = createAdapter();
      expect(adapter.capabilities.supportsTypingIndicator).toBe(true);
    });

    it('supports attachments', () => {
      const adapter = createAdapter();
      expect(adapter.capabilities.supportsAttachments).toBe(true);
    });

    it('has connectionType "webhook"', () => {
      const adapter = createAdapter();
      expect(adapter.capabilities.connectionType).toBe('webhook');
    });
  });

  // ── validateCredentials ───────────────────────────────────────────────

  describe('validateCredentials', () => {
    it('returns invalid when botToken is missing', async () => {
      const adapter = createAdapter();
      const result = await adapter.validateCredentials({});
      expect(result.valid).toBe(false);
      expect(result.error).toContain('botToken is required');
    });

    it('returns invalid when botToken is empty string', async () => {
      const adapter = createAdapter();
      const result = await adapter.validateCredentials({ botToken: '' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('botToken is required');
    });

    it('returns valid when auth.test API call succeeds', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({
          ok: true,
          user_id: 'U_BOT',
          team_id: 'T_TEAM',
          user: 'testbot',
          team: 'Test Team',
        }),
      });

      const adapter = createAdapter();
      const credentials: Record<string, unknown> = { botToken: 'xoxb-valid-token' };
      const result = await adapter.validateCredentials(credentials);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      // Should populate botUserId and teamId on the credentials object
      expect(credentials.botUserId).toBe('U_BOT');
      expect(credentials.teamId).toBe('T_TEAM');
    });

    it('returns invalid when auth.test API returns not ok', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: false, error: 'invalid_auth' }),
      });

      const adapter = createAdapter();
      const result = await adapter.validateCredentials({ botToken: 'xoxb-bad-token' });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid bot token');
      expect(result.error).toContain('invalid_auth');
    });

    it('returns invalid when auth.test API call throws', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const adapter = createAdapter();
      const result = await adapter.validateCredentials({ botToken: 'xoxb-unreachable' });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Failed to validate Slack credentials');
    });

    it('does not set botUserId when auth.test returns no user_id', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true }),
      });

      const adapter = createAdapter();
      const credentials: Record<string, unknown> = { botToken: 'xoxb-valid' };
      const result = await adapter.validateCredentials(credentials);

      expect(result.valid).toBe(true);
      expect(credentials.botUserId).toBeUndefined();
    });
  });

  // ── sendResponse (slash command path) ─────────────────────────────────

  describe('sendResponse - slash command path', () => {
    it('uses responseUrl when message has _slackCommand flag', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true }),
      });
      globalThis.fetch = fetchMock;

      const adapter = createAdapter();
      const config = createChannelConfig();
      const message = createNormalizedMessage({
        raw: {
          _slackCommand: true,
          responseUrl: 'https://hooks.slack.com/commands/response-url',
        },
      });
      const response = createAgentResponse({ content: 'Command response' });

      await adapter.sendResponse(config, message, response);

      // Should have called fetch with the responseUrl
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://hooks.slack.com/commands/response-url');
      expect(opts.method).toBe('POST');

      const body = JSON.parse(opts.body);
      expect(body.text).toContain('Command response');
      expect(body.response_type).toBe('in_channel');
    });

    it('includes session URL in slash command response when available', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true }),
      });
      globalThis.fetch = fetchMock;

      const adapter = createAdapter();
      const config = createChannelConfig({
        metadata: { sessionBaseUrl: 'https://app.example.com/sessions' },
      });
      const message = createNormalizedMessage({
        raw: {
          _slackCommand: true,
          responseUrl: 'https://hooks.slack.com/response',
        },
      });
      const response = createAgentResponse({
        content: 'Response text',
        sessionId: 'sess-abc',
      });

      await adapter.sendResponse(config, message, response);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.text).toContain('https://app.example.com/sessions/sess-abc');
      expect(body.text).toContain('View full session');
    });
  });

  // ── sendResponse (regular message path) ───────────────────────────────

  describe('sendResponse - regular message path', () => {
    it('posts message to Slack API using bot token', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true, ts: '12345.67890' }),
      });
      globalThis.fetch = fetchMock;

      const adapter = createAdapter();
      const config = createChannelConfig();
      const message = createNormalizedMessage({
        externalId: 'thread-ts-123',
        raw: { event: { channel: 'C_TARGET' } },
      });
      const response = createAgentResponse({ content: 'Regular reply' });

      await adapter.sendResponse(config, message, response);

      // Should call chat.postMessage
      expect(fetchMock).toHaveBeenCalled();
      const chatPostCall = fetchMock.mock.calls.find(
        ([url]: [string]) => url.includes('chat.postMessage'),
      );
      expect(chatPostCall).toBeDefined();

      const [url, opts] = chatPostCall!;
      expect(url).toBe('https://slack.com/api/chat.postMessage');
      expect(opts.headers.Authorization).toBe('Bearer xoxb-test-token-123');

      const body = JSON.parse(opts.body);
      expect(body.channel).toBe('C_TARGET');
      expect(body.thread_ts).toBe('thread-ts-123');
    });

    it('does not send when botToken is missing', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const adapter = createAdapter();
      const config = createChannelConfig({ credentials: {} });
      const message = createNormalizedMessage();
      const response = createAgentResponse();

      await adapter.sendResponse(config, message, response);

      expect(fetchMock).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('does not send when channel cannot be determined', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const adapter = createAdapter();
      const config = createChannelConfig();
      const message = createNormalizedMessage({
        raw: { event: {} }, // no channel
      });
      const response = createAgentResponse();

      await adapter.sendResponse(config, message, response);

      expect(fetchMock).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('uses threadId from message when available', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true }),
      });
      globalThis.fetch = fetchMock;

      const adapter = createAdapter();
      const config = createChannelConfig();
      const message = createNormalizedMessage({
        threadId: 'parent-thread-ts',
        externalId: 'msg-ts',
        raw: { event: { channel: 'C123' } },
      });
      const response = createAgentResponse();

      await adapter.sendResponse(config, message, response);

      const chatPostCall = fetchMock.mock.calls.find(
        ([url]: [string]) => url.includes('chat.postMessage'),
      );
      expect(chatPostCall).toBeDefined();
      const body = JSON.parse(chatPostCall![1].body);
      expect(body.thread_ts).toBe('parent-thread-ts');
    });

    it('includes blocks in the postMessage call', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true }),
      });
      globalThis.fetch = fetchMock;

      const adapter = createAdapter();
      const config = createChannelConfig();
      const message = createNormalizedMessage();
      const response = createAgentResponse({ content: 'Hello with blocks' });

      await adapter.sendResponse(config, message, response);

      const chatPostCall = fetchMock.mock.calls.find(
        ([url]: [string]) => url.includes('chat.postMessage'),
      );
      const body = JSON.parse(chatPostCall![1].body);
      expect(body.blocks).toBeDefined();
      expect(Array.isArray(body.blocks)).toBe(true);
    });
  });

  // ── onChannelRemoved ──────────────────────────────────────────────────

  describe('onChannelRemoved', () => {
    it('does not throw when called', async () => {
      const adapter = createAdapter();
      const config = createChannelConfig();
      await expect(adapter.onChannelRemoved(config)).resolves.not.toThrow();
    });
  });

  // ── Reaction lifecycle ────────────────────────────────────────────────

  describe('reactComplete', () => {
    it('adds white_check_mark reaction on success', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true }),
      });
      globalThis.fetch = fetchMock;

      const adapter = createAdapter();
      const config = createChannelConfig();
      const message = createNormalizedMessage({
        externalId: '1234.5678',
        raw: { event: { channel: 'C_CHAN' } },
      });

      await adapter.reactComplete(config, message);

      const reactionCall = fetchMock.mock.calls.find(
        ([url]: [string]) => url.includes('reactions.add'),
      );
      expect(reactionCall).toBeDefined();
      const body = JSON.parse(reactionCall![1].body);
      expect(body.name).toBe('white_check_mark');
      expect(body.channel).toBe('C_CHAN');
      expect(body.timestamp).toBe('1234.5678');
    });

    it('does nothing without bot token', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      const adapter = createAdapter();
      const config = createChannelConfig({ credentials: {} });
      const message = createNormalizedMessage();

      await adapter.reactComplete(config, message);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('reactError', () => {
    it('adds x reaction on error', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true }),
      });
      globalThis.fetch = fetchMock;

      const adapter = createAdapter();
      const config = createChannelConfig();
      const message = createNormalizedMessage({
        externalId: '1234.5678',
        raw: { event: { channel: 'C_CHAN' } },
      });

      await adapter.reactError(config, message);

      const reactionCall = fetchMock.mock.calls.find(
        ([url]: [string]) => url.includes('reactions.add'),
      );
      expect(reactionCall).toBeDefined();
      const body = JSON.parse(reactionCall![1].body);
      expect(body.name).toBe('x');
    });
  });

  describe('reactFilesChanged', () => {
    it('adds file_folder reaction when files change', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true }),
      });
      globalThis.fetch = fetchMock;

      const adapter = createAdapter();
      const config = createChannelConfig();
      const message = createNormalizedMessage({
        externalId: '1234.5678',
        raw: { event: { channel: 'C_CHAN' } },
      });

      await adapter.reactFilesChanged(config, message);

      const reactionCall = fetchMock.mock.calls.find(
        ([url]: [string]) => url.includes('reactions.add'),
      );
      expect(reactionCall).toBeDefined();
      const body = JSON.parse(reactionCall![1].body);
      expect(body.name).toBe('file_folder');
    });
  });
});
