import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPermissionRequest,
  replyPermissionRequest,
  isPermissionPending,
  pendingCount,
} from '../src/pending-permissions.js';

describe('pending-permissions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── create + reply ────────────────────────────────────────────────────

  it('create + reply(true) resolves to true', async () => {
    const promise = createPermissionRequest('test-approve-1');
    replyPermissionRequest('test-approve-1', true);
    await expect(promise).resolves.toBe(true);
  });

  it('create + reply(false) resolves to false', async () => {
    const promise = createPermissionRequest('test-reject-1');
    replyPermissionRequest('test-reject-1', false);
    await expect(promise).resolves.toBe(false);
  });

  // ── reply return values ───────────────────────────────────────────────

  it('reply returns true when request is found', () => {
    createPermissionRequest('test-found-1');
    const result = replyPermissionRequest('test-found-1', true);
    expect(result).toBe(true);
  });

  it('reply returns false for unknown ID', () => {
    const result = replyPermissionRequest('nonexistent-id-12345', true);
    expect(result).toBe(false);
  });

  // ── Timeout ───────────────────────────────────────────────────────────

  it('timeout (5 min) auto-resolves to false', async () => {
    const promise = createPermissionRequest('test-timeout-1');

    // Advance past the 5-minute timeout
    vi.advanceTimersByTime(5 * 60 * 1000);

    await expect(promise).resolves.toBe(false);
  });

  it('request is no longer pending after timeout', async () => {
    createPermissionRequest('test-timeout-cleanup-1');
    expect(isPermissionPending('test-timeout-cleanup-1')).toBe(true);

    vi.advanceTimersByTime(5 * 60 * 1000);

    // Allow microtask queue to flush
    await vi.advanceTimersByTimeAsync(0);

    expect(isPermissionPending('test-timeout-cleanup-1')).toBe(false);
  });

  // ── Duplicate requestId ───────────────────────────────────────────────

  it('duplicate requestId: old promise resolves false, new one works', async () => {
    const oldPromise = createPermissionRequest('test-dup-1');
    const newPromise = createPermissionRequest('test-dup-1');

    // Old promise should resolve to false (rejected by duplicate)
    await expect(oldPromise).resolves.toBe(false);

    // New promise should still be pending
    expect(isPermissionPending('test-dup-1')).toBe(true);

    // Reply to new one
    replyPermissionRequest('test-dup-1', true);
    await expect(newPromise).resolves.toBe(true);
  });

  // ── isPermissionPending ───────────────────────────────────────────────

  it('isPermissionPending returns true for active request', () => {
    createPermissionRequest('test-pending-1');
    expect(isPermissionPending('test-pending-1')).toBe(true);
  });

  it('isPermissionPending returns false after reply', () => {
    createPermissionRequest('test-pending-after-1');
    replyPermissionRequest('test-pending-after-1', true);
    expect(isPermissionPending('test-pending-after-1')).toBe(false);
  });

  it('isPermissionPending returns false for never-created ID', () => {
    expect(isPermissionPending('never-created-xyz')).toBe(false);
  });

  // ── pendingCount ──────────────────────────────────────────────────────

  it('pendingCount reflects current state', () => {
    const baseline = pendingCount();

    createPermissionRequest('test-count-a');
    expect(pendingCount()).toBe(baseline + 1);

    createPermissionRequest('test-count-b');
    expect(pendingCount()).toBe(baseline + 2);

    replyPermissionRequest('test-count-a', true);
    expect(pendingCount()).toBe(baseline + 1);

    replyPermissionRequest('test-count-b', false);
    expect(pendingCount()).toBe(baseline);
  });

  // ── Timer cleanup ─────────────────────────────────────────────────────

  it('timer is cleared on reply (no late resolve)', async () => {
    const promise = createPermissionRequest('test-timer-clear-1');
    replyPermissionRequest('test-timer-clear-1', true);
    await expect(promise).resolves.toBe(true);

    // Advancing past timeout should not cause any issues
    vi.advanceTimersByTime(5 * 60 * 1000);

    // The request should remain not pending (timer was cleaned up)
    expect(isPermissionPending('test-timer-clear-1')).toBe(false);
  });

  it('timer is cleared on reply — pendingCount stays stable', async () => {
    const baseline = pendingCount();
    const promise = createPermissionRequest('test-timer-stable-1');
    replyPermissionRequest('test-timer-stable-1', true);
    await promise;

    // Advance timers — timeout callback should NOT decrement count again
    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(pendingCount()).toBe(baseline);
  });
});
