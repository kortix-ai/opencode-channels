import { describe, it, expect, vi } from 'vitest';
import { ResponseStreamer } from '../src/response-streamer.js';
import type { StreamEvent } from '../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function* makeEvents(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

/** Collect all yielded strings from an AsyncIterable */
async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of iter) {
    chunks.push(chunk);
  }
  return chunks;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ResponseStreamer', () => {
  it('yields text deltas from text events in order', async () => {
    const streamer = new ResponseStreamer();
    const gen = makeEvents([
      { type: 'text', data: 'Hello' },
      { type: 'text', data: ' ' },
      { type: 'text', data: 'World' },
      { type: 'done' },
    ]);

    const chunks = await collect(streamer.streamResponse(gen));
    expect(chunks).toEqual(['Hello', ' ', 'World']);
  });

  it('completes on done event', async () => {
    const streamer = new ResponseStreamer();
    const gen = makeEvents([
      { type: 'text', data: 'data' },
      { type: 'done' },
      // These should never be reached
      { type: 'text', data: 'after-done' },
    ]);

    const chunks = await collect(streamer.streamResponse(gen));
    expect(chunks).toEqual(['data']);
  });

  it('throws error on error event', async () => {
    const streamer = new ResponseStreamer();
    const gen = makeEvents([
      { type: 'text', data: 'before' },
      { type: 'error', data: 'Something went wrong' },
    ]);

    const iter = streamer.streamResponse(gen);
    const chunks: string[] = [];

    await expect(async () => {
      for await (const chunk of iter) {
        chunks.push(chunk);
      }
    }).rejects.toThrow('Something went wrong');

    expect(chunks).toEqual(['before']);
  });

  it('error with no message uses "Unknown agent error"', async () => {
    const streamer = new ResponseStreamer();
    const gen = makeEvents([
      { type: 'error' }, // no data field
    ]);

    await expect(async () => {
      for await (const _ of streamer.streamResponse(gen)) {
        // should throw before yielding
      }
    }).rejects.toThrow('Unknown agent error');
  });

  it('error with empty string uses "Unknown agent error"', async () => {
    const streamer = new ResponseStreamer();
    const gen = makeEvents([
      { type: 'error', data: '' },
    ]);

    await expect(async () => {
      for await (const _ of streamer.streamResponse(gen)) {
        // should throw
      }
    }).rejects.toThrow('Unknown agent error');
  });

  it('busy event calls onToolActivity callback', async () => {
    const onToolActivity = vi.fn();
    const streamer = new ResponseStreamer(onToolActivity);
    const gen = makeEvents([
      { type: 'busy' },
      { type: 'text', data: 'hi' },
      { type: 'done' },
    ]);

    await collect(streamer.streamResponse(gen));

    expect(onToolActivity).toHaveBeenCalledTimes(1);
    expect(onToolActivity).toHaveBeenCalledWith({
      tool: 'session',
      status: 'running',
      title: 'Processing...',
    });
  });

  it('permission event does not yield any text', async () => {
    const streamer = new ResponseStreamer();
    const gen = makeEvents([
      { type: 'text', data: 'before' },
      { type: 'permission', permission: { id: 'p1', tool: 'bash', description: 'run cmd' } },
      { type: 'text', data: 'after' },
      { type: 'done' },
    ]);

    const chunks = await collect(streamer.streamResponse(gen));
    // Permission should be silently skipped; only text events yield
    expect(chunks).toEqual(['before', 'after']);
  });

  it('file event does not yield any text', async () => {
    const streamer = new ResponseStreamer();
    const gen = makeEvents([
      { type: 'text', data: 'before' },
      { type: 'file', file: { name: 'output.png', url: '/tmp/output.png' } },
      { type: 'text', data: 'after' },
      { type: 'done' },
    ]);

    const chunks = await collect(streamer.streamResponse(gen));
    expect(chunks).toEqual(['before', 'after']);
  });

  it('generator exhausted without done → still completes', async () => {
    const streamer = new ResponseStreamer();
    // No 'done' event — generator just ends
    const gen = makeEvents([
      { type: 'text', data: 'only-text' },
    ]);

    const chunks = await collect(streamer.streamResponse(gen));
    expect(chunks).toEqual(['only-text']);
  });

  it('empty text event (no data) does not yield', async () => {
    const streamer = new ResponseStreamer();
    const gen = makeEvents([
      { type: 'text' }, // no data field
      { type: 'text', data: '' }, // empty string is falsy → skipped
      { type: 'text', data: 'real' },
      { type: 'done' },
    ]);

    const chunks = await collect(streamer.streamResponse(gen));
    expect(chunks).toEqual(['real']);
  });

  it('return() aborts the underlying generator', async () => {
    let generatorReturned = false;
    let abortController: AbortController | undefined;

    async function* slowGenerator(): AsyncGenerator<StreamEvent> {
      abortController = new AbortController();
      try {
        yield { type: 'text', data: 'chunk1' };
        // Wait on an abort-able promise instead of a long setTimeout
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            reject(new Error('aborted'));
          };
          abortController!.signal.addEventListener('abort', onAbort, { once: true });
          if (abortController!.signal.aborted) reject(new Error('aborted'));
        });
        yield { type: 'text', data: 'chunk2' };
        yield { type: 'done' };
      } catch {
        // Expected abort error
      } finally {
        generatorReturned = true;
      }
    }

    const streamer = new ResponseStreamer();
    const iter = streamer.streamResponse(slowGenerator());
    const iterator = iter[Symbol.asyncIterator]();

    // Pull the first chunk
    const first = await iterator.next();
    expect(first).toEqual({ value: 'chunk1', done: false });

    // Abort the generator's internal wait so return() can complete
    abortController?.abort();

    // Abort early via the iterator protocol
    const returnResult = await iterator.return!();
    expect(returnResult.done).toBe(true);

    // Give a microtask tick for the generator's finally block to execute
    await new Promise((r) => setTimeout(r, 10));
    expect(generatorReturned).toBe(true);
  });

  it('multiple rapid text events are queued and yielded sequentially', async () => {
    const streamer = new ResponseStreamer();

    // Use a generator that yields all events synchronously (no await between them)
    async function* rapidGen(): AsyncGenerator<StreamEvent> {
      yield { type: 'text', data: 'a' };
      yield { type: 'text', data: 'b' };
      yield { type: 'text', data: 'c' };
      yield { type: 'text', data: 'd' };
      yield { type: 'text', data: 'e' };
      yield { type: 'done' };
    }

    const chunks = await collect(streamer.streamResponse(rapidGen()));
    expect(chunks).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('multiple busy events each trigger onToolActivity', async () => {
    const onToolActivity = vi.fn();
    const streamer = new ResponseStreamer(onToolActivity);
    const gen = makeEvents([
      { type: 'busy' },
      { type: 'text', data: 'x' },
      { type: 'busy' },
      { type: 'done' },
    ]);

    await collect(streamer.streamResponse(gen));
    expect(onToolActivity).toHaveBeenCalledTimes(2);
  });

  it('no onToolActivity callback → busy event is silently ignored', async () => {
    const streamer = new ResponseStreamer(); // no callback
    const gen = makeEvents([
      { type: 'busy' },
      { type: 'text', data: 'ok' },
      { type: 'done' },
    ]);

    const chunks = await collect(streamer.streamResponse(gen));
    expect(chunks).toEqual(['ok']);
  });
});
