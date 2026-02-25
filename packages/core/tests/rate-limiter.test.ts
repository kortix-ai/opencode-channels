import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../src/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new RateLimiter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Basic allow ───────────────────────────────────────────────────────

  it('first request is allowed', () => {
    const result = limiter.check('config1', 'user1');
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBeUndefined();
  });

  // ── Per-user limit (20) ───────────────────────────────────────────────

  it('20 requests from same user are allowed', () => {
    for (let i = 0; i < 20; i++) {
      const result = limiter.check('config1', 'userA');
      expect(result.allowed).toBe(true);
    }
  });

  it('21st request from same user is rate-limited', () => {
    for (let i = 0; i < 20; i++) {
      limiter.check('config1', 'userB');
    }
    const result = limiter.check('config1', 'userB');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeDefined();
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  // ── Independent user buckets ──────────────────────────────────────────

  it('different users have independent buckets', () => {
    // Exhaust userX
    for (let i = 0; i < 20; i++) {
      limiter.check('config1', 'userX');
    }
    expect(limiter.check('config1', 'userX').allowed).toBe(false);

    // userY should still be allowed
    expect(limiter.check('config1', 'userY').allowed).toBe(true);
  });

  // ── Per-config limit (60) ─────────────────────────────────────────────

  it('60 requests to same config are allowed (from different users)', () => {
    for (let i = 0; i < 60; i++) {
      // Each from a different user so we don't hit the per-user limit
      const result = limiter.check('configZ', `user-${i}`);
      expect(result.allowed).toBe(true);
    }
  });

  it('61st request to same config is rate-limited', () => {
    for (let i = 0; i < 60; i++) {
      limiter.check('configW', `user-${i}`);
    }
    const result = limiter.check('configW', 'user-61');
    expect(result.allowed).toBe(false);
  });

  // ── retryAfterMs ──────────────────────────────────────────────────────

  it('retryAfterMs is returned when rate-limited', () => {
    for (let i = 0; i < 20; i++) {
      limiter.check('config1', 'userC');
    }
    const result = limiter.check('config1', 'userC');
    expect(result.allowed).toBe(false);
    expect(typeof result.retryAfterMs).toBe('number');
    expect(result.retryAfterMs!).toBeGreaterThanOrEqual(1000);
  });

  // ── Token refill ──────────────────────────────────────────────────────

  it('tokens refill over time', () => {
    // Exhaust user limit
    for (let i = 0; i < 20; i++) {
      limiter.check('config1', 'userD');
    }
    expect(limiter.check('config1', 'userD').allowed).toBe(false);

    // Advance time by the full window (60 seconds) — should refill
    vi.advanceTimersByTime(60_000);

    const result = limiter.check('config1', 'userD');
    expect(result.allowed).toBe(true);
  });

  it('partial time advance refills partial tokens', () => {
    // Exhaust user limit (20 tokens)
    for (let i = 0; i < 20; i++) {
      limiter.check('config1', 'userE');
    }
    expect(limiter.check('config1', 'userE').allowed).toBe(false);

    // Advance by half the window — should refill ~10 tokens
    vi.advanceTimersByTime(30_000);

    // Should be allowed again (at least some tokens refilled)
    const result = limiter.check('config1', 'userE');
    expect(result.allowed).toBe(true);
  });

  // ── Cleanup ───────────────────────────────────────────────────────────

  it('cleanup removes stale buckets', () => {
    limiter.check('stale-config', 'stale-user');

    // Advance past 2× the window (120 seconds)
    vi.advanceTimersByTime(121_000);

    limiter.cleanup();

    // After cleanup, a new check should start fresh (allowed)
    const result = limiter.check('stale-config', 'stale-user');
    expect(result.allowed).toBe(true);
  });

  it('cleanup keeps recent buckets', () => {
    // Use up 15 tokens for a user
    for (let i = 0; i < 15; i++) {
      limiter.check('recent-config', 'recent-user');
    }

    // Only 30 seconds have passed — well within the 2× window
    vi.advanceTimersByTime(30_000);

    limiter.cleanup();

    // Bucket should still exist with reduced tokens
    // We used 15, partial refill of ~10 (30s/60s * 20), so ~15 tokens
    // 16th through ~25th requests should be allowed
    const result = limiter.check('recent-config', 'recent-user');
    expect(result.allowed).toBe(true);
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it('different configIds have independent config buckets', () => {
    // Exhaust config1
    for (let i = 0; i < 60; i++) {
      limiter.check('configA', `u${i}`);
    }
    expect(limiter.check('configA', 'u99').allowed).toBe(false);

    // configB should be unaffected
    expect(limiter.check('configB', 'u0').allowed).toBe(true);
  });

  it('retryAfterMs is at least 1000ms', () => {
    // Exhaust and check immediately
    for (let i = 0; i < 20; i++) {
      limiter.check('config1', 'userF');
    }
    const result = limiter.check('config1', 'userF');
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(1000);
  });
});
