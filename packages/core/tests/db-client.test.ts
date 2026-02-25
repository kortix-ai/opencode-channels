import { describe, it, expect, afterEach } from 'vitest';
import { createDatabase } from '../src/db/client.js';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ── Helpers ──────────────────────────────────────────────────────────────────

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `test-channels-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

const tempFiles: string[] = [];

function createTempDb() {
  const dbPath = tmpDbPath();
  tempFiles.push(dbPath);
  return { dbPath, db: createDatabase(dbPath) };
}

afterEach(() => {
  for (const f of tempFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      // ignore — file may not exist
    }
    // Also clean up WAL/SHM files
    try {
      fs.unlinkSync(f + '-wal');
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(f + '-shm');
    } catch {
      // ignore
    }
  }
  tempFiles.length = 0;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('createDatabase', () => {
  it('creates all 3 tables', () => {
    const { dbPath } = createTempDb();

    const sqlite = new Database(dbPath);
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row: any) => row.name)
      .sort();

    expect(tables).toContain('channel_configs');
    expect(tables).toContain('channel_sessions');
    expect(tables).toContain('channel_messages');
    expect(tables.length).toBe(3);

    sqlite.close();
  });

  it('creates all 5 indices', () => {
    const { dbPath } = createTempDb();

    const sqlite = new Database(dbPath);
    const indices = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all()
      .map((row: any) => row.name)
      .sort();

    expect(indices).toContain('idx_channel_sessions_config_id');
    expect(indices).toContain('idx_channel_sessions_session_key');
    expect(indices).toContain('idx_channel_messages_config_id');
    expect(indices).toContain('idx_channel_messages_external_id');
    expect(indices).toContain('idx_channel_messages_session_id');
    expect(indices.length).toBe(5);

    sqlite.close();
  });

  it('is idempotent — calling twice on same path does not error', () => {
    const dbPath = tmpDbPath();
    tempFiles.push(dbPath);

    // Should not throw
    createDatabase(dbPath);
    createDatabase(dbPath);

    const sqlite = new Database(dbPath);
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all();
    expect(tables.length).toBe(3);

    sqlite.close();
  });

  it('WAL mode is enabled', () => {
    const { dbPath } = createTempDb();

    const sqlite = new Database(dbPath);
    const result = sqlite.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(result[0].journal_mode).toBe('wal');

    sqlite.close();
  });

  it('foreign keys are enabled', () => {
    const { dbPath } = createTempDb();

    const sqlite = new Database(dbPath);
    const result = sqlite.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    expect(result[0].foreign_keys).toBe(1);

    sqlite.close();
  });

  it('FK cascade: deleting a channelConfig cascades to channelSessions and channelMessages', () => {
    const { dbPath } = createTempDb();
    const now = new Date().toISOString();

    // Open a fresh connection with foreign_keys enabled
    const sqlite = new Database(dbPath);
    sqlite.pragma('foreign_keys = ON');

    // Insert a channel config
    sqlite
      .prepare(
        `INSERT INTO channel_configs (id, channel_type, name, enabled, credentials, platform_config, metadata, session_strategy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('cfg-1', 'slack', 'Test', 1, '{}', '{}', '{}', 'per-user', now, now);

    // Insert a session referencing cfg-1
    sqlite
      .prepare(
        `INSERT INTO channel_sessions (id, config_id, session_key, opencode_session_id, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('sess-1', 'cfg-1', 'key-1', 'oc-sess-1', now, now);

    // Insert a message referencing cfg-1
    sqlite
      .prepare(
        `INSERT INTO channel_messages (id, config_id, direction, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('msg-1', 'cfg-1', 'inbound', 'hello', now);

    // Verify data exists
    expect(sqlite.prepare('SELECT COUNT(*) as c FROM channel_sessions').get()).toEqual({ c: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) as c FROM channel_messages').get()).toEqual({ c: 1 });

    // Delete the config → should cascade
    sqlite.prepare('DELETE FROM channel_configs WHERE id = ?').run('cfg-1');

    // Verify cascaded deletes
    expect(sqlite.prepare('SELECT COUNT(*) as c FROM channel_configs').get()).toEqual({ c: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) as c FROM channel_sessions').get()).toEqual({ c: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) as c FROM channel_messages').get()).toEqual({ c: 0 });

    sqlite.close();
  });

  it('channel_configs table has the expected columns', () => {
    const { dbPath } = createTempDb();

    const sqlite = new Database(dbPath);
    const columns = sqlite
      .prepare("PRAGMA table_info('channel_configs')")
      .all()
      .map((row: any) => row.name)
      .sort();

    expect(columns).toContain('id');
    expect(columns).toContain('channel_type');
    expect(columns).toContain('name');
    expect(columns).toContain('enabled');
    expect(columns).toContain('credentials');
    expect(columns).toContain('platform_config');
    expect(columns).toContain('metadata');
    expect(columns).toContain('session_strategy');
    expect(columns).toContain('system_prompt');
    expect(columns).toContain('agent_name');
    expect(columns).toContain('created_at');
    expect(columns).toContain('updated_at');

    sqlite.close();
  });

  it('channel_sessions table has the expected columns', () => {
    const { dbPath } = createTempDb();

    const sqlite = new Database(dbPath);
    const columns = sqlite
      .prepare("PRAGMA table_info('channel_sessions')")
      .all()
      .map((row: any) => row.name)
      .sort();

    expect(columns).toContain('id');
    expect(columns).toContain('config_id');
    expect(columns).toContain('session_key');
    expect(columns).toContain('opencode_session_id');
    expect(columns).toContain('created_at');
    expect(columns).toContain('last_used_at');

    sqlite.close();
  });

  it('channel_messages table has the expected columns', () => {
    const { dbPath } = createTempDb();

    const sqlite = new Database(dbPath);
    const columns = sqlite
      .prepare("PRAGMA table_info('channel_messages')")
      .all()
      .map((row: any) => row.name)
      .sort();

    expect(columns).toContain('id');
    expect(columns).toContain('config_id');
    expect(columns).toContain('external_id');
    expect(columns).toContain('direction');
    expect(columns).toContain('content');
    expect(columns).toContain('session_id');
    expect(columns).toContain('user_id');
    expect(columns).toContain('user_name');
    expect(columns).toContain('metadata');
    expect(columns).toContain('created_at');

    sqlite.close();
  });

  it('session_key column has a UNIQUE constraint', () => {
    const { dbPath } = createTempDb();
    const now = new Date().toISOString();

    const sqlite = new Database(dbPath);
    sqlite.pragma('foreign_keys = ON');

    // Insert config
    sqlite
      .prepare(
        `INSERT INTO channel_configs (id, channel_type, name, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('cfg-1', 'slack', 'Test', 1, now, now);

    // Insert first session
    sqlite
      .prepare(
        `INSERT INTO channel_sessions (id, config_id, session_key, opencode_session_id, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('sess-1', 'cfg-1', 'unique-key', 'oc-1', now, now);

    // Insert second session with same session_key → should fail
    expect(() => {
      sqlite
        .prepare(
          `INSERT INTO channel_sessions (id, config_id, session_key, opencode_session_id, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('sess-2', 'cfg-1', 'unique-key', 'oc-2', now, now);
    }).toThrow();

    sqlite.close();
  });
});
