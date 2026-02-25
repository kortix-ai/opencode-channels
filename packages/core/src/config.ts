import { z } from 'zod';

/**
 * Zod schema for the @opencode-channels/core configuration.
 *
 * All values have sensible defaults and are read from `process.env`.
 * The optional `CREDENTIAL_KEY` must be exactly 64 hex characters (32 bytes)
 * when provided.
 */
export const configSchema = z.object({
  /** URL of the local OpenCode server */
  OPENCODE_URL: z
    .string()
    .url()
    .default('http://localhost:8000'),

  /** AES-GCM encryption key for channel credentials (64 hex chars / 32 bytes) */
  CREDENTIAL_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'CREDENTIAL_KEY must be exactly 64 hex characters')
    .optional(),

  /** Port the webhook HTTP server listens on */
  PORT: z.coerce.number().int().min(1).max(65535).default(3456),

  /** Host the webhook HTTP server binds to */
  HOST: z.string().default('0.0.0.0'),

  /** Log level */
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  /** Path to the SQLite database file */
  DB_PATH: z.string().default('./channels.db'),
});

export type ChannelsConfig = z.infer<typeof configSchema>;

/**
 * Load configuration from `process.env`, validate with zod, and return a
 * frozen config object.
 *
 * Throws `ZodError` if validation fails.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): ChannelsConfig {
  const raw = {
    OPENCODE_URL: env.OPENCODE_URL,
    CREDENTIAL_KEY: env.CHANNELS_CREDENTIAL_KEY ?? env.CREDENTIAL_KEY,
    PORT: env.CHANNELS_PORT ?? env.PORT,
    HOST: env.CHANNELS_HOST ?? env.HOST,
    LOG_LEVEL: env.CHANNELS_LOG_LEVEL ?? env.LOG_LEVEL,
    DB_PATH: env.CHANNELS_DB_PATH ?? env.DB_PATH,
  };

  // Strip undefined values so zod .default() kicks in
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined),
  );

  return Object.freeze(configSchema.parse(cleaned));
}
