import type { SlackApi, SlackReplyMessage, SlackConversationMessage } from './api';

interface ExportMessage {
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  subtype?: string;
}

export interface ExportThreadOptions {
  channel: string;
  threadTs: string;
  api: SlackApi;
}

export interface ExportChannelOptions {
  messages: ExportMessage[];
  api: SlackApi;
  channelId: string;
}

// Cache resolved usernames within a single export run
type UsernameCache = Map<string, string>;

async function resolveUsername(
  userId: string,
  api: SlackApi,
  cache: UsernameCache,
): Promise<string> {
  const cached = cache.get(userId);
  if (cached) return cached;

  try {
    const info = await api.usersInfo(userId);
    const name =
      info.user?.profile?.display_name ||
      info.user?.real_name ||
      info.user?.name ||
      userId;
    cache.set(userId, name);
    return name;
  } catch {
    cache.set(userId, userId);
    return userId;
  }
}

function formatTimestamp(ts: string): string {
  const seconds = parseFloat(ts);
  if (isNaN(seconds)) return '';
  const date = new Date(seconds * 1000);
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function renderMarkdown(
  messages: Array<{ name: string; text: string; ts: string; isBot: boolean }>,
  title: string,
): string {
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push(`_Exported at ${new Date().toISOString()}_`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const time = formatTimestamp(msg.ts);
    const role = msg.isBot ? `**${msg.name}** (bot)` : `**${msg.name}**`;
    lines.push(`### ${role} — ${time}`);
    lines.push('');
    lines.push(msg.text || '_empty message_');
    lines.push('');
  }

  lines.push('---');
  lines.push(`_${messages.length} messages exported_`);

  return lines.join('\n');
}

export async function exportThreadAsMarkdown(options: ExportThreadOptions): Promise<string> {
  const { channel, threadTs, api } = options;
  const usernameCache: UsernameCache = new Map();

  const result = await api.conversationsReplies(channel, threadTs, 200);
  if (!result.ok || !result.messages || result.messages.length === 0) {
    return '# Thread Export\n\n_No messages found._';
  }

  const formatted = await formatMessages(result.messages, api, usernameCache);
  return renderMarkdown(formatted, `Thread Export — ${channel}`);
}

export async function exportChannelAsMarkdown(options: ExportChannelOptions): Promise<string> {
  const { messages, api, channelId } = options;
  const usernameCache: UsernameCache = new Map();

  const formatted = await formatMessages(messages, api, usernameCache);
  return renderMarkdown(formatted, `Channel Export — ${channelId}`);
}

async function formatMessages(
  messages: ExportMessage[],
  api: SlackApi,
  cache: UsernameCache,
): Promise<Array<{ name: string; text: string; ts: string; isBot: boolean }>> {
  const result: Array<{ name: string; text: string; ts: string; isBot: boolean }> = [];

  for (const msg of messages) {
    if (!msg.text && !msg.subtype) continue;

    const isBot = !!(msg.bot_id || msg.subtype === 'bot_message');
    let name: string;

    if (isBot) {
      name = 'Assistant';
    } else if (msg.user) {
      name = await resolveUsername(msg.user, api, cache);
    } else {
      name = 'Unknown';
    }

    result.push({
      name,
      text: msg.text || '',
      ts: msg.ts,
      isBot,
    });
  }

  return result;
}
