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
import { splitMessage, markdownToSlack } from '@opencode-channels/core';
import type { OpenCodeClient } from '@opencode-channels/core';
import { SlackApi } from './api.js';
import { handleSlackWebhook } from './webhook.js';
import { handleSlackCommand, postToResponseUrl } from './commands.js';
import { handleSlackInteractivity } from './interactivity.js';
import { buildBlockKitMessage, type UsageMetadata } from './block-kit.js';

// ─── Adapter options ────────────────────────────────────────────────────────

export interface SlackAdapterOptions {
  /**
   * Resolve a ChannelConfig by Slack team_id.
   * Called on every incoming webhook to look up the right config.
   */
  getConfigByTeamId: (teamId: string) => ChannelConfig | undefined;

  /**
   * Resolve the OpenCodeClient for a given ChannelConfig.
   * Used by slash commands that need to query providers, agents, etc.
   */
  getClient: (config: ChannelConfig) => OpenCodeClient;
}

// ─── SlackAdapter ───────────────────────────────────────────────────────────

export class SlackAdapter extends BaseAdapter {
  readonly type = 'slack' as const;
  readonly name = 'Slack';
  readonly capabilities: ChannelCapabilities = {
    textChunkLimit: 4000,
    supportsRichText: true,
    supportsEditing: true,
    supportsTypingIndicator: true,
    supportsAttachments: true,
    connectionType: 'webhook',
  };

  private readonly options: SlackAdapterOptions;

  constructor(options: SlackAdapterOptions) {
    super();
    this.options = options;
  }

  registerRoutes(router: Hono, engine: ChannelEngine): void {
    const { getConfigByTeamId, getClient } = this.options;

    // Events API (messages, reactions, link_shared, etc.)
    router.post('/slack/events', (c) =>
      handleSlackWebhook(c, engine, null, getConfigByTeamId),
    );

    // Slash commands — need to resolve config + client per-request
    router.post('/slack/commands', async (c) => {
      const rawBody = await c.req.text();
      const params = new URLSearchParams(rawBody);
      const teamId = params.get('team_id') || '';
      const config = getConfigByTeamId(teamId);
      if (!config) {
        return c.json({ text: 'No workspace connected for this Slack team.' }, 200);
      }
      const client = getClient(config);
      return handleSlackCommand(c, engine, config, client, rawBody);
    });

    // Interactivity (button clicks, message actions)
    router.post('/slack/interactivity', (c) =>
      handleSlackInteractivity(c, engine, getConfigByTeamId),
    );
  }

  async sendResponse(
    channelConfig: ChannelConfig,
    message: NormalizedMessage,
    response: AgentResponse,
  ): Promise<void> {
    const rawPayload = message.raw as Record<string, unknown> | undefined;

    // Slash command response: use response_url
    if (rawPayload?._slackCommand && rawPayload?.responseUrl) {
      const sessionUrl = this.buildSessionUrl(channelConfig, response.sessionId);
      let slackText = markdownToSlack(response.content);
      if (sessionUrl) {
        slackText += `\n\n<${sessionUrl}|View full session>`;
      }
      await postToResponseUrl(rawPayload.responseUrl as string, slackText);
      return;
    }

    const botToken = this.getBotToken(channelConfig);
    if (!botToken) {
      console.error('[SLACK] No bot token in credentials');
      return;
    }

    const api = new SlackApi(botToken);

    const event = rawPayload?.event as Record<string, unknown> | undefined;
    const channel = event?.channel as string;
    if (!channel) {
      console.error('[SLACK] Cannot determine channel from message');
      return;
    }

    const threadTs = message.threadId || message.externalId;

    const sessionUrl = this.buildSessionUrl(channelConfig, response.sessionId);
    const usageMeta: UsageMetadata = {
      modelName: response.modelName,
      durationMs: response.durationMs,
    };
    const blocks = buildBlockKitMessage(response.content, sessionUrl, usageMeta);

    let fallbackText = markdownToSlack(response.content);
    if (sessionUrl) {
      fallbackText += `\n\n<${sessionUrl}|View full session>`;
    }

    const chunks = splitMessage(fallbackText, this.capabilities.textChunkLimit);

    const meta = channelConfig.metadata as Record<string, unknown> | null;
    const customIdentity = meta?.customIdentity as { username?: string; iconUrl?: string } | undefined;

    let firstResult = await api.postMessage({
      channel,
      text: chunks[0] || fallbackText,
      thread_ts: threadTs,
      blocks,
      ...(customIdentity?.username && { username: customIdentity.username }),
      ...(customIdentity?.iconUrl && { icon_url: customIdentity.iconUrl }),
    });

    // Fall back to plain text if blocks are rejected
    if (!firstResult.ok && firstResult.error === 'invalid_blocks') {
      console.warn(`[SLACK] Blocks rejected, retrying with plain text`);
      firstResult = await api.postMessage({
        channel,
        text: chunks[0] || fallbackText,
        thread_ts: threadTs,
        ...(customIdentity?.username && { username: customIdentity.username }),
        ...(customIdentity?.iconUrl && { icon_url: customIdentity.iconUrl }),
      });
    }

    if (!firstResult.ok) {
      console.error(`[SLACK] postMessage failed: ${firstResult.error}`);
    }

    for (let i = 1; i < chunks.length; i++) {
      const result = await api.postMessage({
        channel,
        text: chunks[i],
        thread_ts: threadTs,
      });
      if (!result.ok) {
        console.error(`[SLACK] postMessage failed: ${result.error}`);
      }
    }
  }

  private static PROGRESS_EMOJI = 'hourglass_flowing_sand';
  private static COMPLETE_EMOJI = 'white_check_mark';
  private static ERROR_EMOJI = 'x';
  private static FILES_EMOJI = 'file_folder';

  override async sendTypingIndicator(
    channelConfig: ChannelConfig,
    message: NormalizedMessage,
  ): Promise<void> {
    const botToken = this.getBotToken(channelConfig);
    if (!botToken) return;

    const rawPayload = message.raw as Record<string, unknown> | undefined;
    const event = rawPayload?.event as Record<string, unknown> | undefined;
    const channel = event?.channel as string;
    if (!channel) return;

    const api = new SlackApi(botToken);
    await api.addReaction(channel, message.externalId, SlackAdapter.PROGRESS_EMOJI);
  }

  override async removeTypingIndicator(
    channelConfig: ChannelConfig,
    message: NormalizedMessage,
  ): Promise<void> {
    const botToken = this.getBotToken(channelConfig);
    if (!botToken) return;

    const rawPayload = message.raw as Record<string, unknown> | undefined;
    const event = rawPayload?.event as Record<string, unknown> | undefined;
    const channel = event?.channel as string;
    if (!channel) return;

    const api = new SlackApi(botToken);
    await api.removeReaction(channel, message.externalId, SlackAdapter.PROGRESS_EMOJI);
  }

  override async reactComplete(
    channelConfig: ChannelConfig,
    message: NormalizedMessage,
  ): Promise<void> {
    const botToken = this.getBotToken(channelConfig);
    if (!botToken) return;

    const rawPayload = message.raw as Record<string, unknown> | undefined;
    const event = rawPayload?.event as Record<string, unknown> | undefined;
    const channel = event?.channel as string;
    if (!channel) return;

    const api = new SlackApi(botToken);
    await api.addReaction(channel, message.externalId, SlackAdapter.COMPLETE_EMOJI);
  }

  override async reactError(
    channelConfig: ChannelConfig,
    message: NormalizedMessage,
  ): Promise<void> {
    const botToken = this.getBotToken(channelConfig);
    if (!botToken) return;

    const rawPayload = message.raw as Record<string, unknown> | undefined;
    const event = rawPayload?.event as Record<string, unknown> | undefined;
    const channel = event?.channel as string;
    if (!channel) return;

    const api = new SlackApi(botToken);
    await api.addReaction(channel, message.externalId, SlackAdapter.ERROR_EMOJI);
  }

  override async reactFilesChanged(
    channelConfig: ChannelConfig,
    message: NormalizedMessage,
  ): Promise<void> {
    const botToken = this.getBotToken(channelConfig);
    if (!botToken) return;

    const rawPayload = message.raw as Record<string, unknown> | undefined;
    const event = rawPayload?.event as Record<string, unknown> | undefined;
    const channel = event?.channel as string;
    if (!channel) return;

    const api = new SlackApi(botToken);
    await api.addReaction(channel, message.externalId, SlackAdapter.FILES_EMOJI);
  }

  override async onChannelRemoved(channelConfig: ChannelConfig): Promise<void> {
    console.log(`[SLACK] Channel ${channelConfig.id} removed.`);
  }

  override async validateCredentials(
    credentials: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const botToken = credentials.botToken as string;
    if (!botToken) {
      return { valid: false, error: 'botToken is required' };
    }

    try {
      const api = new SlackApi(botToken);
      const result = await api.authTest();
      if (!result.ok) {
        return { valid: false, error: `Invalid bot token: ${result.error}` };
      }
      if (result.user_id) {
        credentials.botUserId = result.user_id;
      }
      if (result.team_id) {
        credentials.teamId = result.team_id;
      }
      return { valid: true };
    } catch {
      return { valid: false, error: 'Failed to validate Slack credentials' };
    }
  }

  override async sendPermissionRequest(
    channelConfig: ChannelConfig,
    message: NormalizedMessage,
    permission: PermissionRequest,
  ): Promise<void> {
    const botToken = this.getBotToken(channelConfig);
    if (!botToken) return;

    const rawPayload = message.raw as Record<string, unknown> | undefined;
    const event = rawPayload?.event as Record<string, unknown> | undefined;
    const channel = event?.channel as string;
    if (!channel) return;

    const api = new SlackApi(botToken);
    const threadTs = message.threadId || message.externalId;

    await api.postMessage({
      channel,
      text: `Permission requested: ${permission.tool}`,
      thread_ts: threadTs,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:lock: *Permission Request*\n*Tool:* \`${permission.tool}\`\n${permission.description || ''}`,
          },
        },
        {
          type: 'actions',
          block_id: `perm_${permission.id}`,
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve', emoji: true },
              style: 'primary',
              action_id: 'permission_approve',
              value: permission.id,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Reject', emoji: true },
              style: 'danger',
              action_id: 'permission_reject',
              value: permission.id,
            },
          ],
        },
      ],
    });
  }

  async sendUnlinkedMessage(
    channelConfig: ChannelConfig,
    message: NormalizedMessage,
  ): Promise<void> {
    const rawPayload = message.raw as Record<string, unknown> | undefined;

    // For slash commands, respond via response_url
    if (rawPayload?._slackCommand && rawPayload?.responseUrl) {
      await postToResponseUrl(
        rawPayload.responseUrl as string,
        `:warning: This Slack channel isn't linked to an instance yet.`,
        true,
      );
      return;
    }

    const botToken = this.getBotToken(channelConfig);
    if (!botToken) return;

    const event = rawPayload?.event as Record<string, unknown> | undefined;
    const channel = event?.channel as string;
    if (!channel) return;

    const api = new SlackApi(botToken);
    const threadTs = message.threadId || message.externalId;

    await api.postMessage({
      channel,
      text: "This channel isn't linked to an instance yet. Link one to start chatting.",
      thread_ts: threadTs,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ":warning: *No instance linked*\nThis Slack channel isn't connected to an instance yet. Link one to start chatting.",
          },
        },
      ],
    });
  }

  override async sendFiles(
    channelConfig: ChannelConfig,
    message: NormalizedMessage,
    files: FileOutput[],
  ): Promise<void> {
    const botToken = this.getBotToken(channelConfig);
    if (!botToken) {
      console.warn('[SLACK] sendFiles: no bot token, skipping');
      return;
    }

    const rawPayload = message.raw as Record<string, unknown> | undefined;
    const event = rawPayload?.event as Record<string, unknown> | undefined;
    const channel = (event?.channel as string) || (rawPayload?.channelId as string);
    if (!channel) {
      console.warn('[SLACK] sendFiles: no channel in event payload, skipping');
      return;
    }

    const api = new SlackApi(botToken);
    const isSlashCommand = rawPayload?._slackCommand === true;
    const threadTs = message.threadId || (isSlashCommand ? undefined : message.externalId);

    console.log(`[SLACK] sendFiles: ${files.length} file(s) to channel=${channel} thread=${threadTs}`);

    for (const file of files) {
      try {
        let fileBuffer: Buffer;
        if (file.content) {
          fileBuffer = file.content;
        } else {
          console.log(`[SLACK] Downloading file from URL: ${file.url.slice(0, 120)}`);
          const fileRes = await fetch(file.url);
          if (!fileRes.ok) {
            console.error(`[SLACK] Failed to download file ${file.name}: ${fileRes.status}`);
            continue;
          }
          fileBuffer = Buffer.from(await fileRes.arrayBuffer());
        }

        if (fileBuffer.length === 0) {
          console.warn(`[SLACK] Skipping 0-byte file: ${file.name}`);
          continue;
        }

        console.log(`[SLACK] Uploading file to Slack: ${file.name} (${fileBuffer.length} bytes)`);
        const result = await api.filesUploadV2({
          channel,
          threadTs,
          filename: file.name,
          content: fileBuffer,
          title: file.name,
        });

        if (!result.ok) {
          console.error(`[SLACK] filesUploadV2 failed for ${file.name}: ${result.error}`);
        } else {
          console.log(`[SLACK] File uploaded to Slack: ${file.name}`);
        }
      } catch (err) {
        console.error(`[SLACK] Failed to upload file ${file.name}:`, err);
      }
    }
  }

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
