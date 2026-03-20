import { Chat, emoji } from 'chat';
import type { Thread, Channel, SlashCommandEvent, ReactionEvent, SentMessage, PostableMessage, Attachment } from 'chat';
import { createMemoryState } from '@chat-adapter/state-memory';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { OpenCodeClient, type FileOutput } from './opencode.js';
import { SessionManager } from './sessions.js';
import { adapterModules } from './adapters/registry.js';
import type { AdapterCredentials } from './adapters/types.js';

export interface BotConfig {
  opencodeUrl?: string;
  botName?: string;
  agentName?: string;
  systemPrompt?: string;
  model?: { providerID: string; modelID: string };
}

export interface ChatInstanceDeps {
  credentials: AdapterCredentials;
  client: OpenCodeClient;
  sessions: SessionManager;
  getModel: () => { providerID: string; modelID: string } | undefined;
  setModel: (m: { providerID: string; modelID: string } | undefined) => void;
  getSystemPrompt: () => string | undefined;
  botName: string;
}

type Postable = {
  id: string;
  post(message: string | PostableMessage): Promise<SentMessage>;
  startTyping?(status?: string): Promise<void>;
};

export function createChatInstance(deps: ChatInstanceDeps): Chat | null {
  const adapters: Record<string, unknown> = {};
  for (const mod of adapterModules) {
    const creds = deps.credentials[mod.name];
    if (creds) {
      adapters[mod.name] = mod.createAdapter(creds);
      console.log(`[opencode-channels] ${mod.name} adapter initialized`);
    }
  }

  if (Object.keys(adapters).length === 0) {
    console.log('[opencode-channels] No adapter credentials — running server only (waiting for OAuth)');
    return null;
  }

  const bot = new Chat({
    userName: deps.botName,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapters: adapters as any,
    state: createMemoryState(),
    streamingUpdateIntervalMs: 500,
  });

  const { client, sessions, getModel, setModel, getSystemPrompt } = deps;

  function mimeFromFilename(name?: string): string | undefined {
    if (!name) return undefined;
    const ext = name.split('.').pop()?.toLowerCase();
    const map: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
      pdf: 'application/pdf', json: 'application/json', xml: 'application/xml',
      txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
      html: 'text/html', css: 'text/css', js: 'text/javascript', ts: 'text/typescript',
      py: 'text/x-python', rb: 'text/x-ruby', go: 'text/x-go', rs: 'text/x-rust',
      java: 'text/x-java', c: 'text/x-c', cpp: 'text/x-c++', h: 'text/x-c',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
      mp4: 'video/mp4', webm: 'video/webm',
      zip: 'application/zip', tar: 'application/x-tar', gz: 'application/gzip',
    };
    return ext ? map[ext] : undefined;
  }

  async function convertAttachments(
    attachments: Attachment[],
  ): Promise<Array<{ type: 'file'; mime: string; url: string; filename?: string }>> {
    const files: Array<{ type: 'file'; mime: string; url: string; filename?: string }> = [];
    for (const att of attachments) {
      try {
        let buffer: Buffer | undefined;
        if (att.data) {
          buffer = Buffer.isBuffer(att.data) ? att.data : Buffer.from(await (att.data as Blob).arrayBuffer());
        } else if (att.fetchData) {
          buffer = await att.fetchData();
        }
        if (!buffer || buffer.length === 0) continue;

        const typeFallback: Record<string, string> = {
          image: 'image/jpeg', video: 'video/mp4', audio: 'audio/mpeg',
        };
        const mime = att.mimeType || mimeFromFilename(att.name) || typeFallback[att.type] || 'application/octet-stream';
        if (mime === 'application/octet-stream') continue;
        const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
        files.push({ type: 'file', mime, url: dataUrl, filename: att.name });
      } catch (err) {
        console.warn('[opencode-channels] Failed to fetch attachment:', att.name, err);
      }
    }
    return files;
  }

  async function handleMessage(
    thread: Thread,
    userText: string,
    attachments?: Attachment[],
  ): Promise<void> {
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

    const parts: string[] = [];
    const sp = getSystemPrompt();
    if (sp) parts.push(sp);
    parts.push('[Response format: You are responding in a chat channel. Keep responses short and concise — brief paragraphs, short bullet points. Aim for the minimum words that fully answer the question.]');
    parts.push(userText);
    const prompt = parts.join('\n\n');

    const incomingFiles = attachments?.length
      ? await convertAttachments(attachments)
      : undefined;

    const filesBefore = new Set(
      (await client.getModifiedFiles().catch(() => [])).map(f => f.path),
    );
    const collectedFiles: FileOutput[] = [];

    const thinkingMsg = await thread.post('_Thinking..._');
    try {
      await thinkingMsg.addReaction(emoji.hourglass);
    } catch { /* reaction may fail if bot lacks permissions */ }

    try {
      const textStream = client.promptStream(sessionId, prompt, {
        agentName: sessions.getAgent(),
        model: getModel(),
        files: incomingFiles,
        collectedFiles,
      });

      let fullText = '';
      let lastEditAt = 0;
      const EDIT_INTERVAL_MS = 600;

      for await (const delta of textStream) {
        fullText += delta;
        const now = Date.now();
        if (now - lastEditAt >= EDIT_INTERVAL_MS) {
          await thinkingMsg.edit({ markdown: fullText + ' _..._' });
          lastEditAt = now;
        }
      }

      if (fullText) {
        await thinkingMsg.edit({ markdown: fullText });
      } else {
        await thinkingMsg.edit('_No response from the agent._');
      }

      try {
        await thinkingMsg.removeReaction(emoji.hourglass);
        await thinkingMsg.addReaction(emoji.check);
      } catch { /* ignore reaction errors */ }

    } catch (err) {
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

    await uploadNewFiles(thread, filesBefore, collectedFiles);
  }

  async function uploadNewFiles(
    thread: Postable,
    filesBefore: Set<string>,
    collectedFiles: FileOutput[],
  ): Promise<void> {
    try {
      console.log('[opencode-channels] uploadNewFiles called:', {
        collectedFiles: collectedFiles.map(f => ({ name: f.name, path: f.path })),
        filesBefore: [...filesBefore],
      });

      const uploaded = new Set<string>();

      // Upload files collected during the SSE stream
      for (const f of collectedFiles) {
        let buffer: Buffer | null = f.content ?? null;
        if (buffer) {
          console.log('[opencode-channels] Using inline content for:', f.name, 'size:', buffer.length);
        } else {
          // Try API first, fall back to reading directly from disk
          console.log('[opencode-channels] Downloading collected file:', f.path);
          buffer = await client.downloadFileByPath(f.path);
          console.log('[opencode-channels] Downloaded:', f.name, 'size:', buffer?.length ?? 0);
          if ((!buffer || buffer.length === 0) && f.path.startsWith('/') && existsSync(f.path)) {
            console.log('[opencode-channels] API returned empty, reading from disk:', f.path);
            try {
              buffer = await readFile(f.path);
              console.log('[opencode-channels] Read from disk:', f.name, 'size:', buffer.length);
            } catch (err) {
              console.warn('[opencode-channels] Disk read failed:', f.path, err);
            }
          }
        }
        if (buffer && buffer.length > 0) {
          await thread.post({
            markdown: `\`${f.name}\``,
            files: [{ data: buffer, filename: f.name }],
          });
          uploaded.add(f.name);
          console.log('[opencode-channels] Uploaded collected file:', f.name);
        }
      }

      // Also upload any newly modified files not already covered
      const modifiedFiles = await client.getModifiedFiles().catch(() => []);
      console.log('[opencode-channels] Modified files:', modifiedFiles.map(f => ({ name: f.name, path: f.path })));

      for (const f of modifiedFiles) {
        if (uploaded.has(f.name)) { console.log('[opencode-channels] Skipping (already uploaded):', f.name); continue; }
        if (filesBefore.has(f.path)) { console.log('[opencode-channels] Skipping (existed before):', f.name); continue; }

        console.log('[opencode-channels] Downloading modified file:', f.path);
        const buffer = await client.downloadFileByPath(f.path);
        console.log('[opencode-channels] Downloaded:', f.name, 'size:', buffer?.length ?? 0);
        if (buffer && buffer.length > 0) {
          await thread.post({
            markdown: `\`${f.name}\``,
            files: [{ data: buffer, filename: f.name }],
          });
          console.log('[opencode-channels] Uploaded modified file:', f.name);
        }
      }
    } catch (err) {
      console.warn('[opencode-channels] File upload failed:', err);
    }
  }

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
          setModel({ providerID: provider.id, modelID: model.id });
          const sent = await target.post({ markdown: `Model switched to \`${model.id}\` (${provider.name}).` });
          try { await sent.addReaction(emoji.check); } catch { /* ignore */ }
          return;
        }
      }
    }

    const available = providers.flatMap(p => p.models.map(m => `\`${m.id}\``)).slice(0, 10).join(', ');
    await target.post({ markdown: `No model matching "${query}". Available: ${available}` });
  }

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
        const cm = getModel();
        const current = cm ? `\n_Current:_ \`${cm.modelID}\`` : '';
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
        const cm = getModel();
        const modelStr = cm ? `\`${cm.modelID}\`` : 'default';
        await thinking.edit({ markdown: `${statusIcon} **Status:** ${statusText}\n**Model:** ${modelStr}\n**Sessions:** ${sessions.size} active` });
        break;
      }

      case 'model': {
        if (!restText) {
          const cm = getModel();
          const modelStr = cm ? `\`${cm.modelID}\`` : 'default';
          await event.channel.post(`_Current model:_ ${modelStr}`);
          return;
        }
        await handleModelSwitch(event.channel, restText);
        break;
      }

      case 'agent': {
        if (!restText) {
          const agentStr = sessions.getAgent() || 'default';
          await event.channel.post(`_Current agent:_ *${agentStr}*`);
          return;
        }
        sessions.setAgent(restText);
        const sent = await event.channel.post({ markdown: `Agent switched to **${restText}**.` });
        await sent.addReaction(emoji.check);
        break;
      }

      case 'reset': {
        sessions.clearAll();
        const sent = await event.channel.post('All sessions reset.');
        await sent.addReaction(emoji.check);
        break;
      }

      case 'diff': {
        const thinking = await event.channel.post('_Fetching diff..._');
        const lastId = sessions.lastSessionId();
        if (!lastId) {
          await thinking.edit('No active session to show diff for.');
          return;
        }
        const diff = await client.getSessionDiff(lastId);
        if (!diff) {
          await thinking.edit('No changes found.');
          return;
        }
        await thinking.edit({ markdown: `\`\`\`\n${diff.slice(0, 3500)}\n\`\`\`` });
        break;
      }

      case 'link': {
        const thinking = await event.channel.post('_Generating link..._');
        const lastId = sessions.lastSessionId();
        if (!lastId) {
          await thinking.edit('No active session.');
          return;
        }
        const shareUrl = await client.shareSession(lastId);
        if (shareUrl) {
          await thinking.edit(`Session link: ${shareUrl}`);
        } else {
          await thinking.edit('Session sharing not available.');
        }
        break;
      }

      default:
        if (args) {
          const thinking = await event.channel.post('_Thinking..._');
          try {
            await thinking.addReaction(emoji.hourglass);
          } catch { /* ignore */ }

          const sessionId = await client.createSession(sessions.getAgent());
          let responseText = '';
          try {
            for await (const delta of client.promptStream(sessionId, args, { model: getModel() })) {
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

  bot.onNewMention(async (thread, message) => {
    await thread.subscribe();
    await handleMessage(thread, message.text, message.attachments);
  });

  bot.onSubscribedMessage(async (thread, message) => {
    if (message.author.isMe) return;

    const text = message.text.trim();

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

    await handleMessage(thread, text, message.attachments);
  });

  bot.onSlashCommand('/oc', async (event) => {
    await handleSlashCommand(event);
  });

  bot.onSlashCommand('/opencode', async (event) => {
    await handleSlashCommand(event);
  });

  bot.onReaction(async (event: ReactionEvent) => {
    if (!event.added) return;

    const emojiName = event.rawEmoji;

    if (emojiName === 'arrows_counterclockwise' || emojiName === 'repeat') {
      if (event.message?.text && !event.message.author.isMe) {
        await handleMessage(event.thread as Thread, event.message.text);
      }
    }
  });

  return bot;
}

export function readAdaptersFromEnv(): AdapterCredentials {
  const credentials: AdapterCredentials = {};
  for (const mod of adapterModules) {
    const creds = mod.readCredentialsFromEnv();
    if (creds) {
      credentials[mod.name] = creds;
    }
  }
  return credentials;
}

export function createBot(config: BotConfig = {}) {
  const opencodeUrl = config.opencodeUrl || process.env.OPENCODE_URL || 'http://localhost:1707';
  const botName = config.botName || process.env.OPENCODE_BOT_NAME || 'opencode';

  const client = new OpenCodeClient({ baseUrl: opencodeUrl });
  const sessions = new SessionManager('per-thread', config.agentName);
  let currentModel = config.model;
  let systemPrompt = config.systemPrompt;

  const bot = createChatInstance({
    credentials: readAdaptersFromEnv(),
    client,
    sessions,
    getModel: () => currentModel,
    setModel: (m) => { currentModel = m; },
    getSystemPrompt: () => systemPrompt,
    botName,
  });

  return { bot, client, sessions };
}
