// The upgraded channel of a protocol upgrade (DESIGN.md §4.2, §5.6): the connection's transport, handed over after
// the confirming reply, which first yields the bytes the framer had already read past the varlink part.
import type { ByteChannel, FdHandle, ReadChunk } from "../core/protocol/channel.ts";
import { closeFds } from "../core/protocol/framer.ts";

/** What `conn.upgrade()` resolves with. */
export interface UpgradeResult<T = Record<string, unknown>> {
  /** The confirming reply's parameters. */
  readonly parameters: T;
  /**
   * The connection's transport, now carrying the upgraded protocol: it first yields any bytes that arrived after the
   * confirming reply (also in the same chunk), then reads from the transport. It owns the transport: close or end it
   * when done (the Connection is finished and its `close()` leaves the channel alone).
   */
  readonly channel: ByteChannel;
}

/** Where the reads of an {@link UpgradedChannel} continue after its buffered head. */
export interface UpgradeTail {
  /** A read of the transport started by the previous owner and not yet settled: its outcome is the next read's. */
  readonly pending?: Promise<ReadChunk | null> | undefined;
  /** The previous owner already read the end of the stream (`error` = that read rejected). */
  readonly ended?: { readonly error?: unknown } | undefined;
}

/** A chunk without fds (the upgraded stream is bytes only): any that came are closed. */
function bytesOnly(chunk: ReadChunk | null): ReadChunk | null {
  if (chunk === null || (chunk.fds === undefined && chunk.fdError === undefined)) return chunk;
  closeFds(chunk.fds);
  return { bytes: chunk.bytes };
}

/**
 * The §4.1 contract over `inner`: reads give `head` first (if not empty), then `tail.pending`'s outcome or
 * `tail.ended`, then the transport's own reads; writes, `end()` (half-close), `close()` and `closed` are the
 * transport's, so its backpressure applies and nothing is buffered beyond `head`. The upgraded stream is bytes only
 * (M11): fd input is switched off on the transport, fds that still arrive are closed, writes with fds reject, and
 * `capabilities` keeps only `peer` (the transport's own object where it has no fd passing). Constructing it calls the transport's `capabilities.upgraded` hook (the native channel removes its
 * `user.varlink` xattr, as sd-varlink.c:1524-1527 does).
 */
export class UpgradedChannel implements ByteChannel {
  readonly #inner: ByteChannel;
  readonly capabilities: ByteChannel["capabilities"];
  #head: Uint8Array | undefined;
  #pending: Promise<ReadChunk | null> | undefined;
  #ended: { readonly error?: unknown } | undefined;
  #closed = false;

  constructor(inner: ByteChannel, head: Uint8Array, tail?: UpgradeTail) {
    this.#inner = inner;
    this.#head = head.length > 0 ? head : undefined;
    this.#pending = tail?.pending;
    this.#ended = tail?.ended;
    const caps = inner.capabilities;
    try {
      caps.fdPassing?.setAcceptInput(false);
      caps.upgraded?.();
    } catch {
      // Best effort (the transport may be closed already).
    }
    // Nothing to take away (every transport but the native one): the transport's own object.
    if (caps.fdPassing === undefined && caps.upgraded === undefined) this.capabilities = caps;
    else this.capabilities = caps.peer === undefined ? {} : { peer: caps.peer };
  }

  get closed(): Promise<void> {
    return this.#inner.closed;
  }

  read(): Promise<ReadChunk | null> {
    if (this.#closed) return Promise.resolve(null);
    const head = this.#head;
    if (head !== undefined) {
      this.#head = undefined;
      return Promise.resolve({ bytes: head });
    }
    const pending = this.#pending;
    if (pending !== undefined) {
      this.#pending = undefined;
      // A close() meanwhile turns the outcome into the end of the stream, as for the transport's own reads.
      return pending.then(
        (chunk) => {
          if (!this.#closed) return bytesOnly(chunk);
          closeFds(chunk?.fds);
          return null;
        },
        (e: unknown) => {
          if (this.#closed) return null;
          throw e;
        },
      );
    }
    const ended = this.#ended;
    if (ended !== undefined) {
      if ("error" in ended) {
        // Reported once, then the end of the stream (like the transports).
        this.#ended = {};
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the transport's error as is
        return Promise.reject(ended.error);
      }
      return Promise.resolve(null);
    }
    return this.#inner.read().then(bytesOnly);
  }

  write(chunk: Uint8Array, fds?: readonly FdHandle[]): Promise<void> {
    if (fds !== undefined && fds.length > 0)
      return Promise.reject(new TypeError("an upgraded channel carries bytes only (no fds)"));
    return this.#inner.write(chunk);
  }

  end(): Promise<void> {
    return this.#inner.end();
  }

  close(reason?: unknown): void {
    this.#closed = true;
    this.#head = undefined;
    this.#inner.close(reason);
  }
}
