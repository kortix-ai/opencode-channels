import { OpenCodeClient } from './opencode.js';

export type SessionStrategy = 'per-thread' | 'per-message';

interface SessionEntry {
  opencodeSessionId: string;
  lastUsedAt: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000;

export interface ChannelSessionPersistConfig {
  /** kortix-api base URL — e.g. http://localhost:8008 */
  kortixApiUrl: string;
  /** Bearer token for authenticating to kortix-api */
  kortixToken: string;
  /** The channel config UUID this bot instance belongs to */
  channelConfigId: string;
}

export interface ChannelSessionContext {
  /** Platform that triggered this session (slack | telegram | discord | …) */
  platform: string;
  /** Platform-level thread/chat identifier */
  threadId: string;
  /** Display name of the platform user who triggered the conversation */
  platformUserName?: string;
  /** Platform user ID */
  platformUserId?: string;
  /** Channel or room name on the platform (e.g. #general) */
  platformRoomName?: string;
  /** The channel config UUID */
  channelConfigId: string;
  /** Human-readable channel name set in Kortix */
  channelName?: string;
}

export class SessionManager {
  private readonly cache = new Map<string, SessionEntry>();
  private strategy: SessionStrategy;
  private agentName?: string;
  private persistConfig?: ChannelSessionPersistConfig;

  constructor(
    strategy: SessionStrategy = 'per-thread',
    agentName?: string,
    persistConfig?: ChannelSessionPersistConfig,
  ) {
    this.strategy = strategy;
    this.agentName = agentName;
    this.persistConfig = persistConfig;
  }

  setStrategy(strategy: SessionStrategy): void {
    this.strategy = strategy;
  }

  setAgent(agentName: string | undefined): void {
    this.agentName = agentName;
  }

  getAgent(): string | undefined {
    return this.agentName;
  }

  get size(): number {
    return this.cache.size;
  }

  clearAll(): void {
    this.cache.clear();
  }

  lastSessionId(): string | undefined {
    let latest: SessionEntry | undefined;
    for (const entry of this.cache.values()) {
      if (!latest || entry.lastUsedAt > latest.lastUsedAt) {
        latest = entry;
      }
    }
    return latest?.opencodeSessionId;
  }

  async resolve(threadId: string, client: OpenCodeClient): Promise<string> {
    if (this.strategy === 'per-message') {
      const sessionId = await client.createSession(this.agentName);
      // per-message: each call gets a fresh session, still persist for tracking
      void this.persistSession(threadId, sessionId);
      return sessionId;
    }

    const existing = this.cache.get(threadId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      // keep DB last_used_at fresh (fire-and-forget)
      void this.persistSession(threadId, existing.opencodeSessionId);
      return existing.opencodeSessionId;
    }

    const sessionId = await client.createSession(this.agentName);
    this.cache.set(threadId, { opencodeSessionId: sessionId, lastUsedAt: Date.now() });
    void this.persistSession(threadId, sessionId);
    return sessionId;
  }

  invalidate(threadId: string): void {
    this.cache.delete(threadId);
  }

  get(threadId: string): string | undefined {
    return this.cache.get(threadId)?.opencodeSessionId;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.lastUsedAt > SESSION_TTL_MS) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Persist the thread→session mapping to kortix-api so it is queryable
   * from the frontend and other services. Fire-and-forget from callers.
   */
  private async persistSession(strategyKey: string, sessionId: string): Promise<void> {
    const cfg = this.persistConfig;
    if (!cfg) return;

    try {
      // Use the internal route — accepts KORTIX_TOKEN (combined auth)
      const url = `${cfg.kortixApiUrl}/v1/channels/internal/sessions/${cfg.channelConfigId}`;
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.kortixToken}`,
        },
        body: JSON.stringify({
          strategy_key: strategyKey,
          session_id: sessionId,
          metadata: { strategy: this.strategy },
        }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) {
      // Non-fatal — in-memory cache still works even if DB write fails
      console.warn('[opencode-channels] Failed to persist channel session:', err instanceof Error ? err.message : err);
    }
  }
}
