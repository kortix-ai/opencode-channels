/**
 * AES-256-GCM encryption for channel credentials.
 *
 * Credentials are encrypted before storage and decrypted on read.
 * When no key is available, credentials pass through unmodified.
 */

import type { webcrypto } from 'node:crypto';

const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12;
const TAG_LENGTH = 128;
const ENCRYPTED_PREFIX = 'enc:';

let _cryptoKey: webcrypto.CryptoKey | null = null;
let _lastKeyHex: string | null = null;

/**
 * Derive a CryptoKey from a 64-character hex string.
 * The key is cached for the lifetime of the process (invalidated if the hex changes).
 */
async function getCryptoKey(keyHex?: string): Promise<webcrypto.CryptoKey | null> {
  const resolvedHex = keyHex ?? process.env.CHANNELS_CREDENTIAL_KEY ?? process.env.CREDENTIAL_KEY;
  if (!resolvedHex) return null;

  // Reuse cached key if the hex hasn't changed
  if (_cryptoKey && _lastKeyHex === resolvedHex) {
    return _cryptoKey;
  }

  const keyBytes = hexToBytes(resolvedHex);
  if (keyBytes.length !== 32) {
    console.error(
      '[CREDENTIALS] Encryption key must be 64 hex chars (32 bytes). Credentials will NOT be encrypted.',
    );
    return null;
  }

  _cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: ALGORITHM },
    false,
    ['encrypt', 'decrypt'],
  );
  _lastKeyHex = resolvedHex;

  return _cryptoKey;
}

/**
 * Encrypt a credentials object. Returns `{ _encrypted: "enc:..." }`.
 * If no key is available, the object is returned as-is.
 */
export async function encryptCredentials(
  credentials: Record<string, unknown>,
  key?: string,
): Promise<Record<string, unknown>> {
  const cryptoKey = await getCryptoKey(key);
  if (!cryptoKey) return credentials;

  const plaintext = JSON.stringify(credentials);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
    cryptoKey,
    new TextEncoder().encode(plaintext),
  );

  const combined = new Uint8Array(iv.length + cipherBuffer.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuffer), iv.length);

  const encoded = ENCRYPTED_PREFIX + bytesToBase64(combined);

  return { _encrypted: encoded };
}

/**
 * Decrypt a credentials object previously encrypted by `encryptCredentials`.
 * If the object is not encrypted or no key is available, returns as-is.
 */
export async function decryptCredentials(
  credentials: Record<string, unknown>,
  key?: string,
): Promise<Record<string, unknown>> {
  const encrypted = credentials._encrypted as string | undefined;

  if (!encrypted || typeof encrypted !== 'string' || !encrypted.startsWith(ENCRYPTED_PREFIX)) {
    return credentials;
  }

  const cryptoKey = await getCryptoKey(key);
  if (!cryptoKey) {
    console.error(
      '[CREDENTIALS] Cannot decrypt: encryption key not set but encrypted credentials found.',
    );
    return credentials;
  }

  const combined = base64ToBytes(encrypted.slice(ENCRYPTED_PREFIX.length));
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
    cryptoKey,
    ciphertext,
  );

  return JSON.parse(new TextDecoder().decode(plainBuffer));
}

/**
 * Check whether credential encryption is enabled (i.e. a key is configured).
 */
export function isCredentialEncryptionEnabled(): boolean {
  return !!(process.env.CHANNELS_CREDENTIAL_KEY ?? process.env.CREDENTIAL_KEY);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
