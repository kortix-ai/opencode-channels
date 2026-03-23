import { Chat, emoji } from 'chat';
import type { Thread, Channel, Message, SlashCommandEvent, ReactionEvent, SentMessage, PostableMessage, PostableMarkdown, Attachment } from 'chat';
import { createMemoryState } from '@chat-adapter/state-memory';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { OpenCodeClient, type FileOutput, type StreamEvent } from './opencode.js';
import { SessionManager } from './sessions.js';
import { adapterModules } from './adapters/registry.js';
import type { AdapterCredentials, TelegramCredentials } from './adapters/types.js';
import {
  type TelegramDirectConfig,
  type TelegramSentMessage,
  sendMessageDirect,
  editMessageDirect,
  sendTypingDirect,
  setMyCommands,
  extractChatId,
} from './telegram-api.js';

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
  /** Telegram bot token for direct API calls (bypassing Chat SDK's broken parse_mode). */
  telegramConfig?: TelegramDirectConfig;
}

type Postable = {
  id: string;
  post(message: string | PostableMessage): Promise<SentMessage>;
  startTyping?(status?: string): Promise<void>;
};

export async function createChatInstance(deps: ChatInstanceDeps): Promise<Chat | null> {
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
    // logger: 'debug',  // Uncomment for verbose Chat SDK logging
  });

  const { client, sessions, getModel, setModel, getSystemPrompt, telegramConfig } = deps;

  // ── Telegram direct API detection ────────────────────────────────────
  // The Chat SDK's Telegram adapter sends parse_mode: undefined for all
  // non-Card messages, so markdown is rendered as plain text. When we have
  // a telegramConfig, we bypass thread.post()/edit() for Telegram threads
  // and call the Telegram API directly with parse_mode: "MarkdownV2".

  function isTelegramThread(thread: { adapter: { name: string } }): boolean {
    return telegramConfig != null && thread.adapter.name === 'telegram';
  }

  // ── Message queue & debounce ──────────────────────────────────────────
  // The Chat SDK locks per-thread and DROPS messages that arrive while
  // another is being processed. For rapid-fire typing (common in Telegram),
  // we need to collect messages and send them as one prompt.
  //
  // How it works:
  //   1. When a message arrives, add it to the thread's queue.
  //   2. Start/reset a debounce timer (DEBOUNCE_MS).
  //   3. When the timer fires (no new messages for DEBOUNCE_MS), flush the
  //      queue: concatenate all buffered texts and call handleMessage once.
  //   4. If handleMessage is already running for that thread, wait for it
  //      to finish before flushing.

  const DEBOUNCE_MS = 2500;

  interface QueuedMsg {
    text: string;
    attachments?: Attachment[];
    /** Telegram message_id of the user's message (for reply_to_message_id) */
    telegramMsgId?: number;
    /** Text of the message the user replied to (for context) */
    replyContext?: string;
  }

  interface ThreadQueue {
    messages: QueuedMsg[];
    timer: ReturnType<typeof setTimeout> | null;
    processing: boolean;
    thread: Thread;
    /** The latest incoming Telegram message_id — used for reply_to */
    lastUserMsgId?: number;
  }

  const threadQueues = new Map<string, ThreadQueue>();

  // Track which sessions have already received the channel context injection.
  // We inject it once (first message) then never again — keeps tokens lean.
  const contextInjectedSessions = new Set<string>();

  /** Extract the bare platform-native ID from a Chat SDK thread ID.
   *  e.g. "slack:C0AG3PJLCHH:1773444548.094629" → "C0AG3PJLCHH"
   *       "telegram:123456789" → "123456789"
   *       "discord:987654321" → "987654321"
   */
  function extractPlatformId(threadId: string): string {
    const parts = threadId.split(':');
    // slack:CHANNEL:THREAD_TS → CHANNEL (index 1)
    // telegram:CHAT_ID        → CHAT_ID (index 1)
    // discord:CHANNEL_ID      → CHANNEL_ID (index 1)
    return parts[1] ?? threadId;
  }

  /** Extract Telegram-specific info from a Chat SDK message's raw field. */
  function extractTelegramRaw(message: Message): { msgId?: number; replyContext?: string } {
    const raw = (message as unknown as { raw?: Record<string, unknown> }).raw;
    if (!raw) return {};
    const msgId = raw.message_id as number | undefined;
    // If the user replied to another message, grab its text for context
    const replyTo = raw.reply_to_message as Record<string, unknown> | undefined;
    let replyContext: string | undefined;
    if (replyTo) {
      const replyText = (replyTo.text as string) || (replyTo.caption as string) || '';
      if (replyText) {
        replyContext = replyText;
      }
    }
    return { msgId, replyContext };
  }

  function enqueueMessage(thread: Thread, text: string, attachments?: Attachment[], rawMessage?: Message): void {
    console.log(`[opencode-channels] enqueueMessage: threadId=${thread.id}, text="${text.slice(0, 60)}"`);
    let q = threadQueues.get(thread.id);
    if (!q) {
      q = { messages: [], timer: null, processing: false, thread };
      threadQueues.set(thread.id, q);
    }
    // Always update the thread reference (it may have new context)
    q.thread = thread;

    // Extract Telegram message ID and reply context
    const tgRaw = rawMessage ? extractTelegramRaw(rawMessage) : {};
    q.messages.push({ text, attachments, telegramMsgId: tgRaw.msgId, replyContext: tgRaw.replyContext });
    if (tgRaw.msgId) q.lastUserMsgId = tgRaw.msgId;

    // Show typing indicator so the user knows we received their message
    if (isTelegramThread(q.thread) && telegramConfig) {
      sendTypingDirect(telegramConfig, extractChatId(q.thread.id)).catch(() => {});
    } else {
      thread.startTyping().catch(() => {});
    }

    // Reset debounce timer
    if (q.timer) clearTimeout(q.timer);
    q.timer = setTimeout(() => void flushQueue(thread.id), DEBOUNCE_MS);
  }

  async function flushQueue(threadId: string): Promise<void> {
    const q = threadQueues.get(threadId);
    if (!q || q.messages.length === 0) return;

    // If already processing, don't start another — the completion handler
    // will re-check and flush again.
    if (q.processing) {
      console.log(`[opencode-channels] flushQueue: threadId=${threadId} still processing, skipping`);
      return;
    }
    q.processing = true;
    q.timer = null;

    // Drain the queue
    const batch = q.messages.splice(0);
    const combinedText = batch.map(m => m.text).join('\n');
    console.log(`[opencode-channels] flushQueue: threadId=${threadId}, batch=${batch.length}, text="${combinedText.slice(0, 60)}"`);
    // Merge attachments from all messages
    const allAttachments = batch.flatMap(m => m.attachments ?? []);
    const thread = q.thread;
    // Collect reply context from all messages (first one with context wins)
    const replyContext = batch.find(m => m.replyContext)?.replyContext;
    // Use the last user message ID for reply_to
    const replyToMsgId = q.lastUserMsgId;

    try {
      await handleMessage(
        thread,
        combinedText,
        allAttachments.length > 0 ? allAttachments : undefined,
        replyToMsgId,
        replyContext,
      );
    } catch (err) {
      console.error('[opencode-channels] handleMessage threw:', err instanceof Error ? err.message : err);
    } finally {
      q.processing = false;
      // Check if more messages arrived while we were processing
      if (q.messages.length > 0) {
        // Reset debounce for the new batch
        if (q.timer) clearTimeout(q.timer);
        q.timer = setTimeout(() => flushQueue(threadId), DEBOUNCE_MS);
      }
    }
  }

  // ── Save attachments to disk ────────────────────────────────────────
  // Instead of passing files as base64 blobs to OpenCode (which breaks on
  // unsupported media types), we save them to a local directory and tell
  // the agent about the file paths so it can read them with its own tools.

  const UPLOADS_DIR = join(process.cwd(), 'uploads');

  async function saveAttachmentsToDisk(
    attachments: Attachment[],
  ): Promise<string[]> {
    const savedPaths: string[] = [];
    await mkdir(UPLOADS_DIR, { recursive: true });

    for (const att of attachments) {
      try {
        let buffer: Buffer | undefined;
        if (att.data) {
          buffer = Buffer.isBuffer(att.data) ? att.data : Buffer.from(await (att.data as Blob).arrayBuffer());
        } else if (att.fetchData) {
          buffer = await att.fetchData();
        }
        if (!buffer || buffer.length === 0) continue;

        const timestamp = Date.now();
        const safeName = (att.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${timestamp}_${safeName}`;
        const filePath = join(UPLOADS_DIR, filename);

        await writeFile(filePath, buffer);
        savedPaths.push(filePath);
        console.log(`[opencode-channels] Saved attachment: ${filePath} (${buffer.length} bytes)`);
      } catch (err) {
        console.warn('[opencode-channels] Failed to save attachment:', att.name, err);
      }
    }
    return savedPaths;
  }

  async function handleMessage(
    thread: Thread,
    userText: string,
    attachments?: Attachment[],
    replyToMsgId?: number,
    replyContext?: string,
  ): Promise<void> {
    const useTelegramDirect = isTelegramThread(thread) && telegramConfig != null;
    const chatId = useTelegramDirect ? extractChatId(thread.id) : '';
    const adapterName = (thread as unknown as { adapter?: { name: string } }).adapter?.name ?? 'unknown';
    // The bare platform-native ID (channel ID for Slack, chat_id for Telegram)
    const platformId = extractPlatformId(thread.id);

    // Show typing indicator
    try {
      if (useTelegramDirect) {
        await sendTypingDirect(telegramConfig!, chatId);
      } else {
        await thread.startTyping('Thinking...');
      }
    } catch {
      // startTyping may fail for some adapters (e.g. fake chat IDs) — not fatal
    }

    console.log(`[opencode-channels] handleMessage: threadId=${thread.id}, text="${userText.slice(0, 80)}..."`);

    let sessionId: string;
    try {
      sessionId = await sessions.resolve(thread.id, client);
    } catch (err) {
      const errText = `Could not connect to OpenCode server. Is it running?\n\`\`\`\n${err instanceof Error ? err.message : String(err)}\n\`\`\``;
      if (useTelegramDirect) {
        await sendMessageDirect(telegramConfig!, chatId, errText).catch(() => {});
      } else {
        await thread.post({ markdown: errText });
      }
      return;
    }

    // Save any attached files to disk and append paths to the message
    let fileContext = '';
    if (attachments?.length) {
      const savedPaths = await saveAttachmentsToDisk(attachments);
      if (savedPaths.length > 0) {
        const fileLines = savedPaths.map(p => `- ${p}`).join('\n');
        fileContext = `\n\n[The user attached ${savedPaths.length} file(s). They have been saved locally:\n${fileLines}\nYou can read/process them using your tools.]`;
      }
    }

    // If the user replied to a previous message, include that context
    let replyPrefix = '';
    if (replyContext) {
      // Truncate long quoted messages
      const quoted = replyContext.length > 500 ? replyContext.slice(0, 500) + '...' : replyContext;
      replyPrefix = `[The user is replying to this earlier message: "${quoted}"]\n\n`;
    }

    const parts: string[] = [];

    // Inject full channel context only on the FIRST message of a session.
    // After that it lives in the session history — no need to repeat it.
    const isFirstMessage = !contextInjectedSessions.has(sessionId);
    if (isFirstMessage) {
      contextInjectedSessions.add(sessionId);
      const sp = getSystemPrompt();
      if (sp) parts.push(sp);
      // Compact one-time context block
      const sendTo = platformId || thread.id;
      parts.push(
        `[Channel: ${adapterName} | ID: ${sendTo} | Reply: curl -s -X POST http://localhost:3456/send -d '{"platform":"${adapterName}","to":"${sendTo}","text":"..."}']`,
      );
    }

    parts.push(replyPrefix + userText + fileContext);
    const prompt = parts.join('\n\n');

    const filesBefore = new Set(
      (await client.getModifiedFiles().catch(() => [])).map(f => f.path),
    );
    const collectedFiles: FileOutput[] = [];

    // ── Streaming response ──────────────────────────────────────────────
    // Uses promptStreamEvents to get text deltas AND tool activity events.
    // During tool calls, the message shows what the agent is doing instead
    // of appearing stuck on the last text chunk.

    let responseMsg: SentMessage | null = null;
    let telegramMsg: TelegramSentMessage | null = null;

    // ── Telegram helpers ──────────────────────────────────────────────
    // Streaming edits use PLAIN TEXT to avoid MarkdownV2 parse errors on
    // partial/intermediate content. Only the FINAL message uses MarkdownV2
    // for proper formatting.

    /** Send/edit a plain-text streaming update (no formatting). */
    async function postStreamingUpdate(plainText: string): Promise<void> {
      if (useTelegramDirect) {
        const baseUrl = telegramConfig!.apiBaseUrl || 'https://api.telegram.org';
        if (!telegramMsg) {
          try {
            const body: Record<string, unknown> = { chat_id: chatId, text: plainText };
            if (replyToMsgId) body.reply_to_message_id = replyToMsgId;
            const res = await fetch(`${baseUrl}/bot${telegramConfig!.botToken}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const data = await res.json() as { ok: boolean; result?: { message_id: number; chat: { id: number } } };
            if (data.ok && data.result) {
              telegramMsg = { messageId: data.result.message_id, chatId: data.result.chat.id };
            }
          } catch { /* non-fatal */ }
        } else {
          try {
            await fetch(`${baseUrl}/bot${telegramConfig!.botToken}/editMessageText`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, message_id: telegramMsg.messageId, text: plainText }),
            });
          } catch { /* non-fatal */ }
        }
      } else {
        if (!responseMsg) {
          try { responseMsg = await thread.post(plainText); } catch { /* non-fatal */ }
        } else {
          try { await responseMsg.edit(plainText); } catch { /* non-fatal */ }
        }
      }
    }

    /** Send/edit the FINAL formatted message (MarkdownV2 for Telegram). */
    async function postFinalMsg(markdown: string): Promise<void> {
      if (useTelegramDirect) {
        if (!telegramMsg) {
          // No streaming message yet — send new formatted message (as reply)
          try { telegramMsg = await sendMessageDirect(telegramConfig!, chatId, markdown, replyToMsgId); } catch (err) { console.error('[opencode-channels] sendMessageDirect failed:', err instanceof Error ? err.message : err); }
        } else {
          // Edit existing streaming message with formatted version
          try { await editMessageDirect(telegramConfig!, chatId, telegramMsg.messageId, markdown); } catch (err) { console.error('[opencode-channels] editMessageDirect failed:', err instanceof Error ? err.message : err); }
        }
      } else {
        if (!responseMsg) {
          try { responseMsg = await thread.post({ markdown }); } catch { /* non-fatal */ }
        } else {
          try { await responseMsg.edit({ markdown }); } catch { /* non-fatal */ }
        }
      }
    }

    async function refreshTyping(): Promise<void> {
      if (useTelegramDirect) {
        sendTypingDirect(telegramConfig!, chatId).catch(() => {});
      }
    }

    try {
      console.log(`[opencode-channels] handleMessage: sessionId=${sessionId}, sending prompt...`);

      const eventStream = client.promptStreamEvents(sessionId, prompt, {
        agentName: sessions.getAgent(),
        model: getModel(),
      });

      let fullText = '';
      let lastEditAt = 0;
      let toolsUsed = 0;
      const EDIT_INTERVAL_MS = 600;

      for await (const event of eventStream) {
        if (event.type === 'text' && event.data) {
          fullText += event.data;

          const now = Date.now();
          if (now - lastEditAt >= EDIT_INTERVAL_MS) {
            await postStreamingUpdate(fullText + ' ...');
            await refreshTyping();
            lastEditAt = now;
          }
        }

        if (event.type === 'tool' && event.tool) {
          if (event.tool.status === 'running') {
            toolsUsed++;
            // Just keep typing indicator — don't clutter the message with tool names
            await refreshTyping();
            // If no text yet, show a simple working indicator
            if (!telegramMsg && !responseMsg) {
              await postStreamingUpdate('Thinking...');
              lastEditAt = Date.now();
            }
          } else if (event.tool.status === 'completed' || event.tool.status === 'error') {
            if (fullText) {
              await postStreamingUpdate(fullText + ' ...');
              lastEditAt = Date.now();
            }
          }
        }

        if (event.type === 'permission' && event.permission) {
          // Auto-approve tool permissions so the agent doesn't hang
          console.log(`[opencode-channels] Auto-approving permission: ${event.permission.tool} (${event.permission.id})`);
          await client.replyPermission(event.permission.id, true);
        }

        if (event.type === 'busy') {
          await refreshTyping();
          if (!responseMsg && !telegramMsg) {
            await postStreamingUpdate('Thinking...');
            lastEditAt = Date.now();
          }
        }

        if (event.type === 'file' && event.file) {
          collectedFiles.push({
            name: event.file.name,
            path: event.file.url,
          });
        }

        if (event.type === 'error') {
          throw new Error(event.data || 'Agent error');
        }
      }

      // ── Final message ──
      // The final message uses MarkdownV2 for proper formatting.
      // Streaming updates above used plain text to avoid parse issues.
      console.log(`[opencode-channels] handleMessage: stream done, fullText length=${fullText.length}, toolsUsed=${toolsUsed}`);
      if (fullText) {
        await postFinalMsg(fullText);
      } else {
        await postFinalMsg('No response from the agent.');
      }

    } catch (err) {
      console.error('[opencode-channels] handleMessage error:', err instanceof Error ? err.message : err);
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorMarkdown = `Something went wrong:\n\`\`\`\n${errorMsg}\n\`\`\``;
      await postFinalMsg(errorMarkdown);
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
      const uploaded = new Set<string>();

      for (const f of collectedFiles) {
        let buffer: Buffer | null = f.content ?? null;
        if (!buffer) {
          buffer = await client.downloadFileByPath(f.path);
          if ((!buffer || buffer.length === 0) && f.path.startsWith('/') && existsSync(f.path)) {
            try {
              buffer = await readFile(f.path);
            } catch {
              // Disk read failed — skip this file
            }
          }
        }
        if (buffer && buffer.length > 0) {
          await thread.post({
            markdown: `\`${f.name}\``,
            files: [{ data: buffer, filename: f.name }],
          });
          uploaded.add(f.name);
        }
      }

      const modifiedFiles = await client.getModifiedFiles().catch(() => []);
      for (const f of modifiedFiles) {
        if (uploaded.has(f.name) || filesBefore.has(f.path)) continue;
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
        const agentList = await client.listAgents();
        const matched = agentList.find(a => a.name.toLowerCase() === restText.toLowerCase());
        if (!matched) {
          const names = agentList.map(a => `\`${a.name}\``).join(', ');
          await event.channel.post({ markdown: `Agent "${restText}" not found. Available: ${names}` });
          return;
        }
        sessions.setAgent(matched.name);
        sessions.clearAll(); // Force new sessions with new agent
        const sent = await event.channel.post({ markdown: `Agent switched to **${matched.name}**. Sessions reset.` });
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
          const sessionId = await client.createSession(sessions.getAgent());
          let responseText = '';
          try {
            for await (const delta of client.promptStream(sessionId, args, { model: getModel() })) {
              responseText += delta;
            }
            await event.channel.post({ markdown: responseText || '_No response from agent._' });
          } catch (err) {
            await event.channel.post({
              markdown: `Something went wrong:\n\`\`\`\n${err instanceof Error ? err.message : String(err)}\n\`\`\``,
            });
          }
        } else {
          await event.channel.post(formatHelp());
        }
    }
  }

  function formatHelp(): PostableMarkdown {
    return {
      markdown: `**OpenCode Channels - Commands**

**Slash commands:**
* \`/help\` - Show this help
* \`/models\` - List available models
* \`/model <name>\` - Switch model
* \`/agents\` - List available agents
* \`/agent <name>\` - Switch agent
* \`/status\` - Show connection status
* \`/reset\` - Reset session
* \`/new\` - Start a fresh session
* \`/diff\` - Show recent changes
* \`/link\` - Share session link

Just send a message to start chatting with the agent.`,
    };
  }

  // ── Telegram /command handler ────────────────────────────────────────
  // Telegram bots receive /commands as regular messages. We intercept them
  // here and handle them directly (using the direct Telegram API for formatted
  // responses). Returns true if the message was a command, false otherwise.

  async function handleTelegramCommand(thread: Thread, text: string): Promise<boolean> {
    if (!text.startsWith('/')) return false;

    // Strip @botname suffix from commands (e.g. /help@TEd123123Bot)
    const rawCmd = text.split(/\s+/)[0]!.replace(/@\S+$/, '').toLowerCase();
    const args = text.slice(text.indexOf(' ') + 1).trim();
    const hasArgs = text.includes(' ');

    const useDirect = isTelegramThread(thread) && telegramConfig != null;
    const chatId = useDirect ? extractChatId(thread.id) : '';

    // Helper to send a formatted response
    async function reply(markdown: string): Promise<void> {
      if (useDirect) {
        await sendMessageDirect(telegramConfig!, chatId, markdown).catch(() => {});
      } else {
        await thread.post({ markdown }).catch(() => {});
      }
    }

    switch (rawCmd) {
      case '/start': {
        await reply('**Welcome to OpenCode!**\n\nJust send me a message and I\'ll respond using AI. Use /help to see all commands.');
        return true;
      }

      case '/help': {
        await reply(formatHelp().markdown!);
        return true;
      }

      case '/models': {
        const providers = await client.listProviders();
        if (providers.length === 0) {
          await reply('No providers configured. Is OpenCode running?');
          return true;
        }
        const lines = providers.flatMap(p =>
          p.models.map(m => `- \`${m.id}\` (${p.name})`),
        );
        const cm = getModel();
        const current = cm ? `\n\n_Current:_ \`${cm.modelID}\`` : '';
        await reply(`**Available Models:**\n${lines.join('\n')}${current}`);
        return true;
      }

      case '/model': {
        if (!hasArgs) {
          const cm = getModel();
          const modelStr = cm ? `\`${cm.modelID}\`` : 'default';
          await reply(`_Current model:_ ${modelStr}\n\nUsage: \`/model <name>\``);
          return true;
        }
        const query = args;
        const providers = await client.listProviders();
        const queryLower = query.toLowerCase();
        for (const provider of providers) {
          for (const model of provider.models) {
            if (model.id.toLowerCase().includes(queryLower) || model.name.toLowerCase().includes(queryLower)) {
              setModel({ providerID: provider.id, modelID: model.id });
              await reply(`Model switched to \`${model.id}\` (${provider.name}).`);
              return true;
            }
          }
        }
        const available = providers.flatMap(p => p.models.map(m => `\`${m.id}\``)).slice(0, 10).join(', ');
        await reply(`No model matching "${query}". Available: ${available}`);
        return true;
      }

      case '/agents': {
        const agents = await client.listAgents();
        if (agents.length === 0) {
          await reply('No agents configured.');
          return true;
        }
        const lines = agents.map(a => `- **${a.name}**${a.description ? ` — ${a.description}` : ''}`);
        await reply(`**Available Agents:**\n${lines.join('\n')}`);
        return true;
      }

      case '/agent': {
        if (!hasArgs) {
          const agentStr = sessions.getAgent() || 'default';
          await reply(`_Current agent:_ **${agentStr}**\n\nUsage: \`/agent <name>\``);
          return true;
        }
        // Validate agent name against available agents
        const availableAgents = await client.listAgents();
        const matchedAgent = availableAgents.find(a =>
          a.name.toLowerCase() === args.toLowerCase()
        );
        if (!matchedAgent) {
          const names = availableAgents.map(a => `\`${a.name}\``).join(', ');
          await reply(`Agent "${args}" not found.\n\nAvailable: ${names}`);
          return true;
        }
        sessions.setAgent(matchedAgent.name);
        sessions.invalidate(thread.id); // Force new session with new agent
        await reply(`Agent switched to **${matchedAgent.name}**. Session reset.`);
        return true;
      }

      case '/status': {
        const ready = await client.isReady();
        const statusText = ready ? '🟢 Connected' : '🔴 Disconnected';
        const cm = getModel();
        const modelStr = cm ? `\`${cm.modelID}\`` : 'default';
        const agentStr = sessions.getAgent() || 'default';
        await reply(`**Status:** ${statusText}\n**Model:** ${modelStr}\n**Agent:** ${agentStr}\n**Sessions:** ${sessions.size} active`);
        return true;
      }

      case '/reset': {
        sessions.invalidate(thread.id);
        await reply('Session reset. Starting fresh.');
        return true;
      }

      case '/new': {
        sessions.invalidate(thread.id);
        await reply('New session started. Send your first message.');
        return true;
      }

      case '/diff': {
        const lastId = sessions.lastSessionId();
        if (!lastId) {
          await reply('No active session to show diff for.');
          return true;
        }
        const diff = await client.getSessionDiff(lastId);
        if (!diff) {
          await reply('No changes found.');
          return true;
        }
        await reply(`\`\`\`\n${diff.slice(0, 3500)}\n\`\`\``);
        return true;
      }

      case '/link': {
        const lastId = sessions.lastSessionId();
        if (!lastId) {
          await reply('No active session.');
          return true;
        }
        const shareUrl = await client.shareSession(lastId);
        if (shareUrl) {
          await reply(`Session link: ${shareUrl}`);
        } else {
          await reply('Session sharing not available.');
        }
        return true;
      }

      default:
        // Unknown /command — not a command we handle, let it pass through
        // to the normal message flow (could be a typo or user intent)
        return false;
    }
  }

  // ── Chat SDK event handlers ──────────────────────────────────────────
  // CRITICAL: These handlers must return quickly to release the Chat SDK's
  // per-thread lock. If we await handleMessage() here, the lock is held for
  // the entire LLM round-trip (10-60s) and every subsequent message for that
  // thread is DROPPED. Instead we enqueue and return immediately — the
  // debounce layer flushes the queue asynchronously outside the lock.

  bot.onNewMention(async (thread, message) => {
    await thread.subscribe();
    // Check for /commands (Telegram sends them as regular messages)
    if (message.text.trim().startsWith('/')) {
      const handled = await handleTelegramCommand(thread, message.text.trim());
      if (handled) return;
    }
    enqueueMessage(thread, message.text, message.attachments, message);
  });

  bot.onNewMessage(/[\s\S]*/, async (thread, message) => {
    if (message.author.isMe) return;
    await thread.subscribe();
    // Check for /commands
    if (message.text.trim().startsWith('/')) {
      const handled = await handleTelegramCommand(thread, message.text.trim());
      if (handled) return;
    }
    enqueueMessage(thread, message.text, message.attachments, message);
  });

  bot.onSubscribedMessage(async (thread, message) => {
    if (message.author.isMe) return;

    const text = message.text.trim();

    // Check for /commands (Telegram)
    if (text.startsWith('/')) {
      const handled = await handleTelegramCommand(thread, text);
      if (handled) return;
    }

    // Bang-commands are fast — handle inline (don't queue)
    if (text === '!reset' || text === '!clear') {
      sessions.invalidate(thread.id);
      await thread.post('Session reset. Starting fresh.').catch(() => {});
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
      const agentList = await client.listAgents();
      const matched = agentList.find(a => a.name.toLowerCase() === name.toLowerCase());
      if (!matched) {
        const names = agentList.map(a => `\`${a.name}\``).join(', ');
        await thread.post({ markdown: `Agent "${name}" not found. Available: ${names}` }).catch(() => {});
        return;
      }
      sessions.setAgent(matched.name);
      sessions.invalidate(thread.id);
      await thread.post({ markdown: `Agent switched to **${matched.name}**. Session reset.` }).catch(() => {});
      return;
    }

    enqueueMessage(thread, text, message.attachments, message);
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

  // Initialize the Chat instance so polling-based adapters (Telegram, Discord)
  // can start their background listeners. For webhook-based adapters (Slack),
  // this is a no-op since they initialize on first webhook request.
  // IMPORTANT: This must be awaited — fire-and-forget causes the Telegram
  // polling loop to silently fail to receive updates.
  await bot.initialize();

  // Register Telegram bot commands so they appear in the "/" menu
  if (telegramConfig) {
    void setMyCommands(telegramConfig, [
      { command: 'help', description: 'Show available commands' },
      { command: 'models', description: 'List available AI models' },
      { command: 'model', description: 'Switch AI model (/model <name>)' },
      { command: 'agents', description: 'List available agents' },
      { command: 'agent', description: 'Switch agent (/agent <name>)' },
      { command: 'status', description: 'Show connection status' },
      { command: 'reset', description: 'Reset current session' },
      { command: 'new', description: 'Start a fresh session' },
      { command: 'diff', description: 'Show recent code changes' },
      { command: 'link', description: 'Share session link' },
    ]).then(() => {
      console.log('[opencode-channels] Telegram bot commands registered');
    }).catch(() => {});
  }

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

  // Extract Telegram config for direct API calls (bypassing Chat SDK's broken parse_mode)
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramConfig: TelegramDirectConfig | undefined = telegramBotToken
    ? { botToken: telegramBotToken, apiBaseUrl: process.env.TELEGRAM_API_BASE_URL }
    : undefined;

  const bot = createChatInstance({
    credentials: readAdaptersFromEnv(),
    client,
    sessions,
    getModel: () => currentModel,
    setModel: (m) => { currentModel = m; },
    getSystemPrompt: () => systemPrompt,
    botName,
    telegramConfig,
  });

  return { bot, client, sessions };
}
