// Test-only helpers for the RPC tests: a scripted raw peer, channel wrappers with injectable failures, timer and
// listener accounting.
import { getEventListeners } from "node:events";
import type { ByteChannel, ReadChunk } from "../../../src/core/protocol/index.ts";
import { createConnection, type Connection, type ConnectionOptions } from "../../../src/rpc/index.ts";
import { pair, type PairOptions } from "../../../src/testing/index.ts";
import { concat, frame, msg, texts, utf8 } from "../protocol/helpers.ts";

export { concat, frame, msg, texts, utf8 };

/** Reads NUL-terminated messages from a channel. */
export class MessageReader {
  readonly #channel: ByteChannel;
  #buffer: Uint8Array = new Uint8Array(0);
  /** Every byte read so far. */
  readonly raw: Uint8Array[] = [];
  eof = false;

  constructor(channel: ByteChannel) {
    this.#channel = channel;
  }

  /** The next message as text, or null at EOF. */
  async nextText(): Promise<string | null> {
    for (;;) {
      const nul = this.#buffer.indexOf(0);
      if (nul >= 0) {
        const text = new TextDecoder().decode(this.#buffer.subarray(0, nul));
        this.#buffer = this.#buffer.slice(nul + 1);
        return text;
      }
      if (this.eof) return null;
      const chunk = await this.#channel.read();
      if (chunk === null) {
        this.eof = true;
        continue;
      }
      this.raw.push(chunk.bytes);
      this.#buffer = concat([this.#buffer, chunk.bytes]);
    }
  }

  /** The next message, JSON-parsed (throws at EOF). */
  async next(): Promise<Record<string, unknown>> {
    const t = await this.nextText();
    if (t === null) throw new Error("EOF");
    return JSON.parse(t) as Record<string, unknown>;
  }

  /** Reads until EOF; true if nothing more arrived. */
  async drainToEof(): Promise<string[]> {
    const out: string[] = [];
    for (;;) {
      const t = await this.nextText();
      if (t === null) return out;
      out.push(t);
    }
  }
}

/** A connection over one end of a pair; `peer` is the other end, `reader` reads what the client wrote. */
export function connectRaw(
  options?: ConnectionOptions,
  pairOptions?: PairOptions,
): { conn: Connection; peer: ByteChannel; reader: MessageReader; reply: (value: unknown) => Promise<void> } {
  const [a, b] = pair(pairOptions);
  const conn = createConnection(a, options);
  return { conn, peer: b, reader: new MessageReader(b), reply: (value) => b.write(msg(value)) };
}

/** A channel wrapper whose read/write can be made to fail on demand. */
export function controllable(inner: ByteChannel): ByteChannel & {
  failRead(error: Error): void;
  failWrites(error: Error): void;
} {
  let readError: { e: Error } | undefined;
  let writeError: { e: Error } | undefined;
  let rejectRead: ((e: unknown) => void) | undefined;
  return {
    read(): Promise<ReadChunk | null> {
      if (readError !== undefined) return Promise.reject(readError.e);
      return new Promise((resolve, reject) => {
        rejectRead = reject;
        inner.read().then(resolve, reject);
      });
    },
    write(chunk: Uint8Array): Promise<void> {
      if (writeError !== undefined) return Promise.reject(writeError.e);
      return inner.write(chunk);
    },
    end: () => inner.end(),
    close: (reason?: unknown) => {
      inner.close(reason);
    },
    get closed() {
      return inner.closed;
    },
    capabilities: {},
    failRead(error: Error) {
      readError = { e: error };
      rejectRead?.(error);
    },
    failWrites(error: Error) {
      writeError = { e: error };
    },
  };
}

/** An in-memory listener: `dial()` returns the client end of a new pair whose server end is accepted. */
export class MemoryListener implements AsyncIterable<ByteChannel> {
  readonly #pending: ByteChannel[] = [];
  #waiter: ((r: IteratorResult<ByteChannel, undefined>) => void) | undefined;
  #closed = false;
  closeCalls = 0;
  readonly #pairOptions: PairOptions | undefined;

  constructor(pairOptions?: PairOptions) {
    this.#pairOptions = pairOptions;
  }

  dial(): ByteChannel {
    const [client, server] = pair(this.#pairOptions);
    if (this.#closed) {
      server.close();
      return client;
    }
    const w = this.#waiter;
    this.#waiter = undefined;
    if (w !== undefined) w({ value: server, done: false });
    else this.#pending.push(server);
    return client;
  }

  close(): Promise<void> {
    this.closeCalls++;
    this.#closed = true;
    const w = this.#waiter;
    this.#waiter = undefined;
    w?.({ value: undefined, done: true });
    return Promise.resolve();
  }

  [Symbol.asyncIterator](): AsyncIterator<ByteChannel, undefined> {
    return {
      next: () => {
        const ch = this.#pending.shift();
        if (ch !== undefined) return Promise.resolve({ value: ch, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiter = resolve;
        });
      },
    };
  }
}

/** Counts live timers created through the global setTimeout while installed. */
export function trackTimers(): { live(): number; restore(): void } {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const live = new Set<unknown>();
  const patchedSet = ((fn: () => void, ms?: number) => {
    const id = realSet(() => {
      live.delete(id);
      fn();
    }, ms);
    live.add(id);
    return id;
  }) as typeof setTimeout;
  const patchedClear = ((id: ReturnType<typeof setTimeout> | undefined) => {
    live.delete(id);
    realClear(id);
  }) as typeof clearTimeout;
  globalThis.setTimeout = patchedSet;
  globalThis.clearTimeout = patchedClear;
  return {
    live: () => live.size,
    restore: () => {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

/** Abort listeners currently on `signal`. */
export function abortListeners(signal: AbortSignal): number {
  return getEventListeners(signal, "abort").length;
}

/** Resolves after `ms` (small values only). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lets pending promise callbacks run (a few macrotask turns). */
export async function settle(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Whether `p` is still pending after the microtask queue drained. */
export async function isPending(p: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  const r = await Promise.race([
    p.then(
      () => "settled",
      () => "settled",
    ),
    settle(2).then(() => marker),
  ]);
  return r === marker;
}
