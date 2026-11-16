// ByteChannel over a Node net.Socket (DESIGN.md §4.1, §4.11).
import type { Socket } from "node:net";
import { ConnectionClosedError } from "../core/errors/local.ts";
import type { ByteChannel, ReadChunk } from "../core/protocol/channel.ts";

/**
 * Write errnos that mean the peer is gone. Node destroys a net.Socket on any write error (and marks its readable side
 * errored, which drops later reads), losing what the peer sent before it went: a service that reads one line, writes
 * a reply and closes while we keep writing (`yes | … call --upgrade`). A write failing with one of these is kept from
 * Node instead (see #keepReadingAfterWriteErrors).
 */
const PEER_GONE = new Set(["EPIPE", "ECONNRESET", "ECONNABORTED", "ENOTCONN", "ESHUTDOWN"]);

function isPeerGone(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && PEER_GONE.has(code);
}

type WriteCallback = (error?: Error | null) => void;

/**
 * After a peer-gone write error the socket reads ahead (so it reaches the peer's EOF or reset and closes on its own
 * when nobody reads and the peer sent less than this), but only up to this many buffered bytes (plus Node's own
 * highWaterMark); past that the socket stays open until the reader drains it or the owner calls close(): a peer that merely shut its read side down may
 * still send a lot, and that keeps its backpressure.
 */
const DRAIN_LIMIT = 1024 * 1024;

interface PendingRead {
  resolve(chunk: ReadChunk | null): void;
  reject(error: unknown): void;
}

class NodeSocketChannel implements ByteChannel {
  readonly capabilities: ByteChannel["capabilities"] = {};
  readonly closed: Promise<void>;
  readonly #socket: Socket;
  readonly #chunks: Uint8Array[] = [];
  /** Rejecters of writes whose callback has not fired yet: a `close` before it rejects them. */
  readonly #writes = new Set<(error: unknown) => void>();
  #reader: PendingRead | undefined;
  /** The peer's FIN was read (`end`). */
  #eof = false;
  /** `close()` was called, or the socket emitted `close`. */
  #done = false;
  /** A local `close()`: reads give `null`, a pending socket error is dropped. */
  #localClose = false;
  /** `end()` or `close()` was called (or the socket closed): writes reject at once. */
  #writeShut = false;
  /** A socket error not yet delivered to a read (delivered once). */
  #error: { value: unknown } | undefined;
  #errorDelivered = false;
  /** A write failed because the peer is gone ({@link PEER_GONE}): pending and later writes reject with it. */
  #writeError: { value: unknown } | undefined;
  /** Set with {@link #writeError}: read ahead up to {@link DRAIN_LIMIT} buffered bytes. */
  #draining = false;
  /** Bytes in {@link #chunks}. */
  #buffered = 0;

  constructor(socket: Socket) {
    this.#socket = socket;
    let resolveClosed: () => void = () => undefined;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    socket.pause();
    this.#keepReadingAfterWriteErrors(socket);
    this.#keepBufferedOnErrors(socket);
    socket.on("data", (data: Buffer) => {
      if (!this.#draining || this.#buffered + data.byteLength >= DRAIN_LIMIT) socket.pause();
      if (this.#done) return;
      this.#chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      this.#buffered += data.byteLength;
      this.#wake();
    });
    socket.on("end", () => {
      this.#eof = true;
      this.#wake();
    });
    // Always listening: an unhandled socket `error` would crash the process (F1, F8).
    socket.on("error", (error: unknown) => {
      if (this.#error === undefined && !this.#errorDelivered) this.#error = { value: error };
      this.#wake();
    });
    socket.on("close", () => {
      this.#done = true;
      this.#writeShut = true;
      const error = new ConnectionClosedError("the socket closed before the write completed");
      for (const reject of [...this.#writes]) reject(error);
      this.#writes.clear();
      this.#wake();
      resolveClosed();
    });
    if (socket.closed) {
      this.#done = true;
      this.#writeShut = true;
      resolveClosed();
    }
  }

  read(): Promise<ReadChunk | null> {
    if (this.#reader !== undefined) return Promise.reject(new TypeError("read() called concurrently"));
    return new Promise((resolve, reject) => {
      this.#reader = { resolve, reject };
      if (!this.#wake()) this.#socket.resume();
    });
  }

  write(chunk: Uint8Array): Promise<void> {
    if (this.#writeError !== undefined)
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the socket's error as is
      return Promise.reject(this.#writeError.value);
    if (this.#writeShut || this.#socket.destroyed)
      return Promise.reject(new ConnectionClosedError("the socket is closed"));
    return new Promise((resolve, reject) => {
      const settle = (error: unknown): void => {
        if (!this.#writes.delete(settle)) return;
        // Once the peer is gone, Node sees the failed write (and the ones after it) succeed: reject them here.
        if (error === undefined && this.#writeError !== undefined) error = this.#writeError.value;
        if (error === undefined) resolve();
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the socket's error as is
        else reject(error);
      };
      this.#writes.add(settle);
      this.#socket.write(chunk, (error) => {
        settle(error ?? undefined);
      });
    });
  }

  end(): Promise<void> {
    const socket = this.#socket;
    this.#writeShut = true;
    if (this.#done || socket.writableFinished) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        socket.off("finish", done);
        socket.off("close", done);
        resolve();
      };
      socket.on("finish", done);
      socket.on("close", done);
      socket.end();
    });
  }

  close(): void {
    if (this.#done) return;
    this.#done = true;
    this.#localClose = true;
    this.#writeShut = true;
    this.#chunks.length = 0;
    this.#buffered = 0;
    this.#wake();
    const error = new ConnectionClosedError("the channel was closed");
    for (const reject of [...this.#writes]) reject(error);
    this.#socket.destroy();
  }

  /**
   * Wraps the socket's `_write`/`_writev` so that a write failing with a peer-gone errno ({@link PEER_GONE}) never
   * reaches Node's Writable, which would mark the socket errored and destroy it, dropping the bytes the peer sent
   * before it went (still queued in the kernel). The error is recorded instead (that write and every later one
   * reject with it), the write side is ended, and reading goes on to the peer's EOF or a read error. Other write
   * errors reach Node as before (destroy, `error`).
   */
  #keepReadingAfterWriteErrors(socket: Socket): void {
    const keep =
      (cb: WriteCallback): WriteCallback =>
      (error) => {
        if (error === undefined || error === null || !isPeerGone(error)) {
          cb(error);
          return;
        }
        const first = this.#writeError === undefined;
        this.#writeError ??= { value: error };
        this.#writeShut = true;
        cb();
        if (!first) return;
        // The write side is over: end it, and read ahead (bounded, DRAIN_LIMIT) so the socket reaches the peer's EOF
        // or reset and closes on its own.
        if (!socket.writableEnded) socket.end();
        this.#draining = true;
        socket.resume();
      };
    const write = socket._write.bind(socket);
    socket._write = (chunk: unknown, encoding: BufferEncoding, cb: WriteCallback): void => {
      write(chunk, encoding, keep(cb));
    };
    const writev = socket._writev?.bind(socket);
    if (writev !== undefined)
      socket._writev = (chunks: { chunk: unknown; encoding: BufferEncoding }[], cb: WriteCallback): void => {
        writev(chunks, keep(cb));
      };
  }

  /**
   * Wraps `socket.destroy` so that bytes Node already read into the paused socket's buffer survive an error. Node keeps
   * reading from the kernel while the socket is paused (up to its highWaterMark) and a read error (the peer's reset,
   * on Linux after the bytes it sent before: `read ECONNRESET`) destroys the socket, which drops that buffer: a reply
   * followed by a reset was lost when nobody was reading. Before such a destroy the buffer is read out (bounded by the
   * highWaterMark), its `data` events landing in {@link #chunks} ahead of the error.
   */
  #keepBufferedOnErrors(socket: Socket): void {
    const destroy = socket.destroy.bind(socket);
    socket.destroy = (error?: Error): Socket => {
      if (error !== undefined && !this.#done)
        while (socket.readableLength > 0 && !socket.destroyed && socket.read() !== null);
      return destroy(error);
    };
  }

  /** Settles the pending read if there is something to give it (data, then an error once, then EOF); true if so. */
  #wake(): boolean {
    const reader = this.#reader;
    if (reader === undefined) return false;
    const chunk = this.#chunks.shift();
    if (chunk !== undefined) {
      this.#buffered -= chunk.byteLength;
      if (this.#draining && this.#buffered < DRAIN_LIMIT) this.#socket.resume();
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
    if (this.#eof || this.#done || this.#errorDelivered) {
      this.#reader = undefined;
      reader.resolve(null);
      return true;
    }
    return false;
  }
}

/**
 * A {@link ByteChannel} over a connected `net.Socket` (DESIGN.md §4.11). The socket is paused and read on demand:
 * `read()` returns the next received chunk (a plain `Uint8Array` view of Node's buffer) or resumes the socket for
 * one `data` event, so Node's own buffering pushes back on the peer. `read()` gives `null` after the peer's FIN
 * once drained and after a local `close()`; a socket error rejects one read, later reads give `null`. `write()`
 * resolves on the socket's write callback and rejects with its error, or with `ConnectionClosedError` if the
 * socket closes first or is already ended/closed. A write failing because the peer is gone (EPIPE, ECONNRESET, …)
 * does not destroy the socket: it and every later write reject with that error, the write side is ended, and reads
 * still return what the peer sent before it went, then its EOF or error (over TCP best effort: the peer's reset may
 * have dropped bytes it had not yet sent). `end()` half-closes (resolves on `finish`/`close`), `close()`
 * destroys the socket (idempotent), `closed` resolves on the socket's `close`. An `error` listener is always
 * attached, so socket errors never crash the process.
 */
export function fromNodeSocket(socket: Socket): ByteChannel {
  return new NodeSocketChannel(socket);
}
