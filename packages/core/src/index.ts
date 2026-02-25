// ─── Types ──────────────────────────────────────────────────────────────────
export type {
  ChannelType,
  SessionStrategy,
  ChatType,
  MessageDirection,
  Attachment,
  ThreadMessage,
  MessageOverrides,
  NormalizedMessage,
  AgentResponse,
  ChannelCapabilities,
  ChannelConfig,
  PermissionRequest,
  FileOutput,
  StreamEvent,
} from './types.js';

// ─── Config ─────────────────────────────────────────────────────────────────
export { configSchema, loadConfig } from './config.js';
export type { ChannelsConfig } from './config.js';

// ─── Database ───────────────────────────────────────────────────────────────
export { channelConfigs, channelSessions, channelMessages } from './db/schema.js';
export { createDatabase, getDatabase } from './db/client.js';
export type { ChannelsDatabase } from './db/client.js';

// ─── Adapter ────────────────────────────────────────────────────────────────
export type { ChannelAdapter, ChannelEngine } from './adapter.js';
export { BaseAdapter } from './adapter.js';

// ─── Lib ────────────────────────────────────────────────────────────────────
export {
  encryptCredentials,
  decryptCredentials,
  isCredentialEncryptionEnabled,
} from './lib/credentials.js';
export { markdownToSlack } from './lib/markdown-to-slack.js';
export { splitMessage } from './lib/message-splitter.js';

// ─── Core utilities ─────────────────────────────────────────────────────────
export {
  createPermissionRequest,
  replyPermissionRequest,
  isPermissionPending,
  pendingCount,
} from './pending-permissions.js';
export { RateLimiter } from './rate-limiter.js';

// ─── OpenCode client & session management ───────────────────────────────────
export { OpenCodeClient } from './opencode-client.js';
export type { OpenCodeClientConfig } from './opencode-client.js';
export { SessionManager } from './session-manager.js';
export { ResponseStreamer } from './response-streamer.js';
export type { ToolActivity, OnToolActivity } from './response-streamer.js';
export { EventBridge } from './event-bridge.js';
export type { EventBridgeAdapter } from './event-bridge.js';
export { MessageQueue } from './queue.js';

// ─── Engine ─────────────────────────────────────────────────────────────────
export { ChannelEngineImpl } from './engine.js';

// ─── Webhook server ─────────────────────────────────────────────────────────
export { createWebhookServer, registerAdapter } from './webhook-server.js';
export type { WebhookServerConfig, WebhookServer } from './webhook-server.js';

// ─── Plugin ─────────────────────────────────────────────────────────────────
export { startChannels } from './plugin.js';
export type { ChannelsPluginOptions, ChannelsPluginResult } from './plugin.js';
export {
  getChannelConfig,
  listChannelConfigs,
  createChannelConfig,
  updateChannelConfig,
  deleteChannelConfig,
} from './plugin.js';

// ─── OpenCode Plugin ────────────────────────────────────────────────────────
export { OpenCodeChannelsPlugin, stopChannelsPlugin } from './opencode-plugin.js';
