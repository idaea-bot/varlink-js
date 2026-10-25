// NUL framing of the byte stream (DESIGN.md §4.2, §4.10; fixes F15): one growable buffer, a size limit with
// bounded memory, strict UTF-8.
import { MessageTooLargeError, ProtocolError } from "../errors/local.ts";

/** Default `maxMessageSize`: sd-varlink's input buffer limit (JSON_STREAM_BUFFER_MAX_DEFAULT, 16 MiB). */
export const DEFAULT_MAX_MESSAGE_SIZE: number = 16 * 1024 * 1024;

/** Options for {@link Framer}. */
export interface FramerOptions {
  /** Largest message in bytes, without its NUL. A positive safe integer; default {@link DEFAULT_MAX_MESSAGE_SIZE}. */
  maxMessageSize?: number;
}

const INITIAL_CAPACITY = 4096;
const NUL = 0;

/** The `maxMessageSize` option checked: a positive safe integer, default {@link DEFAULT_MAX_MESSAGE_SIZE}. */
export function checkMaxMessageSize(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_MESSAGE_SIZE;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new RangeError("maxMessageSize must be a positive safe integer");
  return value;
}

/**
 * Splits a byte stream into NUL-terminated UTF-8 messages. Amortised O(n) over the stream: bytes are copied into
 * one growable buffer (doubling, compacted as it is consumed) and each byte is scanned for NUL once on push.
 *
 * Problems in the peer's data (a message over `maxMessageSize`, invalid UTF-8) never throw from push(): they are
 * thrown by next() when the stream reaches them, after every complete message before them. From then on the
 * framer is failed: next() rethrows the same error object and push() is a no-op.
 */
export class Framer {
  readonly #max: number;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  #buf: Uint8Array = new Uint8Array(0);
  /** Read offset: start of the first unconsumed message. */
  #start = 0;
  /** Write offset. */
  #end = 0;
  /** Start of the incomplete message after the last NUL found; bytes before it are scanned. */
  #msgStart = 0;
  #complete = 0;
  /** Recorded on push (too large), thrown by next() once the complete messages before it are consumed. */
  #pending: ProtocolError | null = null;
  /** Thrown by next() before; rethrown forever. */
  #failed: ProtocolError | null = null;
  /** A push was ignored because of {@link #pending}: the buffered bytes are not the whole stream. */
  #dropped = false;
  #finished = false;

  constructor(options?: FramerOptions) {
    this.#max = checkMaxMessageSize(options?.maxMessageSize);
  }

  /** Unconsumed bytes currently held. */
  get buffered(): number {
    return this.#end - this.#start;
  }

  /** Number of complete (NUL-terminated) messages currently buffered and not yet returned by next(). */
  get completeMessages(): number {
    return this.#complete;
  }

  /**
   * False once push() would ignore its input: an error is pending or was thrown, or the framer is finished.
   * Reading more from the peer is pointless then.
   */
  get accepting(): boolean {
    return this.#pending === null && this.#failed === null && !this.#finished;
  }

  /** Appends a copy of `bytes`. Never throws for peer data (problems surface from next(), in stream order). */
  push(bytes: Uint8Array): void {
    if (this.#finished) throw new TypeError("the framer is finished (takeRemainder was called)");
    if (this.#pending !== null || this.#failed !== null) {
      if (bytes.length > 0) this.#dropped = true;
      return;
    }
    if (bytes.length === 0) return;
    this.#reserve(bytes.length);
    this.#buf.set(bytes, this.#end);
    const scanFrom = this.#end;
    this.#end += bytes.length;
    this.#scan(scanFrom);
  }

  /** Next complete message as a string (without the NUL), or null if none is complete yet. */
  next(): string | null {
    if (this.#finished) throw new TypeError("the framer is finished (takeRemainder was called)");
    if (this.#failed !== null) throw this.#failed;
    if (this.#complete === 0) {
      if (this.#pending === null) return null;
      this.#failed = this.#pending;
      throw this.#failed;
    }
    const nul = this.#buf.subarray(0, this.#end).indexOf(NUL, this.#start);
    const bytes = this.#buf.subarray(this.#start, nul);
    this.#start = nul + 1;
    this.#complete--;
    let text: string;
    try {
      text = this.#decoder.decode(bytes);
    } catch (e) {
      this.#failed = new ProtocolError("message is not valid UTF-8", { cause: e });
      throw this.#failed;
    }
    if (this.#start === this.#end) {
      this.#start = this.#end = this.#msgStart = 0;
    } else if (this.#start > this.#buf.length / 2) {
      this.#compact();
    }
    return text;
  }

  /**
   * Returns the unconsumed bytes (a copy) and finishes the framer: later push/next throw TypeError. For upgrade.
   *
   * @throws {MessageTooLargeError} (the pending error) if bytes were discarded because of the size limit, so the
   *   remainder would not be the whole rest of the stream. The framer is finished anyway.
   */
  takeRemainder(): Uint8Array {
    if (this.#finished) throw new TypeError("the framer is finished (takeRemainder was called)");
    this.#finished = true;
    const rest = this.#buf.slice(this.#start, this.#end);
    this.#buf = new Uint8Array(0);
    this.#start = this.#end = this.#msgStart = this.#complete = 0;
    if (this.#dropped && this.#pending !== null) throw this.#pending;
    return rest;
  }

  /** Counts the NULs in the bytes from `from` to the end and checks the size limit. */
  #scan(from: number): void {
    const view = this.#buf.subarray(0, this.#end);
    let i = from;
    for (;;) {
      const nul = view.indexOf(NUL, i);
      if (nul < 0) break;
      if (nul - this.#msgStart > this.#max) {
        this.#tooLarge();
        return;
      }
      this.#complete++;
      this.#msgStart = nul + 1;
      i = nul + 1;
    }
    if (this.#end - this.#msgStart > this.#max) this.#tooLarge();
  }

  #tooLarge(): void {
    // The bytes of this push stay buffered (an upgrade remainder may need them); later pushes are dropped, so
    // memory stays bounded at maxMessageSize + one chunk + the complete messages before.
    this.#pending = new MessageTooLargeError(`message exceeds maxMessageSize (${String(this.#max)} bytes)`);
  }

  /** Makes room for `n` more bytes after #end. */
  #reserve(n: number): void {
    if (this.#buf.length - this.#end >= n) return;
    if (this.#start > 0) this.#compact();
    if (this.#buf.length - this.#end >= n) return;
    const need = this.#end + n;
    const grown = new Uint8Array(Math.max(INITIAL_CAPACITY, this.#buf.length * 2, need));
    grown.set(this.#buf.subarray(0, this.#end));
    this.#buf = grown;
  }

  /** Moves the unconsumed bytes to the front of the buffer. */
  #compact(): void {
    const shift = this.#start;
    if (shift === 0) return;
    this.#buf.copyWithin(0, shift, this.#end);
    this.#end -= shift;
    this.#msgStart -= shift;
    this.#start = 0;
  }
}

const encoder = new TextEncoder();

/**
 * UTF-8 encodes `text` and appends NUL.
 *
 * @throws {TypeError} if `text` contains U+0000 (JSON from the codec never does) or is not well-formed UTF-16 (a
 *   lone surrogate: TextEncoder would silently write U+FFFD).
 */
export function frameMessage(text: string): Uint8Array {
  if (typeof text !== "string") throw new TypeError("frameMessage expects a string");
  if (text.includes("\0")) throw new TypeError("a message must not contain U+0000");
  if (!text.isWellFormed()) throw new TypeError("a message must be well-formed UTF-16 (lone surrogate)");
  const utf8 = encoder.encode(text);
  const framed = new Uint8Array(utf8.length + 1);
  framed.set(utf8);
  return framed;
}
