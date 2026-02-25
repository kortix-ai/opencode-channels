import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  encryptCredentials,
  decryptCredentials,
  isCredentialEncryptionEnabled,
} from '../src/lib/credentials.js';

// 64 hex chars → valid 32-byte key
const TEST_KEY = '0123456789abcdef'.repeat(4);
const ALT_KEY = 'a'.repeat(64);

describe('credentials', () => {
  // ── encryptCredentials / decryptCredentials round-trip ──────────────────

  describe('encryptCredentials', () => {
    it('returns credentials unmodified when no key is provided', async () => {
      const creds = { token: 'secret', apiKey: '12345' };
      const result = await encryptCredentials(creds);
      // No env var set and no explicit key → pass-through
      expect(result).toEqual(creds);
    });

    it('returns { _encrypted: "enc:..." } when an explicit key is provided', async () => {
      const creds = { token: 'my-secret-token' };
      const result = await encryptCredentials(creds, TEST_KEY);

      expect(result).toHaveProperty('_encrypted');
      expect(typeof result._encrypted).toBe('string');
      expect((result._encrypted as string).startsWith('enc:')).toBe(true);
      // Original keys should NOT be present
      expect(result).not.toHaveProperty('token');
    });

    it('returns credentials unmodified when key is too short', async () => {
      const creds = { key: 'value' };
      const shortKey = 'abcd'; // only 4 hex chars, not 64
      const result = await encryptCredentials(creds, shortKey);
      expect(result).toEqual(creds);
    });

    it('works with empty credential objects', async () => {
      const creds = {};
      const result = await encryptCredentials(creds, TEST_KEY);
      expect(result).toHaveProperty('_encrypted');
      expect((result._encrypted as string).startsWith('enc:')).toBe(true);
    });

    it('works with complex nested credential objects', async () => {
      const creds = {
        oauth: {
          accessToken: 'at-123',
          refreshToken: 'rt-456',
          expiresIn: 3600,
        },
        botToken: 'xoxb-foo',
        flags: [true, false, null],
        count: 42,
      };
      const result = await encryptCredentials(creds, TEST_KEY);
      expect(result).toHaveProperty('_encrypted');
    });
  });

  describe('decryptCredentials', () => {
    it('returns credentials as-is when no _encrypted field is present', async () => {
      const creds = { token: 'plain' };
      const result = await decryptCredentials(creds, TEST_KEY);
      expect(result).toEqual(creds);
    });

    it('returns credentials as-is when _encrypted is not a string', async () => {
      const creds = { _encrypted: 123 } as unknown as Record<string, unknown>;
      const result = await decryptCredentials(creds, TEST_KEY);
      expect(result).toEqual(creds);
    });

    it('returns credentials as-is when _encrypted does not start with "enc:"', async () => {
      const creds = { _encrypted: 'not-encrypted-data' };
      const result = await decryptCredentials(creds, TEST_KEY);
      expect(result).toEqual(creds);
    });

    it('returns credentials as-is when _encrypted is present but no key is provided', async () => {
      // First encrypt with a key
      const original = { token: 'secret' };
      const encrypted = await encryptCredentials(original, TEST_KEY);
      expect(encrypted).toHaveProperty('_encrypted');

      // Then try to decrypt without a key (and no env var set)
      const result = await decryptCredentials(encrypted);
      // Should return the encrypted object as-is since we can't decrypt
      expect(result).toEqual(encrypted);
    });
  });

  describe('round-trip encrypt → decrypt', () => {
    it('recovers the original simple object', async () => {
      const original = { token: 'my-secret', apiKey: 'abc123' };
      const encrypted = await encryptCredentials(original, TEST_KEY);
      const decrypted = await decryptCredentials(encrypted, TEST_KEY);
      expect(decrypted).toEqual(original);
    });

    it('recovers a complex nested object', async () => {
      const original = {
        oauth: { accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 },
        botToken: 'xoxb-foo',
        nested: { deep: { value: [1, 2, 3] } },
      };
      const encrypted = await encryptCredentials(original, TEST_KEY);
      const decrypted = await decryptCredentials(encrypted, TEST_KEY);
      expect(decrypted).toEqual(original);
    });

    it('recovers an empty object', async () => {
      const original = {};
      const encrypted = await encryptCredentials(original, TEST_KEY);
      const decrypted = await decryptCredentials(encrypted, TEST_KEY);
      expect(decrypted).toEqual(original);
    });

    it('produces different ciphertext each time (random IV)', async () => {
      const original = { token: 'same' };
      const enc1 = await encryptCredentials(original, TEST_KEY);
      const enc2 = await encryptCredentials(original, TEST_KEY);
      // Both should be valid encrypted blobs but different due to random IV
      expect(enc1._encrypted).not.toEqual(enc2._encrypted);
      // Both should decrypt to the same original
      expect(await decryptCredentials(enc1, TEST_KEY)).toEqual(original);
      expect(await decryptCredentials(enc2, TEST_KEY)).toEqual(original);
    });

    it('works with the alternate key', async () => {
      const original = { secret: 'data' };
      const encrypted = await encryptCredentials(original, ALT_KEY);
      const decrypted = await decryptCredentials(encrypted, ALT_KEY);
      expect(decrypted).toEqual(original);
    });
  });

  // ── isCredentialEncryptionEnabled ───────────────────────────────────────

  describe('isCredentialEncryptionEnabled', () => {
    let savedChannelsKey: string | undefined;
    let savedCredentialKey: string | undefined;

    beforeEach(() => {
      savedChannelsKey = process.env.CHANNELS_CREDENTIAL_KEY;
      savedCredentialKey = process.env.CREDENTIAL_KEY;
      delete process.env.CHANNELS_CREDENTIAL_KEY;
      delete process.env.CREDENTIAL_KEY;
    });

    afterEach(() => {
      if (savedChannelsKey !== undefined) {
        process.env.CHANNELS_CREDENTIAL_KEY = savedChannelsKey;
      } else {
        delete process.env.CHANNELS_CREDENTIAL_KEY;
      }
      if (savedCredentialKey !== undefined) {
        process.env.CREDENTIAL_KEY = savedCredentialKey;
      } else {
        delete process.env.CREDENTIAL_KEY;
      }
    });

    it('returns false when neither env var is set', () => {
      expect(isCredentialEncryptionEnabled()).toBe(false);
    });

    it('returns true when CHANNELS_CREDENTIAL_KEY is set', () => {
      process.env.CHANNELS_CREDENTIAL_KEY = TEST_KEY;
      expect(isCredentialEncryptionEnabled()).toBe(true);
    });

    it('returns true when CREDENTIAL_KEY is set', () => {
      process.env.CREDENTIAL_KEY = TEST_KEY;
      expect(isCredentialEncryptionEnabled()).toBe(true);
    });

    it('returns true when both env vars are set', () => {
      process.env.CHANNELS_CREDENTIAL_KEY = TEST_KEY;
      process.env.CREDENTIAL_KEY = ALT_KEY;
      expect(isCredentialEncryptionEnabled()).toBe(true);
    });

    it('returns true even for a non-64-char key (env presence is enough)', () => {
      // isCredentialEncryptionEnabled only checks presence, not validity
      process.env.CREDENTIAL_KEY = 'short';
      expect(isCredentialEncryptionEnabled()).toBe(true);
    });
  });
});
