// NUL framing of the byte stream (DESIGN.md §4.2, §4.10; fixes F15): one growable buffer, a size limit with
// bounded memory, strict UTF-8.
import { MessageTooLargeError, ProtocolError } from "../errors/local.ts";
import type { FdHandle } from "./channel.ts";

/** Default `maxMessageSize`: sd-varlink's input buffer limit (JSON_STREAM_BUFFER_MAX_DEFAULT, 16 MiB). */
export const DEFAULT_MAX_MESSAGE_SIZE: number = 16 * 1024 * 1024;

/** Options for {@link Framer}. */
export interface FramerOptions {
  /** Largest message in bytes, without its NUL. A positive safe integer; default {@link DEFAULT_MAX_MESSAGE_SIZE}. */
  maxMessageSize?: number;
}

const INITIAL_CAPACITY = 4096;
/**
 * A buffer larger than this is dropped when it empties (next() consumed everything), and shrunk when next() leaves
 * less than a quarter of it buffered.
 */
const SHRINK_THRESHOLD = 64 * 1024;
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
 * one growable buffer (doubling, compacted as it is consumed, shrunk once mostly consumed) and each byte is scanned
 * for NUL twice: once on push (counting complete messages, checking the size limit) and once more when next()
 * returns its message.
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
  /** Messages completed so far (counted on push), and returned by next(): the stream ordinal of the next one. */
  #completedTotal = 0;
  #returnedTotal = 0;
  /** fds per message (by stream ordinal), received with the chunk that started the message. */
  readonly #fds: { ordinal: number; fds: FdHandle[] }[] = [];
  /** Total number of fds in {@link #fds}. */
  #queuedFds = 0;
  /** fds of the message next() returned last, until takeFds() or the next next() (which closes them). */
  #lastFds: FdHandle[] | undefined;

  constructor(options?: FramerOptions) {
    this.#max = checkMaxMessageSize(options?.maxMessageSize);
  }

  /** Unconsumed bytes currently held. */
  get buffered(): number {
    return this.#end - this.#start;
  }

  /** Size of the internal buffer in bytes (≥ {@link buffered}). For tests and diagnostics. */
  get capacity(): number {
    return this.#buf.length;
  }

  /** Number of complete (NUL-terminated) messages currently buffered and not yet returned by next(). */
  get completeMessages(): number {
    return this.#complete;
  }

  /** Number of fds held for messages next() has not returned yet (complete or not). */
  get queuedFds(): number {
    return this.#queuedFds;
  }

  /**
   * False once push() would ignore its input: an error is pending or was thrown, or the framer is finished.
   * Reading more from the peer is pointless then.
   */
  get accepting(): boolean {
    return this.#pending === null && this.#failed === null && !this.#finished;
  }

  /**
   * Appends a copy of `bytes`. Never throws for peer data (problems surface from next(), in stream order).
   *
   * `fds` (M11, DESIGN.md §4.1) arrived with the first byte of `bytes`: they belong to the message that byte starts,
   * and next() hands them out with it ({@link takeFds}); the framer owns them until then. Like sd-varlink, fds may
   * only come with the first byte of a message: fds arriving while a message is incomplete are a protocol error
   * (json-stream.c:1345-1350 returns EPROTO; here they are closed and, after the complete messages before, next()
   * throws). The bytes of such a chunk are dropped.
   */
  push(bytes: Uint8Array, fds?: readonly FdHandle[]): void {
    if (this.#finished) {
      closeFds(fds);
      throw new TypeError("the framer is finished (takeRemainder was called)");
    }
    if (this.#pending !== null || this.#failed !== null) {
      closeFds(fds);
      if (bytes.length > 0) this.#dropped = true;
      return;
    }
    if (fds !== undefined && fds.length > 0) {
      if (this.#end !== this.#msgStart || bytes.length === 0) {
        closeFds(fds);
        this.#pending = new ProtocolError("file descriptors received in the middle of a message");
        this.#dropped = true;
        return;
      }
      this.#fds.push({ ordinal: this.#completedTotal, fds: [...fds] });
      this.#queuedFds += fds.length;
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
      this.discardFds();
      throw this.#failed;
    }
    // The previous message's fds that nobody took are done with.
    closeFds(this.#lastFds);
    this.#lastFds = undefined;
    const ordinal = this.#returnedTotal++;
    const head = this.#fds[0];
    if (head?.ordinal === ordinal) {
      this.#fds.shift();
      this.#queuedFds -= head.fds.length;
      this.#lastFds = head.fds;
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
      this.discardFds();
      throw this.#failed;
    }
    if (this.#start === this.#end) {
      this.#start = this.#end = this.#msgStart = 0;
      // Give a large buffer back once it is empty (re-allocated lazily on the next push): one big message must
      // not pin its memory for the rest of the connection.
      if (this.#buf.length > SHRINK_THRESHOLD) this.#buf = new Uint8Array(0);
    } else if (this.#buf.length > SHRINK_THRESHOLD && this.#buf.length > 4 * this.buffered) {
      // Mostly consumed (e.g. a big message followed by the first bytes of the next one): shrink so the rest does
      // not pin the big buffer. It copies < 1/4 of the capacity and the new capacity is < 4 × buffered, so each
      // shrink at least roughly halves the capacity: a run of shrinks copies less than the capacity the buffer had
      // grown to, which growing already paid for. Copying stays amortised O(n).
      this.#shrink();
    } else if (this.#start > this.#buf.length / 2) {
      this.#compact();
    }
    return text;
  }

  /**
   * The fds that came with the message next() returned last (empty if none), handed to the caller, who owns them
   * from now on. Not taken before the next next() (or {@link discardFds}), they are closed.
   */
  takeFds(): FdHandle[] {
    const fds = this.#lastFds ?? [];
    this.#lastFds = undefined;
    return fds;
  }

  /** Closes every fd the framer still holds (the session is done with the stream). */
  discardFds(): void {
    closeFds(this.#lastFds);
    this.#lastFds = undefined;
    for (const entry of this.#fds.splice(0)) closeFds(entry.fds);
    this.#queuedFds = 0;
  }

  /**
   * Returns the unconsumed bytes (a copy) and finishes the framer: later push/next throw TypeError. For upgrade.
   * fds still held (with bytes past the varlink part) are closed: the upgraded stream is bytes only.
   *
   * @throws {MessageTooLargeError} (the pending error) if bytes were discarded because of the size limit, so the
   *   remainder would not be the whole rest of the stream. The framer is finished anyway.
   */
  takeRemainder(): Uint8Array {
    if (this.#finished) throw new TypeError("the framer is finished (takeRemainder was called)");
    // The upgraded stream is bytes only: fds that came with bytes past the varlink part are closed.
    this.discardFds();
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
      this.#completedTotal++;
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
    // Compact only when that frees at least a quarter of the buffer: each compaction then moves at most 3/4 of
    // the capacity for ≥ 1/4 of it consumed, so copying stays amortised O(n) (otherwise grow).
    if (this.#start >= this.#buf.length / 4) {
      this.#compact();
      if (this.#buf.length - this.#end >= n) return;
    }
    // Growing copies anyway: copy only the unconsumed bytes, to the front.
    const shift = this.#start;
    const need = this.#end - shift + n;
    const grown = new Uint8Array(Math.max(INITIAL_CAPACITY, this.#buf.length * 2, need));
    grown.set(this.#buf.subarray(shift, this.#end));
    this.#buf = grown;
    this.#end -= shift;
    this.#msgStart -= shift;
    this.#start = 0;
  }

  /** Moves the unconsumed bytes to the front of a new buffer: the smallest INITIAL_CAPACITY × 2^k ≥ 2 × buffered. */
  #shrink(): void {
    const shift = this.#start;
    let size = INITIAL_CAPACITY;
    while (size < 2 * (this.#end - shift)) size *= 2;
    const shrunk = new Uint8Array(size);
    shrunk.set(this.#buf.subarray(shift, this.#end));
    this.#buf = shrunk;
    this.#end -= shift;
    this.#msgStart -= shift;
    this.#start = 0;
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

/** Closes each fd; a failing close() (a caller's handle) is ignored. */
export function closeFds(fds: readonly FdHandle[] | undefined): void {
  if (fds === undefined) return;
  for (const fd of fds) {
    try {
      fd.close();
    } catch {
      // Closing is best effort here: the fd is no longer ours either way.
    }
  }
}

/**
 * The fds go from the library to a user (`ctx.takeFd`, an `acceptFds` reply): handles that support it (the native
 * channel's) stop being tracked by their transport, so tearing that environment down does not close them under their
 * new owner. Duck-typed: other handles are left alone.
 */
export function handOver(fds: readonly FdHandle[] | undefined): void {
  if (fds === undefined) return;
  for (const fd of fds) {
    const h = (fd as { handOver?: unknown }).handOver;
    if (typeof h === "function") {
      try {
        (h as () => void).call(fd);
      } catch {
        // Bookkeeping only.
      }
    }
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
