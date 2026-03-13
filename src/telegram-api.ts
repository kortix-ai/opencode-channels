/**
 * Direct Telegram Bot API helper.
 *
 * The Chat SDK's Telegram adapter sends `parse_mode: undefined` for all
 * non-Card messages, which means markdown is sent as plain text. This module
 * bypasses the Chat SDK for outgoing messages and calls the Telegram Bot API
 * directly with `parse_mode: "MarkdownV2"`.
 *
 * We still rely on the Chat SDK for:
 *   - Incoming message handling (polling / webhooks)
 *   - Thread/user resolution
 *   - Lock management (bypassed via our queue layer)
 */

const TELEGRAM_API_BASE = 'https://api.telegram.org';

// ── MarkdownV2 Escaping ────────────────────────────────────────────────
//
// Telegram MarkdownV2 requires escaping these characters outside of code blocks:
//   _ * [ ] ( ) ~ ` > # + - = | { } . !
//
// Inside `code` and `pre` blocks, only ` and \ need escaping.
// Inside (...) of inline links, only ) and \ need escaping.

const MD2_SPECIAL = /([_*\[\]()~`>#\+\-=|{}.!\\])/g;

/**
 * Escape a plain-text string for MarkdownV2.
 * Use this for text that should NOT contain any markdown formatting.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(MD2_SPECIAL, '\\$1');
}

/**
 * Convert standard markdown (from LLM output) to Telegram MarkdownV2.
 *
 * LLM output uses standard markdown:
 *   **bold**, *italic*, `code`, ```code blocks```, [links](url), etc.
 *
 * Telegram MarkdownV2 uses:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 *
 * Key differences:
 *   1. Bold: ** → * (but must not conflict with italic)
 *   2. Italic: * → _ (but __ is underline in Telegram)
 *   3. Special chars must be escaped outside formatting
 *   4. Strikethrough: ~~ → ~ (same)
 *
 * This is a best-effort conversion. For complex nested markdown, some
 * formatting may be lost, but the text will always be readable.
 */
export function markdownToTelegramV2(markdown: string): string {
  // Strategy: Process the markdown line by line, handling code blocks specially.
  // Within code blocks, only escape ` and \.
  // Outside code blocks, convert formatting and escape special chars.

  const lines = markdown.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';

  for (const line of lines) {
    // Check for code block fences
    const fenceMatch = line.match(/^(\s*)(```)(.*)/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        // Opening fence
        inCodeBlock = true;
        codeBlockLang = fenceMatch[3] ?? '';
        result.push('```' + escapeCodeContent(codeBlockLang));
      } else {
        // Closing fence
        inCodeBlock = false;
        codeBlockLang = '';
        result.push('```');
      }
      continue;
    }

    if (inCodeBlock) {
      // Inside code block: only escape ` and \
      result.push(escapeCodeContent(line));
    } else {
      result.push(convertLine(line));
    }
  }

  // If we ended inside an unclosed code block (streaming), close it
  if (inCodeBlock) {
    result.push('```');
  }

  return result.join('\n');
}

/** Escape content inside a code block (only ` and \ need escaping). */
function escapeCodeContent(text: string): string {
  return text.replace(/([`\\])/g, '\\$1');
}

/**
 * Convert a single line of standard markdown to MarkdownV2.
 * Handles inline code, bold, italic, links, and escapes remaining special chars.
 */
function convertLine(line: string): string {
  // Tokenize the line to separate inline code from the rest.
  // Inline code (`...`) content should only have ` and \ escaped.
  const tokens = tokenizeInlineCode(line);
  
  return tokens
    .map((token) => {
      if (token.type === 'code') {
        // Inline code: wrap in ` and escape content
        return '`' + escapeCodeContent(token.text) + '`';
      }
      // Regular text: convert formatting
      return convertFormattedText(token.text);
    })
    .join('');
}

interface Token {
  type: 'text' | 'code';
  text: string;
}

function tokenizeInlineCode(line: string): Token[] {
  const tokens: Token[] = [];
  const regex = /`([^`]*)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', text: line.slice(lastIndex, match.index) });
    }
    tokens.push({ type: 'code', text: match[1] ?? '' });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < line.length) {
    tokens.push({ type: 'text', text: line.slice(lastIndex) });
  }

  return tokens;
}

/**
 * Convert markdown formatting in non-code text and escape special characters.
 *
 * Strategy: tokenize the text into segments — formatting spans (bold, italic,
 * links, strikethrough) vs plain text. Convert formatting markers to their
 * MarkdownV2 equivalents, escape inner content of formatted spans, and
 * escape all special characters in plain text segments.
 *
 * This avoids the fragile regex-on-regex approach by building the output
 * from discrete tokens.
 */
function convertFormattedText(text: string): string {
  // We use a single pass regex that captures all markdown formatting constructs.
  // Matches (in priority order):
  //   1. Links: [text](url)
  //   2. Bold+italic: ***text***
  //   3. Bold: **text**
  //   4. Italic (asterisk): *text*
  //   5. Italic (underscore): _text_
  //   6. Strikethrough: ~~text~~
  // Everything else is plain text that needs full escaping.

  const FORMATTING_RE =
    /(\[([^\]]+)\]\(([^)]+)\))|\*{3}(.+?)\*{3}|\*{2}(.+?)\*{2}|(?<!\w)\*(.+?)\*(?!\w)|(?<!\w)_(.+?)_(?!\w)|~~(.+?)~~/g;

  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = FORMATTING_RE.exec(text)) !== null) {
    // Add escaped plain text before this match
    if (match.index > lastIndex) {
      parts.push(escapeMarkdownV2(text.slice(lastIndex, match.index)));
    }

    if (match[1]) {
      // Link: [text](url) — same syntax in MarkdownV2
      const linkText = match[2]!;
      const url = match[3]!;
      parts.push(`[${escapeMarkdownV2(linkText)}](${url.replace(/([)\\])/g, '\\$1')})`);
    } else if (match[4] != null) {
      // Bold+italic: ***text*** → *_text_*
      parts.push(`*_${escapeMarkdownV2(match[4])}_*`);
    } else if (match[5] != null) {
      // Bold: **text** → *text*
      parts.push(`*${escapeMarkdownV2(match[5])}*`);
    } else if (match[6] != null) {
      // Italic (asterisk): *text* → _text_
      parts.push(`_${escapeMarkdownV2(match[6])}_`);
    } else if (match[7] != null) {
      // Italic (underscore): _text_ → _text_ (same markers, escape content)
      parts.push(`_${escapeMarkdownV2(match[7])}_`);
    } else if (match[8] != null) {
      // Strikethrough: ~~text~~ → ~text~
      parts.push(`~${escapeMarkdownV2(match[8])}~`);
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining plain text
  if (lastIndex < text.length) {
    parts.push(escapeMarkdownV2(text.slice(lastIndex)));
  }

  return parts.join('');
}

// ── Telegram API Calls ─────────────────────────────────────────────────

export interface TelegramDirectConfig {
  botToken: string;
  apiBaseUrl?: string;
}

export interface TelegramSentMessage {
  messageId: number;
  chatId: number | string;
}

const TELEGRAM_MAX_MSG_LEN = 4096;

/**
 * Send a single raw message via Telegram API. Tries MarkdownV2 first,
 * falls back to plain text if parsing fails.
 */
async function sendSingleMessage(
  url: string,
  chatId: string | number,
  formatted: string,
  plainFallback: string,
  replyToMessageId?: number,
): Promise<{ message_id: number; chat: { id: number } }> {
  type TgResult = { ok: boolean; result?: { message_id: number; chat: { id: number } }; description?: string };

  const base: Record<string, unknown> = { chat_id: chatId };
  if (replyToMessageId) base.reply_to_message_id = replyToMessageId;

  let response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...base, text: formatted, parse_mode: 'MarkdownV2' }),
  });
  let data = await response.json() as TgResult;

  // If MarkdownV2 parsing fails, fall back to plain text
  if (!data.ok && data.description?.includes('parse')) {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base, text: plainFallback }),
    });
    data = await response.json() as TgResult;
  }

  // If still too long, truncate and retry
  if (!data.ok && data.description?.includes('too long')) {
    const truncated = plainFallback.slice(0, TELEGRAM_MAX_MSG_LEN - 20) + '\n\n_(truncated)_';
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base, text: truncated }),
    });
    data = await response.json() as TgResult;
  }

  if (!data.ok || !data.result) {
    throw new Error(`Telegram sendMessage failed: ${data.description ?? 'unknown error'}`);
  }
  return data.result;
}

/**
 * Split text into chunks that fit Telegram's 4096 char limit.
 * Splits at newline boundaries when possible.
 */
function splitMessage(text: string, maxLen: number = TELEGRAM_MAX_MSG_LEN): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Find a good split point (last newline before maxLen)
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0 || splitAt < maxLen * 0.3) {
      // No good newline — split at space or hard cut
      splitAt = remaining.lastIndexOf(' ', maxLen);
      if (splitAt <= 0) splitAt = maxLen;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, ''); // trim leading newline
  }

  return chunks;
}

/**
 * Send a message with MarkdownV2 formatting via direct Telegram API call.
 * Automatically splits long messages into multiple sends.
 * Falls back to plain text if MarkdownV2 parsing fails.
 */
export async function sendMessageDirect(
  config: TelegramDirectConfig,
  chatId: string | number,
  markdown: string,
  replyToMessageId?: number,
): Promise<TelegramSentMessage> {
  const baseUrl = config.apiBaseUrl || TELEGRAM_API_BASE;
  const url = `${baseUrl}/bot${config.botToken}/sendMessage`;

  // Split long messages
  const plainChunks = splitMessage(markdown);

  let lastResult: { message_id: number; chat: { id: number } } | undefined;

  for (let i = 0; i < plainChunks.length; i++) {
    const formatted = markdownToTelegramV2(plainChunks[i]!);
    // Only reply to the user's message on the first chunk
    lastResult = await sendSingleMessage(url, chatId, formatted, plainChunks[i]!, i === 0 ? replyToMessageId : undefined);
  }

  return {
    messageId: lastResult!.message_id,
    chatId: lastResult!.chat.id,
  };
}

/**
 * Edit a message with MarkdownV2 formatting via direct Telegram API call.
 * Falls back to plain text if MarkdownV2 parsing fails.
 */
export async function editMessageDirect(
  config: TelegramDirectConfig,
  chatId: string | number,
  messageId: number,
  markdown: string,
): Promise<void> {
  const baseUrl = config.apiBaseUrl || TELEGRAM_API_BASE;
  const url = `${baseUrl}/bot${config.botToken}/editMessageText`;

  const formatted = markdownToTelegramV2(markdown);

  let response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: formatted,
      parse_mode: 'MarkdownV2',
    }),
  });

  let data = await response.json() as { ok: boolean; description?: string };

  if (!data.ok && data.description?.includes('parse')) {
    console.warn('[telegram-api] MarkdownV2 edit parse failed, falling back to plain text:', data.description);
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: markdown, // fallback: original text as plain
      }),
    });
    data = await response.json() as typeof data;
  }

  // "message is not modified" is not a real error — just means content didn't change
  if (!data.ok && !data.description?.includes('message is not modified')) {
    throw new Error(`Telegram editMessageText failed: ${data.description ?? 'unknown error'}`);
  }
}

/**
 * Send typing action via direct Telegram API call.
 */
export async function sendTypingDirect(
  config: TelegramDirectConfig,
  chatId: string | number,
): Promise<void> {
  const baseUrl = config.apiBaseUrl || TELEGRAM_API_BASE;
  const url = `${baseUrl}/bot${config.botToken}/sendChatAction`;

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      action: 'typing',
    }),
  }).catch(() => {}); // Non-fatal
}

/**
 * Register bot commands with Telegram so they appear in the "/" menu.
 */
export async function setMyCommands(
  config: TelegramDirectConfig,
  commands: Array<{ command: string; description: string }>,
): Promise<void> {
  const baseUrl = config.apiBaseUrl || TELEGRAM_API_BASE;
  const url = `${baseUrl}/bot${config.botToken}/setMyCommands`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands }),
  });

  const data = await response.json() as { ok: boolean; description?: string };
  if (!data.ok) {
    console.warn('[telegram-api] setMyCommands failed:', data.description);
  }
}

/**
 * Extract the numeric chat ID from a Chat SDK thread ID.
 * Thread IDs from the Telegram adapter are prefixed: "telegram:chatId" or "telegram:chatId:topicId".
 */
export function extractChatId(threadId: string): string {
  // The adapter encodes thread IDs as "telegram:chatId" or "telegram:chatId:topicId"
  const parts = threadId.split(':');
  // Skip the "telegram" prefix
  if (parts[0] === 'telegram' && parts.length >= 2) {
    return parts[1]!;
  }
  // Fallback: if no prefix, first part is the chat ID
  return parts[0] ?? threadId;
}
