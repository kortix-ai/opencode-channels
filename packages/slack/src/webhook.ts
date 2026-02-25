import type { Context } from 'hono';
import type {
  NormalizedMessage,
  ChatType,
  ThreadMessage,
  Attachment,
  ChannelConfig,
} from '@opencode-channels/core';
import type { ChannelEngine } from '@opencode-channels/core';
import { OpenCodeClient, updateChannelConfig } from '@opencode-channels/core';
import { verifySlackSignature } from './utils.js';
import { parseCommand, fuzzyMatchModel } from './command-parser.js';
import { SlackApi, type SlackReplyMessage } from './api.js';
import { handleReactionAdded } from './reactions.js';

// ─── Slack payload types ────────────────────────────────────────────────────

interface SlackUrlVerification {
  type: 'url_verification';
  challenge: string;
  token: string;
}

interface SlackEventCallback {
  type: 'event_callback';
  token: string;
  team_id: string;
  event: SlackEvent;
  event_id: string;
  event_time: number;
}

interface SlackEvent {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
  links?: Array<{ domain: string; url: string }>;
  reaction?: string;
  item?: { type: string; channel: string; ts: string };
  item_user?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download?: string;
    size: number;
  }>;
}

type SlackPayload = SlackUrlVerification | SlackEventCallback | { type: string };

// ─── Bot participation cache ────────────────────────────────────────────────

interface ParticipationEntry {
  participated: boolean;
  expiresAt: number;
}

const botParticipationCache = new Map<string, ParticipationEntry>();
const PARTICIPATION_TTL_MS = 5 * 60 * 1000;
const PARTICIPATION_CACHE_MAX = 1000;

async function checkBotParticipation(
  config: ChannelConfig,
  channel: string,
  threadTs: string,
  botUserId?: string,
): Promise<boolean> {
  const cacheKey = `${channel}:${threadTs}`;
  const now = Date.now();

  const cached = botParticipationCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.participated;
  }

  const credentials = config.credentials as Record<string, unknown>;
  const botToken = credentials?.botToken as string | undefined;
  if (!botToken) return false;

  const api = new SlackApi(botToken);
  const result = await api.conversationsReplies(channel, threadTs, 10);
  let participated = false;

  if (result.ok && result.messages) {
    for (const msg of result.messages) {
      if (msg.bot_id || (botUserId && msg.user === botUserId)) {
        participated = true;
        break;
      }
    }
  }

  if (botParticipationCache.size >= PARTICIPATION_CACHE_MAX) {
    const firstKey = botParticipationCache.keys().next().value as string;
    botParticipationCache.delete(firstKey);
  }

  botParticipationCache.set(cacheKey, { participated, expiresAt: now + PARTICIPATION_TTL_MS });
  return participated;
}

// ─── File downloading ───────────────────────────────────────────────────────

const MAX_FILE_SIZE = 20 * 1024 * 1024;

async function downloadSlackFiles(
  files: NonNullable<SlackEvent['files']>,
  botToken: string,
): Promise<Attachment[]> {
  const attachments: Attachment[] = [];

  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      console.warn(`[SLACK] Skipping file ${file.name}: too large (${file.size} bytes)`);
      continue;
    }

    try {
      const url = file.url_private_download || file.url_private;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${botToken}` },
      });

      if (!res.ok) {
        console.warn(`[SLACK] Failed to download file ${file.name}: ${res.status}`);
        continue;
      }

      const buffer = await res.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const dataUrl = `data:${file.mimetype};base64,${base64}`;

      const type = file.mimetype.startsWith('image/')
        ? ('image' as const)
        : file.mimetype.startsWith('audio/')
          ? ('audio' as const)
          : file.mimetype.startsWith('video/')
            ? ('video' as const)
            : ('file' as const);

      attachments.push({
        type,
        url: dataUrl,
        mimeType: file.mimetype,
        name: file.name,
        size: file.size,
      });
    } catch (err) {
      console.warn(`[SLACK] Failed to download file ${file.name}:`, err);
    }
  }

  return attachments;
}

// ─── Thread context fetching ────────────────────────────────────────────────

interface ThreadContextResult {
  messages: ThreadMessage[];
  files: NonNullable<SlackEvent['files']>;
}

async function fetchThreadContext(
  config: ChannelConfig,
  channel: string,
  threadTs: string,
  currentTs: string,
  botUserId?: string,
): Promise<ThreadContextResult> {
  try {
    const credentials = config.credentials as Record<string, unknown>;
    const botToken = credentials?.botToken as string | undefined;
    if (!botToken) return { messages: [], files: [] };

    const api = new SlackApi(botToken);
    const result = await api.conversationsReplies(channel, threadTs, 30);
    if (!result.ok || !result.messages) return { messages: [], files: [] };

    const context: ThreadMessage[] = [];
    const threadFiles: NonNullable<SlackEvent['files']> = [];

    // Determine the last bot message timestamp for file context windowing
    let lastBotTs = '0';
    for (const msg of result.messages) {
      const isBot = !!(msg.bot_id || msg.subtype === 'bot_message');
      const isSelf = isBot && botUserId && msg.user === botUserId;
      if (isSelf && msg.ts > lastBotTs) {
        lastBotTs = msg.ts;
      }
    }

    for (const msg of result.messages) {
      // Collect files from messages newer than the last bot reply
      if (msg.ts !== currentTs && msg.files && msg.ts > lastBotTs) {
        threadFiles.push(...msg.files);
      }

      if (msg.ts === currentTs) continue;
      if (!msg.text) continue;

      const isBot = !!(msg.bot_id || msg.subtype === 'bot_message');
      const isSelf = isBot && botUserId && msg.user === botUserId;

      context.push({
        sender: isSelf ? 'assistant' : (msg.user || 'unknown'),
        text: msg.text,
        isBot,
      });
    }

    return { messages: context, files: threadFiles };
  } catch (err) {
    console.warn('[SLACK] Failed to fetch thread context:', err);
    return { messages: [], files: [] };
  }
}

// ─── Chat type detection ────────────────────────────────────────────────────

function detectChatType(channelType?: string): ChatType {
  switch (channelType) {
    case 'im':
      return 'dm';
    case 'channel':
    case 'group':
    case 'mpim':
      return 'group';
    default:
      return 'dm';
  }
}

// ─── In-thread command confirmation ─────────────────────────────────────────

function confirmCommandInThread(
  config: ChannelConfig,
  event: SlackEvent,
  text: string,
): void {
  const credentials = config.credentials as Record<string, unknown>;
  const botToken = credentials?.botToken as string;
  if (!botToken || !event.channel) return;

  const api = new SlackApi(botToken);
  const threadTs = event.thread_ts || event.ts;

  api.postMessage({
    channel: event.channel,
    text,
    thread_ts: threadTs,
  }).catch((err) => {
    console.error('[SLACK] Failed to confirm command:', err);
  });
}

// ─── Link sharing handler ───────────────────────────────────────────────────

async function handleLinkShared(
  eventPayload: SlackEventCallback,
  config: ChannelConfig,
): Promise<void> {
  const event = eventPayload.event;
  const links = event.links;
  if (!links || links.length === 0) return;

  const credentials = config.credentials as Record<string, unknown>;
  const botToken = credentials?.botToken as string;
  if (!botToken) return;

  const api = new SlackApi(botToken);
  const unfurls: Record<string, { title: string; text: string; color?: string }> = {};

  for (const link of links) {
    unfurls[link.url] = {
      title: link.domain,
      text: `Link shared: ${link.url}`,
      color: '#7C3AED',
    };
  }

  await api.chatUnfurl(
    event.channel || '',
    event.ts || event.event_ts || '',
    unfurls,
  );
}

// ─── Session reset handler ──────────────────────────────────────────────────

async function handleSessionReset(
  engine: ChannelEngine,
  config: ChannelConfig,
  eventPayload: SlackEventCallback,
  event: SlackEvent,
): Promise<void> {
  const message: NormalizedMessage = {
    externalId: event.ts || event.event_ts || '',
    channelType: 'slack',
    channelConfigId: config.id,
    chatType: detectChatType(event.channel_type),
    content: '',
    attachments: [],
    platformUser: {
      id: event.user || '',
      name: event.user || 'Unknown',
    },
    threadId: event.thread_ts,
    groupId: event.channel,
    raw: eventPayload,
  };

  const strategy = (config.sessionStrategy as 'single' | 'per-thread' | 'per-user' | 'per-message') || 'per-user';
  await engine.resetSession(config.id, 'slack', strategy, message);

  confirmCommandInThread(config, event, ':white_check_mark: Session reset. Starting fresh!');
}

// ─── Main webhook handler ───────────────────────────────────────────────────

/**
 * Handle incoming Slack Events API webhooks.
 *
 * @param c      - Hono request context
 * @param engine - Channel engine for message processing
 * @param config - The resolved ChannelConfig for this Slack workspace (if known).
 *                 When `null`, the handler still processes url_verification but
 *                 will skip message processing.
 * @param getConfig - Optional resolver function to look up a config by team_id.
 *                    Used when `config` is null and we need to resolve from payload.
 */
export async function handleSlackWebhook(
  c: Context,
  engine: ChannelEngine,
  config?: ChannelConfig | null,
  getConfig?: (teamId: string) => ChannelConfig | undefined,
): Promise<Response> {
  const rawBody = await c.req.text();
  const payload = JSON.parse(rawBody) as SlackPayload;

  // URL verification does not require a config
  if (payload.type === 'url_verification') {
    const verification = payload as SlackUrlVerification;
    return c.json({ challenge: verification.challenge });
  }

  if (payload.type !== 'event_callback') {
    return c.json({ ok: true });
  }

  const eventPayload = payload as SlackEventCallback;
  const event = eventPayload.event;

  // Resolve the channel config: use the one passed in, or look up by team_id
  let channelConfig = config ?? undefined;
  if (!channelConfig && getConfig) {
    channelConfig = getConfig(eventPayload.team_id);
  }

  // Verify signature if we have a signing secret
  if (channelConfig) {
    const credentials = channelConfig.credentials as Record<string, unknown>;
    const signingSecret = credentials?.signingSecret as string | undefined;

    if (signingSecret) {
      const timestamp = c.req.header('X-Slack-Request-Timestamp') || '';
      const signature = c.req.header('X-Slack-Signature') || '';

      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - Number(timestamp)) > 300) {
        return c.json({ error: 'Request timestamp too old' }, 401);
      }

      const valid = await verifySlackSignature(signingSecret, timestamp, rawBody, signature);
      if (!valid) {
        return c.json({ error: 'Invalid request signature' }, 401);
      }
    }
  }

  if (!channelConfig) {
    console.warn(`[SLACK] No channel config found for team_id=${eventPayload.team_id}`);
    return c.json({ ok: true });
  }

  // ─── link_shared ────────────────────────────────────────────────────────

  if (event.type === 'link_shared') {
    handleLinkShared(eventPayload, channelConfig).catch((err) => {
      console.error('[SLACK] link_shared handler failed:', err);
    });
    return c.json({ ok: true });
  }

  // ─── reaction_added ─────────────────────────────────────────────────────

  if (event.type === 'reaction_added') {
    (async () => {
      await handleReactionAdded(
        event as unknown as {
          type: 'reaction_added';
          user: string;
          reaction: string;
          item: { type: string; channel: string; ts: string };
          item_user?: string;
          event_ts: string;
        },
        channelConfig!,
        engine,
      );
    })().catch((err) => {
      console.error('[SLACK] reaction_added handler failed:', err);
    });
    return c.json({ ok: true });
  }

  // ─── Filter non-message events ──────────────────────────────────────────

  if (event.type !== 'message' && event.type !== 'app_mention') {
    return c.json({ ok: true });
  }

  // Ignore bot messages
  if (event.bot_id || event.subtype === 'bot_message') {
    return c.json({ ok: true });
  }

  // Ignore subtypes other than file_share
  if (event.subtype && event.subtype !== 'file_share') {
    return c.json({ ok: true });
  }

  // ─── Extract content ────────────────────────────────────────────────────

  const hasFiles = event.files && event.files.length > 0;
  let content = event.text || '';
  if (!content && !hasFiles) {
    return c.json({ ok: true });
  }
  if (!content && hasFiles) {
    const fileNames = event.files!.map((f) => f.name).join(', ');
    content = `[User uploaded: ${fileNames}]`;
  }

  const credentials = channelConfig.credentials as Record<string, unknown>;
  const botToken = credentials?.botToken as string | undefined;
  const botUserId = credentials?.botUserId as string | undefined;

  // Auto-join channels (non-DM)
  if (botToken && event.channel && event.channel_type !== 'im') {
    const api = new SlackApi(botToken);
    api.conversationsJoin(event.channel).catch((err) => {
      console.warn(`[SLACK] Auto-join channel ${event.channel} failed:`, err);
    });
  }

  // Detect mention and strip bot mention from text
  const isMention = event.type === 'app_mention';
  if (botUserId) {
    content = content.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();
  }

  const chatType = detectChatType(event.channel_type);

  // ─── Group mention gating ──────────────────────────────────────────────

  if (chatType === 'group') {
    const platformConfig = channelConfig.platformConfig as Record<string, unknown> | null;
    const groupConfig = (platformConfig?.groups as Record<string, unknown>) ?? {};
    const requireMention = groupConfig.requireMention !== false;

    if (requireMention && !isMention) {
      if (event.thread_ts && event.channel) {
        const participated = await checkBotParticipation(
          channelConfig, event.channel, event.thread_ts, botUserId,
        );
        if (!participated) {
          return c.json({ ok: true });
        }
      } else {
        return c.json({ ok: true });
      }
    }
  }

  // ─── Command parsing ──────────────────────────────────────────────────

  const parsed = parseCommand(content);

  if (parsed.type === 'reset') {
    handleSessionReset(engine, channelConfig, eventPayload, event).catch((err) => {
      console.error('[SLACK] Session reset failed:', err);
    });
    return c.json({ ok: true });
  }

  // ─── Build normalized message ─────────────────────────────────────────

  const normalized: NormalizedMessage = {
    externalId: event.ts || event.event_ts || '',
    channelType: 'slack',
    channelConfigId: channelConfig.id,
    chatType,
    content: parsed.type === 'none' ? content : parsed.remainingText,
    attachments: [],
    platformUser: {
      id: event.user || '',
      name: event.user || 'Unknown',
    },
    threadId: event.thread_ts,
    groupId: chatType !== 'dm' ? event.channel : undefined,
    isMention,
    raw: eventPayload,
  };

  // ─── Model / agent overrides ──────────────────────────────────────────

  if (parsed.type === 'set_model' && parsed.model) {
    const meta = (channelConfig.metadata as Record<string, unknown>) ?? {};
    meta.model = parsed.model;
    channelConfig.metadata = meta;
    normalized.overrides = { model: parsed.model };

    // Persist model choice to SQLite
    updateChannelConfig(channelConfig.id, { metadata: meta }).catch((err) => {
      console.error('[SLACK] Failed to persist model change:', err);
    });

    if (!parsed.remainingText) {
      confirmCommandInThread(channelConfig, event, `Model switched to *${parsed.model.modelID}*.`);
      return c.json({ ok: true });
    }
  }

  if (parsed.type === 'set_model_fuzzy' && parsed.modelQuery) {
    // Fuzzy model resolution: query OpenCode for available providers/models
    const opencodeUrl = process.env.OPENCODE_URL || 'http://localhost:8000';
    const fuzzyClient = new OpenCodeClient({ baseUrl: opencodeUrl });

    (async () => {
      try {
        const providers = await fuzzyClient.listProviders();
        if (providers.length === 0) {
          confirmCommandInThread(channelConfig, event, ':x: No providers available. Is OpenCode running?');
          return;
        }

        const matched = fuzzyMatchModel(parsed.modelQuery!, providers);
        if (!matched) {
          const availableModels = providers
            .flatMap((p) => p.models.map((m) => `\`${m.id}\``))
            .slice(0, 10)
            .join(', ');
          confirmCommandInThread(
            channelConfig,
            event,
            `:x: No model matching "${parsed.modelQuery}". Available: ${availableModels}`,
          );
          return;
        }

        // Apply the resolved model
        const meta = (channelConfig.metadata as Record<string, unknown>) ?? {};
        meta.model = matched;
        channelConfig.metadata = meta;

        // Persist to SQLite
        await updateChannelConfig(channelConfig.id, { metadata: meta });

        confirmCommandInThread(
          channelConfig,
          event,
          `:white_check_mark: Model switched to *${matched.modelID}* (provider: ${matched.providerID}).`,
        );
      } catch (err) {
        console.error('[SLACK] Fuzzy model matching failed:', err);
        confirmCommandInThread(
          channelConfig,
          event,
          `:x: Failed to resolve model: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })().catch(() => {});

    return c.json({ ok: true });
  }

  if (parsed.type === 'set_agent' && parsed.agentName) {
    normalized.overrides = { agentName: parsed.agentName };

    // Persist agent change to SQLite
    updateChannelConfig(channelConfig.id, { agentName: parsed.agentName }).catch((err) => {
      console.error('[SLACK] Failed to persist agent change:', err);
    });

    if (!parsed.remainingText) {
      confirmCommandInThread(channelConfig, event, `Agent switched to *${parsed.agentName}*.`);
      return c.json({ ok: true });
    }
  }

  // ─── Async processing: download files, fetch thread context, process ──

  (async () => {
    const creds = channelConfig!.credentials as Record<string, unknown>;
    const token = creds?.botToken as string;

    if (event.files && event.files.length > 0 && token) {
      normalized.attachments = await downloadSlackFiles(event.files, token);
    }

    if (event.thread_ts && event.channel) {
      const threadResult = await fetchThreadContext(
        channelConfig!,
        event.channel,
        event.thread_ts,
        event.ts || '',
        botUserId,
      );
      normalized.threadContext = threadResult.messages;
      if (normalized.attachments.length === 0 && threadResult.files.length > 0 && token) {
        normalized.attachments = await downloadSlackFiles(threadResult.files, token);
      }
    }

    await engine.processMessage(normalized);
  })().catch((err) => {
    console.error('[SLACK] Failed to process message:', err);
  });

  return c.json({ ok: true });
}
