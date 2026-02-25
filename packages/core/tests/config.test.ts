import { describe, it, expect } from 'vitest';
import { loadConfig, configSchema } from '../src/config.js';
import { ZodError } from 'zod';

describe('loadConfig', () => {
  // ── Defaults ──────────────────────────────────────────────────────────

  it('returns all defaults when env is empty', () => {
    const config = loadConfig({});
    expect(config.OPENCODE_URL).toBe('http://localhost:8000');
    expect(config.CREDENTIAL_KEY).toBeUndefined();
    expect(config.PORT).toBe(3456);
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.DB_PATH).toBe('./channels.db');
  });

  // ── CHANNELS_ prefix priority ─────────────────────────────────────────

  it('picks CHANNELS_CREDENTIAL_KEY over CREDENTIAL_KEY', () => {
    const config = loadConfig({
      CREDENTIAL_KEY: 'a'.repeat(64),
      CHANNELS_CREDENTIAL_KEY: 'b'.repeat(64),
    });
    expect(config.CREDENTIAL_KEY).toBe('b'.repeat(64));
  });

  it('falls back to CREDENTIAL_KEY when CHANNELS_CREDENTIAL_KEY is absent', () => {
    const config = loadConfig({
      CREDENTIAL_KEY: 'c'.repeat(64),
    });
    expect(config.CREDENTIAL_KEY).toBe('c'.repeat(64));
  });

  it('picks CHANNELS_PORT over PORT and coerces string to number', () => {
    const config = loadConfig({
      PORT: '4000',
      CHANNELS_PORT: '5000',
    });
    expect(config.PORT).toBe(5000);
  });

  it('falls back to PORT when CHANNELS_PORT is absent', () => {
    const config = loadConfig({ PORT: '4000' });
    expect(config.PORT).toBe(4000);
  });

  it('picks CHANNELS_HOST over HOST', () => {
    const config = loadConfig({
      HOST: '127.0.0.1',
      CHANNELS_HOST: 'localhost',
    });
    expect(config.HOST).toBe('localhost');
  });

  it('picks CHANNELS_LOG_LEVEL over LOG_LEVEL', () => {
    const config = loadConfig({
      LOG_LEVEL: 'warn',
      CHANNELS_LOG_LEVEL: 'debug',
    });
    expect(config.LOG_LEVEL).toBe('debug');
  });

  it('picks CHANNELS_DB_PATH over DB_PATH', () => {
    const config = loadConfig({
      DB_PATH: '/old/path.db',
      CHANNELS_DB_PATH: '/new/path.db',
    });
    expect(config.DB_PATH).toBe('/new/path.db');
  });

  // ── Validation: OPENCODE_URL ──────────────────────────────────────────

  it('validates OPENCODE_URL must be a valid URL', () => {
    expect(() => loadConfig({ OPENCODE_URL: 'not-a-url' })).toThrow(ZodError);
  });

  it('accepts a valid OPENCODE_URL', () => {
    const config = loadConfig({ OPENCODE_URL: 'https://my-server.com:9000' });
    expect(config.OPENCODE_URL).toBe('https://my-server.com:9000');
  });

  // ── Validation: CREDENTIAL_KEY ────────────────────────────────────────

  it('validates CREDENTIAL_KEY must be exactly 64 hex chars', () => {
    expect(() => loadConfig({ CREDENTIAL_KEY: 'tooshort' })).toThrow(ZodError);
  });

  it('rejects CREDENTIAL_KEY with 63 hex chars', () => {
    expect(() => loadConfig({ CREDENTIAL_KEY: 'a'.repeat(63) })).toThrow(ZodError);
  });

  it('rejects CREDENTIAL_KEY with 65 hex chars', () => {
    expect(() => loadConfig({ CREDENTIAL_KEY: 'a'.repeat(65) })).toThrow(ZodError);
  });

  it('rejects CREDENTIAL_KEY with non-hex characters', () => {
    expect(() => loadConfig({ CREDENTIAL_KEY: 'g'.repeat(64) })).toThrow(ZodError);
  });

  it('accepts CREDENTIAL_KEY with mixed-case hex', () => {
    const key = 'aAbBcCdD'.repeat(8); // 64 chars
    const config = loadConfig({ CREDENTIAL_KEY: key });
    expect(config.CREDENTIAL_KEY).toBe(key);
  });

  // ── Validation: PORT ──────────────────────────────────────────────────

  it('rejects PORT of 0', () => {
    expect(() => loadConfig({ CHANNELS_PORT: '0' })).toThrow(ZodError);
  });

  it('rejects PORT of 65536', () => {
    expect(() => loadConfig({ CHANNELS_PORT: '65536' })).toThrow(ZodError);
  });

  it('rejects negative PORT', () => {
    expect(() => loadConfig({ CHANNELS_PORT: '-1' })).toThrow(ZodError);
  });

  it('accepts PORT of 1', () => {
    const config = loadConfig({ CHANNELS_PORT: '1' });
    expect(config.PORT).toBe(1);
  });

  it('accepts PORT of 65535', () => {
    const config = loadConfig({ CHANNELS_PORT: '65535' });
    expect(config.PORT).toBe(65535);
  });

  // ── Validation: LOG_LEVEL ─────────────────────────────────────────────

  it('validates LOG_LEVEL enum', () => {
    expect(() => loadConfig({ CHANNELS_LOG_LEVEL: 'verbose' })).toThrow(ZodError);
  });

  it('accepts all valid log levels', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      const config = loadConfig({ CHANNELS_LOG_LEVEL: level });
      expect(config.LOG_LEVEL).toBe(level);
    }
  });

  // ── Frozen result ─────────────────────────────────────────────────────

  it('result is frozen (Object.isFrozen)', () => {
    const config = loadConfig({});
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('throws when trying to mutate a frozen config', () => {
    const config = loadConfig({});
    expect(() => {
      (config as any).PORT = 9999;
    }).toThrow();
  });

  // ── ZodError on bad input ─────────────────────────────────────────────

  it('throws ZodError with issues array on bad input', () => {
    try {
      loadConfig({ OPENCODE_URL: 'nope', CHANNELS_PORT: 'abc', CHANNELS_LOG_LEVEL: 'nope' });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
      expect((err as ZodError).issues.length).toBeGreaterThan(0);
    }
  });
});

describe('configSchema', () => {
  it('exports a zod schema', () => {
    expect(configSchema).toBeDefined();
    expect(typeof configSchema.parse).toBe('function');
  });
});
