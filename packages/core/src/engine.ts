/**
 * ChannelEngineImpl — Central orchestrator that processes inbound messages.
 *
 * Ported from the Kortix API engine with all Supabase / Postgres / sandbox
 * dependencies removed.  This version:
 *   - Reads channel configs from SQLite via Drizzle
 *   - Connects to a single local OpenCode instance (no sandboxId routing)
 *   - Downloads files directly and sends them to the platform adapter
 *   - Delegates permission requests to the EventBridge
 */

import { eq, and } from 'drizzle-orm';

import type {
  ChannelType,
  ChannelConfig,
  NormalizedMessage,
  AgentResponse,
  SessionStrategy,
  StreamEvent,
  FileOutput,
  MessageDirection,
} from './types.js';
import type { ChannelAdapter, ChannelEngine } from './adapter.js';
import { OpenCodeClient } from './opencode-client.js';
import { SessionManager } from './session-manager.js';
import { RateLimiter } from './rate-limiter.js';
import { MessageQueue } from './queue.js';
import { EventBridge } from './event-bridge.js';
import { decryptCredentials } from './lib/credentials.js';
import { getDatabase, type ChannelsDatabase } from './db/client.js';
import { channelConfigs, channelMessages } from './db/schema.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default OPENCODE_URL when not configured via env */
const DEFAULT_OPENCODE_URL = 'http://localhost:8000';

/** Queue key — single local server, so we use a constant */
const QUEUE_KEY = 'opencode';

// ─── Engine implementation ──────────────────────────────────────────────────

export class ChannelEngineImpl implements ChannelEngine {
  private readonly adapters: Map<ChannelType, ChannelAdapter>;
  private readonly db: ChannelsDatabase;
  private readonly sessionManager: SessionManager;
  private readonly queue: MessageQueue;
  private readonly rateLimiter: RateLimiter;
  private readonly eventBridge: EventBridge;
  private readonly openCodeUrl: string;

  constructor(
    adapters: Map<ChannelType, ChannelAdapter>,
    db?: ChannelsDatabase,
  ) {
    this.adapters = adapters;
    this.db = db ?? getDatabase();
    this.sessionManager = new SessionManager();
    this.queue = new MessageQueue();
    this.rateLimiter = new RateLimiter();
    this.eventBridge = new EventBridge();
    this.openCodeUrl = process.env.OPENCODE_URL ?? DEFAULT_OPENCODE_URL;

    // Wire the queue to process messages through processInner once server is ready
    this.queue.onProcess((msg, config) => this.processInner(msg, config));
  }

  /** Look up a registered adapter by channel type. */
  getAdapter(type: ChannelType): ChannelAdapter | undefined {
    return this.adapters.get(type);
  }

  // ── Main entry point ────────────────────────────────────────────────────

  async processMessage(message: NormalizedMessage): Promise<void> {
    // 1. Look up enabled config from SQLite
    const rows = this.db
      .select()
      .from(channelConfigs)
      .where(
        and(
          eq(channelConfigs.id, message.channelConfigId),
          eq(channelConfigs.enabled, true),
        ),
      )
      .all();

    const rawConfig = rows[0];
    if (!rawConfig) {
      console.warn(
        `[CHANNELS] No enabled config found for ${message.channelConfigId}`,
      );
      return;
    }

    // 2. Hydrate config — decrypt credentials and parse JSON text columns
    const config = await this.hydrateConfig(rawConfig);

    // 3. Rate-limit check
    const rateResult = this.rateLimiter.check(
      config.id,
      message.platformUser.id,
    );
    if (!rateResult.allowed) {
      console.warn(
        `[CHANNELS] Rate limited: config=${config.id} user=${message.platformUser.id}`,
      );
      return;
    }

    // 4. Process the message
    await this.processInner(message, config);
  }

  // ── Core processing pipeline ────────────────────────────────────────────

  private async processInner(
    message: NormalizedMessage,
    config: ChannelConfig,
  ): Promise<void> {
    const adapter = this.adapters.get(config.channelType as ChannelType);
    if (!adapter) {
      console.error(`[CHANNELS] No adapter for type: ${config.channelType}`);
      return;
    }

    const client = new OpenCodeClient({ baseUrl: this.openCodeUrl });

    // Log inbound message
    await this.logMessage(config, message, 'inbound');

    // Show typing indicator
    if (adapter.sendTypingIndicator) {
      adapter.sendTypingIndicator(config, message).catch((err) => {
        console.warn(`[CHANNELS] Typing indicator failed:`, err);
      });
    }

    const removeTyping = () => {
      if (adapter.removeTypingIndicator) {
        adapter.removeTypingIndicator(config, message).catch((err) => {
          console.warn(`[CHANNELS] Remove typing indicator failed:`, err);
        });
      }
    };

    try {
      // ── 1. Check if OpenCode is ready ──────────────────────────────────
      const ready = await client.isReady();
      if (!ready) {
        try {
          await this.queue.enqueue(QUEUE_KEY, message, config, client);
        } catch (err) {
          console.error(`[CHANNELS] Queue processing failed:`, err);
        }
        return;
      }

      // ── 2. Resolve session ─────────────────────────────────────────────
      const agentName =
        message.overrides?.agentName ?? config.agentName ?? undefined;
      const sessionId = await this.sessionManager.resolve(
        config,
        message,
        client,
      );

      // ── 3. Build prompt ────────────────────────────────────────────────
      const prompt = this.buildPrompt(config, message);
      const model = this.resolveModel(config, message);

      // ── 4. Build file parts from attachments ───────────────────────────
      const fileParts = message.attachments
        .filter((a) => a.url)
        .map((a) => ({
          type: 'file' as const,
          mime: a.mimeType || 'application/octet-stream',
          url: a.url!,
          filename: a.name,
        }));

      // ── 4b. Snapshot files BEFORE prompting (for accurate new-file detection)
      const filesBefore = new Set(
        (await client.getModifiedFiles().catch(() => [])).map((f) => f.path),
      );

      // ── 5. Stream response from OpenCode ───────────────────────────────
      let responseText = '';
      const collectedFiles: FileOutput[] = [];
      const startTime = Date.now();

      try {
        for await (const event of client.promptStreaming(
          sessionId,
          prompt,
          agentName,
          model,
          fileParts,
        )) {
          responseText = await this.handleStreamEvent(
            event,
            responseText,
            collectedFiles,
            client,
            adapter,
            config,
            message,
          );
        }
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : String(err);
        console.error(`[CHANNELS] Agent prompt failed:`, errMsg);
        throw new Error(`Failed to get response from agent: ${errMsg}`);
      }

      // ── 6. Build and send agent response ───────────────────────────────
      const agentResponse: AgentResponse = {
        content: responseText,
        sessionId,
        truncated: false,
        modelName: model?.modelID ?? 'default',
        durationMs: Date.now() - startTime,
      };

      await adapter.sendResponse(config, message, agentResponse);

      // ── 7. Download and send collected files ───────────────────────────
      let hadFiles = false;

      if (collectedFiles.length > 0 && adapter.sendFiles) {
        for (const file of collectedFiles) {
          if (!file.content) {
            file.content = await this.downloadFileWithFallback(
              client,
              file.name,
              file.url,
            );
          }
        }

        const downloadedFiles = collectedFiles.filter((f) => f.content);
        if (downloadedFiles.length > 0) {
          hadFiles = true;
          await adapter
            .sendFiles(config, message, downloadedFiles)
            .catch((err) => {
              console.error('[CHANNELS] File send to channel failed:', err);
            });
        }
      }

      // ── 8. Check git-status for new output files ───────────────────────
      if (adapter.sendFiles) {
        const newFileCount = await this.sendNewFilesFromGitStatus(
          client,
          adapter,
          config,
          message,
          collectedFiles,
          filesBefore,
        );
        if (newFileCount > 0) hadFiles = true;
      }

      // ── 9. React with status indicators ────────────────────────────────
      // Completion checkmark
      if (adapter.reactComplete) {
        adapter.reactComplete(config, message).catch(() => {});
      }
      // File-change indicator
      if (hadFiles && adapter.reactFilesChanged) {
        adapter.reactFilesChanged(config, message).catch(() => {});
      }

      // ── 10. Log outbound message ───────────────────────────────────────
      await this.logMessage(
        config,
        message,
        'outbound',
        responseText,
        sessionId,
      );
    } catch (err) {
      // React with error if not already handled above
      if (adapter.reactError) {
        adapter.reactError(config, message).catch(() => {});
      }
      console.error('[CHANNELS] processInner failed:', err);
    } finally {
      removeTyping();
    }
  }

  // ── SSE event handler ───────────────────────────────────────────────────

  private async handleStreamEvent(
    event: StreamEvent,
    responseText: string,
    collectedFiles: FileOutput[],
    client: OpenCodeClient,
    adapter: ChannelAdapter,
    config: ChannelConfig,
    message: NormalizedMessage,
  ): Promise<string> {
    switch (event.type) {
      case 'text':
        return responseText + (event.data || '');

      case 'permission':
        if (event.permission && adapter.sendPermissionRequest) {
          // The guard above ensures sendPermissionRequest exists, so the
          // adapter satisfies the EventBridgeAdapter contract at runtime.
          await this.eventBridge.handlePermissionEvent(
            config,
            message,
            event.permission,
            adapter as ChannelAdapter & { sendPermissionRequest: NonNullable<ChannelAdapter['sendPermissionRequest']> },
            client,
          );
        }
        return responseText;

      case 'file':
        if (event.file && (event.file.url || event.file.name)) {
          collectedFiles.push({
            name: event.file.name,
            url: event.file.url || event.file.name,
            mimeType: event.file.mimeType,
          });
        }
        return responseText;

      case 'error':
        throw new Error(`Agent error: ${event.data}`);

      default:
        return responseText;
    }
  }

  // ── Prompt building ─────────────────────────────────────────────────────

  private buildPrompt(
    config: ChannelConfig,
    message: NormalizedMessage,
  ): string {
    const parts: string[] = [];

    // System prompt
    if (config.systemPrompt) {
      parts.push(config.systemPrompt);
    }

    // Channel-specific prompt (from platformConfig.channelPrompts[groupId])
    if (message.groupId) {
      const channelPrompts = config.platformConfig?.channelPrompts as
        | Record<string, string>
        | undefined;
      const channelPrompt = channelPrompts?.[message.groupId];
      if (channelPrompt) {
        parts.push(`[Channel-specific instructions]\n${channelPrompt}`);
      }
    }

    // Format instruction for chat-style platforms
    if (config.channelType === 'slack' || config.channelType === 'telegram') {
      parts.push(
        `[Response format: You are responding in a ${config.channelType} channel. Keep responses short and concise — use brief paragraphs, short bullet points, and avoid verbose explanations. No headers unless truly needed. Aim for the minimum words that fully answer the question. When generating files, use the show tool to attach them.]`,
      );
    }

    // Metadata line
    parts.push(
      `[Channel: ${config.channelType} | Chat: ${message.chatType} | User: ${message.platformUser.name}]`,
    );

    // Thread context
    if (message.threadContext && message.threadContext.length > 0) {
      const threadLines = message.threadContext.map((m) => {
        const role = m.isBot ? 'Assistant' : m.sender;
        return `${role}: ${m.text}`;
      });
      parts.push(
        `--- Thread context ---\n${threadLines.join('\n')}\n--- End thread context ---`,
      );
    }

    // Actual message content
    parts.push(message.content);

    return parts.join('\n\n');
  }

  // ── Model resolution ────────────────────────────────────────────────────

  private resolveModel(
    config: ChannelConfig,
    message: NormalizedMessage,
  ): { providerID: string; modelID: string } | undefined {
    // Per-message override takes priority
    if (message.overrides?.model) {
      return message.overrides.model;
    }

    // Fall back to config-level model
    const meta = config.metadata;
    if (meta?.model && typeof meta.model === 'object' && !Array.isArray(meta.model)) {
      const m = meta.model as Record<string, unknown>;
      if (typeof m.providerID === 'string' && typeof m.modelID === 'string') {
        return { providerID: m.providerID, modelID: m.modelID };
      }
    }

    return undefined;
  }

  // ── File downloads ──────────────────────────────────────────────────────

  /**
   * Download a file from the OpenCode server, trying the URL first and
   * falling back to a file-by-path lookup.
   */
  private async downloadFileWithFallback(
    client: OpenCodeClient,
    name: string,
    url: string,
  ): Promise<Buffer | undefined> {
    const buffer = await client.downloadFile(url);
    if (buffer) {
      return buffer;
    }

    const fallback = await client.downloadFileByPath(name);
    if (fallback) {
      return fallback;
    }

    return undefined;
  }

  /**
   * After the agent response, check git status for newly created output
   * files and send any that weren't already collected via SSE file events.
   *
   * @param filesBefore - Set of file paths that existed before prompting.
   *                      Only files NOT in this set are treated as new.
   */
  private async sendNewFilesFromGitStatus(
    client: OpenCodeClient,
    adapter: ChannelAdapter,
    config: ChannelConfig,
    message: NormalizedMessage,
    alreadyCollected: FileOutput[],
    filesBefore?: Set<string>,
  ): Promise<number> {
    try {
      const modifiedFiles = await client.getModifiedFiles().catch(() => []);
      if (modifiedFiles.length === 0) return 0;

      const alreadySent = new Set(alreadyCollected.map((f) => f.name));
      const newFiles: FileOutput[] = [];

      for (const f of modifiedFiles) {
        if (alreadySent.has(f.name)) continue;
        // Skip files that already existed before prompting
        if (filesBefore && filesBefore.has(f.path)) continue;

        const buffer = await client.downloadFileByPath(f.path);
        if (buffer) {
          newFiles.push({
            name: f.name,
            url: f.path,
            content: buffer,
          });
        } else {
          console.warn(`[CHANNELS] Failed to download: ${f.path}`);
        }
      }

      if (newFiles.length > 0 && adapter.sendFiles) {
        await adapter
          .sendFiles(config, message, newFiles)
          .catch((err) => {
            console.error('[CHANNELS] File send to channel failed:', err);
          });
      }
      return newFiles.length;
    } catch (err) {
      console.warn('[CHANNELS] Git-status file check failed:', err);
      return 0;
    }
  }

  // ── Config hydration ────────────────────────────────────────────────────

  /**
   * Parse JSON text columns and decrypt credentials.
   * Drizzle with SQLite stores JSON columns as plain text strings,
   * so we need to parse them before use.
   */
  private async hydrateConfig(
    raw: typeof channelConfigs.$inferSelect,
  ): Promise<ChannelConfig> {
    const credentials = safeJsonParse(raw.credentials);
    const decrypted = await decryptCredentials(credentials);

    return {
      id: raw.id,
      channelType: raw.channelType as ChannelType,
      name: raw.name,
      enabled: raw.enabled,
      credentials: decrypted,
      platformConfig: safeJsonParse(raw.platformConfig),
      metadata: safeJsonParse(raw.metadata),
      sessionStrategy: raw.sessionStrategy as SessionStrategy,
      systemPrompt: raw.systemPrompt,
      agentName: raw.agentName,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }

  // ── Message logging ─────────────────────────────────────────────────────

  private async logMessage(
    config: ChannelConfig,
    message: NormalizedMessage,
    direction: MessageDirection,
    content?: string,
    sessionId?: string,
  ): Promise<void> {
    try {
      this.db
        .insert(channelMessages)
        .values({
          id: crypto.randomUUID(),
          configId: config.id,
          direction,
          externalId: message.externalId,
          content: direction === 'inbound' ? message.content : (content ?? ''),
          sessionId: sessionId ?? null,
          userId: message.platformUser.id,
          userName: message.platformUser.name,
          metadata: JSON.stringify({}),
          createdAt: new Date().toISOString(),
        })
        .run();
    } catch (err) {
      console.error(`[CHANNELS] Failed to log ${direction} message:`, err);
    }
  }

  // ── Session reset ───────────────────────────────────────────────────────

  async resetSession(
    configId: string,
    channelType: string,
    strategy: SessionStrategy,
    message: NormalizedMessage,
  ): Promise<void> {
    await this.sessionManager.invalidateSession(
      configId,
      channelType,
      strategy,
      message,
    );
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  /**
   * Evict stale entries from in-memory caches.
   * Call periodically (e.g. every few minutes) to keep memory bounded.
   */
  cleanup(): void {
    this.sessionManager.cleanup();
    this.rateLimiter.cleanup();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Safely parse a JSON string or return the object as-is.
 * Returns an empty object on parse failure.
 */
function safeJsonParse(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }
  return {};
}
