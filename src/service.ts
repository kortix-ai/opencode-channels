import type { Chat } from 'chat';

import { OpenCodeClient } from './opencode.js';
import { SessionManager } from './sessions.js';
import { createChatInstance, readAdaptersFromEnv } from './bot.js';
import { adapterModules } from './adapters/registry.js';
import type { AdapterCredentials } from './adapters/types.js';
import type { ReloadResult } from './types.js';

export interface ChannelsServiceConfig {
  opencodeUrl?: string;
  botName?: string;
  agentName?: string;
  systemPrompt?: string;
  model?: { providerID: string; modelID: string };
  credentials?: AdapterCredentials;
}

export class ChannelsService {
  readonly client: OpenCodeClient;
  readonly sessions: SessionManager;
  readonly botName: string;

  private _currentModel: { providerID: string; modelID: string } | undefined;
  private _systemPrompt: string | undefined;
  private _credentials: AdapterCredentials;

  private _bot: Chat | null = null;

  constructor(config: ChannelsServiceConfig = {}) {
    const opencodeUrl = config.opencodeUrl || process.env.OPENCODE_URL || 'http://localhost:1707';
    this.botName = config.botName || process.env.OPENCODE_BOT_NAME || 'opencode';

    this.client = new OpenCodeClient({ baseUrl: opencodeUrl });
    this.sessions = new SessionManager('per-thread', config.agentName);
    this._currentModel = config.model;
    this._systemPrompt = config.systemPrompt;
    this._credentials = config.credentials ?? readAdaptersFromEnv();

    this._bot = createChatInstance({
      credentials: this._credentials,
      client: this.client,
      sessions: this.sessions,
      getModel: () => this._currentModel,
      setModel: (m) => { this._currentModel = m; },
      getSystemPrompt: () => this._systemPrompt,
      botName: this.botName,
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

  reload(credentials: AdapterCredentials): ReloadResult {
    if (credentialsEqual(this._credentials, credentials)) {
      return {
        ok: true,
        adapters: this.activeAdapters,
        reloaded: false,
      };
    }

    console.log('[opencode-channels] Reloading with new credentials...');
    this._credentials = credentials;

    this._bot = createChatInstance({
      credentials,
      client: this.client,
      sessions: this.sessions,
      getModel: () => this._currentModel,
      setModel: (m) => { this._currentModel = m; },
      getSystemPrompt: () => this._systemPrompt,
      botName: this.botName,
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
