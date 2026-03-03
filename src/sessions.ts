import { OpenCodeClient } from './opencode.js';

export type SessionStrategy = 'per-thread' | 'per-message';

interface SessionEntry {
  opencodeSessionId: string;
  lastUsedAt: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000;

export class SessionManager {
  private readonly cache = new Map<string, SessionEntry>();
  private strategy: SessionStrategy;
  private agentName?: string;

  constructor(strategy: SessionStrategy = 'per-thread', agentName?: string) {
    this.strategy = strategy;
    this.agentName = agentName;
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
      return client.createSession(this.agentName);
    }

    const existing = this.cache.get(threadId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.opencodeSessionId;
    }

    const sessionId = await client.createSession(this.agentName);
    this.cache.set(threadId, { opencodeSessionId: sessionId, lastUsedAt: Date.now() });
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
}
