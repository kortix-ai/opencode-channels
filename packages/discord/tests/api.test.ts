import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscordApi, DiscordApiError } from '../src/api.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const BOT_TOKEN = 'test-bot-token-12345';
const BASE_URL = 'https://discord.com/api/v10';

/** Build a mock Response with the given status and JSON body. */
function mockResponse(status: number, body?: unknown): Response {
  const hasBody = body !== undefined;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: hasBody ? () => Promise.resolve(body) : () => Promise.reject(new Error('no body')),
    text: () => Promise.resolve(hasBody ? JSON.stringify(body) : ''),
    headers: new Headers(),
  } as unknown as Response;
}

// ─── DiscordApiError ────────────────────────────────────────────────────────

describe('DiscordApiError', () => {
  it('stores status and body', () => {
    const err = new DiscordApiError(404, { message: 'Not Found' });
    expect(err.status).toBe(404);
    expect(err.body).toEqual({ message: 'Not Found' });
    expect(err.name).toBe('DiscordApiError');
  });

  it('formats a default message from status and body', () => {
    const err = new DiscordApiError(400, { code: 50035 });
    expect(err.message).toBe('Discord API error 400: {"code":50035}');
  });

  it('uses a custom message when provided', () => {
    const err = new DiscordApiError(500, {}, 'Server blew up');
    expect(err.message).toBe('Server blew up');
  });

  it('is an instance of Error', () => {
    const err = new DiscordApiError(401, null);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DiscordApiError);
  });
});

// ─── DiscordApi ─────────────────────────────────────────────────────────────

describe('DiscordApi', () => {
  let api: DiscordApi;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    api = new DiscordApi(BOT_TOKEN);
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── createMessage ───────────────────────────────────────────────────────

  describe('createMessage', () => {
    it('sends POST to /channels/{id}/messages with correct headers and body', async () => {
      const fakeMessage = { id: 'msg-1', content: 'hello' };
      fetchSpy.mockResolvedValue(mockResponse(200, fakeMessage));

      const result = await api.createMessage('chan-1', { content: 'hello' });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/channels/chan-1/messages`);
      expect(opts.method).toBe('POST');
      expect(opts.headers).toEqual({
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(opts.body)).toEqual({ content: 'hello' });
      expect(result).toEqual(fakeMessage);
    });
  });

  // ── editMessage ─────────────────────────────────────────────────────────

  describe('editMessage', () => {
    it('sends PATCH to /channels/{channelId}/messages/{messageId}', async () => {
      const edited = { id: 'msg-1', content: 'updated' };
      fetchSpy.mockResolvedValue(mockResponse(200, edited));

      const result = await api.editMessage('chan-1', 'msg-1', { content: 'updated' });

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/channels/chan-1/messages/msg-1`);
      expect(opts.method).toBe('PATCH');
      expect(result).toEqual(edited);
    });
  });

  // ── getChannelMessages ──────────────────────────────────────────────────

  describe('getChannelMessages', () => {
    it('sends GET to /channels/{id}/messages without query params', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, []));

      await api.getChannelMessages('chan-1');

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/channels/chan-1/messages`);
      expect(opts.method).toBe('GET');
      // No body → should send authOnly headers (no Content-Type)
      expect(opts.headers).toEqual({ Authorization: `Bot ${BOT_TOKEN}` });
      expect(opts.body).toBeUndefined();
    });

    it('appends query params when limit and before are provided', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, []));

      await api.getChannelMessages('chan-1', { limit: 50, before: 'msg-99' });

      const [url] = fetchSpy.mock.calls[0];
      const parsed = new URL(url);
      expect(parsed.searchParams.get('limit')).toBe('50');
      expect(parsed.searchParams.get('before')).toBe('msg-99');
    });

    it('omits query params that are not set', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, []));

      await api.getChannelMessages('chan-1', { limit: 10 });

      const [url] = fetchSpy.mock.calls[0];
      const parsed = new URL(url);
      expect(parsed.searchParams.get('limit')).toBe('10');
      expect(parsed.searchParams.has('before')).toBe(false);
    });
  });

  // ── createInteractionResponse ───────────────────────────────────────────

  describe('createInteractionResponse', () => {
    it('sends POST to /interactions/{id}/{token}/callback', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {}));

      await api.createInteractionResponse('int-1', 'tok-abc', {
        type: 5,
      });

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/interactions/int-1/tok-abc/callback`);
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ type: 5 });
    });
  });

  // ── editOriginalInteractionResponse ─────────────────────────────────────

  describe('editOriginalInteractionResponse', () => {
    it('sends PATCH to /webhooks/{appId}/{token}/messages/@original', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {}));

      await api.editOriginalInteractionResponse('app-1', 'tok-abc', {
        content: 'edited',
      });

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/webhooks/app-1/tok-abc/messages/@original`);
      expect(opts.method).toBe('PATCH');
    });
  });

  // ── createReaction ──────────────────────────────────────────────────────

  describe('createReaction', () => {
    it('sends PUT with URL-encoded emoji', async () => {
      fetchSpy.mockResolvedValue(mockResponse(204));

      await api.createReaction('chan-1', 'msg-1', '\u23F3');

      const [url, opts] = fetchSpy.mock.calls[0];
      const encoded = encodeURIComponent('\u23F3');
      expect(url).toBe(`${BASE_URL}/channels/chan-1/messages/msg-1/reactions/${encoded}/@me`);
      expect(opts.method).toBe('PUT');
    });
  });

  // ── deleteOwnReaction ───────────────────────────────────────────────────

  describe('deleteOwnReaction', () => {
    it('sends DELETE with URL-encoded emoji', async () => {
      fetchSpy.mockResolvedValue(mockResponse(204));

      await api.deleteOwnReaction('chan-1', 'msg-1', '\u23F3');

      const [url, opts] = fetchSpy.mock.calls[0];
      const encoded = encodeURIComponent('\u23F3');
      expect(url).toBe(`${BASE_URL}/channels/chan-1/messages/msg-1/reactions/${encoded}/@me`);
      expect(opts.method).toBe('DELETE');
    });
  });

  // ── getUser ─────────────────────────────────────────────────────────────

  describe('getUser', () => {
    it('sends GET to /users/{userId}', async () => {
      const user = { id: 'u-1', username: 'tester', discriminator: '0' };
      fetchSpy.mockResolvedValue(mockResponse(200, user));

      const result = await api.getUser('u-1');

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/users/u-1`);
      expect(opts.method).toBe('GET');
      expect(result).toEqual(user);
    });
  });

  // ── getCurrentUser ──────────────────────────────────────────────────────

  describe('getCurrentUser', () => {
    it('sends GET to /users/@me', async () => {
      const me = { id: 'bot-1', username: 'mybot', discriminator: '0', bot: true };
      fetchSpy.mockResolvedValue(mockResponse(200, me));

      const result = await api.getCurrentUser();

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/users/@me`);
      expect(opts.method).toBe('GET');
      expect(result).toEqual(me);
    });
  });

  // ── getChannel ──────────────────────────────────────────────────────────

  describe('getChannel', () => {
    it('sends GET to /channels/{channelId}', async () => {
      const channel = { id: 'chan-1', type: 0 };
      fetchSpy.mockResolvedValue(mockResponse(200, channel));

      const result = await api.getChannel('chan-1');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/channels/chan-1`);
      expect(result).toEqual(channel);
    });
  });

  // ── createDM ────────────────────────────────────────────────────────────

  describe('createDM', () => {
    it('sends POST to /users/@me/channels with recipient_id', async () => {
      const dm = { id: 'dm-1', type: 1 };
      fetchSpy.mockResolvedValue(mockResponse(200, dm));

      const result = await api.createDM('u-42');

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/users/@me/channels`);
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ recipient_id: 'u-42' });
      expect(result).toEqual(dm);
    });
  });

  // ── createThreadFromMessage ─────────────────────────────────────────────

  describe('createThreadFromMessage', () => {
    it('sends POST to /channels/{id}/messages/{msgId}/threads', async () => {
      const thread = { id: 'thread-1', type: 11, name: 'My Thread' };
      fetchSpy.mockResolvedValue(mockResponse(200, thread));

      const result = await api.createThreadFromMessage('chan-1', 'msg-1', 'My Thread');

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/channels/chan-1/messages/msg-1/threads`);
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ name: 'My Thread', auto_archive_duration: 1440 });
      expect(result).toEqual(thread);
    });
  });

  // ── 204 response returns undefined ──────────────────────────────────────

  describe('204 No Content', () => {
    it('returns undefined and does not attempt JSON parse', async () => {
      // createReaction typically returns 204
      fetchSpy.mockResolvedValue(mockResponse(204));

      const result = await api.createReaction('chan-1', 'msg-1', '\uD83D\uDE00');

      expect(result).toBeUndefined();
    });
  });

  // ── Non-OK response throws DiscordApiError ──────────────────────────────

  describe('error handling', () => {
    it('throws DiscordApiError on 400', async () => {
      fetchSpy.mockResolvedValue(mockResponse(400, { code: 50035, message: 'Invalid Form Body' }));

      await expect(api.createMessage('chan-1', { content: 'hi' })).rejects.toThrow(
        DiscordApiError,
      );
    });

    it('thrown error contains status and body', async () => {
      const errorBody = { code: 50001, message: 'Missing Access' };
      fetchSpy.mockResolvedValue(mockResponse(403, errorBody));

      try {
        await api.getChannelMessages('chan-1');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DiscordApiError);
        const apiErr = err as DiscordApiError;
        expect(apiErr.status).toBe(403);
        expect(apiErr.body).toEqual(errorBody);
      }
    });

    it('throws DiscordApiError on 404', async () => {
      fetchSpy.mockResolvedValue(mockResponse(404, { code: 10003, message: 'Unknown Channel' }));

      await expect(api.getChannel('nonexistent')).rejects.toThrow(DiscordApiError);
    });

    it('throws DiscordApiError on 500', async () => {
      fetchSpy.mockResolvedValue(
        mockResponse(500, { code: 0, message: 'Internal Server Error' }),
      );

      await expect(api.getCurrentUser()).rejects.toThrow(DiscordApiError);
    });
  });

  // ── createMessageWithFiles ──────────────────────────────────────────────

  describe('createMessageWithFiles', () => {
    it('sends a FormData POST to /channels/{id}/messages', async () => {
      const fakeMsg = { id: 'msg-files-1', content: '' };
      fetchSpy.mockResolvedValue(mockResponse(200, fakeMsg));

      const files = [
        { name: 'test.txt', data: Buffer.from('hello world') },
        { name: 'image.png', data: Buffer.from('\x89PNG') },
      ];

      const result = await api.createMessageWithFiles('chan-1', {
        content: 'Here are files',
        files,
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/channels/chan-1/messages`);
      expect(opts.method).toBe('POST');
      // Auth header only, no Content-Type (FormData sets it)
      expect(opts.headers).toEqual({ Authorization: `Bot ${BOT_TOKEN}` });
      // Body is FormData
      expect(opts.body).toBeInstanceOf(FormData);

      const formData = opts.body as FormData;
      // Should have payload_json + 2 file fields
      expect(formData.has('payload_json')).toBe(true);
      expect(formData.has('files[0]')).toBe(true);
      expect(formData.has('files[1]')).toBe(true);

      // Verify payload_json content
      const payloadJson = JSON.parse(formData.get('payload_json') as string);
      expect(payloadJson.content).toBe('Here are files');
      expect(payloadJson.attachments).toEqual([
        { id: 0, filename: 'test.txt' },
        { id: 1, filename: 'image.png' },
      ]);

      expect(result).toEqual(fakeMsg);
    });

    it('omits content from payload_json when not provided', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, { id: 'msg-2' }));

      await api.createMessageWithFiles('chan-1', {
        files: [{ name: 'file.bin', data: Buffer.from([0x01, 0x02]) }],
      });

      const formData = fetchSpy.mock.calls[0][1].body as FormData;
      const payloadJson = JSON.parse(formData.get('payload_json') as string);
      expect(payloadJson.content).toBeUndefined();
    });

    it('throws DiscordApiError on non-OK response', async () => {
      fetchSpy.mockResolvedValue(mockResponse(413, { message: 'Request entity too large' }));

      await expect(
        api.createMessageWithFiles('chan-1', {
          files: [{ name: 'huge.zip', data: Buffer.alloc(100) }],
        }),
      ).rejects.toThrow(DiscordApiError);
    });
  });
});
