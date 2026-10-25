// Fault-injecting ByteChannel wrapper for tests (DESIGN.md §4.1, §4.10): split chunks, reset mid-message, delay.
import { ConnectionClosedError } from "../core/errors/local.ts";
import type { ByteChannel, FdHandle, ReadChunk } from "../core/protocol/channel.ts";

/** How a chunk is cut: at every byte, into pieces of at most n bytes, or at the offsets a function returns. */
export type SplitMode = "every-byte" | number | ((chunk: Uint8Array) => readonly number[]);

/** What {@link faulty} does to a channel. */
export interface FaultPlan {
  /**
   * Split every chunk read from the inner channel: "every-byte", a max chunk size, or a function returning cut
   * offsets for a chunk. Applies to reads (what this side receives).
   */
  splitReads?: SplitMode;
  /** Same for writes (what this side sends). */
  splitWrites?: SplitMode;
  /**
   * After this many bytes were read in total, the next read rejects with a ConnectionClosedError("connection reset
   * (faulty)") and the inner channel is closed (simulated RST mid-message).
   */
  resetAfterReadBytes?: number;
  /**
   * Same for writes: bytes beyond the limit are not written, write() rejects, the inner channel is closed, and
   * every later write() rejects too.
   */
  resetAfterWriteBytes?: number;
  /** Await this before every read and write (e.g. `() => new Promise(r => setTimeout(r, 1))` in tests). */
  delay?: () => Promise<void>;
}

function checkSplit(mode: SplitMode | undefined, name: string): void {
  if (mode === undefined || mode === "every-byte" || typeof mode === "function") return;
  if (typeof mode !== "number" || !Number.isSafeInteger(mode) || mode <= 0)
    throw new RangeError(`${name} must be "every-byte", a positive integer or a function`);
}

function checkLimit(limit: number | undefined, name: string): void {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
    throw new RangeError(`${name} must be a non-negative integer`);
}

/** `chunk` cut into pieces per `mode` (no empty pieces). */
function split(chunk: Uint8Array, mode: SplitMode | undefined): Uint8Array[] {
  if (mode === undefined || chunk.length <= 1) return [chunk];
  let cuts: number[];
  if (mode === "every-byte") {
    cuts = Array.from({ length: chunk.length - 1 }, (_, i) => i + 1);
  } else if (typeof mode === "number") {
    cuts = [];
    for (let i = mode; i < chunk.length; i += mode) cuts.push(i);
  } else {
    cuts = [...new Set(mode(chunk))].filter((c) => Number.isInteger(c) && c > 0 && c < chunk.length);
    cuts.sort((x, y) => x - y);
  }
  const pieces: Uint8Array[] = [];
  let start = 0;
  for (const cut of cuts) {
    pieces.push(chunk.subarray(start, cut));
    start = cut;
  }
  pieces.push(chunk.subarray(start));
  return pieces;
}

function resetError(): ConnectionClosedError {
  return new ConnectionClosedError("connection reset (faulty)");
}

/**
 * Wraps `channel` with the faults in `plan`. `closed`, `close` and `capabilities` delegate to the inner channel;
 * `end` too, but only after the writes before it settled (a real socket flushes them before its FIN): its promise
 * resolves only once those queued writes settled, so unlike `pair().end()` it waits on their backpressure (await
 * it only while the peer is reading). fds of a
 * split chunk go with its first piece. Concurrent writes are serialized: each starts after the previous one
 * settled, so they arrive in call order and never interleave. `close()` is immediate: from then on `read()` gives
 * `null` (also a read waiting for its delay; split pieces not yet delivered are dropped) and every write still
 * queued or made later rejects, also a zero-length one.
 */
export function faulty(channel: ByteChannel, plan: FaultPlan): ByteChannel {
  checkSplit(plan.splitReads, "splitReads");
  checkSplit(plan.splitWrites, "splitWrites");
  checkLimit(plan.resetAfterReadBytes, "resetAfterReadBytes");
  checkLimit(plan.resetAfterWriteBytes, "resetAfterWriteBytes");
  const pending: ReadChunk[] = [];
  let readBytes = 0;
  let writtenBytes = 0;
  let readReset = false;
  /** A write hit resetAfterWriteBytes: every later write rejects (also zero-length ones). */
  let writeReset = false;
  /** close() was called (with this reason). */
  let closed = false;
  let closeReason: unknown;

  async function read(): Promise<ReadChunk | null> {
    if (closed) return null;
    if (plan.delay !== undefined) {
      await plan.delay();
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- close() may run during the await
      if (closed) return null;
    }
    const limit = plan.resetAfterReadBytes;
    if (readReset || (limit !== undefined && readBytes >= limit)) {
      readReset = true;
      channel.close(resetError());
      throw resetError();
    }
    let next = pending.shift();
    if (next === undefined) {
      const chunk = await channel.read();
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- close() may run during the await
      if (chunk === null || closed) return null;
      const pieces = split(chunk.bytes, plan.splitReads);
      pieces.forEach((bytes, i) => {
        pending.push(i === 0 && chunk.fds !== undefined ? { bytes, fds: chunk.fds } : { bytes });
      });
      next = pending.shift();
      if (next === undefined) return { bytes: new Uint8Array(0) };
    }
    if (limit !== undefined && readBytes + next.bytes.length > limit) {
      // Deliver up to the limit; the next read is the reset.
      const keep = limit - readBytes;
      next =
        next.fds !== undefined
          ? { bytes: next.bytes.subarray(0, keep), fds: next.fds }
          : { bytes: next.bytes.subarray(0, keep) };
      pending.length = 0;
    }
    readBytes += next.bytes.length;
    return next;
  }

  // Writes run one after another (each starts once the previous one settled), so concurrent writes reach the
  // inner channel whole and in call order, whatever the split or the delay.
  let writeChain: Promise<void> = Promise.resolve();

  function write(chunk: Uint8Array, fds?: readonly FdHandle[]): Promise<void> {
    const run = writeChain.then(() => writeNow(chunk, fds));
    writeChain = run.catch(() => undefined);
    return run;
  }

  async function writeNow(chunk: Uint8Array, fds?: readonly FdHandle[]): Promise<void> {
    if (plan.delay !== undefined) await plan.delay();
    if (closed)
      throw new ConnectionClosedError("channel closed", closeReason === undefined ? undefined : { cause: closeReason });
    if (writeReset) throw resetError();
    const limit = plan.resetAfterWriteBytes;
    const pieces = split(chunk, plan.splitWrites);
    for (let i = 0; i < pieces.length; i++) {
      let piece = pieces[i] ?? new Uint8Array(0);
      const pieceFds = i === 0 ? fds : undefined;
      let reset = false;
      if (limit !== undefined && writtenBytes + piece.length > limit) {
        piece = piece.subarray(0, limit - writtenBytes);
        reset = true;
      }
      if (piece.length > 0) {
        await (pieceFds === undefined ? channel.write(piece) : channel.write(piece, pieceFds));
        writtenBytes += piece.length;
      }
      if (reset) {
        writeReset = true;
        channel.close(resetError());
        throw resetError();
      }
    }
  }

  return {
    read,
    write,
    // After the writes before it settled; their failures do not prevent end().
    end: () => writeChain.then(() => channel.end()),
    close: (reason?: unknown) => {
      if (!closed) {
        closed = true;
        closeReason = reason;
        pending.length = 0;
      }
      channel.close(reason);
    },
    get closed() {
      return channel.closed;
    },
    get capabilities() {
      return channel.capabilities;
    },
  };
}
