/**
 * SessionManager — SQLite-backed session management.
 *
 * Maps platform threads to OpenCode sessions using 4 strategies:
 *   - single:      One global session for the entire config
 *   - per-thread:  One session per thread/group
 *   - per-user:    One session per platform user
 *   - per-message: Fresh session for every message
 *
 * Uses Drizzle + better-sqlite3 for persistence and an in-memory
 * cache with 24 h TTL for fast lookups.
 */

import { eq, and, desc } from 'drizzle-orm';
import { getDatabase } from './db/client.js';
import { channelSessions } from './db/schema.js';
import { OpenCodeClient } from './opencode-client.js';
import type { ChannelConfig, NormalizedMessage, SessionStrategy } from './types.js';

// ─── In-memory cache ────────────────────────────────────────────────────────

interface CachedSession {
  sessionId: string;
  lastUsedAt: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── SessionManager ─────────────────────────────────────────────────────────

export class SessionManager {
  private cache = new Map<string, CachedSession>();

  /**
   * Build a deterministic cache/DB key from the routing strategy.
   */
  private buildKey(
    configId: string,
    channelType: string,
    strategy: SessionStrategy,
    message: NormalizedMessage,
  ): string {
    let discriminator: string;

    switch (strategy) {
      case 'single':
        discriminator = 'global';
        break;
      case 'per-thread':
        discriminator = message.threadId || message.groupId || message.platformUser.id;
        break;
      case 'per-user':
        discriminator = message.platformUser.id;
        break;
      case 'per-message':
        discriminator = message.externalId;
        break;
      default:
        discriminator = message.platformUser.id;
    }

    return `${configId}:${channelType}:${strategy}:${discriminator}`;
  }

  /**
   * Resolve (get or create) an OpenCode session for the given config + message.
   */
  async resolve(
    config: ChannelConfig,
    message: NormalizedMessage,
    client: OpenCodeClient,
  ): Promise<string> {
    const db = getDatabase();
    const strategy = config.sessionStrategy as SessionStrategy;
    const key = this.buildKey(config.id, config.channelType, strategy, message);

    // per-message always creates a fresh session
    if (strategy === 'per-message') {
      const sessionId = await client.createSession(config.agentName ?? undefined);
      return sessionId;
    }

    // ── Check in-memory cache ────────────────────────────────────────────
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.lastUsedAt < SESSION_TTL_MS) {
      cached.lastUsedAt = Date.now();
      this.touchDb(config.id, key).catch(() => {});
      return cached.sessionId;
    }

    // ── Check SQLite ─────────────────────────────────────────────────────
    const rows = db
      .select()
      .from(channelSessions)
      .where(
        and(
          eq(channelSessions.configId, config.id),
          eq(channelSessions.sessionKey, key),
        ),
      )
      .all();

    const dbSession = rows[0];

    if (dbSession) {
      const lastUsed = new Date(dbSession.lastUsedAt).getTime();
      const age = Date.now() - lastUsed;
      if (age < SESSION_TTL_MS) {
        this.cache.set(key, {
          sessionId: dbSession.opencodeSessionId,
          lastUsedAt: Date.now(),
        });
        this.touchDb(config.id, key).catch(() => {});
        return dbSession.opencodeSessionId;
      }
    }

    // ── Create new session ───────────────────────────────────────────────
    const sessionId = await client.createSession(config.agentName ?? undefined);
    const now = new Date().toISOString();

    this.cache.set(key, { sessionId, lastUsedAt: Date.now() });

    // Upsert — handles race conditions where two concurrent requests
    // resolve the same session key simultaneously.
    db.insert(channelSessions)
      .values({
        id: dbSession?.id ?? crypto.randomUUID(),
        configId: config.id,
        sessionKey: key,
        opencodeSessionId: sessionId,
        createdAt: dbSession?.createdAt ?? now,
        lastUsedAt: now,
      })
      .onConflictDoUpdate({
        target: channelSessions.sessionKey,
        set: {
          opencodeSessionId: sessionId,
          lastUsedAt: now,
        },
      })
      .run();

    return sessionId;
  }

  /**
   * Update the last_used_at timestamp in the DB (fire-and-forget).
   */
  private async touchDb(configId: string, key: string): Promise<void> {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.update(channelSessions)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(channelSessions.configId, configId),
          eq(channelSessions.sessionKey, key),
        ),
      )
      .run();
  }

  /**
   * Invalidate a session from both cache and DB.
   */
  async invalidateSession(
    configId: string,
    channelType: string,
    strategy: SessionStrategy,
    message: NormalizedMessage,
  ): Promise<void> {
    const db = getDatabase();
    const key = this.buildKey(configId, channelType, strategy, message);
    this.cache.delete(key);

    db.delete(channelSessions)
      .where(
        and(
          eq(channelSessions.configId, configId),
          eq(channelSessions.sessionKey, key),
        ),
      )
      .run();
  }

  /**
   * Find the most recent active session for a config (optionally scoped to a user).
   */
  async getActiveSessionId(configId: string, userId?: string): Promise<string | null> {
    const db = getDatabase();

    // Check in-memory cache first
    const prefix = userId ? `${configId}:` : configId;
    const suffix = userId ? `:${userId}` : undefined;

    for (const [key, entry] of this.cache) {
      if (!key.startsWith(prefix)) continue;
      if (suffix && !key.endsWith(suffix)) continue;
      if (Date.now() - entry.lastUsedAt < SESSION_TTL_MS) {
        return entry.sessionId;
      }
    }

    // Fall back to DB — find most recently used session for this config
    const conditions = [eq(channelSessions.configId, configId)];

    const rows = db
      .select()
      .from(channelSessions)
      .where(and(...conditions))
      .orderBy(desc(channelSessions.lastUsedAt))
      .limit(1)
      .all();

    const row = rows[0];
    if (!row) return null;

    const lastUsed = new Date(row.lastUsedAt).getTime();
    if (Date.now() - lastUsed > SESSION_TTL_MS) return null;

    // If userId filter was requested, verify the key matches
    if (userId && !row.sessionKey.includes(userId)) return null;

    return row.opencodeSessionId;
  }

  /**
   * Evict expired entries from the in-memory cache.
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
