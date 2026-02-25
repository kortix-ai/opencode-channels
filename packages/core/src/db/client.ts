import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';

export type ChannelsDatabase = BetterSQLite3Database<typeof schema>;

/**
 * Create (or open) a SQLite database at `dbPath`, apply the schema via
 * inline DDL, and return a typed drizzle-orm instance.
 */
export function createDatabase(dbPath: string): ChannelsDatabase {
  const sqlite = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });

  // Set the singleton so getDatabase() returns this same instance
  _db = db;

  // ── Inline schema creation (idempotent) ───────────────────────────────
  db.run(sql`
    CREATE TABLE IF NOT EXISTS channel_configs (
      id              TEXT PRIMARY KEY NOT NULL,
      channel_type    TEXT NOT NULL,
      name            TEXT NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1,
      credentials     TEXT NOT NULL DEFAULT '{}',
      platform_config TEXT NOT NULL DEFAULT '{}',
      metadata        TEXT NOT NULL DEFAULT '{}',
      session_strategy TEXT NOT NULL DEFAULT 'per-user',
      system_prompt   TEXT,
      agent_name      TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS channel_sessions (
      id                    TEXT PRIMARY KEY NOT NULL,
      config_id             TEXT NOT NULL REFERENCES channel_configs(id) ON DELETE CASCADE,
      session_key           TEXT NOT NULL UNIQUE,
      opencode_session_id   TEXT NOT NULL,
      created_at            TEXT NOT NULL,
      last_used_at          TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS channel_messages (
      id          TEXT PRIMARY KEY NOT NULL,
      config_id   TEXT NOT NULL REFERENCES channel_configs(id) ON DELETE CASCADE,
      external_id TEXT,
      direction   TEXT NOT NULL,
      content     TEXT NOT NULL,
      session_id  TEXT,
      user_id     TEXT,
      user_name   TEXT,
      metadata    TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL
    )
  `);

  // ── Indices ───────────────────────────────────────────────────────────
  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_channel_sessions_config_id
      ON channel_sessions(config_id)
  `);

  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_channel_sessions_session_key
      ON channel_sessions(session_key)
  `);

  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_channel_messages_config_id
      ON channel_messages(config_id)
  `);

  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_channel_messages_external_id
      ON channel_messages(external_id)
  `);

  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_channel_messages_session_id
      ON channel_messages(session_id)
  `);

  return db;
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _db: ChannelsDatabase | null = null;

/**
 * Lazily create or return the singleton database instance.
 *
 * Reads `CHANNELS_DB_PATH` from the environment, falling back to
 * `./channels.db`.
 */
export function getDatabase(): ChannelsDatabase {
  if (!_db) {
    const dbPath = process.env.CHANNELS_DB_PATH ?? process.env.DB_PATH ?? './channels.db';
    _db = createDatabase(dbPath);
  }
  return _db;
}
