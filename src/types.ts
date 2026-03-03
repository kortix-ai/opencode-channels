export type { AdapterCredentials } from './adapters/types.js';
export type { AdapterModule } from './adapters/types.js';

export interface ReloadRequest {
  credentials: Record<string, unknown>;
}

export interface ReloadResult {
  ok: boolean;
  adapters: string[];
  reloaded: boolean;
}
