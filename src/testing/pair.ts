// In-memory ByteChannel pair for tests (DESIGN.md §4.1, §4.10). Runtime-agnostic: no timers, no Node APIs.
import { ConnectionClosedError } from "../core/errors/local.ts";
import type { ByteChannel, ReadChunk } from "../core/protocol/channel.ts";

/** Options for {@link pair}. */
export interface PairOptions {
  /** Bytes queued per direction before write() waits. Default 65536. */
  highWaterMark?: number;
}

interface Waiter {
  resolve(): void;
  reject(error: unknown): void;
}

/** One direction: what one side wrote and the other has not read yet. */
class Pipe {
  readonly chunks: Uint8Array[] = [];
  queued = 0;
  /** The writer called end() or close(): the reader gets null once drained. */
  ended = false;
  /** Writes waiting for the reader to drain below the high-water mark. */
  readonly writers: Waiter[] = [];
  /** The reader's pending read(). */
  reader: ((chunk: ReadChunk | null) => void) | null = null;
}

class Side implements ByteChannel {
  readonly capabilities: ByteChannel["capabilities"] = {};
  readonly closed: Promise<void>;
  readonly #in: Pipe;
  readonly #out: Pipe;
  readonly #hwm: number;
  peer!: Side;
  #closed = false;
  #ended = false;
  #readEof = false;
  #resolveClosed: () => void = () => undefined;

  constructor(inbound: Pipe, outbound: Pipe, hwm: number) {
    this.#in = inbound;
    this.#out = outbound;
    this.#hwm = hwm;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  read(): Promise<ReadChunk | null> {
    if (this.#in.reader !== null) return Promise.reject(new TypeError("read() called concurrently"));
    if (this.#closed) return Promise.resolve(null);
    const chunk = this.#take();
    if (chunk !== undefined) return Promise.resolve(chunk);
    return new Promise((resolve) => {
      this.#in.reader = resolve;
    });
  }

  write(chunk: Uint8Array): Promise<void> {
    if (this.#closed || this.#ended || this.peer.isClosed)
      return Promise.reject(new ConnectionClosedError("channel is closed"));
    if (chunk.length === 0) return Promise.resolve();
    const out = this.#out;
    const copy = chunk.slice();
    const reader = out.reader;
    if (reader !== null) {
      out.reader = null;
      reader({ bytes: copy });
      return Promise.resolve();
    }
    out.chunks.push(copy);
    out.queued += copy.length;
    if (out.queued <= this.#hwm) return Promise.resolve();
    return new Promise((resolve, reject) => {
      out.writers.push({ resolve, reject });
    });
  }

  end(): Promise<void> {
    if (this.#closed || this.#ended) return Promise.resolve();
    this.#ended = true;
    this.#out.ended = true;
    this.peer.wakeReader();
    this.#checkClosed();
    return Promise.resolve();
  }

  close(reason?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new ConnectionClosedError("channel closed", reason === undefined ? undefined : { cause: reason });
    // Our pending read ends; what the peer sent us is discarded and its waiting writes fail.
    const reader = this.#in.reader;
    this.#in.reader = null;
    reader?.(null);
    this.#in.chunks.length = 0;
    this.#in.queued = 0;
    for (const w of this.#in.writers.splice(0)) w.reject(error);
    // Our waiting writes fail; the peer still reads what was queued, then null.
    for (const w of this.#out.writers.splice(0)) w.reject(error);
    this.#out.ended = true;
    this.peer.wakeReader();
    this.#resolveClosed();
  }

  /** Called by the peer when it ended or closed: a pending read with nothing queued gets EOF. */
  wakeReader(): void {
    const reader = this.#in.reader;
    if (reader === null || this.#in.chunks.length > 0) return;
    this.#in.reader = null;
    this.#readEof = true;
    reader(null);
    this.#checkClosed();
  }

  /** Next queued chunk, null at EOF, or undefined if the read has to wait. */
  #take(): ReadChunk | null | undefined {
    const pipe = this.#in;
    const bytes = pipe.chunks.shift();
    if (bytes !== undefined) {
      pipe.queued -= bytes.length;
      while (pipe.writers.length > 0 && pipe.queued <= this.#hwm) pipe.writers.shift()?.resolve();
      return { bytes };
    }
    if (pipe.ended) {
      this.#readEof = true;
      this.#checkClosed();
      return null;
    }
    return undefined;
  }

  #checkClosed(): void {
    if (this.#ended && this.#readEof) {
      this.#closed = true;
      this.#resolveClosed();
    }
  }
}

/**
 * Two connected in-memory {@link ByteChannel}s. Bytes written on one side are read on the other in order, chunk by
 * chunk as written (never merged).
 *
 * - `write()` copies the chunk and resolves once the peer's unread bytes are at or below `highWaterMark`, so a peer
 *   that does not read pushes back. It rejects with `ConnectionClosedError` after this side's `end()`/`close()` or
 *   the peer's `close()` (pending writes reject on those closes).
 * - `read()` resolves with the next chunk, `null` after the peer's `end()` (or `close()`) once drained, and `null`
 *   after this side's `close()` (a pending read resolves null). Concurrent `read()` calls are a caller bug
 *   (`TypeError`).
 * - `close(reason)`: this side's pending read gets null and its pending writes reject; the peer can still read what
 *   was already queued, then gets `null`; the peer's writes reject.
 * - `closed` resolves (never rejects) when the side was closed, or has both ended and read EOF.
 * - `capabilities` is `{}`. No timers.
 */
export function pair(options?: PairOptions): [ByteChannel, ByteChannel] {
  const hwm = options?.highWaterMark ?? 65536;
  if (!Number.isSafeInteger(hwm) || hwm < 0) throw new RangeError("highWaterMark must be a non-negative integer");
  const ab = new Pipe();
  const ba = new Pipe();
  const a = new Side(ba, ab, hwm);
  const b = new Side(ab, ba, hwm);
  a.peer = b;
  b.peer = a;
  return [a, b];
}
