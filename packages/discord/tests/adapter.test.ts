import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscordAdapter } from '../src/adapter.js';
import { DiscordApiError } from '../src/api.js';
import type { ChannelConfig, NormalizedMessage, AgentResponse, PermissionRequest, FileOutput } from '@opencode-channels/core';

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockResponse(status: number, body?: unknown): Response {
  const hasBody = body !== undefined;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: hasBody ? () => Promise.resolve(body) : () => Promise.reject(new Error('no body')),
    text: () => Promise.resolve(hasBody ? JSON.stringify(body) : ''),
    headers: new Headers(),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  } as unknown as Response;
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

function createNormalizedMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    externalId: 'msg-1',
    channelType: 'discord',
    channelConfigId: 'cfg-1',
    chatType: 'group',
    content: 'Hello',
    attachments: [],
    platformUser: { id: 'u-1', name: 'TestUser' },
    raw: { channelId: 'chan-1' },
    ...overrides,
  };
}

function createAgentResponse(overrides?: Partial<AgentResponse>): AgentResponse {
  return {
    content: 'Hello back!',
    sessionId: 'sess-1',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DiscordAdapter', () => {
  let adapter: DiscordAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new DiscordAdapter({
      getConfigByApplicationId: () => undefined,
    });
    fetchSpy = vi.fn().mockResolvedValue(mockResponse(200, {}));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Static properties ───────────────────────────────────────────────────

  describe('type and capabilities', () => {
    it('has type "discord"', () => {
      expect(adapter.type).toBe('discord');
    });

    it('has name "Discord"', () => {
      expect(adapter.name).toBe('Discord');
    });

    it('has correct capabilities', () => {
      expect(adapter.capabilities).toEqual({
        textChunkLimit: 2000,
        supportsRichText: true,
        supportsEditing: true,
        supportsTypingIndicator: false,
        supportsAttachments: true,
        connectionType: 'webhook',
      });
    });
  });

  // ── validateCredentials ─────────────────────────────────────────────────

  describe('validateCredentials', () => {
    it('returns invalid when botToken is missing', async () => {
      const result = await adapter.validateCredentials({ publicKey: 'a'.repeat(64) });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('botToken is required');
    });

    it('returns invalid when publicKey is missing', async () => {
      const result = await adapter.validateCredentials({ botToken: 'some-token' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('publicKey is required');
    });

    it('returns invalid when publicKey is not a 64-char hex string', async () => {
      const result = await adapter.validateCredentials({
        botToken: 'some-token',
        publicKey: 'not-hex',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('64-character hex');
    });

    it('returns invalid for publicKey with wrong length', async () => {
      const result = await adapter.validateCredentials({
        botToken: 'some-token',
        publicKey: 'ab'.repeat(16), // 32 chars, not 64
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('64-character hex');
    });

    it('returns valid when getCurrentUser succeeds', async () => {
      fetchSpy.mockResolvedValue(
        mockResponse(200, { id: 'bot-1', username: 'mybot', discriminator: '0' }),
      );

      const creds: Record<string, unknown> = {
        botToken: 'real-token',
        publicKey: 'a'.repeat(64),
      };
      const result = await adapter.validateCredentials(creds);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      // Should have stored botUserId and botUsername
      expect(creds.botUserId).toBe('bot-1');
      expect(creds.botUsername).toBe('mybot');
    });

    it('returns invalid when getCurrentUser throws', async () => {
      fetchSpy.mockResolvedValue(
        mockResponse(401, { message: 'Unauthorized' }),
      );

      const result = await adapter.validateCredentials({
        botToken: 'bad-token',
        publicKey: 'a'.repeat(64),
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('returns invalid when getCurrentUser returns empty id', async () => {
      fetchSpy.mockResolvedValue(
        mockResponse(200, { id: '', username: 'mybot', discriminator: '0' }),
      );

      const result = await adapter.validateCredentials({
        botToken: 'some-token',
        publicKey: 'a'.repeat(64),
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid bot token');
    });
  });

  // ── sendResponse (interaction-based) ────────────────────────────────────

  describe('sendResponse', () => {
    it('edits the deferred interaction response for short content', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {}));

      const config = createMockConfig();
      const message = createNormalizedMessage({
        raw: {
          _discordInteraction: true,
          interaction: {
            id: 'int-1',
            token: 'tok-abc',
            application_id: 'app-123',
          },
        },
      });
      const response = createAgentResponse({ content: 'Short reply' });

      await adapter.sendResponse(config, message, response);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/webhooks/app-123/tok-abc/messages/@original');
      expect(opts.method).toBe('PATCH');
      const body = JSON.parse(opts.body);
      expect(body.content).toBe('Short reply');
    });

    it('sends channel message with reply reference for non-interaction messages', async () => {
      const fakeMsg = { id: 'msg-reply-1' };
      fetchSpy.mockResolvedValue(mockResponse(200, fakeMsg));

      const config = createMockConfig();
      const message = createNormalizedMessage({
        externalId: 'msg-orig',
        raw: { channelId: 'chan-5' },
      });
      const response = createAgentResponse({ content: 'channel reply' });

      await adapter.sendResponse(config, message, response);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/channels/chan-5/messages');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      expect(body.content).toBe('channel reply');
      expect(body.message_reference).toEqual({ message_id: 'msg-orig' });
    });

    it('sends embeds for long content in interaction response', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {}));

      const config = createMockConfig();
      const longContent = 'x'.repeat(3000);
      const message = createNormalizedMessage({
        raw: {
          _discordInteraction: true,
          interaction: {
            id: 'int-2',
            token: 'tok-def',
            application_id: 'app-123',
          },
        },
      });
      const response = createAgentResponse({ content: longContent });

      await adapter.sendResponse(config, message, response);

      expect(fetchSpy).toHaveBeenCalled();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/webhooks/app-123/tok-def/messages/@original');
      const body = JSON.parse(opts.body);
      // Long content should be sent as embeds
      expect(body.embeds).toBeDefined();
      expect(body.embeds.length).toBeGreaterThanOrEqual(1);
    });

    it('does nothing when botToken is missing', async () => {
      const config = createMockConfig({ credentials: {} });
      const message = createNormalizedMessage();
      const response = createAgentResponse();

      await adapter.sendResponse(config, message, response);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does nothing when channelId is missing for non-interaction message', async () => {
      const config = createMockConfig();
      const message = createNormalizedMessage({
        raw: {},
        groupId: undefined,
      });
      const response = createAgentResponse();

      await adapter.sendResponse(config, message, response);

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ── buildResponseEmbeds (tested via sendResponse) ───────────────────────

  describe('buildResponseEmbeds (via sendResponse)', () => {
    it('produces a single embed for short content', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {}));

      const config = createMockConfig({
        metadata: { sessionBaseUrl: 'https://example.com/sessions/' },
      });
      const longEnoughContent = 'x'.repeat(2001); // Over 2000 → uses embeds
      const message = createNormalizedMessage({
        raw: { channelId: 'chan-embed' },
      });
      const response = createAgentResponse({
        content: longEnoughContent,
        sessionId: 'sess-42',
      });

      await adapter.sendResponse(config, message, response);

      expect(fetchSpy).toHaveBeenCalled();
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.embeds).toBeDefined();
      expect(body.embeds.length).toBe(1);
      expect(body.embeds[0].description).toBe(longEnoughContent);
      expect(body.embeds[0].color).toBe(0x5865f2);
    });

    it('produces multiple embeds for very long content (>4096 chars)', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {}));

      const config = createMockConfig();
      const veryLong = 'y'.repeat(5000); // Over 4096 embed desc limit
      const message = createNormalizedMessage({
        raw: { channelId: 'chan-long' },
      });
      const response = createAgentResponse({ content: veryLong });

      await adapter.sendResponse(config, message, response);

      expect(fetchSpy).toHaveBeenCalled();
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.embeds).toBeDefined();
      expect(body.embeds.length).toBeGreaterThanOrEqual(2);
      // Each embed description should be <= 4096 chars
      for (const embed of body.embeds) {
        expect(embed.description.length).toBeLessThanOrEqual(4096);
      }
    });

    it('includes session URL in embed footer when configured', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {}));

      const config = createMockConfig({
        metadata: { sessionBaseUrl: 'https://myapp.com/s' },
      });
      const message = createNormalizedMessage({
        raw: {
          _discordInteraction: true,
          interaction: {
            id: 'int-url',
            token: 'tok-url',
            application_id: 'app-123',
          },
        },
      });
      // Short content but with sessionUrl, so it will use embeds path
      // (content.length <= 2000 but sessionUrl is truthy → goes to embeds path)
      const response = createAgentResponse({
        content: 'Here is your answer',
        sessionId: 'sess-99',
      });

      await adapter.sendResponse(config, message, response);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.embeds).toBeDefined();
      expect(body.embeds[0].footer).toBeDefined();
      expect(body.embeds[0].url).toBe('https://myapp.com/s/sess-99');
    });
  });

  // ── sendFiles ───────────────────────────────────────────────────────────

  describe('sendFiles', () => {
    it('batches files 10 per message', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, { id: 'msg-files' }));

      const config = createMockConfig();
      const message = createNormalizedMessage({ raw: { channelId: 'chan-files' } });

      // Create 12 files → should produce 2 batches (10 + 2)
      const files: FileOutput[] = Array.from({ length: 12 }, (_, i) => ({
        name: `file-${i}.txt`,
        url: `https://example.com/file-${i}`,
        content: Buffer.from(`content-${i}`),
      }));

      await adapter.sendFiles(config, message, files);

      // Each batch calls createMessageWithFiles → 2 fetch calls
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // First call should have 10 files
      const form1 = fetchSpy.mock.calls[0][1].body as FormData;
      const payload1 = JSON.parse(form1.get('payload_json') as string);
      expect(payload1.attachments.length).toBe(10);

      // Second call should have 2 files
      const form2 = fetchSpy.mock.calls[1][1].body as FormData;
      const payload2 = JSON.parse(form2.get('payload_json') as string);
      expect(payload2.attachments.length).toBe(2);
    });

    it('downloads files from URL when content is not provided', async () => {
      const fileContent = Buffer.from('downloaded content');
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(fileContent.buffer.slice(
            fileContent.byteOffset,
            fileContent.byteOffset + fileContent.byteLength,
          )),
        } as unknown as Response)
        .mockResolvedValueOnce(mockResponse(200, { id: 'msg-dl' }));

      const config = createMockConfig();
      const message = createNormalizedMessage({ raw: { channelId: 'chan-dl' } });
      const files: FileOutput[] = [{ name: 'remote.txt', url: 'https://example.com/remote.txt' }];

      await adapter.sendFiles(config, message, files);

      // First call: download the file, second call: upload via FormData
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[0][0]).toBe('https://example.com/remote.txt');
    });

    it('skips when botToken is missing', async () => {
      const config = createMockConfig({ credentials: {} });
      const message = createNormalizedMessage();

      await adapter.sendFiles(config, message, [{ name: 'a.txt', url: '', content: Buffer.from('x') }]);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('skips when channelId is missing', async () => {
      const config = createMockConfig();
      const message = createNormalizedMessage({ raw: {}, groupId: undefined });

      await adapter.sendFiles(config, message, [{ name: 'a.txt', url: '', content: Buffer.from('x') }]);

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ── sendPermissionRequest ───────────────────────────────────────────────

  describe('sendPermissionRequest', () => {
    it('creates a message with approve/reject buttons for channel messages', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, { id: 'msg-perm' }));

      const config = createMockConfig();
      const message = createNormalizedMessage({ raw: { channelId: 'chan-perm' } });
      const permission: PermissionRequest = {
        id: 'perm-42',
        tool: 'shell_exec',
        description: 'Run `rm -rf /tmp`',
      };

      await adapter.sendPermissionRequest(config, message, permission);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/channels/chan-perm/messages');
      expect(opts.method).toBe('POST');

      const body = JSON.parse(opts.body);

      // Should have an embed
      expect(body.embeds).toBeDefined();
      expect(body.embeds.length).toBe(1);
      expect(body.embeds[0].title).toContain('Permission Request');
      expect(body.embeds[0].description).toContain('shell_exec');

      // Should have action row with approve/reject buttons
      expect(body.components).toBeDefined();
      expect(body.components.length).toBe(1);
      expect(body.components[0].type).toBe(1); // ActionRow

      const buttons = body.components[0].components;
      expect(buttons.length).toBe(2);

      const approveBtn = buttons.find((b: any) => b.label === 'Approve');
      const rejectBtn = buttons.find((b: any) => b.label === 'Reject');

      expect(approveBtn).toBeDefined();
      expect(approveBtn.custom_id).toBe('perm_approve_perm-42');
      expect(approveBtn.style).toBe(3); // Success

      expect(rejectBtn).toBeDefined();
      expect(rejectBtn.custom_id).toBe('perm_reject_perm-42');
      expect(rejectBtn.style).toBe(4); // Danger

      // Should have a reply reference
      expect(body.message_reference).toEqual({ message_id: 'msg-1' });
    });

    it('sends via webhook follow-up for interaction-based messages', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {}));

      const config = createMockConfig();
      const message = createNormalizedMessage({
        raw: {
          _discordInteraction: true,
          interaction: {
            application_id: 'app-123',
            token: 'int-tok',
          },
        },
      });
      const permission: PermissionRequest = {
        id: 'perm-99',
        tool: 'file_write',
        description: 'Write to /etc/hosts',
      };

      await adapter.sendPermissionRequest(config, message, permission);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://discord.com/api/v10/webhooks/app-123/int-tok');
      expect(opts.method).toBe('POST');

      const body = JSON.parse(opts.body);
      expect(body.embeds).toBeDefined();
      expect(body.components).toBeDefined();
    });

    it('does nothing when botToken is missing', async () => {
      const config = createMockConfig({ credentials: {} });
      const message = createNormalizedMessage();
      const permission: PermissionRequest = { id: 'p-1', tool: 'test', description: '' };

      await adapter.sendPermissionRequest(config, message, permission);

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ── sendTypingIndicator / removeTypingIndicator ─────────────────────────

  describe('sendTypingIndicator', () => {
    it('adds a hourglass reaction for non-interaction messages', async () => {
      fetchSpy.mockResolvedValue(mockResponse(204));

      const config = createMockConfig();
      const message = createNormalizedMessage({
        externalId: 'msg-typing',
        raw: { channelId: 'chan-typing' },
      });

      await adapter.sendTypingIndicator(config, message);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/reactions/');
      expect(url).toContain('/@me');
      expect(opts.method).toBe('PUT');
    });

    it('skips for interaction-based messages', async () => {
      const config = createMockConfig();
      const message = createNormalizedMessage({
        raw: { _discordInteraction: true },
      });

      await adapter.sendTypingIndicator(config, message);

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('removeTypingIndicator', () => {
    it('removes the hourglass reaction', async () => {
      fetchSpy.mockResolvedValue(mockResponse(204));

      const config = createMockConfig();
      const message = createNormalizedMessage({
        externalId: 'msg-typing',
        raw: { channelId: 'chan-typing' },
      });

      await adapter.removeTypingIndicator(config, message);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/reactions/');
      expect(opts.method).toBe('DELETE');
    });
  });

  // ── onChannelRemoved ────────────────────────────────────────────────────

  describe('onChannelRemoved', () => {
    it('logs removal without throwing', async () => {
      const config = createMockConfig();
      await expect(adapter.onChannelRemoved(config)).resolves.toBeUndefined();
    });
  });
});
