// ByteChannel over a WebSocket (DESIGN.md §4.1, §4.12; UAPI "WebSocket Mode"): frames are bytes, never messages
// (the Connection's framer reassembles on NUL). Runtime-agnostic: only the WHATWG WebSocket API, structurally typed.
import { ConnectionClosedError, OperationNotSupportedError, safeQuote } from "../core/errors/local.ts";
import type { ByteChannel, FdHandle, ReadChunk } from "../core/protocol/channel.ts";
import { DEFAULT_MAX_MESSAGE_SIZE } from "../core/protocol/framer.ts";

/**
 * The members of a WHATWG `WebSocket` (browsers, Node, Bun, Deno, the `ws` package) this library uses. Declared
 * structurally so the public types compile without lib `dom`.
 */
export interface WebSocketLike {
  /** 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED. */
  readonly readyState: number;
  /** Set to `"arraybuffer"`. */
  binaryType: string;
  /** Bytes queued by `send()` and not yet transmitted (write backpressure). */
  readonly bufferedAmount: number;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  /** `open`, `message` (`data`), `close` (`code`, `reason`, `wasClean`) and `error` events. */
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

/** Options for {@link fromWebSocket}. */
export interface WebSocketChannelOptions {
  /**
   * Most received bytes queued unread (the WebSocket API cannot push back on the peer); default 64 MiB
   * (4 × the default `maxMessageSize`). Exceeding it closes the socket and fails the next read.
   */
  maxBufferedBytes?: number;
  /** `write()` resolves once the socket's `bufferedAmount` is at most this many bytes; default 1 MiB. */
  writeHighWaterMark?: number;
}

/** Default {@link WebSocketChannelOptions.maxBufferedBytes}. */
export const DEFAULT_MAX_BUFFERED_BYTES: number = 4 * DEFAULT_MAX_MESSAGE_SIZE;
/** Default {@link WebSocketChannelOptions.writeHighWaterMark}. */
export const DEFAULT_WRITE_HIGH_WATER_MARK: number = 1024 * 1024;
/** `closed` settles at the latest this long after `close()`/`end()`, even if the peer never answers the close. */
export const CLOSE_GUARD_MS: number = 5000;

const CONNECTING = 0;
const OPEN = 1;
/** First and longest delay between `bufferedAmount` polls (ms). */
const POLL_FIRST_MS = 1;
const POLL_MAX_MS = 50;

/** The channel options checked (also used by `connect()` before it dials). */
export function checkChannelOptions(options: WebSocketChannelOptions | undefined): Required<WebSocketChannelOptions> {
  const max = options?.maxBufferedBytes;
  const hwm = options?.writeHighWaterMark;
  if (max !== undefined && (typeof max !== "number" || !Number.isSafeInteger(max) || max <= 0))
    throw new RangeError("maxBufferedBytes must be a positive safe integer");
  if (hwm !== undefined && (typeof hwm !== "number" || !Number.isSafeInteger(hwm) || hwm < 0))
    throw new RangeError("writeHighWaterMark must be a non-negative safe integer");
  return {
    maxBufferedBytes: max ?? DEFAULT_MAX_BUFFERED_BYTES,
    writeHighWaterMark: hwm ?? DEFAULT_WRITE_HIGH_WATER_MARK,
  };
}

/**
 * Closes `ws` with `code` (when the socket is CONNECTING or OPEN). The WHATWG API only takes 1000 and 3000–4999:
 * other codes (1009, 1011) work with the `ws` package, and fall back to 1000 with the same reason elsewhere.
 */
export function closeSocket(ws: WebSocketLike, code: number, reason?: string): void {
  if (ws.readyState !== CONNECTING && ws.readyState !== OPEN) return;
  try {
    ws.close(code, reason);
  } catch {
    try {
      ws.close(1000, reason);
    } catch {
      // Nothing else to try: the socket is being closed or is gone.
    }
  }
}

interface Slot {
  /** Undefined while a Blob is being read. */
  bytes: Uint8Array | undefined;
  /** A failure at this position of the stream (a Blob that could not be read). */
  error?: unknown;
}

interface PendingRead {
  resolve(chunk: ReadChunk | null): void;
  reject(error: unknown): void;
}

interface PendingWrite {
  resolve(): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Describes `{code, reason}` of a close event for an error message (the reason is peer-controlled). */
function closeMessage(event: unknown): string {
  const { code, reason } = event as { code?: unknown; reason?: unknown };
  let text = `websocket closed: code ${typeof code === "number" ? String(code) : "unknown"}`;
  if (typeof reason === "string" && reason !== "") text += ` ${safeQuote(reason)}`;
  return text;
}

/** Whether a close event is an orderly end of the stream: a clean close with 1000 or 1005 (no status). */
function isCleanClose(event: unknown): boolean {
  const { code, wasClean } = event as { code?: unknown; wasClean?: unknown };
  return wasClean === true && (code === 1000 || code === 1005);
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

function isBlobLike(value: unknown): value is { size: number; arrayBuffer(): Promise<ArrayBuffer> } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { size?: unknown }).size === "number" &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

class WebSocketChannel implements ByteChannel {
  readonly capabilities: ByteChannel["capabilities"] = {};
  readonly closed: Promise<void>;
  readonly #ws: WebSocketLike;
  readonly #maxBuffered: number;
  readonly #hwm: number;
  readonly #encoder = new TextEncoder();
  readonly #slots: Slot[] = [];
  readonly #writes = new Set<PendingWrite>();
  #buffered = 0;
  #reader: PendingRead | undefined;
  /** How the stream ends once the slots are drained: `null` = EOF, else the error to reject one read with. */
  #outcome: { error: unknown; fromErrorEvent: boolean } | null | undefined;
  #outcomeDelivered = false;
  /** A local `close()`: reads give null, buffered data is dropped. */
  #localClose = false;
  /** `end()`/`close()` was called or the socket failed: writes reject. */
  #writeShut = false;
  /** The `close` event arrived. */
  #sawClose = false;
  /** We started the closing handshake (`end()`, `close()`, our own failure). */
  #closeInitiated = false;
  #closedResolved = false;
  #guard: ReturnType<typeof setTimeout> | undefined;
  #resolveClosed: () => void = () => undefined;
  readonly #endWaiters: (() => void)[] = [];
  readonly #listeners: [string, (event: unknown) => void][];

  constructor(ws: WebSocketLike, options: Required<WebSocketChannelOptions>) {
    this.#ws = ws;
    this.#maxBuffered = options.maxBufferedBytes;
    this.#hwm = options.writeHighWaterMark;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    ws.binaryType = "arraybuffer";
    this.#listeners = [
      [
        "message",
        (event) => {
          this.#onMessage((event as { data?: unknown }).data);
        },
      ],
      [
        "error",
        (event) => {
          this.#onError(event);
        },
      ],
      [
        "close",
        (event) => {
          this.#onClose(event);
        },
      ],
    ];
    for (const [type, listener] of this.#listeners) ws.addEventListener(type, listener);
  }

  read(): Promise<ReadChunk | null> {
    if (this.#reader !== undefined) return Promise.reject(new TypeError("read() called concurrently"));
    return new Promise((resolve, reject) => {
      this.#reader = { resolve, reject };
      this.#wake();
    });
  }

  write(chunk: Uint8Array, fds?: readonly FdHandle[]): Promise<void> {
    if (fds !== undefined && fds.length > 0)
      return Promise.reject(new OperationNotSupportedError("a WebSocket cannot carry file descriptors"));
    if (this.#writeShut || this.#ws.readyState !== OPEN)
      return Promise.reject(new ConnectionClosedError("the websocket is closed"));
    try {
      this.#ws.send(chunk as Uint8Array<ArrayBuffer>);
    } catch (e) {
      return Promise.reject(new ConnectionClosedError("websocket send failed", { cause: e }));
    }
    if (this.#ws.bufferedAmount <= this.#hwm) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w: PendingWrite = { resolve, reject, timer: undefined };
      this.#writes.add(w);
      this.#poll(w, POLL_FIRST_MS);
    });
  }

  end(): Promise<void> {
    this.#writeShut = true;
    if (this.#sawClose || this.#closedResolved) return Promise.resolve();
    const done = new Promise<void>((resolve) => {
      this.#endWaiters.push(resolve);
    });
    this.#closeInitiated = true;
    closeSocket(this.#ws, 1000);
    this.#armGuard();
    return done;
  }

  close(): void {
    if (this.#localClose) return;
    this.#localClose = true;
    this.#writeShut = true;
    this.#slots.length = 0;
    this.#buffered = 0;
    this.#rejectWrites(new ConnectionClosedError("the channel was closed"));
    this.#wake();
    this.#closeInitiated = true;
    closeSocket(this.#ws, 1000);
    if (this.#sawClose) this.#maybeResolveClosed();
    else this.#armGuard();
  }

  #onMessage(data: unknown): void {
    if (this.#localClose || this.#outcome !== undefined) return;
    if (typeof data === "string") {
      this.#push(this.#encoder.encode(data));
    } else if (isArrayBuffer(data)) {
      this.#push(new Uint8Array(data));
    } else if (ArrayBuffer.isView(data)) {
      this.#push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } else if (isBlobLike(data)) {
      // A runtime that ignored binaryType: read it in order (later messages wait behind this slot).
      if (data.size === 0) return;
      if (!this.#reserve(data.size)) return;
      const slot: Slot = { bytes: undefined };
      this.#slots.push(slot);
      data.arrayBuffer().then(
        (buffer) => {
          slot.bytes = new Uint8Array(buffer);
          this.#wake();
        },
        (error: unknown) => {
          slot.bytes = new Uint8Array(0);
          slot.error = new ConnectionClosedError("websocket: reading a Blob message failed", { cause: error });
          this.#wake();
        },
      );
    } else {
      this.#fail(new ConnectionClosedError("websocket: unsupported message data type"), 1003);
    }
  }

  /** Accounts `size` more queued bytes; false (and the channel failed) if that exceeds the limit. */
  #reserve(size: number): boolean {
    if (this.#buffered + size <= this.#maxBuffered) {
      this.#buffered += size;
      return true;
    }
    this.#fail(
      new ConnectionClosedError(
        `websocket receive buffer limit exceeded (maxBufferedBytes ${String(this.#maxBuffered)})`,
      ),
      1009,
      "receive buffer limit exceeded",
    );
    return false;
  }

  #push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (!this.#reserve(bytes.length)) return;
    this.#slots.push({ bytes });
    this.#wake();
  }

  /** Our own failure (limit, bad data): drop the queue, close the socket, fail the next read. */
  #fail(error: unknown, code: number, reason?: string): void {
    this.#slots.length = 0;
    this.#buffered = 0;
    this.#outcome = { error, fromErrorEvent: false };
    this.#writeShut = true;
    this.#rejectWrites(new ConnectionClosedError("the websocket is closed", { cause: error }));
    this.#closeInitiated = true;
    closeSocket(this.#ws, code, reason);
    this.#armGuard();
    this.#wake();
  }

  #onError(event: unknown): void {
    this.#writeShut = true;
    if (this.#outcome === undefined && !this.#localClose)
      this.#outcome = { error: new ConnectionClosedError("websocket error", { cause: event }), fromErrorEvent: true };
    this.#wake();
  }

  #onClose(event: unknown): void {
    if (this.#sawClose) return;
    this.#sawClose = true;
    this.#writeShut = true;
    // The close event is the socket's last event: nothing more to listen to. The closing handshake is over, so the
    // guard is not needed any more (`closed` now waits only for the reader).
    for (const [type, listener] of this.#listeners) this.#ws.removeEventListener(type, listener);
    if (this.#guard !== undefined) {
      clearTimeout(this.#guard);
      this.#guard = undefined;
    }
    const clean = isCleanClose(event);
    // A clean close we started means the closing handshake completed after everything we sent was transmitted. One
    // the peer started may have discarded data frames that arrived after its Close (RFC 6455 §5.5.1): reject then.
    if (clean && this.#closeInitiated) this.#resolveWrites();
    else if (clean)
      this.#rejectWrites(new ConnectionClosedError("the peer closed the websocket before the write was sent"));
    else this.#rejectWrites(new ConnectionClosedError(closeMessage(event)));
    if (!this.#localClose) {
      if (this.#outcome === undefined) {
        this.#outcome = clean ? null : { error: new ConnectionClosedError(closeMessage(event)), fromErrorEvent: false };
      } else if (this.#outcome?.fromErrorEvent === true && !this.#outcomeDelivered) {
        // The error event carries no detail; the close code does.
        this.#outcome = {
          error: new ConnectionClosedError(closeMessage(event), { cause: this.#outcome.error }),
          fromErrorEvent: false,
        };
      }
    }
    for (const resolve of this.#endWaiters.splice(0)) resolve();
    this.#wake();
    this.#maybeResolveClosed();
  }

  /** Settles the pending read if there is something to give it: data in order, then the outcome once, then null. */
  #wake(): void {
    const reader = this.#reader;
    if (reader === undefined) return;
    if (this.#localClose) {
      this.#reader = undefined;
      reader.resolve(null);
      return;
    }
    const slot = this.#slots[0];
    if (slot !== undefined) {
      if (slot.bytes === undefined) return; // a Blob still being read
      this.#slots.shift();
      this.#buffered -= slot.bytes.length;
      this.#reader = undefined;
      if (slot.error !== undefined) {
        // Nothing after an unreadable message can be trusted: fail the stream here.
        this.#slots.length = 0;
        this.#buffered = 0;
        this.#outcome = null;
        this.#outcomeDelivered = true;
        reader.reject(slot.error);
        this.#closeInitiated = true;
        closeSocket(this.#ws, 1011, "unreadable message");
        this.#armGuard();
        this.#maybeResolveClosed();
        return;
      }
      reader.resolve({ bytes: slot.bytes });
      return;
    }
    if (this.#outcome === undefined) return;
    this.#reader = undefined;
    const outcome = this.#outcome;
    if (outcome !== null && !this.#outcomeDelivered) {
      this.#outcomeDelivered = true;
      reader.reject(outcome.error);
    } else {
      this.#outcomeDelivered = true;
      reader.resolve(null);
    }
    this.#maybeResolveClosed();
  }

  #poll(w: PendingWrite, delay: number): void {
    w.timer = setTimeout(() => {
      w.timer = undefined;
      if (!this.#writes.has(w)) return;
      if (this.#ws.bufferedAmount <= this.#hwm) {
        this.#writes.delete(w);
        w.resolve();
        return;
      }
      this.#poll(w, Math.min(delay * 2, POLL_MAX_MS));
    }, delay);
  }

  #resolveWrites(): void {
    for (const w of this.#writes) {
      if (w.timer !== undefined) clearTimeout(w.timer);
      w.resolve();
    }
    this.#writes.clear();
  }

  #rejectWrites(error: unknown): void {
    for (const w of this.#writes) {
      if (w.timer !== undefined) clearTimeout(w.timer);
      w.reject(error);
    }
    this.#writes.clear();
  }

  /** After close()/end(): `closed` settles at the latest after CLOSE_GUARD_MS. */
  #armGuard(): void {
    if (this.#guard !== undefined || this.#closedResolved || this.#sawClose) return;
    this.#guard = setTimeout(() => {
      this.#guard = undefined;
      this.#writeShut = true;
      this.#rejectWrites(new ConnectionClosedError("the websocket did not close in time"));
      for (const resolve of this.#endWaiters.splice(0)) resolve();
      // The close event may never come: end the stream for a reader too (after end(), reads were still allowed),
      // and stop listening, as the close event would have.
      for (const [type, listener] of this.#listeners) this.#ws.removeEventListener(type, listener);
      if (this.#outcome === undefined && !this.#localClose)
        this.#outcome = {
          error: new ConnectionClosedError("the websocket did not close in time"),
          fromErrorEvent: false,
        };
      this.#wake();
      this.#finishClosed();
    }, CLOSE_GUARD_MS);
  }

  /**
   * `closed` settles once the close event arrived and the stream's end was read (or the channel was closed
   * locally), so data queued before the close is never cut off by a `closed` listener.
   */
  #maybeResolveClosed(): void {
    if (!this.#sawClose || !(this.#localClose || this.#outcomeDelivered)) return;
    // One microtask later: a read() that settled synchronously (inside its executor) has no reaction yet, and the
    // reader awaiting it must see the end of the stream before a `closed` listener runs.
    if (this.#closedResolved) return;
    this.#closedResolved = true;
    queueMicrotask(() => {
      this.#resolveClosed();
    });
  }

  #finishClosed(): void {
    if (this.#guard !== undefined) {
      clearTimeout(this.#guard);
      this.#guard = undefined;
    }
    if (this.#closedResolved) return;
    this.#closedResolved = true;
    this.#resolveClosed();
  }
}

/**
 * A {@link ByteChannel} over an OPEN WebSocket (DESIGN.md §4.12; UAPI "WebSocket Mode"). Sets `binaryType` to
 * `"arraybuffer"`; binary messages become chunks as they are, text messages are UTF-8 encoded, and a `Blob` (from
 * a runtime that ignores `binaryType`) is read in order. Message boundaries carry no meaning: the Connection's
 * framer reassembles varlink messages on NUL.
 *
 * Reads are pulled: messages are queued until `read()`. The WebSocket API cannot push back on the peer, so the queue
 * is bounded by `maxBufferedBytes` (default 64 MiB): exceeding it drops the queue, closes the socket (code 1009,
 * or 1000 where the API refuses 1009) and the next `read()` rejects with `ConnectionClosedError`; later reads give
 * `null` (`WebSocketStream` would allow real backpressure but is not available everywhere). After the queued data,
 * a clean close (code 1000 or 1005) gives `null`; any other close or an `error` event rejects one read with
 * `ConnectionClosedError("websocket closed: code N …")`, later reads give `null`.
 *
 * `write()` sends one binary message and resolves once `bufferedAmount` is at most `writeHighWaterMark` (default
 * 1 MiB, polled); it rejects with `ConnectionClosedError` unless the socket is open, and if it closes uncleanly first,
 * and with `OperationNotSupportedError` when given fds. `end()` (no half-close in WebSocket) closes with 1000 after
 * the queued data and resolves on the `close` event; `close()` is the same but immediate for this side (reads give
 * `null`, writes reject; idempotent). `closed` never rejects; it settles once the `close` event arrived and the end
 * of the stream was read (a microtask after that read settled), or after `close()` — so data queued before the close
 * is never cut off by a `closed` listener. If the peer never answers the closing handshake, `closed` (and `end()`)
 * settle 5 s after `close()`/`end()`; the timer is cleared by the `close` event. All listeners are removed on the
 * `close` event (the socket's last event).
 *
 * Attach it synchronously in the `open` handler: messages that arrive before are not seen.
 *
 * @throws {TypeError} if `ws` is not OPEN.
 * @throws {RangeError} for invalid options.
 */
export function fromWebSocket(ws: WebSocketLike, options?: WebSocketChannelOptions): ByteChannel {
  const checked = checkChannelOptions(options);
  // Untyped callers may pass anything.
  const raw: unknown = ws;
  if (typeof raw !== "object" || raw === null || ws.readyState !== OPEN)
    throw new TypeError("fromWebSocket() needs an OPEN WebSocket");
  return new WebSocketChannel(ws, checked);
}
