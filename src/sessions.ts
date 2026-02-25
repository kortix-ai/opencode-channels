/**
 * Session manager — maps Chat SDK thread IDs to OpenCode session IDs.
 *
 * Strategies:
 *   - per-thread (default): One OpenCode session per Chat SDK thread
 *   - per-message: Fresh OpenCode session for every message
 */

import { OpenCodeClient } from './opencode.js';

export type SessionStrategy = 'per-thread' | 'per-message';

interface SessionEntry {
  opencodeSessionId: string;
  lastUsedAt: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

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

  /**
   * Resolve an OpenCode session ID for a given Chat SDK thread.
   * Creates a new OpenCode session if needed.
   */
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

  /**
   * Invalidate the session for a thread (e.g. on !reset).
   */
  invalidate(threadId: string): void {
    this.cache.delete(threadId);
  }

  /**
   * Get the current session ID for a thread without creating one.
   */
  get(threadId: string): string | undefined {
    return this.cache.get(threadId)?.opencodeSessionId;
  }

  /**
   * Evict stale sessions from the cache.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.lastUsedAt > SESSION_TTL_MS) {
        this.cache.delete(key);
      }
    }
  }
}
