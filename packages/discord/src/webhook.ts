/**
 * Discord Interactions Endpoint handler.
 *
 * Discord sends all slash-command and component interactions as HTTP POSTs
 * to a single "Interactions Endpoint URL". Each request carries an Ed25519
 * signature that MUST be verified before processing.
 *
 * Interaction types:
 *   1 — PING          → respond with { type: 1 }
 *   2 — APPLICATION_COMMAND → slash commands
 *   3 — MESSAGE_COMPONENT  → button clicks, select menus
 *   4 — APPLICATION_COMMAND_AUTOCOMPLETE
 *   5 — MODAL_SUBMIT
 */

import type { Context } from 'hono';
import type {
  ChannelConfig,
  NormalizedMessage,
  ChatType,
} from '@opencode-channels/core';
import type { ChannelEngine } from '@opencode-channels/core';
import { replyPermissionRequest } from '@opencode-channels/core';
import type { DiscordInteraction } from './api.js';
import { DiscordApi } from './api.js';

// ─── Interaction type constants ─────────────────────────────────────────────

const INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

const INTERACTION_RESPONSE_TYPE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
} as const;

// Discord channel types
const CHANNEL_TYPE = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_VOICE: 2,
  GROUP_DM: 3,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  GUILD_STORE: 6,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  GUILD_STAGE_VOICE: 13,
  GUILD_DIRECTORY: 14,
  GUILD_FORUM: 15,
} as const;

// ─── Ed25519 signature verification ────────────────────────────────────────

/**
 * Verify the Ed25519 signature Discord sends with every interaction request.
 * Uses the Web Crypto API (SubtleCrypto) — works in Node 18+, Bun, Deno,
 * Cloudflare Workers, and any other runtime with globalThis.crypto.
 */
export async function verifyDiscordSignature(
  publicKey: string,
  signature: string,
  timestamp: string,
  body: string,
): Promise<boolean> {
  try {
    // Convert hex strings to Uint8Array
    const publicKeyBytes = hexToUint8Array(publicKey);
    const signatureBytes = hexToUint8Array(signature);

    // The message to verify is: timestamp + body
    const encoder = new TextEncoder();
    const message = encoder.encode(timestamp + body);

    // Import the Ed25519 public key
    const key = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );

    // Verify the signature
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      signatureBytes,
      message,
    );
  } catch (err) {
    console.error('[DISCORD] Signature verification error:', err);
    return false;
  }
}

function hexToUint8Array(hex: string): Uint8Array {
  const len = hex.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ─── Chat type detection ────────────────────────────────────────────────────

function detectChatType(interaction: DiscordInteraction): ChatType {
  // If there's no guild_id, it's a DM
  if (!interaction.guild_id) {
    return 'dm';
  }

  const channelType = interaction.channel?.type;
  if (channelType === CHANNEL_TYPE.DM || channelType === CHANNEL_TYPE.GROUP_DM) {
    return 'dm';
  }

  return 'group';
}

// ─── Resolve the interacting user ───────────────────────────────────────────

function resolveUser(interaction: DiscordInteraction): { id: string; name: string; avatar?: string } {
  // In guild contexts, the user is inside `member.user`
  const user = interaction.member?.user ?? interaction.user;
  if (!user) {
    return { id: 'unknown', name: 'Unknown' };
  }

  const displayName = user.global_name ?? user.username;
  const avatar = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
    : undefined;

  return { id: user.id, name: displayName, avatar };
}

// ─── Extract slash command text ─────────────────────────────────────────────

function extractCommandText(interaction: DiscordInteraction): string {
  const data = interaction.data;
  if (!data) return '';

  const parts: string[] = [];

  // Recursively collect option values
  function collectOptions(options?: DiscordInteraction['data']): void {
    if (!options) return;
    const opts = (options as { options?: Array<{ name: string; value?: unknown; options?: unknown[] }> }).options;
    if (!opts) return;

    for (const opt of opts) {
      if (opt.value !== undefined) {
        parts.push(String(opt.value));
      }
      if (opt.options) {
        collectOptions(opt as unknown as DiscordInteraction['data']);
      }
    }
  }

  collectOptions(data);

  // If no option values, fall back to the command name itself
  if (parts.length === 0 && data.name) {
    return data.name;
  }

  return parts.join(' ');
}

// ─── Handle slash command ───────────────────────────────────────────────────

async function handleApplicationCommand(
  interaction: DiscordInteraction,
  engine: ChannelEngine,
  config: ChannelConfig,
): Promise<void> {
  const credentials = config.credentials as Record<string, unknown>;
  const botToken = credentials?.botToken as string;
  if (!botToken) {
    console.error('[DISCORD] No bot token in credentials');
    return;
  }

  const api = new DiscordApi(botToken);
  const commandName = interaction.data?.name ?? '';
  const commandText = extractCommandText(interaction);
  const user = resolveUser(interaction);
  const chatType = detectChatType(interaction);

  // Handle the /reset command
  if (commandName === 'reset') {
    const message: NormalizedMessage = {
      externalId: interaction.id,
      channelType: 'discord',
      channelConfigId: config.id,
      chatType,
      content: '',
      attachments: [],
      platformUser: user,
      threadId: undefined,
      groupId: interaction.channel_id,
      raw: { _discordInteraction: true, interaction },
    };

    const strategy = config.sessionStrategy || 'per-user';
    await engine.resetSession(config.id, 'discord', strategy, message);

    await api.createInteractionResponse(interaction.id, interaction.token, {
      type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: 'Session reset. Starting fresh!',
        flags: 64, // ephemeral
      },
    });
    return;
  }

  // For all other commands: defer the response, then process async
  await api.createInteractionResponse(interaction.id, interaction.token, {
    type: INTERACTION_RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  });

  // Build the normalized message
  const content = commandText || commandName;
  const normalized: NormalizedMessage = {
    externalId: interaction.id,
    channelType: 'discord',
    channelConfigId: config.id,
    chatType,
    content,
    attachments: [],
    platformUser: user,
    threadId: undefined,
    groupId: interaction.guild_id ? interaction.channel_id : undefined,
    isMention: true, // Slash commands are always directed at the bot
    raw: {
      _discordInteraction: true,
      interaction,
      channelId: interaction.channel_id,
    },
  };

  // Process the message — the adapter's sendResponse will edit the deferred response
  await engine.processMessage(normalized);
}

// ─── Handle message component (buttons, selects) ────────────────────────────

async function handleMessageComponent(
  interaction: DiscordInteraction,
  config: ChannelConfig,
): Promise<void> {
  const credentials = config.credentials as Record<string, unknown>;
  const botToken = credentials?.botToken as string;
  if (!botToken) return;

  const api = new DiscordApi(botToken);
  const customId = interaction.data?.custom_id ?? '';

  // Permission approval/rejection buttons
  if (customId.startsWith('perm_approve_') || customId.startsWith('perm_reject_')) {
    const approved = customId.startsWith('perm_approve_');
    const permissionId = approved
      ? customId.slice('perm_approve_'.length)
      : customId.slice('perm_reject_'.length);

    if (!permissionId) {
      console.warn('[DISCORD] Permission component missing permissionId');
      return;
    }

    const found = replyPermissionRequest(permissionId, approved);
    const user = resolveUser(interaction);
    const statusText = approved ? '**Approved**' : '**Rejected**';
    const expiredNote = found ? '' : ' (request expired)';

    // Update the original message to show the result and remove buttons
    await api.createInteractionResponse(interaction.id, interaction.token, {
      type: INTERACTION_RESPONSE_TYPE.UPDATE_MESSAGE,
      data: {
        content: `${statusText} by ${user.name}${expiredNote}`,
        components: [], // Remove the buttons
      },
    });
    return;
  }

  // Unknown component interaction — acknowledge silently
  await api.createInteractionResponse(interaction.id, interaction.token, {
    type: INTERACTION_RESPONSE_TYPE.DEFERRED_UPDATE_MESSAGE,
  });
}

// ─── Main interaction handler ───────────────────────────────────────────────

/**
 * Handle an incoming Discord interaction HTTP POST.
 *
 * @param c      - Hono request context
 * @param engine - Channel engine for message processing
 * @param config - The resolved ChannelConfig for this Discord application
 */
export async function handleDiscordInteraction(
  c: Context,
  engine: ChannelEngine,
  config: ChannelConfig,
): Promise<Response> {
  const rawBody = await c.req.text();

  // 1. Verify Ed25519 signature
  const credentials = config.credentials as Record<string, unknown>;
  const publicKey = credentials?.publicKey as string | undefined;

  if (publicKey) {
    const signature = c.req.header('X-Signature-Ed25519') || '';
    const timestamp = c.req.header('X-Signature-Timestamp') || '';

    if (!signature || !timestamp) {
      return c.json({ error: 'Missing signature headers' }, 401);
    }

    const valid = await verifyDiscordSignature(publicKey, signature, timestamp, rawBody);
    if (!valid) {
      return c.json({ error: 'Invalid request signature' }, 401);
    }
  }

  // 2. Parse the interaction
  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(rawBody) as DiscordInteraction;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // 3. Handle PING (type 1) — used by Discord to verify the endpoint
  if (interaction.type === INTERACTION_TYPE.PING) {
    return c.json({ type: INTERACTION_RESPONSE_TYPE.PONG });
  }

  // 4. Handle APPLICATION_COMMAND (type 2) — slash commands
  if (interaction.type === INTERACTION_TYPE.APPLICATION_COMMAND) {
    // Process async so we can respond quickly
    handleApplicationCommand(interaction, engine, config).catch((err) => {
      console.error('[DISCORD] Application command handler failed:', err);
    });
    // Return 202 — the deferred response is handled by handleApplicationCommand
    return c.json({ ok: true }, 202);
  }

  // 5. Handle MESSAGE_COMPONENT (type 3) — button clicks, select menus
  if (interaction.type === INTERACTION_TYPE.MESSAGE_COMPONENT) {
    handleMessageComponent(interaction, config).catch((err) => {
      console.error('[DISCORD] Message component handler failed:', err);
    });
    return c.json({ ok: true }, 202);
  }

  // 6. Unhandled interaction type — acknowledge
  console.warn(`[DISCORD] Unhandled interaction type: ${interaction.type}`);
  return c.json({ ok: true });
}

// ─── Gateway event handler (webhook-forwarded) ──────────────────────────────

/**
 * Handle Discord gateway events that have been forwarded via webhook.
 *
 * When Discord's gateway sends MESSAGE_CREATE events, an external forwarder
 * (e.g. a lightweight gateway bridge) can POST them to this endpoint.
 * This allows the adapter to process regular channel messages without
 * maintaining a persistent gateway connection.
 */
export async function handleDiscordEvent(
  c: Context,
  engine: ChannelEngine,
  config: ChannelConfig,
): Promise<Response> {
  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const eventType = payload.t as string | undefined;

  if (eventType !== 'MESSAGE_CREATE') {
    return c.json({ ok: true });
  }

  const data = payload.d as Record<string, unknown> | undefined;
  if (!data) {
    return c.json({ ok: true });
  }

  const author = data.author as Record<string, unknown> | undefined;
  if (!author) return c.json({ ok: true });

  // Ignore bot messages
  if (author.bot === true) {
    return c.json({ ok: true });
  }

  const content = (data.content as string) || '';
  if (!content) {
    return c.json({ ok: true });
  }

  const credentials = config.credentials as Record<string, unknown>;
  const botUserId = credentials?.botUserId as string | undefined;

  // In guild channels, check if the bot was mentioned
  const guildId = data.guild_id as string | undefined;
  const mentions = (data.mentions as Array<{ id: string }>) || [];
  const isMention = botUserId ? mentions.some((m) => m.id === botUserId) : false;

  // Strip bot mention from content
  let cleanContent = content;
  if (botUserId) {
    cleanContent = cleanContent.replace(new RegExp(`<@!?${botUserId}>`, 'g'), '').trim();
  }

  // Determine chat type
  const channelType = data.type as number | undefined;
  let chatType: ChatType = 'group';
  if (!guildId || channelType === CHANNEL_TYPE.DM) {
    chatType = 'dm';
  }

  // In group channels, only respond to mentions (unless configured otherwise)
  if (chatType === 'group') {
    const platformConfig = config.platformConfig as Record<string, unknown> | null;
    const requireMention = (platformConfig?.requireMention as boolean) !== false;
    if (requireMention && !isMention) {
      return c.json({ ok: true });
    }
  }

  const messageId = data.id as string;
  const channelId = data.channel_id as string;

  // Resolve thread context
  const messageReference = data.message_reference as Record<string, unknown> | undefined;
  const threadId = messageReference?.message_id as string | undefined;

  const normalized: NormalizedMessage = {
    externalId: messageId,
    channelType: 'discord',
    channelConfigId: config.id,
    chatType,
    content: cleanContent,
    attachments: [],
    platformUser: {
      id: author.id as string,
      name: (author.global_name as string) ?? (author.username as string) ?? 'Unknown',
      avatar: author.avatar
        ? `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png`
        : undefined,
    },
    threadId,
    groupId: guildId ? channelId : undefined,
    isMention,
    raw: {
      _discordEvent: true,
      channelId,
      guildId,
      messageId,
      data,
    },
  };

  // Process async
  engine.processMessage(normalized).catch((err) => {
    console.error('[DISCORD] Failed to process message event:', err);
  });

  return c.json({ ok: true });
}
