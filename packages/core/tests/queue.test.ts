import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageQueue } from '../src/queue.js';
import type { NormalizedMessage, ChannelConfig } from '../src/types.js';
import type { OpenCodeClient } from '../src/opencode-client.js';

// ── Factories ────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: 'cfg-1',
    channelType: 'slack',
    name: 'Test Channel',
    enabled: true,
    credentials: {},
    platformConfig: {},
    metadata: {},
    sessionStrategy: 'per-user',
    systemPrompt: null,
    agentName: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeMessage(content = 'hello'): NormalizedMessage {
  return {
    externalId: `ext-${Math.random().toString(36).slice(2)}`,
    channelType: 'slack',
    channelConfigId: 'cfg-1',
    chatType: 'dm',
    content,
    attachments: [],
    platformUser: { id: 'user-1', name: 'Test User' },
  };
}

function makeClient(ready = true) {
  return {
    isReady: vi.fn().mockResolvedValue(ready),
  } as unknown as OpenCodeClient;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MessageQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enqueue + server immediately ready → callback invoked, promise resolves', async () => {
    const queue = new MessageQueue();
    const callback = vi.fn().mockResolvedValue(undefined);
    queue.onProcess(callback);

    const client = makeClient(true);
    const config = makeConfig();
    const msg = makeMessage('test');

    const promise = queue.enqueue('key1', msg, config, client);

    // Drain microtasks — isReady() resolves immediately, so the queue
    // should drain without needing to advance timers.
    await vi.advanceTimersByTimeAsync(0);

    await promise;

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(msg, config);
  });

  it('multiple messages enqueued before ready → all drained in order', async () => {
    const queue = new MessageQueue();
    const order: string[] = [];
    const callback = vi.fn().mockImplementation(async (msg: NormalizedMessage) => {
      order.push(msg.content);
    });
    queue.onProcess(callback);

    const client = makeClient(true);
    const config = makeConfig();

    const p1 = queue.enqueue('key1', makeMessage('first'), config, client);
    const p2 = queue.enqueue('key1', makeMessage('second'), config, client);
    const p3 = queue.enqueue('key1', makeMessage('third'), config, client);

    await vi.advanceTimersByTimeAsync(0);

    await Promise.all([p1, p2, p3]);

    expect(order).toEqual(['first', 'second', 'third']);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('queueSize returns correct count', async () => {
    const queue = new MessageQueue();
    const client = makeClient(false); // never ready
    const config = makeConfig();

    // Attach .catch to prevent unhandled rejection warnings
    const p1 = queue.enqueue('key1', makeMessage('a'), config, client).catch(() => {});
    const p2 = queue.enqueue('key1', makeMessage('b'), config, client).catch(() => {});

    // Give the poll loop a chance to start (but isReady returns false)
    await vi.advanceTimersByTimeAsync(0);

    // Since isReady is false, they should still be queued
    expect(queue.queueSize('key1')).toBe(2);
    expect(queue.queueSize('nonexistent')).toBe(0);

    // Clean up — advance past timeout to drain
    await vi.advanceTimersByTimeAsync(100_000);
    await Promise.all([p1, p2]);
  });

  it('totalQueueSize sums across keys', async () => {
    const queue = new MessageQueue();
    const client = makeClient(false); // never ready
    const config = makeConfig();

    // Attach .catch to prevent unhandled rejection warnings
    const p1 = queue.enqueue('key-a', makeMessage('a1'), config, client).catch(() => {});
    const p2 = queue.enqueue('key-a', makeMessage('a2'), config, client).catch(() => {});
    const p3 = queue.enqueue('key-b', makeMessage('b1'), config, client).catch(() => {});

    await vi.advanceTimersByTimeAsync(0);

    // Messages are queued but not draining since server never becomes ready
    const total = queue.totalQueueSize();
    expect(total).toBe(3);

    // Clean up — advance past timeout
    await vi.advanceTimersByTimeAsync(100_000);
    await Promise.all([p1, p2, p3]);
  });

  it('no callback registered → messages resolve without processing', async () => {
    const queue = new MessageQueue();
    // No onProcess callback registered
    const client = makeClient(true);
    const config = makeConfig();

    const promise = queue.enqueue('key1', makeMessage('test'), config, client);
    await vi.advanceTimersByTimeAsync(0);

    // Should resolve successfully — no callback means item.resolve() is called directly
    await promise;
  });

  it('callback error on one message rejects that promise but continues draining', async () => {
    const queue = new MessageQueue();
    let callCount = 0;
    const callback = vi.fn().mockImplementation(async (msg: NormalizedMessage) => {
      callCount++;
      if (msg.content === 'fail') {
        throw new Error('Processing failed');
      }
    });
    queue.onProcess(callback);

    const client = makeClient(true);
    const config = makeConfig();

    const p1 = queue.enqueue('key1', makeMessage('ok1'), config, client);
    // Attach .catch so the rejection is handled before the timer advances
    const p2 = queue.enqueue('key1', makeMessage('fail'), config, client).catch((e) => e);
    const p3 = queue.enqueue('key1', makeMessage('ok2'), config, client);

    await vi.advanceTimersByTimeAsync(0);

    await p1; // should resolve
    const err = await p2;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Processing failed');
    await p3; // should still resolve (draining continues)

    expect(callCount).toBe(3);
  });

  it('server never ready → rejects all messages after timeout', async () => {
    const queue = new MessageQueue();
    const callback = vi.fn();
    queue.onProcess(callback);

    const client = makeClient(false); // never ready
    const config = makeConfig();

    // Attach .catch to handle the rejections before they become unhandled
    const p1 = queue.enqueue('key1', makeMessage('msg1'), config, client).catch((e) => e);
    const p2 = queue.enqueue('key1', makeMessage('msg2'), config, client).catch((e) => e);

    // Advance past 90s timeout
    await vi.advanceTimersByTimeAsync(100_000);

    const err1 = await p1;
    const err2 = await p2;

    expect(err1).toBeInstanceOf(Error);
    expect((err1 as Error).message).toMatch(/did not become ready/);
    expect(err2).toBeInstanceOf(Error);
    expect((err2 as Error).message).toMatch(/did not become ready/);

    expect(callback).not.toHaveBeenCalled();
  });

  it('server becomes ready after several poll cycles → messages are processed', async () => {
    const queue = new MessageQueue();
    const processed: string[] = [];
    queue.onProcess(async (msg) => {
      processed.push(msg.content);
    });

    // isReady returns false for the first 3 calls, then true
    let callCount = 0;
    const client = {
      isReady: vi.fn().mockImplementation(async () => {
        callCount++;
        return callCount > 3;
      }),
    } as unknown as OpenCodeClient;

    const config = makeConfig();
    const promise = queue.enqueue('key1', makeMessage('delayed'), config, client);

    // Advance through 3 poll cycles (3s each) → 9s, then one more to succeed
    await vi.advanceTimersByTimeAsync(3_000); // poll 1: not ready
    await vi.advanceTimersByTimeAsync(3_000); // poll 2: not ready
    await vi.advanceTimersByTimeAsync(3_000); // poll 3: not ready
    await vi.advanceTimersByTimeAsync(3_000); // poll 4: ready!

    await promise;

    expect(processed).toEqual(['delayed']);
    expect(client.isReady).toHaveBeenCalled();
  });

  it('separate queue keys are independent', async () => {
    const queue = new MessageQueue();
    const processed: string[] = [];
    queue.onProcess(async (msg) => {
      processed.push(msg.content);
    });

    const clientA = makeClient(true);
    const clientB = makeClient(true);
    const config = makeConfig();

    const pA = queue.enqueue('queue-a', makeMessage('from-a'), config, clientA);
    const pB = queue.enqueue('queue-b', makeMessage('from-b'), config, clientB);

    await vi.advanceTimersByTimeAsync(0);

    await Promise.all([pA, pB]);

    expect(processed).toContain('from-a');
    expect(processed).toContain('from-b');
  });
});
