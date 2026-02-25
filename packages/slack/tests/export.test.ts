import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportThreadAsMarkdown, exportChannelAsMarkdown } from '../src/export.js';
import type { SlackApi } from '../src/api.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockApi(overrides: Partial<SlackApi> = {}): SlackApi {
  return {
    conversationsReplies: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
    usersInfo: vi.fn().mockResolvedValue({
      ok: true,
      user: { id: 'U123', name: 'testuser', real_name: 'Test User', profile: { display_name: 'TestDisplay' } },
    }),
    postMessage: vi.fn().mockResolvedValue({ ok: true }),
    updateMessage: vi.fn().mockResolvedValue({ ok: true }),
    authTest: vi.fn().mockResolvedValue({ ok: true }),
    addReaction: vi.fn().mockResolvedValue({ ok: true }),
    removeReaction: vi.fn().mockResolvedValue({ ok: true }),
    filesUploadV2: vi.fn().mockResolvedValue({ ok: true }),
    conversationsJoin: vi.fn().mockResolvedValue({ ok: true }),
    conversationsHistory: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
    ...overrides,
  } as unknown as SlackApi;
}

// ─── exportThreadAsMarkdown ─────────────────────────────────────────────────

describe('exportThreadAsMarkdown', () => {
  it('returns fallback text when no messages are found (empty array)', async () => {
    const api = createMockApi({
      conversationsReplies: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
    });

    const result = await exportThreadAsMarkdown({
      channel: 'C123',
      threadTs: '1672531200.000000',
      api,
    });

    expect(result).toContain('No messages found');
  });

  it('returns fallback text when API returns not ok', async () => {
    const api = createMockApi({
      conversationsReplies: vi.fn().mockResolvedValue({ ok: false, error: 'channel_not_found' }),
    });

    const result = await exportThreadAsMarkdown({
      channel: 'C123',
      threadTs: '1672531200.000000',
      api,
    });

    expect(result).toContain('No messages found');
  });

  it('returns fallback text when messages is undefined', async () => {
    const api = createMockApi({
      conversationsReplies: vi.fn().mockResolvedValue({ ok: true }),
    });

    const result = await exportThreadAsMarkdown({
      channel: 'C123',
      threadTs: '1672531200.000000',
      api,
    });

    expect(result).toContain('No messages found');
  });

  it('exports a thread with messages in markdown format', async () => {
    const api = createMockApi({
      conversationsReplies: vi.fn().mockResolvedValue({
        ok: true,
        messages: [
          { type: 'message', user: 'U123', text: 'Hello there!', ts: '1672531200.000000' },
          { type: 'message', bot_id: 'B456', text: 'Hi! How can I help?', ts: '1672531260.000000' },
        ],
      }),
      usersInfo: vi.fn().mockResolvedValue({
        ok: true,
        user: { id: 'U123', name: 'alice', real_name: 'Alice', profile: { display_name: 'Alice' } },
      }),
    });

    const result = await exportThreadAsMarkdown({
      channel: 'C123',
      threadTs: '1672531200.000000',
      api,
    });

    expect(result).toContain('Thread Export');
    expect(result).toContain('C123');
    expect(result).toContain('Hello there!');
    expect(result).toContain('Hi! How can I help?');
  });

  it('labels bot messages as "(bot)" and uses "Assistant" as name', async () => {
    const api = createMockApi({
      conversationsReplies: vi.fn().mockResolvedValue({
        ok: true,
        messages: [
          { type: 'message', bot_id: 'B456', text: 'I am a bot', ts: '1672531200.000000' },
        ],
      }),
    });

    const result = await exportThreadAsMarkdown({
      channel: 'C123',
      threadTs: '1672531200.000000',
      api,
    });

    expect(result).toContain('**Assistant** (bot)');
    expect(result).toContain('I am a bot');
  });

  it('labels user messages with resolved username', async () => {
    const api = createMockApi({
      conversationsReplies: vi.fn().mockResolvedValue({
        ok: true,
        messages: [
          { type: 'message', user: 'U999', text: 'User message', ts: '1672531200.000000' },
        ],
      }),
      usersInfo: vi.fn().mockResolvedValue({
        ok: true,
        user: {
          id: 'U999',
          name: 'bob',
          real_name: 'Bob Smith',
          profile: { display_name: 'Bobby' },
        },
      }),
    });

    const result = await exportThreadAsMarkdown({
      channel: 'C123',
      threadTs: '1672531200.000000',
      api,
    });

    // display_name is preferred
    expect(result).toContain('**Bobby**');
    expect(result).not.toContain('(bot)');
  });

  it('formats timestamp as UTC ISO-like string', async () => {
    const api = createMockApi({
      conversationsReplies: vi.fn().mockResolvedValue({
        ok: true,
        messages: [
          { type: 'message', user: 'U123', text: 'test', ts: '1672531200.000000' },
        ],
      }),
    });

    const result = await exportThreadAsMarkdown({
      channel: 'C123',
      threadTs: '1672531200.000000',
      api,
    });

    // 1672531200 = 2023-01-01T00:00:00.000Z
    expect(result).toContain('2023-01-01 00:00:00 UTC');
  });

  it('includes message count in export footer', async () => {
    const api = createMockApi({
      conversationsReplies: vi.fn().mockResolvedValue({
        ok: true,
        messages: [
          { type: 'message', user: 'U1', text: 'First', ts: '1672531200.000000' },
          { type: 'message', user: 'U2', text: 'Second', ts: '1672531260.000000' },
          { type: 'message', bot_id: 'B1', text: 'Third', ts: '1672531320.000000' },
        ],
      }),
    });

    const result = await exportThreadAsMarkdown({
      channel: 'C123',
      threadTs: '1672531200.000000',
      api,
    });

    expect(result).toContain('3 messages exported');
  });

  it('skips messages with no text and no subtype', async () => {
    const api = createMockApi({
      conversationsReplies: vi.fn().mockResolvedValue({
        ok: true,
        messages: [
          { type: 'message', user: 'U1', ts: '1672531200.000000' }, // no text, no subtype -> skipped
          { type: 'message', user: 'U2', text: 'has text', ts: '1672531260.000000' },
        ],
      }),
    });

    const result = await exportThreadAsMarkdown({
      channel: 'C123',
      threadTs: '1672531200.000000',
      api,
    });

    expect(result).toContain('1 messages exported');
    expect(result).toContain('has text');
  });

  it('uses userId as fallback when usersInfo fails', async () => {
    const api = createMockApi({
      conversationsReplies: vi.fn().mockResolvedValue({
        ok: true,
        messages: [
          { type: 'message', user: 'UFAILUSER', text: 'test', ts: '1672531200.000000' },
        ],
      }),
      usersInfo: vi.fn().mockRejectedValue(new Error('API error')),
    });

    const result = await exportThreadAsMarkdown({
      channel: 'C123',
      threadTs: '1672531200.000000',
      api,
    });

    expect(result).toContain('**UFAILUSER**');
  });

  it('caches resolved usernames across multiple messages', async () => {
    const usersInfoMock = vi.fn().mockResolvedValue({
      ok: true,
      user: { id: 'U123', name: 'alice', profile: { display_name: 'Alice' } },
    });

    const api = createMockApi({
      conversationsReplies: vi.fn().mockResolvedValue({
        ok: true,
        messages: [
          { type: 'message', user: 'U123', text: 'First', ts: '1672531200.000000' },
          { type: 'message', user: 'U123', text: 'Second', ts: '1672531260.000000' },
          { type: 'message', user: 'U123', text: 'Third', ts: '1672531320.000000' },
        ],
      }),
      usersInfo: usersInfoMock,
    });

    await exportThreadAsMarkdown({
      channel: 'C123',
      threadTs: '1672531200.000000',
      api,
    });

    // Should only call usersInfo once for the same user
    expect(usersInfoMock).toHaveBeenCalledTimes(1);
  });
});

// ─── exportChannelAsMarkdown ────────────────────────────────────────────────

describe('exportChannelAsMarkdown', () => {
  it('exports channel messages in markdown format', async () => {
    const api = createMockApi({
      usersInfo: vi.fn().mockResolvedValue({
        ok: true,
        user: { id: 'U1', name: 'charlie', profile: { display_name: 'Charlie' } },
      }),
    });

    const result = await exportChannelAsMarkdown({
      messages: [
        { user: 'U1', text: 'Channel message!', ts: '1672531200.000000' },
        { bot_id: 'B1', text: 'Bot reply', ts: '1672531260.000000' },
      ],
      api,
      channelId: 'C456',
    });

    expect(result).toContain('Channel Export');
    expect(result).toContain('C456');
    expect(result).toContain('Channel message!');
    expect(result).toContain('Bot reply');
    expect(result).toContain('2 messages exported');
  });

  it('handles empty messages array', async () => {
    const api = createMockApi();

    const result = await exportChannelAsMarkdown({
      messages: [],
      api,
      channelId: 'C456',
    });

    expect(result).toContain('Channel Export');
    expect(result).toContain('0 messages exported');
  });

  it('labels bot_message subtype as bot', async () => {
    const api = createMockApi();

    const result = await exportChannelAsMarkdown({
      messages: [
        { text: 'bot msg', ts: '1672531200.000000', subtype: 'bot_message' },
      ],
      api,
      channelId: 'C456',
    });

    expect(result).toContain('**Assistant** (bot)');
  });

  it('shows "Unknown" for messages with no user and no bot_id', async () => {
    const api = createMockApi();

    const result = await exportChannelAsMarkdown({
      messages: [
        { text: 'mystery message', ts: '1672531200.000000' },
      ],
      api,
      channelId: 'C456',
    });

    expect(result).toContain('**Unknown**');
  });

  it('shows "_empty message_" for messages with empty text', async () => {
    const api = createMockApi();

    const result = await exportChannelAsMarkdown({
      messages: [
        { user: 'U1', text: '', ts: '1672531200.000000', subtype: 'file_share' },
      ],
      api,
      channelId: 'C456',
    });

    expect(result).toContain('_empty message_');
  });
});
