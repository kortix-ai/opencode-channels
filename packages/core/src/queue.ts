/**
 * MessageQueue — Queues inbound messages when the OpenCode server
 * isn't ready yet and drains them once it becomes available.
 *
 * Unlike the original SandboxConnector queue, this version has NO
 * cloud-provider wakeUp() call — it simply polls isReady() and
 * processes messages sequentially once the server responds.
 */

import type { NormalizedMessage, ChannelConfig } from './types.js';
import type { OpenCodeClient } from './opencode-client.js';

// ─── Internal types ─────────────────────────────────────────────────────────

interface QueuedMessage {
  message: NormalizedMessage;
  config: ChannelConfig;
  resolve: (value: void) => void;
  reject: (reason: unknown) => void;
}

interface ServerQueue {
  messages: QueuedMessage[];
  draining: boolean;
}

// ─── Tuning constants ───────────────────────────────────────────────────────

/** Maximum time to wait for the server to become ready */
const MAX_WAIT_MS = 90_000;

/** Interval between readiness polls */
const POLL_INTERVAL_MS = 3_000;

// ─── MessageQueue ───────────────────────────────────────────────────────────

export class MessageQueue {
  /**
   * One queue per logical "server" (keyed by config ID or a custom group key).
   * In the simplified single-server model you can use a constant key.
   */
  private queues = new Map<string, ServerQueue>();

  /**
   * Callback invoked for each message once the server is ready.
   */
  private processCallback?: (
    message: NormalizedMessage,
    config: ChannelConfig,
  ) => Promise<void>;

  /**
   * Register the callback that processes each queued message.
   */
  onProcess(
    callback: (message: NormalizedMessage, config: ChannelConfig) => Promise<void>,
  ): void {
    this.processCallback = callback;
  }

  /**
   * Enqueue a message. If this is the first message for the given key,
   * start polling the server and drain when ready.
   *
   * Returns a promise that resolves when the message has been processed
   * (or rejects if the server never becomes ready / processing fails).
   */
  enqueue(
    queueKey: string,
    message: NormalizedMessage,
    config: ChannelConfig,
    client: OpenCodeClient,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let queue = this.queues.get(queueKey);
      if (!queue) {
        queue = { messages: [], draining: false };
        this.queues.set(queueKey, queue);
      }

      queue.messages.push({ message, config, resolve, reject });

      if (!queue.draining) {
        this.startPollAndDrain(queueKey, client);
      }
    });
  }

  /**
   * Poll isReady() then drain all queued messages sequentially.
   */
  private async startPollAndDrain(
    queueKey: string,
    client: OpenCodeClient,
  ): Promise<void> {
    const queue = this.queues.get(queueKey);
    if (!queue) return;

    queue.draining = true;

    try {
      // ── Poll until the server is ready ───────────────────────────────
      const start = Date.now();
      let ready = false;

      while (Date.now() - start < MAX_WAIT_MS) {
        if (await client.isReady()) {
          ready = true;
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      if (!ready) {
        // Reject all queued messages
        for (const item of queue.messages) {
          item.reject(
            new Error(`OpenCode server did not become ready within ${MAX_WAIT_MS / 1000}s`),
          );
        }
        queue.messages = [];
        return;
      }

      // ── Drain messages sequentially ──────────────────────────────────
      while (queue.messages.length > 0) {
        const item = queue.messages.shift()!;
        try {
          if (this.processCallback) {
            await this.processCallback(item.message, item.config);
          }
          item.resolve();
        } catch (err) {
          item.reject(err);
        }
      }
    } catch (err) {
      // Catastrophic error — reject everything remaining
      for (const item of queue.messages) {
        item.reject(err);
      }
      queue.messages = [];
    } finally {
      queue.draining = false;
      this.queues.delete(queueKey);
    }
  }

  /**
   * Get the number of queued messages for a given key.
   */
  queueSize(queueKey: string): number {
    return this.queues.get(queueKey)?.messages.length ?? 0;
  }

  /**
   * Get total queued messages across all keys.
   */
  totalQueueSize(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.messages.length;
    }
    return total;
  }
}
