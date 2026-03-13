import type { Hono } from 'hono';
import type { Chat } from 'chat';

export interface AdapterModule<TCreds = unknown> {
  readonly name: string;
  readCredentialsFromEnv(): TCreds | undefined;
  createAdapter(credentials: TCreds): unknown;
  registerRoutes?(app: Hono, getBot: () => Chat | null): void;
}

export interface SlackCredentials {
  botToken: string;
  signingSecret: string;
}

export interface DiscordCredentials {
  botToken: string;
  publicKey: string;
  applicationId: string;
  mentionRoleIds?: string[];
}

export interface TelegramCredentials {
  botToken: string;
  secretToken?: string;
  botUsername?: string;
  apiBaseUrl?: string;
}

export type AdapterCredentials = Record<string, unknown>;
