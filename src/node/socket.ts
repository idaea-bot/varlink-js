// ByteChannel over a Node net.Socket (DESIGN.md §4.1, §4.11).
import type { Socket } from "node:net";
import { ConnectionClosedError } from "../core/errors/local.ts";
import type { ByteChannel, ReadChunk } from "../core/protocol/channel.ts";

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

  constructor(socket: Socket) {
    this.#socket = socket;
    let resolveClosed: () => void = () => undefined;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    socket.pause();
    socket.on("data", (data: Buffer) => {
      socket.pause();
      if (this.#done) return;
      this.#chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
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
    if (this.#writeShut || this.#socket.destroyed)
      return Promise.reject(new ConnectionClosedError("the socket is closed"));
    return new Promise((resolve, reject) => {
      const settle = (error: unknown): void => {
        if (!this.#writes.delete(settle)) return;
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
    this.#wake();
    const error = new ConnectionClosedError("the channel was closed");
    for (const reject of [...this.#writes]) reject(error);
    this.#socket.destroy();
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
 * socket closes first or is already ended/closed. `end()` half-closes (resolves on `finish`/`close`), `close()`
 * destroys the socket (idempotent), `closed` resolves on the socket's `close`. An `error` listener is always
 * attached, so socket errors never crash the process.
 */
export function fromNodeSocket(socket: Socket): ByteChannel {
  return new NodeSocketChannel(socket);
}
