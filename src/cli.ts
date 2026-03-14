#!/usr/bin/env bun
/**
 * channels-send CLI — outbound messaging from the agent to Slack, Telegram, Discord.
 *
 * Usage:
 *   bun run /opt/opencode-channels/src/cli.ts send slack --to "#general" --text "Hello"
 *   bun run /opt/opencode-channels/src/cli.ts send telegram --to "123456789" --text "Done"
 *   bun run /opt/opencode-channels/src/cli.ts send discord --to "987654321098765432" --text "Build passed"
 *   bun run /opt/opencode-channels/src/cli.ts list
 *   bun run /opt/opencode-channels/src/cli.ts health
 *
 * Credentials are read from environment variables:
 *   Slack:    SLACK_BOT_TOKEN
 *   Telegram: TELEGRAM_BOT_TOKEN
 *   Discord:  DISCORD_BOT_TOKEN
 *
 * Output: JSON { ok, messageId?, platform, error? }
 * Exit code: 0 = success, 1 = failure
 */

import { markdownToTelegramV2 } from './telegram-api.js';

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  command: string;
  platform?: string;
  to?: string;
  text?: string;
  threadTs?: string;   // Slack thread_ts for replying in thread
  replyTo?: number;    // Telegram message_id to reply to
  flags: Record<string, string>;
} {
  const args = argv.slice(2);
  const command = args[0] ?? 'help';
  const platform = command === 'send' ? args[1] : undefined;

  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = args[i + 1] && !args[i + 1]!.startsWith('--') ? args[++i]! : 'true';
      flags[key] = val;
    }
  }

  return {
    command,
    platform,
    to: flags['to'],
    text: flags['text'],
    threadTs: flags['thread-ts'],
    replyTo: flags['reply-to'] ? parseInt(flags['reply-to']!, 10) : undefined,
    flags,
  };
}

// ── Output helpers ────────────────────────────────────────────────────────────

function success(data: Record<string, unknown>): never {
  console.log(JSON.stringify({ ok: true, ...data }));
  process.exit(0);
}

function fail(error: string, platform?: string): never {
  console.error(JSON.stringify({ ok: false, error, ...(platform ? { platform } : {}) }));
  process.exit(1);
}

function printHelp(): void {
  console.log(`
channels-send — Outbound messaging CLI for Kortix Channels

USAGE:
  bun run cli.ts <command> [options]

COMMANDS:
  send <platform> --to <target> --text <message>   Send a message
  list                                              List active channels
  health                                            Check channels service health
  help                                              Show this help

PLATFORMS:
  slack       Send to a Slack channel or user
  telegram    Send to a Telegram chat
  discord     Send to a Discord channel

SEND OPTIONS:
  --to <target>        Slack: "#channel" or "UXXXXXXXX" | Telegram: chat_id | Discord: channel_id
  --text <message>     Message text (supports markdown)
  --thread-ts <ts>     [Slack] Reply in thread with this thread_ts
  --reply-to <id>      [Telegram] Reply to message with this message_id

ENVIRONMENT VARIABLES:
  SLACK_BOT_TOKEN      Required for Slack
  TELEGRAM_BOT_TOKEN   Required for Telegram
  DISCORD_BOT_TOKEN    Required for Discord

EXAMPLES:
  bun run cli.ts send slack --to "#general" --text "Build passed ✅"
  bun run cli.ts send slack --to "U12345678" --text "Your task is complete"
  bun run cli.ts send telegram --to "123456789" --text "Done! See attached file."
  bun run cli.ts send discord --to "987654321098765432" --text "Deployment complete"
`);
}

// ── Slack ─────────────────────────────────────────────────────────────────────

async function sendSlack(to: string, text: string, threadTs?: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) fail('SLACK_BOT_TOKEN not set in environment', 'slack');

  // Determine if 'to' is a channel name (starts with #) or ID
  const channel = to.startsWith('#') ? to : to;

  const body: Record<string, unknown> = {
    channel,
    text,
    // Use mrkdwn for basic markdown support
    mrkdwn: true,
  };
  if (threadTs) body.thread_ts = threadTs;

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  const data = await res.json() as { ok: boolean; ts?: string; channel?: string; error?: string };

  if (!data.ok) {
    fail(data.error ?? 'slack api error', 'slack');
  }

  success({ platform: 'slack', messageId: data.ts, channel: data.channel });
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegram(chatId: string, text: string, replyToMessageId?: number): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) fail('TELEGRAM_BOT_TOKEN not set in environment', 'telegram');

  const apiBase = process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org';
  const url = `${apiBase}/bot${token}/sendMessage`;

  // Try MarkdownV2 first, fall back to plain text
  const formatted = markdownToTelegramV2(text);
  const baseBody: Record<string, unknown> = { chat_id: chatId };
  if (replyToMessageId) baseBody.reply_to_message_id = replyToMessageId;

  let res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...baseBody, text: formatted, parse_mode: 'MarkdownV2' }),
    signal: AbortSignal.timeout(15_000),
  });
  let data = await res.json() as { ok: boolean; result?: { message_id: number }; description?: string };

  if (!data.ok && data.description?.includes('parse')) {
    // Fall back to plain text
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseBody, text }),
      signal: AbortSignal.timeout(15_000),
    });
    data = await res.json() as typeof data;
  }

  if (!data.ok) {
    fail(data.description ?? 'telegram api error', 'telegram');
  }

  success({ platform: 'telegram', messageId: String(data.result?.message_id), chatId });
}

// ── Discord ───────────────────────────────────────────────────────────────────

async function sendDiscord(channelId: string, text: string): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) fail('DISCORD_BOT_TOKEN not set in environment', 'discord');

  // Split messages longer than 2000 chars (Discord limit)
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= 2000) {
      chunks.push(remaining);
      break;
    }
    const splitAt = remaining.lastIndexOf('\n', 2000) || 2000;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }

  let lastMessageId: string | undefined;
  for (const chunk of chunks) {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bot ${token}`,
      },
      body: JSON.stringify({ content: chunk }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = await res.json() as { id?: string; message?: string; code?: number };
    if (!res.ok) {
      fail(data.message ?? `discord api error (${res.status})`, 'discord');
    }
    lastMessageId = data.id;
  }

  success({ platform: 'discord', messageId: lastMessageId, channelId });
}

// ── Health / List ─────────────────────────────────────────────────────────────

async function checkHealth(): Promise<void> {
  const channelsUrl = process.env.CHANNELS_SERVICE_URL || 'http://localhost:3456';
  try {
    const res = await fetch(`${channelsUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    const data = await res.json() as { ok: boolean; adapters?: string[] };
    success({ service: 'opencode-channels', url: channelsUrl, ...data });
  } catch (err) {
    fail(`channels service unreachable at ${channelsUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function listChannels(): Promise<void> {
  const kortixApiUrl = process.env.KORTIX_API_URL || 'http://localhost:8008';
  const kortixToken = process.env.KORTIX_TOKEN;

  if (!kortixToken) {
    // Fall back to local health check if no token
    await checkHealth();
    return;
  }

  try {
    const res = await fetch(`${kortixApiUrl}/v1/channels`, {
      headers: { Authorization: `Bearer ${kortixToken}` },
      signal: AbortSignal.timeout(8_000),
    });
    const data = await res.json() as { success: boolean; data?: unknown[]; total?: number };
    if (!data.success) fail('failed to list channels');
    success({ channels: data.data, total: data.total });
  } catch (err) {
    fail(`failed to list channels: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, platform, to, text, threadTs, replyTo } = parseArgs(process.argv);

  switch (command) {
    case 'send': {
      if (!platform) fail('platform required: send <platform> --to <target> --text <message>');
      if (!to) fail(`--to <target> required`, platform);
      if (!text) fail(`--text <message> required`, platform);

      switch (platform.toLowerCase()) {
        case 'slack':
          await sendSlack(to, text, threadTs);
          break;
        case 'telegram':
          await sendTelegram(to, text, replyTo);
          break;
        case 'discord':
          await sendDiscord(to, text);
          break;
        default:
          fail(`unknown platform "${platform}". Supported: slack, telegram, discord`);
      }
      break;
    }

    case 'health':
      await checkHealth();
      break;

    case 'list':
      await listChannels();
      break;

    case 'help':
    default:
      printHelp();
      process.exit(0);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
