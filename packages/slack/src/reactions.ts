import type { ChannelConfig, NormalizedMessage } from '@opencode-channels/core';
import type { ChannelEngine } from '@opencode-channels/core';
import { SlackApi, type SlackReplyMessage } from './api.js';

// ─── Reaction event shape ───────────────────────────────────────────────────

interface ReactionEvent {
  type: 'reaction_added';
  user: string;
  reaction: string;
  item: {
    type: string;
    channel: string;
    ts: string;
  };
  item_user?: string;
  event_ts: string;
}

// ─── Reaction handler type ──────────────────────────────────────────────────

type ReactionHandler = (
  event: ReactionEvent,
  config: ChannelConfig,
  engine: ChannelEngine,
) => Promise<void>;

// ─── Reaction registry ─────────────────────────────────────────────────────

const reactionHandlers: Record<string, ReactionHandler> = {
  repeat: handleRetry,
  arrows_counterclockwise: handleRetry,
  memo: handleSaveToMemory,
  brain: handleSaveToMemory,
  scroll: handleSummarizeThread,
};

// ─── Public entry point ─────────────────────────────────────────────────────

export async function handleReactionAdded(
  event: ReactionEvent,
  config: ChannelConfig,
  engine: ChannelEngine,
): Promise<void> {
  const handler = reactionHandlers[event.reaction];
  if (!handler) return;
  if (event.item.type !== 'message') return;
  await handler(event, config, engine);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getThreadTs(event: ReactionEvent): string {
  return event.item.ts;
}

/**
 * Walk backwards from a bot message to find the preceding user message.
 * This is used by the retry handler to re-send the user's original prompt.
 */
async function findPrecedingUserMessage(
  api: SlackApi,
  channel: string,
  threadTs: string,
  botMessageTs: string,
  botUserId?: string,
): Promise<SlackReplyMessage | null> {
  const result = await api.conversationsReplies(channel, threadTs, 50);
  if (!result.ok || !result.messages) return null;

  const messages = result.messages;
  let botIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].ts === botMessageTs) {
      botIdx = i;
      break;
    }
  }

  if (botIdx <= 0) return null;

  for (let i = botIdx - 1; i >= 0; i--) {
    const msg = messages[i];
    const isBot = !!(msg.bot_id || msg.subtype === 'bot_message');
    if (!isBot && msg.text) return msg;
  }

  return null;
}

// ─── Retry handler (repeat / arrows_counterclockwise) ───────────────────────

async function handleRetry(
  event: ReactionEvent,
  config: ChannelConfig,
  engine: ChannelEngine,
): Promise<void> {
  const credentials = config.credentials as Record<string, unknown>;
  const botToken = credentials?.botToken as string;
  const botUserId = credentials?.botUserId as string | undefined;
  if (!botToken) return;

  const api = new SlackApi(botToken);
  const channel = event.item.channel;
  const threadTs = getThreadTs(event);

  const userMessage = await findPrecedingUserMessage(
    api, channel, threadTs, event.item.ts, botUserId,
  );

  if (!userMessage || !userMessage.text) {
    await api.postMessage({
      channel,
      text: ':x: Could not find the original message to retry.',
      thread_ts: threadTs,
    });
    return;
  }

  const normalized: NormalizedMessage = {
    externalId: userMessage.ts,
    channelType: 'slack',
    channelConfigId: config.id,
    chatType: 'group',
    content: userMessage.text,
    attachments: [],
    platformUser: {
      id: userMessage.user || event.user,
      name: userMessage.user || event.user,
    },
    threadId: threadTs,
    groupId: channel,
    raw: {
      event: { channel },
      _retryViaReaction: true,
    },
  };

  await engine.processMessage(normalized);
}

// ─── Save-to-memory handler (memo / brain) ──────────────────────────────────

async function handleSaveToMemory(
  event: ReactionEvent,
  config: ChannelConfig,
  engine: ChannelEngine,
): Promise<void> {
  const credentials = config.credentials as Record<string, unknown>;
  const botToken = credentials?.botToken as string;
  if (!botToken) return;

  const api = new SlackApi(botToken);
  const channel = event.item.channel;
  const threadTs = getThreadTs(event);

  const result = await api.conversationsReplies(channel, threadTs, 50);
  if (!result.ok || !result.messages) return;

  const reactedMessage = result.messages.find((m) => m.ts === event.item.ts);
  if (!reactedMessage?.text) return;

  const normalized: NormalizedMessage = {
    externalId: event.event_ts,
    channelType: 'slack',
    channelConfigId: config.id,
    chatType: 'group',
    content: `Save the following information to your memory for future reference:\n\n${reactedMessage.text}`,
    attachments: [],
    platformUser: {
      id: event.user,
      name: event.user,
    },
    threadId: threadTs,
    groupId: channel,
    raw: {
      event: { channel },
      _saveToMemory: true,
    },
  };

  await engine.processMessage(normalized);
}

// ─── Summarize-thread handler (scroll) ──────────────────────────────────────

async function handleSummarizeThread(
  event: ReactionEvent,
  config: ChannelConfig,
  engine: ChannelEngine,
): Promise<void> {
  const credentials = config.credentials as Record<string, unknown>;
  const botToken = credentials?.botToken as string;
  if (!botToken) return;

  const api = new SlackApi(botToken);
  const channel = event.item.channel;
  const threadTs = getThreadTs(event);

  const result = await api.conversationsReplies(channel, threadTs, 100);
  if (!result.ok || !result.messages || result.messages.length === 0) return;

  const threadText = result.messages
    .filter((m) => m.text)
    .map((m) => {
      const sender = m.bot_id || m.subtype === 'bot_message' ? 'Bot' : (m.user || 'Unknown');
      return `[${sender}]: ${m.text}`;
    })
    .join('\n');

  if (!threadText) return;

  const normalized: NormalizedMessage = {
    externalId: event.event_ts,
    channelType: 'slack',
    channelConfigId: config.id,
    chatType: 'group',
    content: `Summarize this Slack thread concisely. Highlight key points, decisions, and action items:\n\n${threadText}`,
    attachments: [],
    platformUser: {
      id: event.user,
      name: event.user,
    },
    threadId: threadTs,
    groupId: channel,
    raw: {
      event: { channel },
      _summarizeThread: true,
    },
  };

  await engine.processMessage(normalized);
}
