/**
 * ResponseStreamer — Converts an OpenCode SSE AsyncGenerator<StreamEvent>
 * into an AsyncIterable<string> that yields text deltas.
 *
 * This is the core streaming bridge between the OpenCodeClient's SSE
 * stream and platform adapters that consume text chunks.
 *
 * Features:
 *   - Yields text deltas as they arrive
 *   - Completes on `done` or `error` events
 *   - Supports early abort via return()
 *   - Tracks tool activity for typing indicators via callback
 */

import type { StreamEvent } from './types.js';

/**
 * Tool activity metadata emitted during streaming for typing indicator UI.
 */
export interface ToolActivity {
  tool: string;
  status?: string;
  title?: string;
  callId?: string;
}

export type OnToolActivity = (activity: ToolActivity) => void;

export class ResponseStreamer {
  private readonly onToolActivity?: OnToolActivity;

  constructor(onToolActivity?: OnToolActivity) {
    this.onToolActivity = onToolActivity;
  }

  /**
   * Convert an SSE event generator into a text-delta AsyncIterable.
   *
   * Consumes StreamEvents from OpenCodeClient.promptStreaming() and
   * yields only the text content. Completes on `done` / `error`.
   */
  streamResponse(generator: AsyncGenerator<StreamEvent>): AsyncIterable<string> {
    const onToolActivity = this.onToolActivity;

    return {
      [Symbol.asyncIterator](): AsyncIterator<string> {
        const queue: string[] = [];
        let resolve: (() => void) | null = null;
        let done = false;
        let error: Error | null = null;

        // Consume the generator in the background
        const consume = async () => {
          try {
            for await (const event of generator) {
              if (done) break;

              switch (event.type) {
                case 'text':
                  if (event.data) {
                    queue.push(event.data);
                    resolve?.();
                  }
                  break;

                case 'busy':
                  // Optionally notify about busy state via tool activity
                  onToolActivity?.({
                    tool: 'session',
                    status: 'running',
                    title: 'Processing...',
                  });
                  break;

                case 'done':
                  done = true;
                  resolve?.();
                  return;

                case 'error':
                  error = new Error(event.data || 'Unknown agent error');
                  done = true;
                  resolve?.();
                  return;

                case 'permission':
                  // Permissions are handled externally by the EventBridge;
                  // the streamer does not yield them but keeps running.
                  break;

                case 'file':
                  // Files are handled externally by the adapter;
                  // the streamer does not yield file events as text.
                  break;
              }
            }

            // Generator exhausted without explicit done event
            done = true;
            resolve?.();
          } catch (err) {
            error = err instanceof Error ? err : new Error(String(err));
            done = true;
            resolve?.();
          }
        };

        // Start consuming immediately
        consume();

        return {
          async next(): Promise<IteratorResult<string>> {
            // Wait for data or completion
            while (queue.length === 0 && !done) {
              await new Promise<void>((r) => {
                resolve = r;
              });
              resolve = null;
            }

            if (queue.length > 0) {
              return { value: queue.shift()!, done: false };
            }

            // If we finished with an error, throw it
            if (error) {
              throw error;
            }

            // Stream complete
            return { value: undefined as unknown as string, done: true };
          },

          async return(): Promise<IteratorResult<string>> {
            done = true;
            // Signal the generator to stop
            try {
              await generator.return(undefined as unknown as StreamEvent);
            } catch {
              // Swallow cleanup errors
            }
            return { value: undefined as unknown as string, done: true };
          },
        };
      },
    };
  }
}
