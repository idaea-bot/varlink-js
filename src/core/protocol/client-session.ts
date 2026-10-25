// Sans-IO client side of a connection (DESIGN.md §4.5, §4.10): pipelined calls matched FIFO to replies.
import { ConnectionClosedError, ProtocolError, UpgradePendingError } from "../errors/local.ts";
import { jsonCodec, type Codec } from "../types/codec.ts";
import { Framer, frameMessage } from "./framer.ts";
import { decodeReply, encodeCall, type CallInit, type Reply } from "./messages.ts";

/** Options for {@link ClientSession}. */
export interface ClientSessionOptions {
  /** Default {@link jsonCodec}. */
  codec?: Codec;
  /** Largest reply in bytes; default 16 MiB. */
  maxMessageSize?: number;
}

/** What {@link ClientSession.receive} and friends report. `closed` is the last event ever. */
export type ClientEvent =
  | {
      type: "reply";
      id: number;
      parameters: Record<string, unknown>;
      continues: boolean;
      ext: Record<string, unknown>;
    }
  | { type: "error"; id: number; error: string; parameters: Record<string, unknown>; ext: Record<string, unknown> }
  | { type: "upgraded"; id: number; parameters: Record<string, unknown>; ext: Record<string, unknown> }
  | { type: "failed"; id: number; error: ConnectionClosedError }
  | {
      type: "closed";
      /** Set iff the session closed because the peer broke the protocol. */
      error?: ProtocolError;
    };

interface Entry {
  readonly id: number;
  readonly kind: "single" | "more" | "upgrade";
}

/** A codec/decoder failure as the ProtocolError that closes the session. */
function asProtocolError(e: unknown): ProtocolError {
  return e instanceof ProtocolError ? e : new ProtocolError("malformed message", { cause: e });
}

/**
 * The client side of a varlink connection, without I/O: {@link call} returns the bytes to write, and
 * {@link receive} turns bytes read from the peer into events. Calls are pipelined; replies are matched to calls
 * in order. A protocol violation by the peer closes the session: every pending call gets a `failed` event, then
 * `closed` carries the {@link ProtocolError}.
 */
export class ClientSession {
  readonly #codec: Codec;
  readonly #framer: Framer;
  readonly #queue: Entry[] = [];
  #nextId = 1;
  #state: "open" | "upgraded" | "closed" = "open";
  #upgradePending = false;
  #remainder: Uint8Array[] | null = null;
  #remainderTaken = false;

  constructor(options?: ClientSessionOptions) {
    this.#codec = options?.codec ?? jsonCodec;
    this.#framer = new Framer(
      options?.maxMessageSize === undefined ? undefined : { maxMessageSize: options.maxMessageSize },
    );
  }

  /** `upgraded` after a successful upgrade call: the rest of the stream is not varlink. */
  get state(): "open" | "upgraded" | "closed" {
    return this.#state;
  }

  /** Calls waiting for replies (oneway calls never count). */
  get pending(): number {
    return this.#queue.length;
  }

  /**
   * Encodes and frames a call. Returns its id (positive, increasing) and the bytes the driver must write. Never
   * changes state when it throws.
   *
   * @throws {UpgradePendingError} while an upgrade call is pending.
   * @throws {ConnectionClosedError} when the session is closed or upgraded.
   * @throws {TypeError} from {@link encodeCall} (caller bugs).
   */
  call(init: CallInit): { id: number; bytes: Uint8Array } {
    if (this.#state !== "open")
      throw new ConnectionClosedError(this.#state === "closed" ? "connection is closed" : "connection was upgraded");
    if (this.#upgradePending) throw new UpgradePendingError("an upgrade call is pending on this connection");
    const bytes = frameMessage(encodeCall(init, this.#codec));
    const id = this.#nextId++;
    if (init.upgrade === true) {
      this.#queue.push({ id, kind: "upgrade" });
      this.#upgradePending = true;
    } else if (init.more === true) {
      this.#queue.push({ id, kind: "more" });
    } else if (init.oneway !== true) {
      this.#queue.push({ id, kind: "single" });
    }
    return { id, bytes };
  }

  /** Bytes read from the peer. Returns the events they complete, in order. */
  receive(bytes: Uint8Array): ClientEvent[] {
    if (this.#state === "closed") return [];
    if (this.#remainder !== null) {
      if (bytes.length > 0) this.#remainder.push(bytes.slice());
      return [];
    }
    this.#framer.push(bytes);
    const events: ClientEvent[] = [];
    for (;;) {
      let text: string | null;
      let reply: Reply;
      try {
        text = this.#framer.next();
        if (text === null) return events;
        reply = decodeReply(this.#codec.decode(text));
      } catch (e) {
        return this.#closeWith(events, asProtocolError(e));
      }
      const head = this.#queue[0];
      if (head === undefined) return this.#closeWith(events, new ProtocolError("reply without a pending call"));
      if (reply.continues && head.kind !== "more")
        return this.#closeWith(events, new ProtocolError('"continues" reply to a call without "more"'));
      if (reply.continues) {
        events.push({ type: "reply", id: head.id, parameters: reply.parameters, continues: true, ext: reply.ext });
        continue;
      }
      this.#queue.shift();
      if (head.kind === "upgrade") this.#upgradePending = false;
      if (reply.error !== undefined) {
        events.push({ type: "error", id: head.id, error: reply.error, parameters: reply.parameters, ext: reply.ext });
      } else if (head.kind === "upgrade") {
        let rest: Uint8Array;
        try {
          rest = this.#framer.takeRemainder();
        } catch (e) {
          return this.#closeWith(events, asProtocolError(e));
        }
        this.#state = "upgraded";
        this.#remainder = rest.length > 0 ? [rest] : [];
        events.push({ type: "upgraded", id: head.id, parameters: reply.parameters, ext: reply.ext });
        return events;
      } else {
        events.push({ type: "reply", id: head.id, parameters: reply.parameters, continues: false, ext: reply.ext });
      }
    }
  }

  /** The peer closed its side (EOF). Pending calls fail; a partial message is discarded. */
  receiveEnd(): ClientEvent[] {
    if (this.#state !== "open") return [];
    return this.#close([], new ConnectionClosedError("connection closed by peer"), undefined);
  }

  /** Local close. Pending calls fail with `cause` = `reason`. Idempotent: `[]` when already closed. */
  close(reason?: unknown): ClientEvent[] {
    if (this.#state === "closed") return [];
    const options = reason === undefined ? undefined : { cause: reason };
    return this.#close([], new ConnectionClosedError("connection closed", options), undefined);
  }

  /**
   * The bytes after the confirming reply of the upgrade call (received so far): they belong to the upgraded
   * protocol. Only in state `upgraded`, once.
   */
  takeUpgradeRemainder(): Uint8Array {
    if (this.#state !== "upgraded" || this.#remainder === null || this.#remainderTaken)
      throw new TypeError("no upgrade remainder: the session is not upgraded or it was taken already");
    this.#remainderTaken = true;
    const chunks = this.#remainder;
    this.#remainder = [];
    return concat(chunks);
  }

  #closeWith(events: ClientEvent[], error: ProtocolError): ClientEvent[] {
    return this.#close(events, new ConnectionClosedError("connection closed: protocol error", { cause: error }), error);
  }

  #close(events: ClientEvent[], failure: ConnectionClosedError, error: ProtocolError | undefined): ClientEvent[] {
    this.#state = "closed";
    this.#upgradePending = false;
    for (const entry of this.#queue.splice(0)) events.push({ type: "failed", id: entry.id, error: failure });
    events.push(error === undefined ? { type: "closed" } : { type: "closed", error });
    return events;
  }
}

/** The chunks joined into one array. */
export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1 && chunks[0] !== undefined) return chunks[0];
  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
