// Sans-IO server side of a connection (DESIGN.md §4.5, §4.10): calls strictly in order, exactly one final reply
// per non-oneway call, none for oneway, bounded read-ahead, a pause after an upgrade call.
import { ProtocolError } from "../errors/local.ts";
import { jsonCodec, type Codec } from "../types/codec.ts";
import { concat } from "./client-session.ts";
import { checkMaxMessageSize, Framer, frameMessage } from "./framer.ts";
import { decodeCall, encodeReply, type Call } from "./messages.ts";

/** Default `maxQueuedCalls`: complete messages buffered before the driver stops reading. */
export const DEFAULT_MAX_QUEUED_CALLS: number = 64;

/** Options for {@link ServerSession}. */
export interface ServerSessionOptions {
  /** Default {@link jsonCodec}. */
  codec?: Codec;
  /** Largest call in bytes; default 16 MiB. */
  maxMessageSize?: number;
  /** Complete messages buffered before {@link ServerSession.wantsInput} turns false. Default 64. */
  maxQueuedCalls?: number;
}

/** What {@link ServerSession.nextEvent} returns. */
export type ServerEvent =
  | { type: "call"; id: number; call: Call }
  | {
      type: "close";
      /** Set iff the peer broke the protocol; without it: peer EOF and every call finished. */
      error?: ProtocolError;
    };

interface Active {
  readonly id: number;
  readonly call: Call;
}

/**
 * The server side of a varlink connection, without I/O. The driver feeds bytes with {@link receive}, takes calls
 * from {@link nextEvent} one at a time, and answers each with {@link reply}/{@link error} (or {@link finish} for
 * oneway) before the next call is handed out. Messages are decoded lazily, when they are reached.
 */
export class ServerSession {
  readonly #codec: Codec;
  readonly #framer: Framer;
  readonly #maxQueued: number;
  readonly #maxMessageSize: number;
  #state: "open" | "upgraded" | "closed" = "open";
  #active: Active | null = null;
  #lastFinished = 0;
  #nextId = 1;
  #eof = false;
  #paused = false;
  #closeEvent: ServerEvent | null = null;
  #remainder: Uint8Array[] | null = null;

  constructor(options?: ServerSessionOptions) {
    this.#codec = options?.codec ?? jsonCodec;
    this.#maxMessageSize = checkMaxMessageSize(options?.maxMessageSize);
    this.#framer = new Framer({ maxMessageSize: this.#maxMessageSize });
    const max = options?.maxQueuedCalls ?? DEFAULT_MAX_QUEUED_CALLS;
    if (!Number.isSafeInteger(max) || max <= 0) throw new RangeError("maxQueuedCalls must be a positive safe integer");
    this.#maxQueued = max;
  }

  /** `upgraded` after the final non-error reply to an upgrade call: the rest of the stream is not varlink. */
  get state(): "open" | "upgraded" | "closed" {
    return this.#state;
  }

  /**
   * False while maxQueuedCalls complete messages are buffered, while at least one complete message is buffered and
   * the buffered bytes reach maxMessageSize, while paused after an upgrade call, after EOF, after a framing error,
   * or when not open: the driver stops reading (backpressure). The byte bound is like sd-varlink's 16 MiB input
   * buffer cap (json-stream.c:1240), with room for one partial message: without a complete message the driver
   * keeps reading (the partial message needs it; the framer caps it at maxMessageSize). So a connection buffers at
   * most about 2 × maxMessageSize + one read chunk.
   */
  get wantsInput(): boolean {
    const complete = this.#framer.completeMessages;
    return (
      this.#state === "open" &&
      !this.#eof &&
      !this.#paused &&
      this.#framer.accepting &&
      complete < this.#maxQueued &&
      (complete === 0 || this.#framer.buffered < this.#maxMessageSize)
    );
  }

  /** Bytes read from the peer. */
  receive(bytes: Uint8Array): void {
    if (this.#state === "closed") return;
    if (this.#remainder !== null) {
      if (bytes.length > 0) this.#remainder.push(bytes.slice());
      return;
    }
    this.#framer.push(bytes);
  }

  /** The peer closed its side (EOF). Buffered complete calls are still delivered; a partial message is discarded. */
  receiveEnd(): void {
    this.#eof = true;
  }

  /** Next event, or null if nothing is ready. Returns a call only when no call is active. */
  nextEvent(): ServerEvent | null {
    if (this.#state !== "open") {
      const event = this.#closeEvent;
      this.#closeEvent = null;
      return event;
    }
    if (this.#active !== null) return null;
    let call: Call;
    try {
      const text = this.#framer.next();
      if (text === null) {
        if (!this.#eof) return null;
        this.#state = "closed";
        return { type: "close" };
      }
      call = decodeCall(this.#codec.decode(text));
    } catch (e) {
      this.#state = "closed";
      const error = e instanceof ProtocolError ? e : new ProtocolError("malformed message", { cause: e });
      return { type: "close", error };
    }
    const id = this.#nextId++;
    this.#active = { id, call };
    if (call.upgrade) this.#paused = true;
    return { type: "call", id, call };
  }

  /**
   * Encodes and frames a reply for the active call. Returns null for a oneway call (nothing is ever written), and
   * for the final reply to an upgrade call whose upgraded bytes were lost to the size limit: the session is then
   * closed (its close event carries the MessageTooLargeError) and no confirmation must reach the peer.
   * `continues: true` is only allowed when the call has `more`. A non-continues reply is final and ends the call
   * (except oneway: see {@link finish}).
   *
   * @throws {TypeError} if `id` is not the active call, its final reply was produced, the session is not open,
   *   `continues` is set without `more`, or the reply cannot be encoded (the call then stays active).
   */
  reply(
    id: number,
    parameters: Record<string, unknown>,
    options?: { continues?: boolean; ext?: Record<string, unknown> },
  ): Uint8Array | null {
    const active = this.#activeCall(id);
    const continues = options?.continues === true;
    if (continues && !active.call.more) throw new TypeError('"continues" needs a call with "more"');
    if (active.call.oneway) return null;
    const init: { parameters: Record<string, unknown>; continues?: boolean; ext?: Record<string, unknown> } = {
      parameters,
    };
    if (continues) init.continues = true;
    if (options?.ext !== undefined) init.ext = options.ext;
    const bytes = frameMessage(encodeReply(init, this.#codec));
    if (!continues && !this.#finishActive(false)) return null;
    return bytes;
  }

  /**
   * Error reply for the active call (always final). Returns null for oneway.
   *
   * @throws {TypeError} as for {@link reply}.
   */
  error(id: number, error: string, parameters?: Record<string, unknown>): Uint8Array | null {
    const active = this.#activeCall(id);
    if (active.call.oneway) return null;
    const bytes = frameMessage(encodeReply({ error, parameters: parameters ?? {} }, this.#codec));
    this.#finishActive(true);
    return bytes;
  }

  /**
   * Ends a oneway call (its handler settled). For a non-oneway call it is a TypeError unless the final reply was
   * already produced (then a no-op). A no-op once the session is closed.
   */
  finish(id: number): void {
    if (this.#state === "closed") return;
    const active = this.#active;
    if (active?.id === id) {
      if (!active.call.oneway) throw new TypeError("finish() before the call's final reply");
      this.#finishActive(false);
      return;
    }
    if (id !== this.#lastFinished || id === 0) throw new TypeError(`call ${String(id)} is not active`);
  }

  /**
   * Every byte after the upgrade call's NUL received so far. Only in state `upgraded`. May be called again: bytes
   * passed to {@link receive} later accumulate, and each call returns what arrived since the previous one (an empty
   * array if nothing did).
   */
  takeUpgradeRemainder(): Uint8Array {
    if (this.#state !== "upgraded" || this.#remainder === null)
      throw new TypeError("no upgrade remainder: the session is not upgraded");
    const chunks = this.#remainder;
    this.#remainder = [];
    return concat(chunks);
  }

  /** Local close: nothing more is produced, replies after it are TypeErrors. Idempotent. */
  close(): void {
    this.#state = "closed";
    this.#active = null;
    this.#closeEvent = null;
  }

  #activeCall(id: number): Active {
    if (this.#state !== "open") throw new TypeError(`cannot reply: the session is ${this.#state}`);
    const active = this.#active;
    if (active?.id !== id) throw new TypeError(`call ${String(id)} is not active (or was answered already)`);
    return active;
  }

  /** Ends the active call. False iff an upgrade could not be handed over (the session is closed then). */
  #finishActive(isError: boolean): boolean {
    const active = this.#active;
    if (active === null) return true;
    this.#active = null;
    this.#lastFinished = active.id;
    if (!active.call.upgrade) return true;
    this.#paused = false;
    if (isError) return true;
    try {
      const rest = this.#framer.takeRemainder();
      this.#remainder = rest.length > 0 ? [rest] : [];
      this.#state = "upgraded";
      return true;
    } catch (e) {
      // Upgraded bytes were dropped by the size limit: the stream cannot be handed over intact.
      this.#state = "closed";
      this.#closeEvent = {
        type: "close",
        error: e instanceof ProtocolError ? e : new ProtocolError("upgrade remainder lost", { cause: e }),
      };
      return false;
    }
  }
}
