import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// ─── channelConfigs ─────────────────────────────────────────────────────────

export const channelConfigs = sqliteTable('channel_configs', {
  id: text('id').primaryKey().notNull(),
  channelType: text('channel_type').notNull(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  credentials: text('credentials').notNull().default('{}'),
  platformConfig: text('platform_config').notNull().default('{}'),
  metadata: text('metadata').notNull().default('{}'),
  sessionStrategy: text('session_strategy').notNull().default('per-user'),
  systemPrompt: text('system_prompt'),
  agentName: text('agent_name'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── channelSessions ────────────────────────────────────────────────────────

export const channelSessions = sqliteTable('channel_sessions', {
  id: text('id').primaryKey().notNull(),
  configId: text('config_id')
    .notNull()
    .references(() => channelConfigs.id, { onDelete: 'cascade' }),
  sessionKey: text('session_key').notNull().unique(),
  opencodeSessionId: text('opencode_session_id').notNull(),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at').notNull(),
});

// ─── channelMessages ────────────────────────────────────────────────────────

export const channelMessages = sqliteTable('channel_messages', {
  id: text('id').primaryKey().notNull(),
  configId: text('config_id')
    .notNull()
    .references(() => channelConfigs.id, { onDelete: 'cascade' }),
  externalId: text('external_id'),
  direction: text('direction').notNull(), // 'inbound' | 'outbound'
  content: text('content').notNull(),
  sessionId: text('session_id'),
  userId: text('user_id'),
  userName: text('user_name'),
  metadata: text('metadata').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
});
