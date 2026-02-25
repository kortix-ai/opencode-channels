import type { Context } from 'hono';
import type {
  ChannelConfig,
  ChannelEngine,
  NormalizedMessage,
  SessionStrategy,
} from '@opencode-channels/core';
import { OpenCodeClient, SessionManager, updateChannelConfig } from '@opencode-channels/core';
import { verifySlackRequest } from './utils';
import { SlackApi } from './api';
import { exportChannelAsMarkdown } from './export';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Subcommand {
  type:
    | 'help'
    | 'prompt'
    | 'config'
    | 'export'
    | 'models'
    | 'agents'
    | 'status'
    | 'share'
    | 'diff'
    | 'link'
    | 'search'
    | 'find'
    | 'whois'
    | 'channel'
    | 'dm'
    | 'pin'
    | 'unpin'
    | 'pins'
    | 'team'
    | 'bookmark'
    | 'bookmarks';
  prompt: string;
  configAction?: 'set' | 'clear' | 'show';
  configPromptText?: string;
  searchQuery?: string;
  channelAction?: 'create' | 'topic' | 'archive';
  channelName?: string;
  channelText?: string;
  dmTarget?: string;
  dmMessage?: string;
  teamHandle?: string;
  bookmarkUrl?: string;
  bookmarkTitle?: string;
}

interface CommandContext {
  responseUrl: string;
  userId: string;
  userName: string;
  channelId: string;
  triggerId: string;
}

// Shared session manager instance for finding active sessions
const sessionManager = new SessionManager();

// ─── Main handler ───────────────────────────────────────────────────────────

export async function handleSlackCommand(
  c: Context,
  engine: ChannelEngine,
  config: ChannelConfig,
  client: OpenCodeClient,
  /** Pre-read body (if the caller already consumed c.req.text()). */
  preReadBody?: string,
): Promise<Response> {
  const rawBody = preReadBody ?? await c.req.text();

  const timestamp = c.req.header('X-Slack-Request-Timestamp') || '';
  const signature = c.req.header('X-Slack-Signature') || '';
  const signingSecret = (config.credentials as Record<string, unknown>)?.signingSecret as string || '';
  const valid = await verifySlackRequest(rawBody, { timestamp, signature }, signingSecret);
  if (!valid) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const params = new URLSearchParams(rawBody);
  const userId = params.get('user_id') || '';
  const userName = params.get('user_name') || userId;
  const text = (params.get('text') || '').trim();
  const responseUrl = params.get('response_url') || '';
  const channelId = params.get('channel_id') || '';
  const triggerId = params.get('trigger_id') || '';

  if (!responseUrl) {
    return c.json({ text: 'Missing response_url from Slack.' }, 200);
  }

  // Auto-join the channel so the bot can read/write like a workspace member
  const credentials = config.credentials as Record<string, unknown>;
  const botToken = credentials?.botToken as string | undefined;
  if (botToken && channelId) {
    const joinApi = new SlackApi(botToken);
    joinApi.conversationsJoin(channelId).catch((err) => {
      console.warn(`[SLACK/COMMANDS] Auto-join channel ${channelId} failed:`, err);
    });
  }

  const subcommand = parseSubcommand(text);
  const ctx: CommandContext = { responseUrl, userId, userName, channelId, triggerId };

  if (subcommand.type === 'help') {
    return c.json({
      response_type: 'ephemeral',
      text: buildHelpText(),
    }, 200);
  }

  if (subcommand.type === 'models') {
    handleModelsCommand(config, client, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] Models command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':mag: Fetching models...' }, 200);
  }

  if (subcommand.type === 'agents') {
    handleAgentsCommand(config, client, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] Agents command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':mag: Fetching agents...' }, 200);
  }

  if (subcommand.type === 'status') {
    handleStatusCommand(config, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] Status command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':bar_chart: Fetching status...' }, 200);
  }

  if (subcommand.type === 'share') {
    handleShareCommand(config, client, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] Share command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':link: Generating share link...' }, 200);
  }

  if (subcommand.type === 'diff') {
    handleDiffCommand(config, client, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] Diff command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':file_folder: Fetching diff...' }, 200);
  }

  if (subcommand.type === 'config') {
    handleConfigCommand(config, subcommand, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] Config command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':gear: Processing...' }, 200);
  }

  if (subcommand.type === 'link') {
    handleLinkCommand(config, client, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] Link command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':link: Checking status...' }, 200);
  }

  if (subcommand.type === 'export') {
    handleExportCommand(config, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] Export command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':hourglass_flowing_sand: Exporting...' }, 200);
  }

  if (subcommand.type === 'search') {
    handleSearchCommand(config, subcommand, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] Search command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':mag: Searching messages...' }, 200);
  }

  if (subcommand.type === 'find') {
    handleFindCommand(config, subcommand, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] Find command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':mag: Searching files...' }, 200);
  }

  if (subcommand.type === 'whois') {
    handleWhoisCommand(config, subcommand, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] Whois command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':mag: Searching users...' }, 200);
  }

  if (subcommand.type === 'channel') {
    handleChannelCommand(config, subcommand, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] Channel command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':hash: Processing...' }, 200);
  }

  if (subcommand.type === 'dm') {
    handleDmCommand(config, subcommand, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] DM command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':envelope: Sending DM...' }, 200);
  }

  if (subcommand.type === 'pin') {
    handlePinCommand(config, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] Pin command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':pushpin: Pinning...' }, 200);
  }

  if (subcommand.type === 'unpin') {
    handleUnpinCommand(config, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] Unpin command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':pushpin: Unpinning...' }, 200);
  }

  if (subcommand.type === 'pins') {
    handlePinsListCommand(config, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] Pins command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':pushpin: Fetching pins...' }, 200);
  }

  if (subcommand.type === 'team') {
    handleTeamCommand(config, subcommand, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] Team command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':busts_in_silhouette: Fetching team...' }, 200);
  }

  if (subcommand.type === 'bookmark') {
    handleBookmarkCommand(config, subcommand, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] Bookmark command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':bookmark: Adding bookmark...' }, 200);
  }

  if (subcommand.type === 'bookmarks') {
    handleBookmarksListCommand(config, ctx).catch((err) => {
      console.error('[SLACK/COMMANDS] Bookmarks command failed:', err);
      postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
    return c.json({ response_type: 'ephemeral', text: ':bookmark: Fetching bookmarks...' }, 200);
  }

  if (!subcommand.prompt) {
    return c.json({
      response_type: 'ephemeral',
      text: 'Usage: `/opencode <question>` or `/opencode help`',
    }, 200);
  }

  processCommandAsync(engine, config, subcommand, ctx).catch((err) => {
    console.error('[SLACK/COMMANDS] Async processing failed:', err);
    postToResponseUrl(responseUrl, `:x: Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
  });

  return c.json({
    response_type: 'in_channel',
    text: ':hourglass_flowing_sand: Working on it...',
  }, 200);
}

// ─── Parse subcommand ───────────────────────────────────────────────────────

function parseSubcommand(text: string): Subcommand {
  const lower = text.toLowerCase().trim();

  if (lower === 'help' || lower === '') {
    return { type: 'help', prompt: '' };
  }

  if (lower === 'models') {
    return { type: 'models', prompt: '' };
  }

  if (lower === 'agents') {
    return { type: 'agents', prompt: '' };
  }

  if (lower === 'status') {
    return { type: 'status', prompt: '' };
  }

  if (lower === 'share') {
    return { type: 'share', prompt: '' };
  }

  if (lower === 'diff') {
    return { type: 'diff', prompt: '' };
  }

  if (lower === 'link') {
    return { type: 'link', prompt: '' };
  }

  if (lower.startsWith('config ')) {
    const configText = text.slice(7).trim();
    const configLower = configText.toLowerCase();

    if (configLower === 'show') {
      return { type: 'config', prompt: '', configAction: 'show' };
    }

    if (configLower.startsWith('prompt')) {
      const promptText = configText.slice(6).trim();
      if (!promptText || promptText.toLowerCase() === 'clear') {
        return { type: 'config', prompt: '', configAction: 'clear' };
      }
      return { type: 'config', prompt: '', configAction: 'set', configPromptText: promptText };
    }

    return { type: 'help', prompt: '' };
  }

  if (lower === 'export') {
    return { type: 'export', prompt: '' };
  }

  // search <query>
  if (lower.startsWith('search ')) {
    const query = text.slice(7).trim();
    if (query) return { type: 'search', prompt: '', searchQuery: query };
    return { type: 'help', prompt: '' };
  }

  // find <query>
  if (lower.startsWith('find ')) {
    const query = text.slice(5).trim();
    if (query) return { type: 'find', prompt: '', searchQuery: query };
    return { type: 'help', prompt: '' };
  }

  // whois <query>
  if (lower.startsWith('whois ')) {
    const query = text.slice(6).trim();
    if (query) return { type: 'whois', prompt: '', searchQuery: query };
    return { type: 'help', prompt: '' };
  }

  // channel create <name> | channel topic <text> | channel archive
  if (lower.startsWith('channel ')) {
    const rest = text.slice(8).trim();
    const restLower = rest.toLowerCase();
    if (restLower.startsWith('create ')) {
      const name = rest.slice(7).trim();
      if (name) return { type: 'channel', prompt: '', channelAction: 'create', channelName: name };
    }
    if (restLower.startsWith('topic ')) {
      const topic = rest.slice(6).trim();
      if (topic) return { type: 'channel', prompt: '', channelAction: 'topic', channelText: topic };
    }
    if (restLower === 'archive') {
      return { type: 'channel', prompt: '', channelAction: 'archive' };
    }
    return { type: 'help', prompt: '' };
  }

  // dm @user <message>
  if (lower.startsWith('dm ')) {
    const rest = text.slice(3).trim();
    const mentionMatch = rest.match(/^<@(\w+)(?:\|[^>]*)?>?\s+([\s\S]*)/);
    if (mentionMatch && mentionMatch[2].trim()) {
      return { type: 'dm', prompt: '', dmTarget: mentionMatch[1], dmMessage: mentionMatch[2].trim() };
    }
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx > 0) {
      return { type: 'dm', prompt: '', dmTarget: rest.slice(0, spaceIdx), dmMessage: rest.slice(spaceIdx + 1).trim() };
    }
    return { type: 'help', prompt: '' };
  }

  // pin / unpin / pins
  if (lower === 'pin') return { type: 'pin', prompt: '' };
  if (lower === 'unpin') return { type: 'unpin', prompt: '' };
  if (lower === 'pins') return { type: 'pins', prompt: '' };

  // team <handle>
  if (lower.startsWith('team ')) {
    const handle = text.slice(5).trim();
    if (handle) return { type: 'team', prompt: '', teamHandle: handle };
    return { type: 'help', prompt: '' };
  }

  // bookmark <url> [title]
  if (lower.startsWith('bookmark ')) {
    const rest = text.slice(9).trim();
    const urlMatch = rest.match(/^(<[^>]+>|\S+)\s*(.*)/);
    if (urlMatch) {
      const url = urlMatch[1].replace(/^<|>$/g, '');
      const title = urlMatch[2].trim() || url;
      return { type: 'bookmark', prompt: '', bookmarkUrl: url, bookmarkTitle: title };
    }
    return { type: 'help', prompt: '' };
  }
  if (lower === 'bookmarks') return { type: 'bookmarks', prompt: '' };

  return { type: 'prompt', prompt: text };
}

// ─── Help text builder ──────────────────────────────────────────────────────

function buildHelpText(): string {
  return [
    '*OpenCode Slash Commands*',
    '',
    '*General*',
    '`/opencode <question>` — Ask anything',
    '`/opencode models` — List available models',
    '`/opencode agents` — List available agents',
    '`/opencode status` — Show current session info',
    '`/opencode share` — Generate a shareable session link',
    '`/opencode diff` — Show recent git changes',
    '`/opencode export` — Export last 24h of channel messages as markdown',
    '`/opencode link` — Show connection status',
    '',
    '*Search*',
    '`/opencode search <query>` — Search messages across the workspace',
    '`/opencode find <query>` — Search files across the workspace',
    '`/opencode whois <query>` — Search users in the workspace',
    '',
    '*Channels*',
    '`/opencode channel create <name>` — Create a new channel',
    '`/opencode channel topic <text>` — Set channel topic',
    '`/opencode channel archive` — Archive current channel',
    '',
    '*Messaging*',
    '`/opencode dm @user <message>` — Send a DM to a user',
    '',
    '*Pins*',
    '`/opencode pin` — Pin the most recent message',
    '`/opencode unpin` — Unpin the most recent message',
    '`/opencode pins` — List pinned items in this channel',
    '',
    '*Teams*',
    '`/opencode team <handle>` — List members of a user group',
    '',
    '*Bookmarks*',
    '`/opencode bookmark <url> [title]` — Add a channel bookmark',
    '`/opencode bookmarks` — List channel bookmarks',
    '',
    '*Config*',
    '`/opencode config prompt <text>` — Set a channel-specific system prompt',
    '`/opencode config prompt clear` — Clear channel prompt',
    '`/opencode config show` — Show current config for this channel',
    '`/opencode help` — Show this help',
  ].join('\n');
}

// ─── Response URL helper ────────────────────────────────────────────────────

export async function postToResponseUrl(
  responseUrl: string,
  text: string,
  ephemeral = false,
): Promise<void> {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      response_type: ephemeral ? 'ephemeral' : 'in_channel',
      text,
    }),
  });
}

// ─── Utility: get bot token from config ─────────────────────────────────────

function getBotToken(config: ChannelConfig): string | null {
  const credentials = config.credentials as Record<string, unknown>;
  return (credentials?.botToken as string) || null;
}

// ─── Utility: find active session ───────────────────────────────────────────

async function findActiveSessionId(
  config: ChannelConfig,
  userId: string,
): Promise<string | null> {
  return sessionManager.getActiveSessionId(config.id, userId);
}

// ─── Utility: resolve user ID from mention or name ──────────────────────────

async function resolveUserId(api: SlackApi, target: string): Promise<string | null> {
  // Already a Slack user ID
  if (/^[UW]\w+$/.test(target)) return target;

  // Strip leading @ if present
  const query = target.replace(/^@/, '').toLowerCase();

  let cursor: string | undefined;
  do {
    const result = await api.usersList(cursor);
    if (!result.ok || !result.members) return null;

    for (const member of result.members) {
      if (member.deleted || member.is_bot) continue;
      if (
        member.name?.toLowerCase() === query ||
        member.real_name?.toLowerCase() === query ||
        member.profile?.display_name?.toLowerCase() === query ||
        member.profile?.email?.toLowerCase() === query
      ) {
        return member.id;
      }
    }

    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return null;
}

// ─── Command: models ────────────────────────────────────────────────────────

async function handleModelsCommand(
  config: ChannelConfig,
  client: OpenCodeClient,
  ctx: CommandContext,
): Promise<void> {
  const providers = await client.listProviders();
  if (providers.length === 0) {
    await postToResponseUrl(ctx.responseUrl, ':x: No providers available.', true);
    return;
  }

  const meta = config.metadata as Record<string, unknown> | null;
  const currentModel = (meta?.model as Record<string, unknown>)?.modelID as string | undefined;

  const lines: string[] = ['*Available Models*\n'];
  for (const provider of providers) {
    lines.push(`*${provider.name || provider.id}*`);
    for (const model of provider.models) {
      const isCurrent = currentModel && model.id === currentModel;
      const marker = isCurrent ? ' :white_check_mark:' : '';
      lines.push(`  \`${model.id}\` — ${model.name}${marker}`);
    }
    lines.push('');
  }

  lines.push('_Switch with_ `use <model-name>` _in any channel message._');

  await postToResponseUrl(ctx.responseUrl, lines.join('\n'), true);
}

// ─── Command: agents ────────────────────────────────────────────────────────

async function handleAgentsCommand(
  config: ChannelConfig,
  client: OpenCodeClient,
  ctx: CommandContext,
): Promise<void> {
  const allAgents = await client.listAgents();
  // Filter out subagents — only show primary and "all" mode agents
  const agents = allAgents.filter((a) => a.mode !== 'subagent');
  if (agents.length === 0) {
    await postToResponseUrl(ctx.responseUrl, ':x: No agents available.', true);
    return;
  }

  const currentAgent = config.agentName || 'default';

  const lines: string[] = ['*Available Agents*\n'];
  for (const agent of agents) {
    const isCurrent = agent.name === currentAgent;
    const marker = isCurrent ? ' :white_check_mark:' : '';
    const desc = agent.description ? ` — ${agent.description}` : '';
    lines.push(`\`${agent.name}\`${desc}${marker}`);
  }

  lines.push('\n_Switch with_ `use agent <name>` _in any channel message._');

  await postToResponseUrl(ctx.responseUrl, lines.join('\n'), true);
}

// ─── Command: status ────────────────────────────────────────────────────────

async function handleStatusCommand(
  config: ChannelConfig,
  ctx: CommandContext,
): Promise<void> {
  const meta = config.metadata as Record<string, unknown> | null;
  const currentModel = (meta?.model as Record<string, unknown>)?.modelID as string | undefined;
  const currentAgent = config.agentName || 'default';
  const strategy = config.sessionStrategy || 'per-user';

  const sessionId = await findActiveSessionId(config, ctx.userId);

  const lines: string[] = [
    '*Session Status*\n',
    `*Model:* \`${currentModel || 'default'}\``,
    `*Agent:* \`${currentAgent}\``,
    `*Session strategy:* \`${strategy}\``,
    `*Session ID:* ${sessionId ? `\`${sessionId}\`` : '_none active_'}`,
  ];

  if (sessionId) {
    const frontendUrl = (meta?.frontendUrl as string) || (config.platformConfig as Record<string, unknown>)?.webBaseUrl as string | undefined;
    if (frontendUrl) {
      lines.push(`*Web UI:* ${frontendUrl}/session/${sessionId}`);
    }
  }

  await postToResponseUrl(ctx.responseUrl, lines.join('\n'), true);
}

// ─── Command: share ─────────────────────────────────────────────────────────

async function handleShareCommand(
  config: ChannelConfig,
  client: OpenCodeClient,
  ctx: CommandContext,
): Promise<void> {
  const sessionId = await findActiveSessionId(config, ctx.userId);
  if (!sessionId) {
    await postToResponseUrl(ctx.responseUrl, ':x: No active session to share.', true);
    return;
  }

  const result = await client.shareSession(sessionId);
  if (!result) {
    await postToResponseUrl(ctx.responseUrl, ':x: Failed to generate share link.', true);
    return;
  }

  await postToResponseUrl(ctx.responseUrl, `:link: *Shared session:* ${result.shareUrl}`);
}

// ─── Command: diff ──────────────────────────────────────────────────────────

async function handleDiffCommand(
  config: ChannelConfig,
  client: OpenCodeClient,
  ctx: CommandContext,
): Promise<void> {
  const sessionId = await findActiveSessionId(config, ctx.userId);
  if (!sessionId) {
    await postToResponseUrl(ctx.responseUrl, ':x: No active session found.', true);
    return;
  }

  const diff = await client.getSessionDiff(sessionId);
  if (!diff) {
    await postToResponseUrl(ctx.responseUrl, ':white_check_mark: No changes detected.', true);
    return;
  }

  if (diff.length <= 3000) {
    await postToResponseUrl(ctx.responseUrl, `*Recent Changes*\n\`\`\`\n${diff}\n\`\`\``, true);
  } else {
    const botToken = getBotToken(config);
    if (!botToken) {
      await postToResponseUrl(ctx.responseUrl, ':x: Missing bot token for file upload.', true);
      return;
    }
    const api = new SlackApi(botToken);
    await api.filesUploadV2({
      channel: ctx.channelId,
      filename: `diff-${sessionId.slice(0, 8)}.diff`,
      content: Buffer.from(diff, 'utf-8'),
      title: 'Session Diff',
    });
    await postToResponseUrl(ctx.responseUrl, ':white_check_mark: Diff uploaded as file.', true);
  }
}

// ─── Command: config (set/clear/show) ───────────────────────────────────────

async function handleConfigCommand(
  config: ChannelConfig,
  subcommand: Subcommand,
  ctx: CommandContext,
): Promise<void> {
  const platformConfig = (config.platformConfig as Record<string, unknown>) ?? {};
  const channelPrompts = (platformConfig.channelPrompts as Record<string, string>) ?? {};

  if (subcommand.configAction === 'show') {
    const currentPrompt = channelPrompts[ctx.channelId];
    const lines = [
      '*Current Config*',
      `*System prompt:* ${config.systemPrompt ? `\`${config.systemPrompt.slice(0, 100)}${config.systemPrompt.length > 100 ? '...' : ''}\`` : '_none_'}`,
      `*Channel prompt:* ${currentPrompt ? `\`${currentPrompt.slice(0, 100)}${currentPrompt.length > 100 ? '...' : ''}\`` : '_none_'}`,
      `*Session strategy:* \`${config.sessionStrategy}\``,
      `*Agent:* \`${config.agentName || 'default'}\``,
    ];
    await postToResponseUrl(ctx.responseUrl, lines.join('\n'), true);
    return;
  }

  if (subcommand.configAction === 'clear') {
    delete channelPrompts[ctx.channelId];
    platformConfig.channelPrompts = channelPrompts;
    config.platformConfig = platformConfig;

    // Persist to SQLite
    await updateChannelConfig(config.id, { platformConfig });
    await postToResponseUrl(ctx.responseUrl, ':white_check_mark: Channel prompt cleared.', true);
    return;
  }

  if (subcommand.configAction === 'set' && subcommand.configPromptText) {
    channelPrompts[ctx.channelId] = subcommand.configPromptText;
    platformConfig.channelPrompts = channelPrompts;
    config.platformConfig = platformConfig;

    // Persist to SQLite
    await updateChannelConfig(config.id, { platformConfig });
    await postToResponseUrl(
      ctx.responseUrl,
      `:white_check_mark: Channel prompt set to: \`${subcommand.configPromptText.slice(0, 100)}${subcommand.configPromptText.length > 100 ? '...' : ''}\``,
      true,
    );
  }
}

// ─── Command: link (simplified for standalone) ──────────────────────────────

async function handleLinkCommand(
  config: ChannelConfig,
  client: OpenCodeClient,
  ctx: CommandContext,
): Promise<void> {
  // In standalone mode there is a single OpenCode instance.
  // Show its connection status.
  const ready = await client.isReady();

  const meta = config.metadata as Record<string, unknown> | null;
  const frontendUrl = meta?.frontendUrl as string | undefined;

  const lines: string[] = [
    '*Connection Status*\n',
    `*OpenCode:* ${ready ? ':white_check_mark: Connected' : ':x: Unreachable'}`,
    `*Channel:* \`${config.name}\``,
    `*Agent:* \`${config.agentName || 'default'}\``,
  ];

  if (frontendUrl) {
    lines.push(`*Dashboard:* <${frontendUrl}|Open>`);
  }

  await postToResponseUrl(ctx.responseUrl, lines.join('\n'), true);
}

// ─── Command: export ────────────────────────────────────────────────────────

async function handleExportCommand(
  config: ChannelConfig,
  ctx: CommandContext,
): Promise<void> {
  const botToken = getBotToken(config);
  if (!botToken) {
    await postToResponseUrl(ctx.responseUrl, ':x: Missing bot token.', true);
    return;
  }

  const api = new SlackApi(botToken);

  const oneDayAgo = String(Math.floor(Date.now() / 1000) - 86400);
  const result = await api.conversationsHistory(ctx.channelId, oneDayAgo, 200);

  if (!result.ok || !result.messages || result.messages.length === 0) {
    await postToResponseUrl(ctx.responseUrl, ':x: No messages found in the last 24 hours.', true);
    return;
  }

  const markdown = await exportChannelAsMarkdown({
    messages: result.messages.reverse(),
    api,
    channelId: ctx.channelId,
  });

  const fileBuffer = Buffer.from(markdown, 'utf-8');
  const filename = `channel-export-${ctx.channelId}-${new Date().toISOString().slice(0, 10)}.md`;

  await api.filesUploadV2({
    channel: ctx.channelId,
    filename,
    content: fileBuffer,
    title: `Channel Export — ${new Date().toISOString().slice(0, 10)}`,
  });

  await postToResponseUrl(ctx.responseUrl, ':white_check_mark: Channel export uploaded.', true);
}

// ─── Command: search ────────────────────────────────────────────────────────

async function handleSearchCommand(
  config: ChannelConfig,
  subcommand: Subcommand,
  ctx: CommandContext,
): Promise<void> {
  const botToken = getBotToken(config);
  if (!botToken) {
    await postToResponseUrl(ctx.responseUrl, ':x: Missing bot token.', true);
    return;
  }

  const api = new SlackApi(botToken);
  const result = await api.searchMessages(subcommand.searchQuery!, { count: 5 });

  if (!result.ok) {
    await postToResponseUrl(ctx.responseUrl, `:x: Search failed: ${result.error}`, true);
    return;
  }

  const matches = result.messages?.matches || [];
  if (matches.length === 0) {
    await postToResponseUrl(ctx.responseUrl, `:mag: No results found for "${subcommand.searchQuery}".`, true);
    return;
  }

  const lines = [`*Search results for "${subcommand.searchQuery}"* (${result.messages?.total || 0} total)\n`];
  for (const match of matches.slice(0, 5)) {
    const snippet = (match.text || '').slice(0, 150).replace(/\n/g, ' ');
    lines.push(`> ${snippet}`);
    lines.push(`_#${match.channel?.name || 'unknown'}_ — <${match.permalink}|View message>\n`);
  }

  await postToResponseUrl(ctx.responseUrl, lines.join('\n'), true);
}

// ─── Command: find ──────────────────────────────────────────────────────────

async function handleFindCommand(
  config: ChannelConfig,
  subcommand: Subcommand,
  ctx: CommandContext,
): Promise<void> {
  const botToken = getBotToken(config);
  if (!botToken) {
    await postToResponseUrl(ctx.responseUrl, ':x: Missing bot token.', true);
    return;
  }

  const api = new SlackApi(botToken);
  const result = await api.searchFiles(subcommand.searchQuery!, { count: 5 });

  if (!result.ok) {
    await postToResponseUrl(ctx.responseUrl, `:x: File search failed: ${result.error}`, true);
    return;
  }

  const matches = result.files?.matches || [];
  if (matches.length === 0) {
    await postToResponseUrl(ctx.responseUrl, `:mag: No files found for "${subcommand.searchQuery}".`, true);
    return;
  }

  const lines = [`*File results for "${subcommand.searchQuery}"* (${result.files?.total || 0} total)\n`];
  for (const match of matches.slice(0, 5)) {
    lines.push(`\`${match.name}\` (${match.filetype}) — <${match.permalink}|View file>`);
  }

  await postToResponseUrl(ctx.responseUrl, lines.join('\n'), true);
}

// ─── Command: whois ─────────────────────────────────────────────────────────

async function handleWhoisCommand(
  config: ChannelConfig,
  subcommand: Subcommand,
  ctx: CommandContext,
): Promise<void> {
  const botToken = getBotToken(config);
  if (!botToken) {
    await postToResponseUrl(ctx.responseUrl, ':x: Missing bot token.', true);
    return;
  }

  const api = new SlackApi(botToken);
  const query = subcommand.searchQuery!.toLowerCase();

  // Paginate through users and collect matches
  type UserMatch = NonNullable<Awaited<ReturnType<typeof api.usersList>>['members']>[number];
  const matches: UserMatch[] = [];
  let cursor: string | undefined;

  do {
    const result = await api.usersList(cursor);
    if (!result.ok || !result.members) {
      await postToResponseUrl(ctx.responseUrl, `:x: Failed to fetch users: ${result.error}`, true);
      return;
    }

    for (const member of result.members) {
      if (member.deleted || member.is_bot) continue;
      const haystack = [
        member.name,
        member.real_name,
        member.profile?.display_name,
        member.profile?.real_name,
        member.profile?.email,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      if (haystack.includes(query)) {
        matches.push(member);
        if (matches.length >= 5) break;
      }
    }

    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor && matches.length < 5);

  if (matches.length === 0) {
    await postToResponseUrl(ctx.responseUrl, `:mag: No users found for "${subcommand.searchQuery}".`, true);
    return;
  }

  const lines = [`*User results for "${subcommand.searchQuery}"*\n`];
  for (const match of matches) {
    const displayName = match.profile?.display_name || match.real_name || match.name;
    const email = match.profile?.email ? ` — ${match.profile.email}` : '';
    lines.push(`<@${match.id}> *${displayName}*${email}`);
  }

  await postToResponseUrl(ctx.responseUrl, lines.join('\n'), true);
}

// ─── Command: channel (create/topic/archive) ───────────────────────────────

async function handleChannelCommand(
  config: ChannelConfig,
  subcommand: Subcommand,
  ctx: CommandContext,
): Promise<void> {
  const botToken = getBotToken(config);
  if (!botToken) {
    await postToResponseUrl(ctx.responseUrl, ':x: Missing bot token.', true);
    return;
  }

  const api = new SlackApi(botToken);

  if (subcommand.channelAction === 'create') {
    const result = await api.conversationsCreate(subcommand.channelName!);
    if (!result.ok) {
      await postToResponseUrl(ctx.responseUrl, `:x: Failed to create channel: ${result.error}`, true);
      return;
    }
    await postToResponseUrl(ctx.responseUrl, `:white_check_mark: Channel <#${result.channel?.id}> created.`);
    return;
  }

  if (subcommand.channelAction === 'topic') {
    const result = await api.conversationsSetTopic(ctx.channelId, subcommand.channelText!);
    if (!result.ok) {
      await postToResponseUrl(ctx.responseUrl, `:x: Failed to set topic: ${result.error}`, true);
      return;
    }
    await postToResponseUrl(ctx.responseUrl, ':white_check_mark: Channel topic updated.', true);
    return;
  }

  if (subcommand.channelAction === 'archive') {
    const result = await api.conversationsArchive(ctx.channelId);
    if (!result.ok) {
      await postToResponseUrl(ctx.responseUrl, `:x: Failed to archive channel: ${result.error}`, true);
      return;
    }
    await postToResponseUrl(ctx.responseUrl, ':white_check_mark: Channel archived.', true);
  }
}

// ─── Command: dm ────────────────────────────────────────────────────────────

async function handleDmCommand(
  config: ChannelConfig,
  subcommand: Subcommand,
  ctx: CommandContext,
): Promise<void> {
  const botToken = getBotToken(config);
  if (!botToken) {
    await postToResponseUrl(ctx.responseUrl, ':x: Missing bot token.', true);
    return;
  }

  const api = new SlackApi(botToken);

  const userId = await resolveUserId(api, subcommand.dmTarget!);
  if (!userId) {
    await postToResponseUrl(ctx.responseUrl, `:x: Could not find user "${subcommand.dmTarget}".`, true);
    return;
  }

  const openResult = await api.conversationsOpen(userId);
  if (!openResult.ok || !openResult.channel?.id) {
    await postToResponseUrl(ctx.responseUrl, `:x: Failed to open DM: ${openResult.error}`, true);
    return;
  }

  const result = await api.postMessage({
    channel: openResult.channel.id,
    text: subcommand.dmMessage || '',
  });

  if (!result.ok) {
    await postToResponseUrl(ctx.responseUrl, `:x: Failed to send DM: ${result.error}`, true);
    return;
  }

  await postToResponseUrl(ctx.responseUrl, `:white_check_mark: DM sent to <@${userId}>.`, true);
}

// ─── Command: pin ───────────────────────────────────────────────────────────

async function handlePinCommand(
  config: ChannelConfig,
  ctx: CommandContext,
): Promise<void> {
  const botToken = getBotToken(config);
  if (!botToken) {
    await postToResponseUrl(ctx.responseUrl, ':x: Missing bot token.', true);
    return;
  }

  const api = new SlackApi(botToken);
  const history = await api.conversationsHistory(ctx.channelId, undefined, 1);
  if (!history.ok || !history.messages?.[0]) {
    await postToResponseUrl(ctx.responseUrl, ':x: No recent message to pin.', true);
    return;
  }

  const result = await api.pinsAdd(ctx.channelId, history.messages[0].ts);
  if (!result.ok) {
    await postToResponseUrl(ctx.responseUrl, `:x: Failed to pin: ${result.error}`, true);
    return;
  }

  await postToResponseUrl(ctx.responseUrl, ':pushpin: Message pinned.', true);
}

// ─── Command: unpin ─────────────────────────────────────────────────────────

async function handleUnpinCommand(
  config: ChannelConfig,
  ctx: CommandContext,
): Promise<void> {
  const botToken = getBotToken(config);
  if (!botToken) {
    await postToResponseUrl(ctx.responseUrl, ':x: Missing bot token.', true);
    return;
  }

  const api = new SlackApi(botToken);
  const history = await api.conversationsHistory(ctx.channelId, undefined, 1);
  if (!history.ok || !history.messages?.[0]) {
    await postToResponseUrl(ctx.responseUrl, ':x: No recent message to unpin.', true);
    return;
  }

  const result = await api.pinsRemove(ctx.channelId, history.messages[0].ts);
  if (!result.ok) {
    await postToResponseUrl(ctx.responseUrl, `:x: Failed to unpin: ${result.error}`, true);
    return;
  }

  await postToResponseUrl(ctx.responseUrl, ':pushpin: Message unpinned.', true);
}

// ─── Command: pins ──────────────────────────────────────────────────────────

async function handlePinsListCommand(
  config: ChannelConfig,
  ctx: CommandContext,
): Promise<void> {
  const botToken = getBotToken(config);
  if (!botToken) {
    await postToResponseUrl(ctx.responseUrl, ':x: Missing bot token.', true);
    return;
  }

  const api = new SlackApi(botToken);
  const result = await api.pinsList(ctx.channelId);

  if (!result.ok) {
    await postToResponseUrl(ctx.responseUrl, `:x: Failed to list pins: ${result.error}`, true);
    return;
  }

  const items = result.items || [];
  if (items.length === 0) {
    await postToResponseUrl(ctx.responseUrl, ':pushpin: No pinned items in this channel.', true);
    return;
  }

  const lines = [`*Pinned items* (${items.length})\n`];
  for (const item of items.slice(0, 10)) {
    if (item.message) {
      const snippet = (item.message.text || '').slice(0, 100).replace(/\n/g, ' ');
      lines.push(`> ${snippet} — <${item.message.permalink}|View>`);
    } else if (item.file) {
      lines.push(`\`${item.file.name}\` — <${item.file.permalink}|View>`);
    }
  }

  await postToResponseUrl(ctx.responseUrl, lines.join('\n'), true);
}

// ─── Command: team ──────────────────────────────────────────────────────────

async function handleTeamCommand(
  config: ChannelConfig,
  subcommand: Subcommand,
  ctx: CommandContext,
): Promise<void> {
  const botToken = getBotToken(config);
  if (!botToken) {
    await postToResponseUrl(ctx.responseUrl, ':x: Missing bot token.', true);
    return;
  }

  const api = new SlackApi(botToken);
  const groupsResult = await api.usergroupsList();

  if (!groupsResult.ok) {
    await postToResponseUrl(ctx.responseUrl, `:x: Failed to list groups: ${groupsResult.error}`, true);
    return;
  }

  const handle = subcommand.teamHandle!.replace(/^@/, '');
  const group = groupsResult.usergroups?.find(
    (g) => g.handle === handle || g.name.toLowerCase() === handle.toLowerCase(),
  );

  if (!group) {
    await postToResponseUrl(ctx.responseUrl, `:x: User group "${handle}" not found.`, true);
    return;
  }

  const usersResult = await api.usergroupsUsersList(group.id);
  if (!usersResult.ok) {
    await postToResponseUrl(ctx.responseUrl, `:x: Failed to list group members: ${usersResult.error}`, true);
    return;
  }

  const userIds = usersResult.users || [];
  const lines = [`*${group.name}* (@${group.handle}) — ${userIds.length} members\n`];

  for (const uid of userIds.slice(0, 20)) {
    lines.push(`<@${uid}>`);
  }

  if (userIds.length > 20) {
    lines.push(`_...and ${userIds.length - 20} more_`);
  }

  await postToResponseUrl(ctx.responseUrl, lines.join('\n'), true);
}

// ─── Command: bookmark ──────────────────────────────────────────────────────

async function handleBookmarkCommand(
  config: ChannelConfig,
  subcommand: Subcommand,
  ctx: CommandContext,
): Promise<void> {
  const botToken = getBotToken(config);
  if (!botToken) {
    await postToResponseUrl(ctx.responseUrl, ':x: Missing bot token.', true);
    return;
  }

  const api = new SlackApi(botToken);
  const result = await api.bookmarksAdd(
    ctx.channelId,
    subcommand.bookmarkTitle || subcommand.bookmarkUrl!,
    'link',
    subcommand.bookmarkUrl,
  );

  if (!result.ok) {
    await postToResponseUrl(ctx.responseUrl, `:x: Failed to add bookmark: ${result.error}`, true);
    return;
  }

  await postToResponseUrl(ctx.responseUrl, `:bookmark: Bookmark added: ${subcommand.bookmarkUrl}`, true);
}

// ─── Command: bookmarks list ────────────────────────────────────────────────

async function handleBookmarksListCommand(
  config: ChannelConfig,
  ctx: CommandContext,
): Promise<void> {
  const botToken = getBotToken(config);
  if (!botToken) {
    await postToResponseUrl(ctx.responseUrl, ':x: Missing bot token.', true);
    return;
  }

  const api = new SlackApi(botToken);
  const result = await api.bookmarksList(ctx.channelId);

  if (!result.ok) {
    await postToResponseUrl(ctx.responseUrl, `:x: Failed to list bookmarks: ${result.error}`, true);
    return;
  }

  const bookmarks = result.bookmarks || [];
  if (bookmarks.length === 0) {
    await postToResponseUrl(ctx.responseUrl, ':bookmark: No bookmarks in this channel.', true);
    return;
  }

  const lines = [`*Channel Bookmarks* (${bookmarks.length})\n`];
  for (const bm of bookmarks) {
    lines.push(`<${bm.link}|${bm.title}>`);
  }

  await postToResponseUrl(ctx.responseUrl, lines.join('\n'), true);
}

// ─── Process free-form prompt ───────────────────────────────────────────────

async function processCommandAsync(
  engine: ChannelEngine,
  config: ChannelConfig,
  subcommand: Subcommand,
  ctx: CommandContext,
): Promise<void> {
  const promptContent = subcommand.prompt;

  const message: NormalizedMessage = {
    externalId: `cmd-${Date.now()}`,
    channelType: 'slack',
    channelConfigId: config.id,
    chatType: 'dm',
    content: promptContent,
    attachments: [],
    platformUser: {
      id: ctx.userId,
      name: ctx.userName,
    },
    raw: {
      _slackCommand: true,
      responseUrl: ctx.responseUrl,
      channelId: ctx.channelId,
    },
  };

  await engine.processMessage(message);
}
