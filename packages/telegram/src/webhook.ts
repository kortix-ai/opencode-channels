import type { Context } from 'hono';
import type {
  ChannelConfig,
  NormalizedMessage,
  ChatType,
  SessionStrategy,
  ChannelEngine,
} from '@opencode-channels/core';
import { TelegramApi } from './api';

// ─── Telegram types ─────────────────────────────────────────────────────────

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: {
    id: number;
    is_bot: boolean;
    first_name: string;
    last_name?: string;
    username?: string;
  };
  chat: {
    id: number;
    type: 'private' | 'group' | 'supergroup' | 'channel';
    title?: string;
    username?: string;
  };
  date: number;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
  message_thread_id?: number;
  entities?: Array<{
    type: string;
    offset: number;
    length: number;
    user?: { id: number; username?: string };
  }>;
}

// ─── Webhook handler ────────────────────────────────────────────────────────

/**
 * Handle an inbound Telegram webhook update.
 *
 * The `config` parameter is resolved by the adapter before calling this
 * function, so there is no database lookup here.
 */
export async function handleTelegramWebhook(
  c: Context,
  engine: ChannelEngine,
  config: ChannelConfig,
): Promise<Response> {
  // ── Verify webhook secret ─────────────────────────────────────────────
  const secretToken = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  const expectedSecret = config.credentials?.webhookSecret as string | undefined;

  if (expectedSecret && secretToken !== expectedSecret) {
    return c.json({ error: 'Invalid webhook secret token' }, 403);
  }

  // ── Parse update ──────────────────────────────────────────────────────
  const update = (await c.req.json()) as TelegramUpdate;

  const telegramMsg = update.message || update.edited_message || update.channel_post;
  if (!telegramMsg) {
    return c.json({ ok: true });
  }

  // Ignore messages from bots
  if (telegramMsg.from?.is_bot) {
    return c.json({ ok: true });
  }

  const content = telegramMsg.text || telegramMsg.caption || '';
  if (!content) {
    return c.json({ ok: true });
  }

  const chatType = detectChatType(telegramMsg);
  const botUsername = config.credentials?.botUsername as string | undefined;

  // ── /new command — reset session ──────────────────────────────────────
  if (content.trim() === '/new' || content.trim() === `/new@${botUsername}`) {
    const botToken = config.credentials?.botToken as string;
    if (botToken) {
      const strategy = config.sessionStrategy as SessionStrategy;
      const tempMessage: NormalizedMessage = {
        externalId: String(telegramMsg.message_id),
        channelType: 'telegram',
        channelConfigId: config.id,
        chatType,
        content: '',
        attachments: [],
        platformUser: {
          id: String(telegramMsg.from?.id ?? telegramMsg.chat.id),
          name: '',
        },
        threadId: telegramMsg.message_thread_id
          ? String(telegramMsg.message_thread_id)
          : undefined,
        groupId: chatType !== 'dm' ? String(telegramMsg.chat.id) : undefined,
      };
      await engine.resetSession(config.id, config.channelType, strategy, tempMessage);
      const api = new TelegramApi(botToken);
      await api.sendMessage({
        chat_id: telegramMsg.chat.id,
        text: 'Session reset — next message starts a fresh conversation.',
      });
    }
    return c.json({ ok: true });
  }

  // ── /help command ─────────────────────────────────────────────────────
  if (content.trim() === '/help' || content.trim() === `/help@${botUsername}`) {
    const botToken = config.credentials?.botToken as string;
    if (botToken) {
      const api = new TelegramApi(botToken);
      await api.sendMessage({
        chat_id: telegramMsg.chat.id,
        text: 'Available commands:\n/new — Start a fresh conversation\n/help — Show this message',
      });
    }
    return c.json({ ok: true });
  }

  // ── Group mention filtering ───────────────────────────────────────────
  if (chatType === 'group') {
    const botId = config.credentials?.botId as number | undefined;
    const isMention = detectMention(telegramMsg, botId, botUsername);

    const platformConfig = config.platformConfig as Record<string, unknown> | null;
    const groupConfig = (platformConfig?.groups as Record<string, unknown>) ?? {};
    const requireMention = groupConfig.requireMention !== false;

    if (requireMention && !isMention) {
      return c.json({ ok: true });
    }
  }

  // ── Build normalized message ──────────────────────────────────────────
  const normalized: NormalizedMessage = {
    externalId: String(telegramMsg.message_id),
    channelType: 'telegram',
    channelConfigId: config.id,
    chatType,
    content: stripBotMention(content, botUsername),
    attachments: [],
    platformUser: {
      id: String(telegramMsg.from?.id ?? telegramMsg.chat.id),
      name: telegramMsg.from
        ? [telegramMsg.from.first_name, telegramMsg.from.last_name].filter(Boolean).join(' ')
        : telegramMsg.chat.title || 'Unknown',
      avatar: undefined,
    },
    threadId: telegramMsg.message_thread_id
      ? String(telegramMsg.message_thread_id)
      : undefined,
    groupId: chatType !== 'dm' ? String(telegramMsg.chat.id) : undefined,
    isMention: detectMention(
      telegramMsg,
      config.credentials?.botId as number | undefined,
      botUsername,
    ),
    raw: update,
  };

  engine.processMessage(normalized).catch((err) => {
    console.error(`[TELEGRAM] Failed to process message:`, err);
  });

  return c.json({ ok: true });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function detectChatType(msg: TelegramMessage): ChatType {
  switch (msg.chat.type) {
    case 'private':
      return 'dm';
    case 'channel':
      return 'channel';
    case 'group':
    case 'supergroup':
      return 'group';
    default:
      return 'dm';
  }
}

export function detectMention(
  msg: TelegramMessage,
  botId?: number,
  botUsername?: string,
): boolean {
  if (!msg.entities) return false;

  for (const entity of msg.entities) {
    if (entity.type === 'mention' && botUsername) {
      const mentionText = (msg.text || '').slice(entity.offset, entity.offset + entity.length);
      if (mentionText.toLowerCase() === `@${botUsername.toLowerCase()}`) {
        return true;
      }
    }
    if (entity.type === 'text_mention' && entity.user?.id === botId) {
      return true;
    }
  }

  if (msg.reply_to_message?.from?.id === botId) {
    return true;
  }

  return false;
}

export function stripBotMention(text: string, botUsername?: string): string {
  if (!botUsername) return text;
  return text.replace(new RegExp(`@${botUsername}\\b`, 'gi'), '').trim();
}
