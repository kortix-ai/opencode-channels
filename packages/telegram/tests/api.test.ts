import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramApi } from '../src/api.js';

const BOT_TOKEN = 'test-bot-token-123';
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

describe('TelegramApi', () => {
  let api: TelegramApi;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    api = new TelegramApi(BOT_TOKEN);
    fetchSpy = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true }),
    });
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── sendMessage ────────────────────────────────────────────────────────

  describe('sendMessage', () => {
    it('should POST to /sendMessage with correct URL and body', async () => {
      const mockResponse = {
        ok: true,
        result: { message_id: 42, chat: { id: 123 }, text: 'Hello' },
      };
      fetchSpy.mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse),
      });

      const options = {
        chat_id: 123,
        text: 'Hello, world!',
        parse_mode: 'HTML' as const,
      };

      const result = await api.sendMessage(options);

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledWith(`${BASE_URL}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      });
      expect(result).toEqual(mockResponse);
    });

    it('should include reply_to_message_id when provided', async () => {
      fetchSpy.mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: true }),
      });

      const options = {
        chat_id: 123,
        text: 'Reply',
        reply_to_message_id: 99,
        message_thread_id: 7,
      };

      await api.sendMessage(options);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.reply_to_message_id).toBe(99);
      expect(body.message_thread_id).toBe(7);
    });

    it('should return parsed JSON response', async () => {
      const mockResponse = {
        ok: false,
        description: 'Bad Request: chat not found',
      };
      fetchSpy.mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse),
      });

      const result = await api.sendMessage({ chat_id: 0, text: 'test' });
      expect(result).toEqual(mockResponse);
    });
  });

  // ─── editMessage ────────────────────────────────────────────────────────

  describe('editMessage', () => {
    it('should POST to /editMessageText with correct URL and body', async () => {
      const mockResponse = { ok: true };
      fetchSpy.mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse),
      });

      const options = {
        chat_id: 456,
        message_id: 78,
        text: 'Edited text',
        parse_mode: 'MarkdownV2' as const,
      };

      const result = await api.editMessage(options);

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledWith(`${BASE_URL}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      });
      expect(result).toEqual(mockResponse);
    });
  });

  // ─── sendChatAction ─────────────────────────────────────────────────────

  describe('sendChatAction', () => {
    it('should POST to /sendChatAction with default action "typing"', async () => {
      fetchSpy.mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: true }),
      });

      await api.sendChatAction(123);

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledWith(`${BASE_URL}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: 123, action: 'typing' }),
      });
    });

    it('should POST with a custom action', async () => {
      fetchSpy.mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: true }),
      });

      await api.sendChatAction(456, 'upload_photo');

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.action).toBe('upload_photo');
    });

    it('should return void (no json parsed)', async () => {
      fetchSpy.mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: true }),
      });

      const result = await api.sendChatAction(123);
      expect(result).toBeUndefined();
    });
  });

  // ─── setWebhook ─────────────────────────────────────────────────────────

  describe('setWebhook', () => {
    it('should POST to /setWebhook with url, secret_token and allowed_updates', async () => {
      const mockResponse = { ok: true, description: 'Webhook was set' };
      fetchSpy.mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse),
      });

      const result = await api.setWebhook('https://example.com/webhook', 'my-secret');

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledWith(`${BASE_URL}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com/webhook',
          secret_token: 'my-secret',
          allowed_updates: ['message', 'edited_message', 'channel_post'],
          drop_pending_updates: false,
        }),
      });
      expect(result).toEqual(mockResponse);
    });
  });

  // ─── deleteWebhook ──────────────────────────────────────────────────────

  describe('deleteWebhook', () => {
    it('should POST to /deleteWebhook with drop_pending_updates', async () => {
      const mockResponse = { ok: true, description: 'Webhook was deleted' };
      fetchSpy.mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse),
      });

      const result = await api.deleteWebhook();

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledWith(`${BASE_URL}/deleteWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drop_pending_updates: false }),
      });
      expect(result).toEqual(mockResponse);
    });
  });

  // ─── getMe ──────────────────────────────────────────────────────────────

  describe('getMe', () => {
    it('should GET /getMe without a body', async () => {
      const mockResponse = {
        ok: true,
        result: { id: 999, username: 'TestBot', first_name: 'Test' },
      };
      fetchSpy.mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse),
      });

      const result = await api.getMe();

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledWith(`${BASE_URL}/getMe`, {
        method: 'GET',
      });
      expect(result).toEqual(mockResponse);
    });

    it('should return error response when token is invalid', async () => {
      const mockResponse = {
        ok: false,
        description: 'Unauthorized',
      };
      fetchSpy.mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse),
      });

      const result = await api.getMe();
      expect(result.ok).toBe(false);
    });
  });
});
