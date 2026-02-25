// ─── Channel enums ──────────────────────────────────────────────────────────

export type ChannelType =
  | 'telegram'
  | 'slack'
  | 'discord'
  | 'whatsapp'
  | 'teams'
  | 'voice'
  | 'email'
  | 'sms';

export type SessionStrategy = 'single' | 'per-thread' | 'per-user' | 'per-message';

export type ChatType = 'dm' | 'group' | 'channel';

export type MessageDirection = 'inbound' | 'outbound';

// ─── Attachments ────────────────────────────────────────────────────────────

export interface Attachment {
  type: 'image' | 'file' | 'audio' | 'video' | 'sticker';
  url?: string;
  mimeType?: string;
  name?: string;
  size?: number;
}

// ─── Thread context ─────────────────────────────────────────────────────────

export interface ThreadMessage {
  sender: string;
  text: string;
  isBot?: boolean;
}

// ─── Model / agent overrides ────────────────────────────────────────────────

export interface MessageOverrides {
  model?: { providerID: string; modelID: string };
  agentName?: string;
}

// ─── Normalized message (platform-agnostic) ─────────────────────────────────

export interface NormalizedMessage {
  externalId: string;
  channelType: ChannelType;
  channelConfigId: string;
  chatType: ChatType;
  content: string;
  attachments: Attachment[];
  platformUser: {
    id: string;
    name: string;
    avatar?: string;
  };
  threadId?: string;
  groupId?: string;
  isMention?: boolean;
  raw?: unknown;
  /** Previous messages in the thread, for context */
  threadContext?: ThreadMessage[];
  /** Per-message overrides for model or agent routing */
  overrides?: MessageOverrides;
}

// ─── Agent response ─────────────────────────────────────────────────────────

export interface AgentResponse {
  content: string;
  sessionId: string;
  truncated?: boolean;
  modelName?: string;
  durationMs?: number;
  /** Platform message ID from streaming updates — allows final sendResponse to edit in-place */
  streamMsgId?: string;
}

// ─── Channel capabilities ───────────────────────────────────────────────────

export interface ChannelCapabilities {
  textChunkLimit: number;
  supportsRichText: boolean;
  supportsEditing: boolean;
  supportsTypingIndicator: boolean;
  supportsAttachments: boolean;
  connectionType: 'webhook' | 'websocket' | 'polling';
}

// ─── Channel config (stored in SQLite) ──────────────────────────────────────

export interface ChannelConfig {
  id: string;
  channelType: ChannelType;
  name: string;
  enabled: boolean;
  credentials: Record<string, unknown>;
  platformConfig: Record<string, unknown>;
  metadata: Record<string, unknown>;
  sessionStrategy: SessionStrategy;
  systemPrompt: string | null;
  agentName: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Permission request ─────────────────────────────────────────────────────

export interface PermissionRequest {
  id: string;
  tool: string;
  description: string;
}

// ─── File output ────────────────────────────────────────────────────────────

export interface FileOutput {
  name: string;
  url: string;
  mimeType?: string;
  content?: Buffer;
}

// ─── SSE stream event ───────────────────────────────────────────────────────

export interface StreamEvent {
  type: 'text' | 'busy' | 'done' | 'error' | 'permission' | 'file';
  data?: string;
  permission?: { id: string; tool: string; description: string };
  file?: { name: string; url: string; mimeType?: string };
}
