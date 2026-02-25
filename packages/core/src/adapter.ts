import type { Hono } from 'hono';
import type {
  ChannelType,
  ChannelCapabilities,
  ChannelConfig,
  NormalizedMessage,
  AgentResponse,
  SessionStrategy,
  PermissionRequest,
  FileOutput,
} from './types.js';

// Re-export for convenience
export type { PermissionRequest, FileOutput } from './types.js';

// ─── ChannelAdapter interface ───────────────────────────────────────────────

export interface ChannelAdapter {
  readonly type: ChannelType;
  readonly name: string;
  readonly capabilities: ChannelCapabilities;

  /** Register webhook / HTTP routes on the Hono router */
  registerRoutes(router: Hono, engine: ChannelEngine): void;

  /** Start long-lived connections (websockets, polling loops, etc.) */
  start?(signal: AbortSignal): Promise<void>;

  /** Graceful shutdown */
  shutdown?(): Promise<void>;

  /** Send a completed agent response back to the platform */
  sendResponse(
    config: ChannelConfig,
    message: NormalizedMessage,
    response: AgentResponse,
  ): Promise<void>;

  /** Show a typing / "thinking" indicator */
  sendTypingIndicator?(config: ChannelConfig, message: NormalizedMessage): Promise<void>;

  /** Clear the typing indicator */
  removeTypingIndicator?(config: ChannelConfig, message: NormalizedMessage): Promise<void>;

  /** Called when a new channel config is created */
  onChannelCreated?(config: ChannelConfig): Promise<void>;

  /** Called when a channel config is deleted */
  onChannelRemoved?(config: ChannelConfig): Promise<void>;

  /** Validate platform credentials before saving */
  validateCredentials?(
    credentials: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }>;

  /** Send a tool-permission prompt to the user */
  sendPermissionRequest?(
    config: ChannelConfig,
    message: NormalizedMessage,
    permission: PermissionRequest,
  ): Promise<void>;

  /** Send file outputs to the platform */
  sendFiles?(
    config: ChannelConfig,
    message: NormalizedMessage,
    files: FileOutput[],
  ): Promise<void>;

  /** Send a message that is not linked to an existing session */
  sendUnlinkedMessage?(
    config: ChannelConfig,
    message: NormalizedMessage,
  ): Promise<void>;

  /** React to indicate processing completed successfully */
  reactComplete?(config: ChannelConfig, message: NormalizedMessage): Promise<void>;

  /** React to indicate processing failed */
  reactError?(config: ChannelConfig, message: NormalizedMessage): Promise<void>;

  /** React to indicate files were created or modified */
  reactFilesChanged?(config: ChannelConfig, message: NormalizedMessage): Promise<void>;
}

// ─── ChannelEngine interface ────────────────────────────────────────────────

export interface ChannelEngine {
  /** Process an inbound message through the pipeline */
  processMessage(message: NormalizedMessage): Promise<void>;

  /** Reset (destroy) the session associated with a message */
  resetSession(
    configId: string,
    channelType: string,
    strategy: SessionStrategy,
    message: NormalizedMessage,
  ): Promise<void>;
}

// ─── BaseAdapter (abstract, no-op defaults) ─────────────────────────────────

export abstract class BaseAdapter implements ChannelAdapter {
  abstract readonly type: ChannelType;
  abstract readonly name: string;
  abstract readonly capabilities: ChannelCapabilities;

  abstract registerRoutes(router: Hono, engine: ChannelEngine): void;

  abstract sendResponse(
    config: ChannelConfig,
    message: NormalizedMessage,
    response: AgentResponse,
  ): Promise<void>;

  /** Extract the bot token from a config's credentials */
  protected getBotToken(config: ChannelConfig): string | null {
    const credentials = config.credentials as Record<string, unknown>;
    return (credentials?.botToken as string) || null;
  }

  /** Typed credential accessor */
  protected getCredential<T>(config: ChannelConfig, key: string): T | undefined {
    const credentials = config.credentials as Record<string, unknown>;
    return credentials?.[key] as T | undefined;
  }

  // No-op defaults for optional methods
  async sendTypingIndicator(_config: ChannelConfig, _message: NormalizedMessage): Promise<void> {}
  async removeTypingIndicator(_config: ChannelConfig, _message: NormalizedMessage): Promise<void> {}
  async onChannelCreated(_config: ChannelConfig): Promise<void> {}
  async onChannelRemoved(_config: ChannelConfig): Promise<void> {}

  async validateCredentials(
    _credentials: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    return { valid: true };
  }

  async sendPermissionRequest(
    _config: ChannelConfig,
    _message: NormalizedMessage,
    _permission: PermissionRequest,
  ): Promise<void> {}

  async sendFiles(
    _config: ChannelConfig,
    _message: NormalizedMessage,
    _files: FileOutput[],
  ): Promise<void> {}

  async reactComplete(_config: ChannelConfig, _message: NormalizedMessage): Promise<void> {}
  async reactError(_config: ChannelConfig, _message: NormalizedMessage): Promise<void> {}
  async reactFilesChanged(_config: ChannelConfig, _message: NormalizedMessage): Promise<void> {}
}
