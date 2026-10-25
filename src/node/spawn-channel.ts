// ByteChannel over a separate Readable + Writable pair: a child's stdout/stdin, or process.stdin/stdout
// (DESIGN.md §4.1, §5.8). Same contract as the socket channel (socket.ts).
import type { Readable, Writable } from "node:stream";
import { ConnectionClosedError } from "../core/errors/local.ts";
import type { ByteChannel, ReadChunk } from "../core/protocol/channel.ts";

/** Options for {@link fromNodeStreams}. */
export interface NodeStreamsOptions {
  /**
   * Called once, when the channel is done: on the first `close()`, or when both streams closed on their own. Its
   * exceptions are swallowed; `closed` waits for a returned promise (whose rejection is ignored).
   */
  onClose?: () => void | Promise<void>;
}

interface PendingRead {
  resolve(chunk: ReadChunk | null): void;
  reject(error: unknown): void;
}

/** A stream's `close` as a promise (resolved at once if it already closed). */
function whenClosed(stream: Readable | Writable): Promise<void> {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once("close", () => {
      resolve();
    });
  });
}

class NodeStreamsChannel implements ByteChannel {
  readonly capabilities: ByteChannel["capabilities"] = {};
  readonly closed: Promise<void>;
  readonly #readable: Readable;
  readonly #writable: Writable;
  readonly #chunks: Uint8Array[] = [];
  /** Rejecters of writes whose callback has not fired yet: a `close` of the writable rejects them. */
  readonly #writes = new Set<(error: unknown) => void>();
  readonly #onClose: (() => void | Promise<void>) | undefined;
  #hook: Promise<void> | undefined;
  #reader: PendingRead | undefined;
  /** The readable ended or closed: nothing more to read once the chunks are drained. */
  #eof = false;
  /** A local `close()`: reads give `null`, a pending stream error is dropped. */
  #localClose = false;
  /** `end()` or `close()` was called, or the writable finished, failed or closed: writes reject at once. */
  #writeShut = false;
  /** A readable error not yet delivered to a read (delivered once). */
  #error: { value: unknown } | undefined;
  #errorDelivered = false;

  constructor(readable: Readable, writable: Writable, options: NodeStreamsOptions | undefined) {
    this.#readable = readable;
    this.#writable = writable;
    this.#onClose = options?.onClose;
    readable.pause();
    readable.on("data", (data: Uint8Array | string) => {
      readable.pause();
      if (this.#localClose) return;
      this.#chunks.push(
        typeof data === "string"
          ? new TextEncoder().encode(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
      this.#wake();
    });
    readable.on("end", () => {
      this.#eof = true;
      this.#wake();
    });
    // Always listening on both: an unhandled stream `error` would crash the process (F1).
    readable.on("error", (error: unknown) => {
      if (this.#error === undefined && !this.#errorDelivered) this.#error = { value: error };
      this.#wake();
    });
    readable.on("close", () => {
      this.#eof = true;
      this.#wake();
    });
    // Write errors reach the pending write through its callback; later writes reject at once.
    writable.on("error", () => {
      this.#writeShut = true;
    });
    writable.on("close", () => {
      this.#writeShut = true;
      const error = new ConnectionClosedError("the stream closed before the write completed");
      for (const reject of [...this.#writes]) reject(error);
      this.#writes.clear();
    });
    if (readable.closed || readable.destroyed) this.#eof = true;
    if (writable.closed || writable.destroyed || writable.writableEnded) this.#writeShut = true;
    this.closed = Promise.all([whenClosed(readable), whenClosed(writable)]).then(() => this.#runHook());
  }

  read(): Promise<ReadChunk | null> {
    if (this.#reader !== undefined) return Promise.reject(new TypeError("read() called concurrently"));
    return new Promise((resolve, reject) => {
      this.#reader = { resolve, reject };
      if (!this.#wake()) this.#readable.resume();
    });
  }

  write(chunk: Uint8Array): Promise<void> {
    if (this.#writeShut || this.#writable.destroyed)
      return Promise.reject(new ConnectionClosedError("the stream is closed"));
    return new Promise((resolve, reject) => {
      const settle = (error: unknown): void => {
        if (!this.#writes.delete(settle)) return;
        if (error === undefined) resolve();
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the stream's error as is
        else reject(error);
      };
      this.#writes.add(settle);
      this.#writable.write(chunk, (error) => {
        settle(error ?? undefined);
      });
    });
  }

  end(): Promise<void> {
    const writable = this.#writable;
    this.#writeShut = true;
    if (writable.destroyed || writable.writableFinished) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        writable.off("finish", done);
        writable.off("close", done);
        resolve();
      };
      writable.on("finish", done);
      writable.on("close", done);
      if (!writable.writableEnded) writable.end();
    });
  }

  close(): void {
    if (this.#localClose) return;
    this.#localClose = true;
    this.#writeShut = true;
    this.#chunks.length = 0;
    this.#wake();
    const error = new ConnectionClosedError("the channel was closed");
    for (const reject of [...this.#writes]) reject(error);
    this.#writes.clear();
    void this.#runHook();
    this.#readable.destroy();
    this.#writable.destroy();
  }

  /** Runs `onClose` once; never rejects. */
  #runHook(): Promise<void> {
    this.#hook ??= (async () => {
      try {
        await this.#onClose?.();
      } catch {
        // A failing hook must not break `closed`.
      }
    })();
    return this.#hook;
  }

  /** Settles the pending read if there is something to give it (data, then an error once, then EOF); true if so. */
  #wake(): boolean {
    const reader = this.#reader;
    if (reader === undefined) return false;
    const chunk = this.#chunks.shift();
    if (chunk !== undefined) {
      this.#reader = undefined;
      reader.resolve({ bytes: chunk });
      return true;
    }
    const error = this.#error;
    if (error !== undefined && !this.#localClose) {
      this.#error = undefined;
      this.#errorDelivered = true;
      this.#reader = undefined;
      reader.reject(error.value);
      return true;
    }
    if (this.#eof || this.#localClose || this.#errorDelivered) {
      this.#reader = undefined;
      reader.resolve(null);
      return true;
    }
    return false;
  }
}

/**
 * A {@link ByteChannel} over a separate `readable` and `writable` (a child's stdout and stdin, or `process.stdin`
 * and `process.stdout`), with the contract of {@link fromNodeSocket}: the readable is paused and read on demand;
 * `read()` gives `null` after its end (or close) once drained and after a local `close()`; a readable error rejects
 * one read, later reads give `null`. `write()` resolves on the write callback and rejects with its error, or with
 * `ConnectionClosedError` if the writable closes first or was already ended/closed. `end()` ends the writable only
 * (half-close: the readable stays open). `close()` destroys both (idempotent). `closed` resolves once both streams
 * closed (and `options.onClose` settled). `error` listeners are always attached, so stream errors never crash the
 * process. Passing one duplex as both works too.
 */
export function fromNodeStreams(readable: Readable, writable: Writable, options?: NodeStreamsOptions): ByteChannel {
  if (options?.onClose !== undefined && typeof options.onClose !== "function")
    throw new TypeError("onClose must be a function");
  return new NodeStreamsChannel(readable, writable, options);
}
