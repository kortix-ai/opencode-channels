/**
 * Plugin entry point — boots the opencode-channels system.
 *
 * Starts the webhook server, registers adapters, creates the ChannelEngine,
 * and exposes CRUD helpers for channel configs.
 *
 * Can be used standalone:
 *   const channels = await startChannels({ adapters: { slack: slackAdapter } });
 *
 * Or imported piecemeal for tests / custom setups.
 */

import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { ChannelEngineImpl } from './engine.js';
import { createWebhookServer, registerAdapter } from './webhook-server.js';
import { loadConfig } from './config.js';
import { createDatabase, getDatabase } from './db/client.js';
import { channelConfigs } from './db/schema.js';
import { encryptCredentials } from './lib/credentials.js';
import type { ChannelAdapter } from './adapter.js';
import type { ChannelType, ChannelConfig, SessionStrategy } from './types.js';
import type { ChannelsDatabase } from './db/client.js';

// ─── Options ────────────────────────────────────────────────────────────────

export interface ChannelsPluginOptions {
  /** Adapters to register, keyed by an arbitrary name (e.g. "slack") */
  adapters?: Record<string, ChannelAdapter>;
  /** Port for webhook server (default: from config / env) */
  port?: number;
  /** Host for webhook server (default: from config / env / "0.0.0.0") */
  host?: string;
  /** Auto-approve tool-permission requests for chat sessions */
  autoApprovePermissions?: boolean;
  /** OpenCode server URL (default: from env / "http://localhost:8000") */
  opencodeUrl?: string;
  /** Path to the SQLite database file (default: from env / config) */
  dbPath?: string;
}

// ─── Result ─────────────────────────────────────────────────────────────────

export interface ChannelsPluginResult {
  /** The running engine instance */
  engine: ChannelEngineImpl;
  /** The Hono app — mount additional routes if needed */
  app: Hono;
  /** The database instance used by this plugin */
  db: ChannelsDatabase;
  /** Gracefully shut everything down */
  stop: () => void;
}

// ─── startChannels ──────────────────────────────────────────────────────────

/**
 * Start the opencode-channels system.
 *
 * 1. Loads config from env (merged with explicit options).
 * 2. Opens (or creates) the SQLite database.
 * 3. Builds the adapter map and registers each adapter's webhook routes.
 * 4. Creates the ChannelEngine.
 * 5. Starts the HTTP webhook server.
 * 6. Sets up a periodic cleanup timer for sessions / rate-limiter buckets.
 *
 * Returns an object with the engine, Hono app, db, and a `stop()` function.
 */
export async function startChannels(
  options: ChannelsPluginOptions = {},
): Promise<ChannelsPluginResult> {
  const config = loadConfig();

  // ── Database ──────────────────────────────────────────────────────────
  const dbPath = options.dbPath || config.DB_PATH;
  const db = createDatabase(dbPath);

  // ── Adapters ──────────────────────────────────────────────────────────
  const adapters = new Map<ChannelType, ChannelAdapter>();

  if (options.adapters) {
    for (const [name, adapter] of Object.entries(options.adapters)) {
      adapters.set(adapter.type, adapter);
      registerAdapter(name);
    }
  }

  // ── Engine ────────────────────────────────────────────────────────────
  const engine = new ChannelEngineImpl(adapters, db);

  // ── Webhook server ────────────────────────────────────────────────────
  const port = options.port ?? config.PORT;
  const host = options.host ?? config.HOST;

  const server = createWebhookServer({ port, host });

  // Register each adapter's routes on the Hono app
  for (const adapter of adapters.values()) {
    adapter.registerRoutes(server.app, engine);
  }

  // Start long-lived adapter connections (websockets, polling, etc.)
  const abortController = new AbortController();
  for (const adapter of adapters.values()) {
    if (adapter.start) {
      adapter.start(abortController.signal).catch((err) => {
        console.error(`[channels] Adapter ${adapter.name} start failed:`, err);
      });
    }
  }

  // ── Start server ──────────────────────────────────────────────────────
  await server.start();

  console.log(`[channels] Webhook server started on ${host}:${port}`);
  console.log(
    `[channels] Adapters: ${Array.from(adapters.keys()).join(', ') || 'none'}`,
  );

  // ── Periodic cleanup (every 5 minutes) ────────────────────────────────
  const cleanupInterval = setInterval(() => {
    engine.cleanup();
  }, 5 * 60 * 1000);

  // Prevent the timer from keeping the process alive
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  // ── Stop function ─────────────────────────────────────────────────────
  const stop = () => {
    clearInterval(cleanupInterval);
    abortController.abort();

    // Shut down adapters gracefully
    for (const adapter of adapters.values()) {
      if (adapter.shutdown) {
        adapter.shutdown().catch((err) => {
          console.error(`[channels] Adapter ${adapter.name} shutdown failed:`, err);
        });
      }
    }

    server.stop();
    console.log('[channels] Stopped');
  };

  return { engine, app: server.app, db, stop };
}

// ─── Channel Config CRUD helpers ────────────────────────────────────────────

/**
 * Resolve a database instance — uses the provided db or falls back to
 * the module-level singleton.
 */
function resolveDb(db?: ChannelsDatabase): ChannelsDatabase {
  return db ?? getDatabase();
}

/**
 * Get a single channel config by ID.
 * Returns `null` if not found.
 */
export function getChannelConfig(
  configId: string,
  db?: ChannelsDatabase,
): ChannelConfig | null {
  const d = resolveDb(db);

  const rows = d
    .select()
    .from(channelConfigs)
    .where(eq(channelConfigs.id, configId))
    .all();

  const row = rows[0];
  if (!row) return null;

  return rowToChannelConfig(row);
}

/**
 * List all channel configs, optionally filtered by channel type.
 */
export function listChannelConfigs(
  filter?: { channelType?: ChannelType; enabled?: boolean },
  db?: ChannelsDatabase,
): ChannelConfig[] {
  const d = resolveDb(db);

  let query = d.select().from(channelConfigs);

  // drizzle-orm doesn't support dynamic where chaining well with
  // better-sqlite3 synchronous mode, so we filter in JS for simplicity
  const rows = query.all();

  let results = rows.map(rowToChannelConfig);

  if (filter?.channelType) {
    results = results.filter((c) => c.channelType === filter.channelType);
  }
  if (filter?.enabled !== undefined) {
    results = results.filter((c) => c.enabled === filter.enabled);
  }

  return results;
}

/**
 * Create a new channel config.
 *
 * Credentials are encrypted at rest if `CREDENTIAL_KEY` is set.
 * Returns the created config with its generated `id`.
 */
export async function createChannelConfig(
  input: Omit<ChannelConfig, 'id' | 'createdAt' | 'updatedAt'>,
  db?: ChannelsDatabase,
): Promise<ChannelConfig> {
  const d = resolveDb(db);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  // Encrypt credentials before storage
  const encryptedCreds = await encryptCredentials(input.credentials);

  d.insert(channelConfigs)
    .values({
      id,
      channelType: input.channelType,
      name: input.name,
      enabled: input.enabled,
      credentials: JSON.stringify(encryptedCreds),
      platformConfig: JSON.stringify(input.platformConfig),
      metadata: JSON.stringify(input.metadata),
      sessionStrategy: input.sessionStrategy,
      systemPrompt: input.systemPrompt,
      agentName: input.agentName,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return {
    id,
    channelType: input.channelType,
    name: input.name,
    enabled: input.enabled,
    credentials: input.credentials, // Return unencrypted to caller
    platformConfig: input.platformConfig,
    metadata: input.metadata,
    sessionStrategy: input.sessionStrategy,
    systemPrompt: input.systemPrompt,
    agentName: input.agentName,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Update an existing channel config. Only the provided fields are changed.
 * Returns the updated config or `null` if not found.
 */
export async function updateChannelConfig(
  id: string,
  updates: Partial<Omit<ChannelConfig, 'id' | 'createdAt' | 'updatedAt'>>,
  db?: ChannelsDatabase,
): Promise<ChannelConfig | null> {
  const d = resolveDb(db);

  // Verify the config exists
  const existing = getChannelConfig(id, d);
  if (!existing) return null;

  const now = new Date().toISOString();

  // Build the update payload — only set fields that were provided
  const payload: Record<string, unknown> = { updatedAt: now };

  if (updates.channelType !== undefined) payload.channelType = updates.channelType;
  if (updates.name !== undefined) payload.name = updates.name;
  if (updates.enabled !== undefined) payload.enabled = updates.enabled;
  if (updates.sessionStrategy !== undefined) payload.sessionStrategy = updates.sessionStrategy;
  if (updates.systemPrompt !== undefined) payload.systemPrompt = updates.systemPrompt;
  if (updates.agentName !== undefined) payload.agentName = updates.agentName;

  if (updates.credentials !== undefined) {
    const encryptedCreds = await encryptCredentials(updates.credentials);
    payload.credentials = JSON.stringify(encryptedCreds);
  }
  if (updates.platformConfig !== undefined) {
    payload.platformConfig = JSON.stringify(updates.platformConfig);
  }
  if (updates.metadata !== undefined) {
    payload.metadata = JSON.stringify(updates.metadata);
  }

  d.update(channelConfigs)
    .set(payload)
    .where(eq(channelConfigs.id, id))
    .run();

  // Return the merged result
  return {
    ...existing,
    ...updates,
    updatedAt: now,
  };
}

/**
 * Delete a channel config by ID.
 * Returns `true` if a row was deleted, `false` if the ID was not found.
 */
export function deleteChannelConfig(
  id: string,
  db?: ChannelsDatabase,
): boolean {
  const d = resolveDb(db);

  const result = d
    .delete(channelConfigs)
    .where(eq(channelConfigs.id, id))
    .run();

  return result.changes > 0;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Convert a raw Drizzle row to a typed ChannelConfig.
 *
 * JSON text columns (credentials, platformConfig, metadata) are parsed.
 * Credentials remain encrypted at this layer — the engine's hydrateConfig
 * handles decryption when processing messages.
 */
function rowToChannelConfig(
  row: typeof channelConfigs.$inferSelect,
): ChannelConfig {
  return {
    id: row.id,
    channelType: row.channelType as ChannelType,
    name: row.name,
    enabled: row.enabled,
    credentials: safeJsonParse(row.credentials),
    platformConfig: safeJsonParse(row.platformConfig),
    metadata: safeJsonParse(row.metadata),
    sessionStrategy: row.sessionStrategy as SessionStrategy,
    systemPrompt: row.systemPrompt,
    agentName: row.agentName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Safely parse a JSON string. Returns an empty object on failure.
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
