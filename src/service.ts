import type { Chat } from 'chat';

import { OpenCodeClient } from './opencode.js';
import { SessionManager, type ChannelSessionPersistConfig } from './sessions.js';
import { createChatInstance, readAdaptersFromEnv } from './bot.js';
import { adapterModules } from './adapters/registry.js';
import type { AdapterCredentials } from './adapters/types.js';
import type { TelegramDirectConfig } from './telegram-api.js';
import type { ReloadResult } from './types.js';

/** Build TelegramDirectConfig from env (or credentials) if available. */
function buildTelegramConfig(credentials: AdapterCredentials): TelegramDirectConfig | undefined {
  const botToken = (credentials.telegram as { botToken?: string } | undefined)?.botToken
    ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return undefined;
  return { botToken, apiBaseUrl: process.env.TELEGRAM_API_BASE_URL };
}

/** Build persistence config from environment, if available. */
function buildPersistConfig(channelConfigId?: string): ChannelSessionPersistConfig | undefined {
  const kortixApiUrl = process.env.KORTIX_API_URL;
  const kortixToken = process.env.KORTIX_TOKEN;
  const configId = channelConfigId ?? process.env.CHANNEL_CONFIG_ID;
  if (!kortixApiUrl || !kortixToken || !configId) return undefined;
  return { kortixApiUrl, kortixToken, channelConfigId: configId };
}

export interface ChannelsServiceConfig {
  opencodeUrl?: string;
  botName?: string;
  agentName?: string;
  systemPrompt?: string;
  model?: { providerID: string; modelID: string };
  credentials?: AdapterCredentials;
  /** If provided, sessions will be persisted to kortix-api with this channel config ID. */
  channelConfigId?: string;
  /** Channel metadata injected into the agent system prompt for context-awareness. */
  channelContext?: {
    channelName?: string;
    channelType?: string;
    platform?: string;
  };
}

export class ChannelsService {
  readonly client: OpenCodeClient;
  readonly sessions: SessionManager;
  readonly botName: string;

  private _currentModel: { providerID: string; modelID: string } | undefined;
  private _systemPrompt: string | undefined;
  private _credentials: AdapterCredentials;
  private _channelContext: ChannelsServiceConfig['channelContext'];
  private _channelConfigId: string | undefined;

  private _bot: Chat | null = null;

  constructor(config: ChannelsServiceConfig = {}) {
    const opencodeUrl = config.opencodeUrl || process.env.OPENCODE_URL || 'http://localhost:1707';
    this.botName = config.botName || process.env.OPENCODE_BOT_NAME || 'opencode';

    this._channelConfigId = config.channelConfigId ?? process.env.CHANNEL_CONFIG_ID;
    this._channelContext = config.channelContext;

    this.client = new OpenCodeClient({ baseUrl: opencodeUrl });
    this.sessions = new SessionManager(
      'per-thread',
      config.agentName,
      buildPersistConfig(this._channelConfigId),
    );
    this._currentModel = config.model;
    this._systemPrompt = config.systemPrompt;
    this._credentials = config.credentials ?? readAdaptersFromEnv();
  }

  /** Initialize the bot (must be called after constructor). */
  async init(): Promise<void> {
    this._bot = await createChatInstance({
      credentials: this._credentials,
      client: this.client,
      sessions: this.sessions,
      getModel: () => this._currentModel,
      setModel: (m) => { this._currentModel = m; },
      getSystemPrompt: () => this._buildSystemPrompt(),
      botName: this.botName,
      telegramConfig: buildTelegramConfig(this._credentials),
    });
  }

  get bot(): Chat | null {
    return this._bot;
  }

  get activeAdapters(): string[] {
    if (!this._bot) return [];
    return adapterModules.filter(m => this._credentials[m.name]).map(m => m.name);
  }

  get credentials(): AdapterCredentials {
    return this._credentials;
  }

  setModel(m: { providerID: string; modelID: string } | undefined): void {
    this._currentModel = m;
  }

  setSystemPrompt(prompt: string | undefined): void {
    this._systemPrompt = prompt;
  }

  /**
   * Build the system prompt. Keeps this lean — the per-session channel context
   * (platform, chatId, send instructions) is injected once by bot.ts on the
   * first message of each session, not here.
   */
  private _buildSystemPrompt(): string | undefined {
    const parts: string[] = [];

    // User-configured custom system prompt (from channel config)
    if (this._systemPrompt) {
      parts.push(this._systemPrompt);
    }

    // Minimal channel identity — just enough for the agent to know it's in a channel
    const platform = this._channelContext?.platform ?? this._deriveActivePlatform();
    const channelName = this._channelContext?.channelName ?? '';
    const identity = [
      `You are an AI agent responding via ${channelName || platform || 'a chat channel'}.`,
      `Keep responses concise and chat-appropriate (brief paragraphs, short bullet points).`,
      `The exact channel ID and send instructions are provided on the first message of each conversation.`,
    ].join(' ');
    parts.push(identity);

    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }

  /** Derive which platform is active from the loaded credentials. */
  private _deriveActivePlatform(): string {
    if (this._credentials.slack) return 'slack';
    if (this._credentials.telegram) return 'telegram';
    if (this._credentials.discord) return 'discord';
    return 'unknown';
  }

  async reload(credentials: AdapterCredentials): Promise<ReloadResult> {
    if (credentialsEqual(this._credentials, credentials)) {
      return {
        ok: true,
        adapters: this.activeAdapters,
        reloaded: false,
      };
    }

    console.log('[opencode-channels] Reloading with new credentials...');
    this._credentials = credentials;

    this._bot = await createChatInstance({
      credentials,
      client: this.client,
      sessions: this.sessions,
      getModel: () => this._currentModel,
      setModel: (m) => { this._currentModel = m; },
      getSystemPrompt: () => this._buildSystemPrompt(),
      botName: this.botName,
      telegramConfig: buildTelegramConfig(credentials),
    });

    console.log(`[opencode-channels] Reload complete. Active adapters: ${this.activeAdapters.join(', ') || 'none'}`);

    return {
      ok: true,
      adapters: this.activeAdapters,
      reloaded: true,
    };
  }
}

function credentialsEqual(a: AdapterCredentials, b: AdapterCredentials): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
