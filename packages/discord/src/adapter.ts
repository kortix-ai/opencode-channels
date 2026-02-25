/**
 * Discord channel adapter.
 *
 * Uses the Discord Interactions API (HTTP webhook-based) — no gateway
 * websocket connection required. Slash commands and message components
 * are handled via the interactions endpoint; regular channel messages
 * can optionally be forwarded via a webhook bridge.
 */

import type { Hono } from 'hono';
import type {
  ChannelCapabilities,
  ChannelConfig,
  NormalizedMessage,
  AgentResponse,
  PermissionRequest,
  FileOutput,
} from '@opencode-channels/core';
import { BaseAdapter, type ChannelEngine } from '@opencode-channels/core';
import { splitMessage } from '@opencode-channels/core';
import { DiscordApi, type DiscordEmbed, type DiscordComponent } from './api.js';
import { handleDiscordInteraction, handleDiscordEvent } from './webhook.js';

// ─── Adapter options ────────────────────────────────────────────────────────

export interface DiscordAdapterOptions {
  /**
   * Resolve a ChannelConfig by Discord application_id.
   * Called on every incoming interaction to look up the right config.
   */
  getConfigByApplicationId: (applicationId: string) => ChannelConfig | undefined;

  /**
   * Fallback: resolve config by guild_id (for webhook-forwarded events
   * that don't carry an application_id).
   */
  getConfigByGuildId?: (guildId: string) => ChannelConfig | undefined;
}

// ─── Discord embed color ────────────────────────────────────────────────────

/** Purple accent matching Discord's branding */
const EMBED_COLOR = 0x5865f2;

/** Error embed color */
const EMBED_COLOR_ERROR = 0xed4245;

// ─── DiscordAdapter ─────────────────────────────────────────────────────────

export class DiscordAdapter extends BaseAdapter {
  readonly type = 'discord' as const;
  readonly name = 'Discord';
  readonly capabilities: ChannelCapabilities = {
    textChunkLimit: 2000,
    supportsRichText: true,
    supportsEditing: true,
    supportsTypingIndicator: false,
    supportsAttachments: true,
    connectionType: 'webhook',
  };

  private readonly options: DiscordAdapterOptions;

  constructor(options: DiscordAdapterOptions) {
    super();
    this.options = options;
  }

  // ── Route registration ──────────────────────────────────────────────────

  registerRoutes(router: Hono, engine: ChannelEngine): void {
    const { getConfigByApplicationId, getConfigByGuildId } = this.options;

    // Discord interactions endpoint (slash commands, buttons, modals)
    router.post('/discord/interactions', async (c) => {
      // We need to peek at the body to extract application_id for config lookup,
      // but we also need the raw body for signature verification.
      const rawBody = await c.req.text();
      let parsed: { application_id?: string; guild_id?: string };
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return c.json({ error: 'Invalid JSON' }, 400);
      }

      // Resolve config from application_id
      let config: ChannelConfig | undefined;
      if (parsed.application_id) {
        config = getConfigByApplicationId(parsed.application_id);
      }
      if (!config && parsed.guild_id && getConfigByGuildId) {
        config = getConfigByGuildId(parsed.guild_id);
      }

      if (!config) {
        // For PING interactions (endpoint verification), we still need to respond
        // even without a config. Discord sends PINGs during setup.
        const interaction = parsed as { type?: number };
        if (interaction.type === 1) {
          return c.json({ type: 1 });
        }
        console.warn(`[DISCORD] No config for application_id=${parsed.application_id}`);
        return c.json({ error: 'Unknown application' }, 404);
      }

      // Reconstruct the request context so handleDiscordInteraction can read the body
      // We override req.text() since we already consumed it
      const originalText = c.req.text;
      c.req.text = () => Promise.resolve(rawBody);

      try {
        return await handleDiscordInteraction(c, engine, config);
      } finally {
        c.req.text = originalText;
      }
    });

    // Webhook-forwarded gateway events (MESSAGE_CREATE, etc.)
    router.post('/discord/events', async (c) => {
      const rawBody = await c.req.text();
      let parsed: { d?: { guild_id?: string }; application_id?: string };
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return c.json({ error: 'Invalid JSON' }, 400);
      }

      const guildId = parsed.d?.guild_id;
      let config: ChannelConfig | undefined;

      if (parsed.application_id) {
        config = getConfigByApplicationId(parsed.application_id);
      }
      if (!config && guildId && getConfigByGuildId) {
        config = getConfigByGuildId(guildId);
      }

      if (!config) {
        console.warn(`[DISCORD] No config for guild_id=${guildId}`);
        return c.json({ ok: true });
      }

      const originalText = c.req.text;
      c.req.text = () => Promise.resolve(rawBody);

      try {
        return await handleDiscordEvent(c, engine, config);
      } finally {
        c.req.text = originalText;
      }
    });
  }

  // ── Send response ───────────────────────────────────────────────────────

  async sendResponse(
    channelConfig: ChannelConfig,
    message: NormalizedMessage,
    response: AgentResponse,
  ): Promise<void> {
    const botToken = this.getBotToken(channelConfig);
    if (!botToken) {
      console.error('[DISCORD] No bot token in credentials');
      return;
    }

    const api = new DiscordApi(botToken);
    const rawPayload = message.raw as Record<string, unknown> | undefined;

    // Build session URL if configured
    const sessionUrl = this.buildSessionUrl(channelConfig, response.sessionId);

    // ── Interaction-based response (slash commands) ──────────────────────
    if (rawPayload?._discordInteraction) {
      const interaction = rawPayload.interaction as {
        id: string;
        token: string;
        application_id: string;
      };

      if (interaction?.token && interaction?.application_id) {
        await this.sendInteractionFollowup(
          api,
          interaction.application_id,
          interaction.token,
          response.content,
          sessionUrl,
        );
        return;
      }
    }

    // ── Regular channel message response ────────────────────────────────
    const channelId = (rawPayload?.channelId as string) || message.groupId;
    if (!channelId) {
      console.error('[DISCORD] Cannot determine channel from message');
      return;
    }

    await this.sendChannelMessage(
      api,
      channelId,
      message.externalId,
      response.content,
      sessionUrl,
    );
  }

  // ── Send interaction follow-up (edit deferred response) ─────────────────

  private async sendInteractionFollowup(
    api: DiscordApi,
    applicationId: string,
    interactionToken: string,
    content: string,
    sessionUrl?: string,
  ): Promise<void> {
    const embeds = this.buildResponseEmbeds(content, sessionUrl);

    // Discord interaction follow-up messages have a 2000 char content limit
    // Use embeds for content (4096 char description limit per embed)
    if (content.length <= 2000 && !sessionUrl) {
      try {
        await api.editOriginalInteractionResponse(applicationId, interactionToken, {
          content,
        });
        return;
      } catch (err) {
        console.error('[DISCORD] Failed to edit interaction response:', err);
      }
    }

    // For longer content, use embeds
    try {
      await api.editOriginalInteractionResponse(applicationId, interactionToken, {
        content: undefined,
        embeds: embeds.slice(0, 10), // Discord allows max 10 embeds
      });
    } catch (err) {
      console.error('[DISCORD] Failed to edit interaction response with embeds:', err);

      // Fallback: send chunked plain text
      try {
        const chunks = splitMessage(content, this.capabilities.textChunkLimit);
        await api.editOriginalInteractionResponse(applicationId, interactionToken, {
          content: chunks[0] || content.slice(0, 2000),
        });
      } catch (fallbackErr) {
        console.error('[DISCORD] Fallback plain text response also failed:', fallbackErr);
      }
    }
  }

  // ── Send a regular channel message ──────────────────────────────────────

  private async sendChannelMessage(
    api: DiscordApi,
    channelId: string,
    replyToMessageId: string,
    content: string,
    sessionUrl?: string,
  ): Promise<void> {
    const embeds = this.buildResponseEmbeds(content, sessionUrl);

    // Short messages go as plain text with a reply reference
    if (content.length <= 2000 && !sessionUrl) {
      try {
        await api.createMessage(channelId, {
          content,
          message_reference: { message_id: replyToMessageId },
        });
        return;
      } catch (err) {
        console.error('[DISCORD] Failed to send plain text reply:', err);
      }
    }

    // Longer content goes in embeds
    if (embeds.length <= 10) {
      try {
        await api.createMessage(channelId, {
          embeds,
          message_reference: { message_id: replyToMessageId },
        });
        return;
      } catch (err) {
        console.error('[DISCORD] Failed to send embed reply:', err);
      }
    }

    // Fallback: split into multiple messages
    const chunks = splitMessage(content, this.capabilities.textChunkLimit);
    for (let i = 0; i < chunks.length; i++) {
      try {
        await api.createMessage(channelId, {
          content: chunks[i],
          ...(i === 0 ? { message_reference: { message_id: replyToMessageId } } : {}),
        });
      } catch (err) {
        console.error(`[DISCORD] Failed to send chunk ${i + 1}/${chunks.length}:`, err);
      }
    }
  }

  // ── Build embeds from response content ──────────────────────────────────

  private buildResponseEmbeds(content: string, sessionUrl?: string): DiscordEmbed[] {
    const embeds: DiscordEmbed[] = [];

    // Discord embed description limit is 4096 characters
    const EMBED_DESC_LIMIT = 4096;

    if (content.length <= EMBED_DESC_LIMIT) {
      const embed: DiscordEmbed = {
        description: content,
        color: EMBED_COLOR,
      };
      if (sessionUrl) {
        embed.footer = { text: 'View full session' };
        embed.url = sessionUrl;
        embed.title = 'Response';
      }
      embeds.push(embed);
    } else {
      // Split content across multiple embeds
      const chunks = splitMessage(content, EMBED_DESC_LIMIT);
      for (let i = 0; i < chunks.length; i++) {
        const embed: DiscordEmbed = {
          description: chunks[i],
          color: EMBED_COLOR,
        };
        // Add session URL footer to the last embed
        if (i === chunks.length - 1 && sessionUrl) {
          embed.footer = { text: `View full session: ${sessionUrl}` };
        }
        embeds.push(embed);
      }
    }

    return embeds;
  }

  // ── Typing indicator ────────────────────────────────────────────────────

  override async sendTypingIndicator(
    channelConfig: ChannelConfig,
    message: NormalizedMessage,
  ): Promise<void> {
    const botToken = this.getBotToken(channelConfig);
    if (!botToken) return;

    const rawPayload = message.raw as Record<string, unknown> | undefined;

    // For interaction-based messages, the deferred response acts as a typing indicator
    if (rawPayload?._discordInteraction) return;

    // For regular messages, add a reaction to indicate processing
    const channelId = (rawPayload?.channelId as string) || message.groupId;
    if (!channelId) return;

    const api = new DiscordApi(botToken);
    try {
      await api.createReaction(channelId, message.externalId, '\u23F3'); // hourglass
    } catch {
      // Reaction may fail if bot doesn't have permissions — non-critical
    }
  }

  override async removeTypingIndicator(
    channelConfig: ChannelConfig,
    message: NormalizedMessage,
  ): Promise<void> {
    const botToken = this.getBotToken(channelConfig);
    if (!botToken) return;

    const rawPayload = message.raw as Record<string, unknown> | undefined;
    if (rawPayload?._discordInteraction) return;

    const channelId = (rawPayload?.channelId as string) || message.groupId;
    if (!channelId) return;

    const api = new DiscordApi(botToken);
    try {
      await api.deleteOwnReaction(channelId, message.externalId, '\u23F3');
    } catch {
      // Non-critical
    }
  }

  // ── Permission request ──────────────────────────────────────────────────

  override async sendPermissionRequest(
    channelConfig: ChannelConfig,
    message: NormalizedMessage,
    permission: PermissionRequest,
  ): Promise<void> {
    const botToken = this.getBotToken(channelConfig);
    if (!botToken) return;

    const rawPayload = message.raw as Record<string, unknown> | undefined;
    const api = new DiscordApi(botToken);

    // Build the permission request message with buttons
    const embed: DiscordEmbed = {
      title: '\uD83D\uDD12 Permission Request',
      description: `**Tool:** \`${permission.tool}\`\n${permission.description || ''}`,
      color: 0xfee75c, // Yellow/warning
    };

    const components: DiscordComponent[] = [
      {
        type: 1, // ActionRow
        components: [
          {
            type: 2, // Button
            style: 3, // Success (green)
            label: 'Approve',
            custom_id: `perm_approve_${permission.id}`,
          },
          {
            type: 2, // Button
            style: 4, // Danger (red)
            label: 'Reject',
            custom_id: `perm_reject_${permission.id}`,
          },
        ],
      },
    ];

    // For interaction-based messages, send as a follow-up
    if (rawPayload?._discordInteraction) {
      const interaction = rawPayload.interaction as {
        application_id: string;
        token: string;
      };
      if (interaction?.application_id && interaction?.token) {
        try {
          // Use the webhook follow-up endpoint to send an additional message
          const url = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`;
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              embeds: [embed],
              components,
            }),
          });
        } catch (err) {
          console.error('[DISCORD] Failed to send permission request via webhook:', err);
        }
        return;
      }
    }

    // For regular messages, send in the channel
    const channelId = (rawPayload?.channelId as string) || message.groupId;
    if (!channelId) return;

    try {
      await api.createMessage(channelId, {
        embeds: [embed],
        components,
        message_reference: { message_id: message.externalId },
      });
    } catch (err) {
      console.error('[DISCORD] Failed to send permission request:', err);
    }
  }

  // ── File sending ────────────────────────────────────────────────────────

  override async sendFiles(
    channelConfig: ChannelConfig,
    message: NormalizedMessage,
    files: FileOutput[],
  ): Promise<void> {
    const botToken = this.getBotToken(channelConfig);
    if (!botToken) {
      console.warn('[DISCORD] sendFiles: no bot token, skipping');
      return;
    }

    const rawPayload = message.raw as Record<string, unknown> | undefined;
    const channelId = (rawPayload?.channelId as string) || message.groupId;
    if (!channelId) {
      console.warn('[DISCORD] sendFiles: no channel in payload, skipping');
      return;
    }

    const api = new DiscordApi(botToken);

    console.log(`[DISCORD] sendFiles: ${files.length} file(s) to channel=${channelId}`);

    // Discord allows up to 10 files per message. Batch them.
    const BATCH_SIZE = 10;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const fileBuffers: Array<{ name: string; data: Buffer }> = [];

      for (const file of batch) {
        try {
          let fileBuffer: Buffer;
          if (file.content) {
            fileBuffer = file.content;
          } else {
            console.log(`[DISCORD] Downloading file from URL: ${file.url.slice(0, 120)}`);
            const fileRes = await fetch(file.url);
            if (!fileRes.ok) {
              console.error(`[DISCORD] Failed to download file ${file.name}: ${fileRes.status}`);
              continue;
            }
            fileBuffer = Buffer.from(await fileRes.arrayBuffer());
          }

          fileBuffers.push({ name: file.name, data: fileBuffer });
        } catch (err) {
          console.error(`[DISCORD] Failed to prepare file ${file.name}:`, err);
        }
      }

      if (fileBuffers.length > 0) {
        try {
          await api.createMessageWithFiles(channelId, {
            files: fileBuffers,
          });
          console.log(`[DISCORD] Uploaded ${fileBuffers.length} file(s)`);
        } catch (err) {
          console.error('[DISCORD] Failed to upload files:', err);
        }
      }
    }
  }

  // ── Unlinked message ────────────────────────────────────────────────────

  async sendUnlinkedMessage(
    channelConfig: ChannelConfig,
    message: NormalizedMessage,
  ): Promise<void> {
    const botToken = this.getBotToken(channelConfig);
    if (!botToken) return;

    const rawPayload = message.raw as Record<string, unknown> | undefined;
    const api = new DiscordApi(botToken);

    const embed: DiscordEmbed = {
      title: 'No instance linked',
      description:
        "This Discord channel isn't connected to an instance yet. Link one to start chatting.",
      color: EMBED_COLOR_ERROR,
    };

    // Interaction-based response
    if (rawPayload?._discordInteraction) {
      const interaction = rawPayload.interaction as {
        id: string;
        token: string;
      };
      if (interaction) {
        await api.createInteractionResponse(interaction.id, interaction.token, {
          type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
          data: {
            embeds: [embed],
            flags: 64, // ephemeral
          },
        });
      }
      return;
    }

    const channelId = (rawPayload?.channelId as string) || message.groupId;
    if (!channelId) return;

    await api.createMessage(channelId, {
      embeds: [embed],
      message_reference: { message_id: message.externalId },
    });
  }

  // ── Credential validation ───────────────────────────────────────────────

  override async validateCredentials(
    credentials: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const botToken = credentials.botToken as string;
    if (!botToken) {
      return { valid: false, error: 'botToken is required' };
    }

    const publicKey = credentials.publicKey as string;
    if (!publicKey) {
      return { valid: false, error: 'publicKey is required for interaction signature verification' };
    }

    // Validate the public key format (should be a 64-char hex string = 32 bytes)
    if (!/^[0-9a-fA-F]{64}$/.test(publicKey)) {
      return { valid: false, error: 'publicKey must be a 64-character hex string' };
    }

    try {
      const api = new DiscordApi(botToken);
      const user = await api.getCurrentUser();

      if (!user.id) {
        return { valid: false, error: 'Invalid bot token: could not fetch bot user' };
      }

      // Store the bot user ID for later use (e.g. filtering self-messages)
      credentials.botUserId = user.id;
      credentials.botUsername = user.username;

      return { valid: true };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to validate Discord credentials';
      return { valid: false, error: message };
    }
  }

  // ── Channel lifecycle ───────────────────────────────────────────────────

  override async onChannelRemoved(channelConfig: ChannelConfig): Promise<void> {
    console.log(`[DISCORD] Channel ${channelConfig.id} removed.`);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Build a session URL from config metadata, or return undefined if not configured.
   */
  private buildSessionUrl(config: ChannelConfig, sessionId: string): string | undefined {
    const meta = config.metadata as Record<string, unknown> | null;
    const sessionBaseUrl = meta?.sessionBaseUrl as string | undefined;
    if (!sessionBaseUrl) return undefined;
    const base = sessionBaseUrl.endsWith('/') ? sessionBaseUrl.slice(0, -1) : sessionBaseUrl;
    return `${base}/${sessionId}`;
  }
}
