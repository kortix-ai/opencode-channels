import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifySlackSignature, verifySlackRequest } from '../src/utils.js';
import crypto from 'node:crypto';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute the expected Slack signature for a given secret/timestamp/body
 * using Node's crypto module (reference implementation).
 */
function computeSignature(secret: string, timestamp: string, body: string): string {
  const basestring = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', secret).update(basestring).digest('hex');
  return `v0=${hmac}`;
}

// ─── verifySlackSignature ───────────────────────────────────────────────────

describe('verifySlackSignature', () => {
  const signingSecret = 'test-signing-secret-abc123';
  const timestamp = '1672531200';
  const body = 'token=abc&team_id=T123&text=hello';

  it('returns true for a correctly computed HMAC signature', async () => {
    const signature = computeSignature(signingSecret, timestamp, body);
    const result = await verifySlackSignature(signingSecret, timestamp, body, signature);
    expect(result).toBe(true);
  });

  it('returns false for an incorrect signature', async () => {
    const badSignature = 'v0=0000000000000000000000000000000000000000000000000000000000000000';
    const result = await verifySlackSignature(signingSecret, timestamp, body, badSignature);
    expect(result).toBe(false);
  });

  it('returns false when signature lengths differ', async () => {
    const shortSignature = 'v0=abcd';
    const result = await verifySlackSignature(signingSecret, timestamp, body, shortSignature);
    expect(result).toBe(false);
  });

  it('returns false for empty signature', async () => {
    const result = await verifySlackSignature(signingSecret, timestamp, body, '');
    expect(result).toBe(false);
  });

  it('returns true with different secret/body combinations', async () => {
    const otherSecret = 'another-secret';
    const otherBody = '{"key":"value"}';
    const sig = computeSignature(otherSecret, timestamp, otherBody);
    const result = await verifySlackSignature(otherSecret, timestamp, otherBody, sig);
    expect(result).toBe(true);
  });

  it('returns false when using the wrong secret', async () => {
    const correctSig = computeSignature(signingSecret, timestamp, body);
    const result = await verifySlackSignature('wrong-secret', timestamp, body, correctSig);
    expect(result).toBe(false);
  });

  it('returns false when timestamp differs', async () => {
    const sig = computeSignature(signingSecret, timestamp, body);
    const result = await verifySlackSignature(signingSecret, '9999999999', body, sig);
    expect(result).toBe(false);
  });

  it('returns false when body differs', async () => {
    const sig = computeSignature(signingSecret, timestamp, body);
    const result = await verifySlackSignature(signingSecret, timestamp, 'tampered-body', sig);
    expect(result).toBe(false);
  });
});

// ─── verifySlackRequest ─────────────────────────────────────────────────────

describe('verifySlackRequest', () => {
  const signingSecret = 'test-signing-secret-abc123';
  const body = 'token=abc&team_id=T123&text=hello';

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true (skip verification) when signingSecret is empty string', async () => {
    const result = await verifySlackRequest(
      body,
      { timestamp: '0', signature: 'anything' },
      '',
    );
    expect(result).toBe(true);
  });

  it('returns false when timestamp is stale (>300s old)', async () => {
    // Set "now" to a known epoch
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    // Timestamp that is 600 seconds in the past
    const staleTimestamp = String(now - 600);
    const sig = computeSignature(signingSecret, staleTimestamp, body);

    const result = await verifySlackRequest(
      body,
      { timestamp: staleTimestamp, signature: sig },
      signingSecret,
    );
    expect(result).toBe(false);
  });

  it('returns false when timestamp is 301 seconds old', async () => {
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    const staleTimestamp = String(now - 301);
    const sig = computeSignature(signingSecret, staleTimestamp, body);

    const result = await verifySlackRequest(
      body,
      { timestamp: staleTimestamp, signature: sig },
      signingSecret,
    );
    expect(result).toBe(false);
  });

  it('returns true when timestamp is exactly 300 seconds old with valid signature', async () => {
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    const validTimestamp = String(now - 300);
    const sig = computeSignature(signingSecret, validTimestamp, body);

    const result = await verifySlackRequest(
      body,
      { timestamp: validTimestamp, signature: sig },
      signingSecret,
    );
    expect(result).toBe(true);
  });

  it('returns false when timestamp is in the future beyond 300s', async () => {
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    const futureTimestamp = String(now + 400);
    const sig = computeSignature(signingSecret, futureTimestamp, body);

    const result = await verifySlackRequest(
      body,
      { timestamp: futureTimestamp, signature: sig },
      signingSecret,
    );
    expect(result).toBe(false);
  });

  it('delegates to verifySlackSignature for valid timestamp and returns true for correct signature', async () => {
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    const timestamp = String(now - 10); // 10 seconds ago
    const sig = computeSignature(signingSecret, timestamp, body);

    const result = await verifySlackRequest(
      body,
      { timestamp, signature: sig },
      signingSecret,
    );
    expect(result).toBe(true);
  });

  it('delegates to verifySlackSignature for valid timestamp and returns false for bad signature', async () => {
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    const timestamp = String(now - 10);
    const result = await verifySlackRequest(
      body,
      { timestamp, signature: 'v0=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad' },
      signingSecret,
    );
    expect(result).toBe(false);
  });

  it('returns true when timestamp is current (0 seconds offset)', async () => {
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    const timestamp = String(now);
    const sig = computeSignature(signingSecret, timestamp, body);

    const result = await verifySlackRequest(
      body,
      { timestamp, signature: sig },
      signingSecret,
    );
    expect(result).toBe(true);
  });
});
