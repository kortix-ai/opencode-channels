/**
 * OpenCode Channels Bot — Chat SDK integration.
 *
 * UX features:
 *   - Typing indicator while waiting for OpenCode to respond
 *   - Thinking reaction while processing, checkmark when done
 *   - Streamed responses with live updates
 *   - Error handling with user-friendly messages
 *   - File uploads after agent responds
 *   - Slash commands, inline commands, reaction retry
 */

import { Chat, emoji } from 'chat';
import type { Thread, Channel, SlashCommandEvent, ReactionEvent, SentMessage, PostableMessage } from 'chat';
import { createSlackAdapter } from '@chat-adapter/slack';
import { createMemoryState } from '@chat-adapter/state-memory';

import { OpenCodeClient, type FileOutput } from './opencode.js';
import { SessionManager } from './sessions.js';

// ─── Config ─────────────────────────────────────────────────────────────────

export interface BotConfig {
  /** OpenCode server URL (default: OPENCODE_URL env or http://localhost:8000) */
  opencodeUrl?: string;
  /** Bot display name (default: OPENCODE_BOT_NAME env or "opencode") */
  botName?: string;
  /** Default agent name */
  agentName?: string;
  /** System prompt prepended to all messages */
  systemPrompt?: string;
  /** Model override */
  model?: { providerID: string; modelID: string };
}

// ─── State ──────────────────────────────────────────────────────────────────

let client: OpenCodeClient;
let sessions: SessionManager;
let currentModel: { providerID: string; modelID: string } | undefined;
let systemPrompt: string | undefined;

// ─── Create Bot ─────────────────────────────────────────────────────────────

export function createBot(config: BotConfig = {}) {
  const opencodeUrl = config.opencodeUrl || process.env.OPENCODE_URL || 'http://localhost:1707';
  const botName = config.botName || process.env.OPENCODE_BOT_NAME || 'opencode';

  client = new OpenCodeClient({ baseUrl: opencodeUrl });
  sessions = new SessionManager('per-thread', config.agentName);
  currentModel = config.model;
  systemPrompt = config.systemPrompt;

  const bot = new Chat({
    userName: botName,
    adapters: {
      slack: createSlackAdapter(),
    },
    state: createMemoryState(),
    streamingUpdateIntervalMs: 500,
  });

  // ── New @mention → subscribe + respond ──────────────────────────────

  bot.onNewMention(async (thread, message) => {
    await thread.subscribe();
    await handleMessage(thread, message.text);
  });

  // ── Subscribed thread message → continue conversation ───────────────

  bot.onSubscribedMessage(async (thread, message) => {
    if (message.author.isMe) return;

    const text = message.text.trim();

    // Inline commands
    if (text === '!reset' || text === '!clear') {
      sessions.invalidate(thread.id);
      const sent = await thread.post('Session reset. Starting fresh.');
      await sent.addReaction(emoji.check);
      return;
    }

    if (text === '!help') {
      await thread.post(formatHelp());
      return;
    }

    if (text.startsWith('!model ')) {
      const query = text.slice(7).trim();
      await handleModelSwitch(thread, query);
      return;
    }

    if (text.startsWith('!agent ')) {
      const name = text.slice(7).trim();
      sessions.setAgent(name);
      const sent = await thread.post({ markdown: `Agent switched to **${name}**.` });
      await sent.addReaction(emoji.check);
      return;
    }

    await handleMessage(thread, text);
  });

  // ── Slash commands ──────────────────────────────────────────────────

  bot.onSlashCommand('/oc', async (event) => {
    await handleSlashCommand(event);
  });

  bot.onSlashCommand('/opencode', async (event) => {
    await handleSlashCommand(event);
  });

  // ── Reactions ─────────────────────────────────────────────────────────

  bot.onReaction(async (event: ReactionEvent) => {
    if (!event.added) return;

    const emojiName = event.rawEmoji;

    // Retry — re-run the last prompt
    if (emojiName === 'arrows_counterclockwise' || emojiName === 'repeat') {
      if (event.message?.text && !event.message.author.isMe) {
        await handleMessage(event.thread as Thread, event.message.text);
      }
    }
  });

  return { bot, client, sessions };
}

// ─── Postable interface (Thread and Channel both implement this) ────────────

type Postable = {
  id: string;
  post(message: string | PostableMessage): Promise<SentMessage>;
  startTyping?(status?: string): Promise<void>;
};

// ─── Core message handler with UX indicators ───────────────────────────────

async function handleMessage(
  thread: Thread,
  userText: string,
): Promise<void> {
  // Show typing indicator while we set up the session
  await thread.startTyping('Thinking...');

  let sessionId: string;
  try {
    sessionId = await sessions.resolve(thread.id, client);
  } catch (err) {
    await thread.post({
      markdown: `Could not connect to OpenCode server. Is it running?\n\`\`\`\n${err instanceof Error ? err.message : String(err)}\n\`\`\``,
    });
    return;
  }

  // Build prompt with system context
  const parts: string[] = [];
  if (systemPrompt) parts.push(systemPrompt);
  parts.push('[Response format: You are responding in a chat channel. Keep responses short and concise — brief paragraphs, short bullet points. Aim for the minimum words that fully answer the question.]');
  parts.push(userText);
  const prompt = parts.join('\n\n');

  // Snapshot files before prompting
  const filesBefore = new Set(
    (await client.getModifiedFiles().catch(() => [])).map(f => f.path),
  );

  // Collected files from SSE events
  const collectedFiles: FileOutput[] = [];

  // Post a "thinking" placeholder and add hourglass reaction
  const thinkingMsg = await thread.post('_Thinking..._');
  try {
    await thinkingMsg.addReaction(emoji.hourglass);
  } catch { /* reaction may fail if bot lacks permissions */ }

  try {
    // Stream the response — wraps the OpenCode stream with edit-based updates
    const textStream = client.promptStream(sessionId, prompt, {
      agentName: sessions['agentName'],
      model: currentModel,
      collectedFiles,
    });

    // Collect the full response by consuming the stream, editing the placeholder
    let fullText = '';
    let lastEditAt = 0;
    const EDIT_INTERVAL_MS = 600;

    for await (const delta of textStream) {
      fullText += delta;
      const now = Date.now();
      // Throttle edits to avoid rate limiting
      if (now - lastEditAt >= EDIT_INTERVAL_MS) {
        await thinkingMsg.edit({ markdown: fullText + ' _..._' });
        lastEditAt = now;
      }
    }

    // Final edit with the complete response (no trailing indicator)
    if (fullText) {
      await thinkingMsg.edit({ markdown: fullText });
    } else {
      await thinkingMsg.edit('_No response from the agent._');
    }

    // Swap hourglass for checkmark
    try {
      await thinkingMsg.removeReaction(emoji.hourglass);
      await thinkingMsg.addReaction(emoji.check);
    } catch { /* ignore reaction errors */ }

  } catch (err) {
    // Edit the thinking message to show the error
    const errorMsg = err instanceof Error ? err.message : String(err);
    await thinkingMsg.edit({
      markdown: `Something went wrong:\n\`\`\`\n${errorMsg}\n\`\`\``,
    });

    try {
      await thinkingMsg.removeReaction(emoji.hourglass);
      await thinkingMsg.addReaction(emoji.x);
    } catch { /* ignore */ }
    return;
  }

  // After response: check for new files and upload them
  await uploadNewFiles(thread, filesBefore, collectedFiles);
}

// ─── File upload after response ─────────────────────────────────────────────

async function uploadNewFiles(
  thread: Postable,
  filesBefore: Set<string>,
  collectedFiles: FileOutput[],
): Promise<void> {
  try {
    const modifiedFiles = await client.getModifiedFiles().catch(() => []);
    const alreadySent = new Set(collectedFiles.map(f => f.name));

    for (const f of modifiedFiles) {
      if (alreadySent.has(f.name)) continue;
      if (filesBefore.has(f.path)) continue;

      const buffer = await client.downloadFileByPath(f.path);
      if (buffer && buffer.length > 0) {
        await thread.post({
          markdown: `\`${f.name}\``,
          files: [{ data: buffer, filename: f.name }],
        });
      }
    }
  } catch (err) {
    console.warn('[opencode-channels] File upload failed:', err);
  }
}

// ─── Slash command handler ──────────────────────────────────────────────────

async function handleSlashCommand(
  event: SlashCommandEvent,
): Promise<void> {
  const args = event.text.trim();
  const [subcommand, ...rest] = args.split(/\s+/);
  const restText = rest.join(' ');

  switch (subcommand?.toLowerCase()) {
    case '':
    case 'help':
      await event.channel.post(formatHelp());
      break;

    case 'models': {
      const thinking = await event.channel.post('_Fetching models..._');
      const providers = await client.listProviders();
      if (providers.length === 0) {
        await thinking.edit('No providers configured. Is OpenCode running?');
        return;
      }
      const lines = providers.flatMap(p =>
        p.models.map(m => `* \`${m.id}\` (${p.name})`),
      );
      const current = currentModel ? `\n_Current:_ \`${currentModel.modelID}\`` : '';
      await thinking.edit({ markdown: `**Available Models:**\n${lines.join('\n')}${current}` });
      break;
    }

    case 'agents': {
      const thinking = await event.channel.post('_Fetching agents..._');
      const agents = await client.listAgents();
      if (agents.length === 0) {
        await thinking.edit('No agents configured.');
        return;
      }
      const lines = agents.map(a => `* **${a.name}**${a.description ? ` - ${a.description}` : ''}`);
      await thinking.edit({ markdown: `**Available Agents:**\n${lines.join('\n')}` });
      break;
    }

    case 'status': {
      const thinking = await event.channel.post('_Checking status..._');
      const ready = await client.isReady();
      const statusIcon = ready ? ':large_green_circle:' : ':red_circle:';
      const statusText = ready ? 'Connected' : 'Disconnected';
      const modelStr = currentModel ? `\`${currentModel.modelID}\`` : 'default';
      await thinking.edit({ markdown: `${statusIcon} **Status:** ${statusText}\n**Model:** ${modelStr}\n**Sessions:** ${sessions['cache'].size} active` });
      break;
    }

    case 'model': {
      if (!restText) {
        const modelStr = currentModel ? `\`${currentModel.modelID}\`` : 'default';
        await event.channel.post(`_Current model:_ ${modelStr}`);
        return;
      }
      await handleModelSwitch(event.channel, restText);
      break;
    }

    case 'agent': {
      if (!restText) {
        const agentStr = sessions['agentName'] || 'default';
        await event.channel.post(`_Current agent:_ *${agentStr}*`);
        return;
      }
      sessions.setAgent(restText);
      const sent = await event.channel.post({ markdown: `Agent switched to **${restText}**.` });
      await sent.addReaction(emoji.check);
      break;
    }

    case 'reset': {
      sessions['cache'].clear();
      const sent = await event.channel.post('All sessions reset.');
      await sent.addReaction(emoji.check);
      break;
    }

    case 'diff': {
      const thinking = await event.channel.post('_Fetching diff..._');
      const lastSession = Array.from(sessions['cache'].values()).pop();
      if (!lastSession) {
        await thinking.edit('No active session to show diff for.');
        return;
      }
      const diff = await client.getSessionDiff(lastSession.opencodeSessionId);
      if (!diff) {
        await thinking.edit('No changes found.');
        return;
      }
      await thinking.edit({ markdown: `\`\`\`\n${diff.slice(0, 3500)}\n\`\`\`` });
      break;
    }

    case 'link': {
      const thinking = await event.channel.post('_Generating link..._');
      const lastSession = Array.from(sessions['cache'].values()).pop();
      if (!lastSession) {
        await thinking.edit('No active session.');
        return;
      }
      const shareUrl = await client.shareSession(lastSession.opencodeSessionId);
      if (shareUrl) {
        await thinking.edit(`Session link: ${shareUrl}`);
      } else {
        await thinking.edit('Session sharing not available.');
      }
      break;
    }

    default:
      // Unknown subcommand — treat as a question to the agent
      if (args) {
        const thinking = await event.channel.post('_Thinking..._');
        try {
          await thinking.addReaction(emoji.hourglass);
        } catch { /* ignore */ }

        const sessionId = await client.createSession(sessions['agentName']);
        let responseText = '';
        try {
          for await (const delta of client.promptStream(sessionId, args, { model: currentModel })) {
            responseText += delta;
          }
          await thinking.edit({ markdown: responseText || '_No response from agent._' });
          try {
            await thinking.removeReaction(emoji.hourglass);
            await thinking.addReaction(emoji.check);
          } catch { /* ignore */ }
        } catch (err) {
          await thinking.edit({
            markdown: `Something went wrong:\n\`\`\`\n${err instanceof Error ? err.message : String(err)}\n\`\`\``,
          });
          try {
            await thinking.removeReaction(emoji.hourglass);
            await thinking.addReaction(emoji.x);
          } catch { /* ignore */ }
        }
      } else {
        await event.channel.post(formatHelp());
      }
  }
}

// ─── Model switch helper ────────────────────────────────────────────────────

async function handleModelSwitch(
  target: Postable,
  query: string,
): Promise<void> {
  const providers = await client.listProviders();
  if (providers.length === 0) {
    await target.post('No providers available. Is OpenCode running?');
    return;
  }

  const queryLower = query.toLowerCase();
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.id.toLowerCase().includes(queryLower) || model.name.toLowerCase().includes(queryLower)) {
        currentModel = { providerID: provider.id, modelID: model.id };
        const sent = await target.post({ markdown: `Model switched to \`${model.id}\` (${provider.name}).` });
        try { await sent.addReaction(emoji.check); } catch { /* ignore */ }
        return;
      }
    }
  }

  const available = providers.flatMap(p => p.models.map(m => `\`${m.id}\``)).slice(0, 10).join(', ');
  await target.post({ markdown: `No model matching "${query}". Available: ${available}` });
}

// ─── Help text ──────────────────────────────────────────────────────────────

function formatHelp(): PostableMessage {
  return {
    markdown: `**OpenCode Channels - Commands**

**Slash commands:**
* \`/oc help\` - Show this help
* \`/oc models\` - List available models
* \`/oc model <name>\` - Switch model
* \`/oc agents\` - List available agents
* \`/oc agent <name>\` - Switch agent
* \`/oc status\` - Show connection status
* \`/oc reset\` - Reset all sessions
* \`/oc diff\` - Show recent changes
* \`/oc link\` - Share session link
* \`/oc <question>\` - Ask the agent directly

**In-thread commands:**
* \`!reset\` - Reset this thread's session
* \`!model <name>\` - Switch model
* \`!agent <name>\` - Switch agent
* \`!help\` - Show this help

**How it works:**
@mention the bot to start a conversation. All replies in that thread are automatically sent to the same OpenCode session.`,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

export { client, sessions };
