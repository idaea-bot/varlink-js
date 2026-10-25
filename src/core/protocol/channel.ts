// The transport interface (DESIGN.md §4.1): every transport is a ByteChannel. Types only.

/** A chunk read from a {@link ByteChannel}. */
export interface ReadChunk {
  readonly bytes: Uint8Array;
  /** fds that arrived with the first byte of `bytes` (SCM_RIGHTS). Only on fd-capable channels. */
  readonly fds?: FdHandle[];
}

/** A bidirectional byte stream: pull-based reads, promise-returning writes (backpressure). */
export interface ByteChannel {
  /** Next chunk, or null on orderly EOF. Rejects on transport error. Never called concurrently. */
  read(): Promise<ReadChunk | null>;
  /**
   * Resolves when the chunk is handed to the OS (backpressure). Rejects if closed. `fds` are attached to the first
   * byte of `chunk`; callers pass one whole message per call when sending fds.
   */
  write(chunk: Uint8Array, fds?: readonly FdHandle[]): Promise<void>;
  /** Half-close our side if supported, else close. */
  end(): Promise<void>;
  /** Hard close, idempotent. Pending read() resolves null / write() rejects. */
  close(reason?: unknown): void;
  /** Settles once, when the channel is fully closed (never rejects). */
  readonly closed: Promise<void>;
  /** Optional capabilities. Absent ⇒ not supported on this transport. */
  readonly capabilities: {
    /** fd passing (M11). */
    readonly fdPassing?: FdPassing;
    /** Peer credentials (M11). */
    readonly peer?: () => PeerCredentials;
  };
}

/** Owned file descriptor. Closing is the owner's job; unclaimed fds are closed when their message is done. */
export interface FdHandle {
  readonly fd: number;
  close(): void;
}

/** fd passing controls of an fd-capable channel. */
export interface FdPassing {
  /**
   * Receiving is opt-in (UAPI). Off by default; when off, SO_PASSRIGHTS is cleared where the kernel supports it
   * (Linux ≥ 6.16) and any fds that still arrive are closed and the message rejected (protocol error).
   */
  setAcceptInput(on: boolean): void;
  setAllowOutput(on: boolean): void;
}

/** Credentials of the peer process (SO_PEERCRED / pidfd). */
export interface PeerCredentials {
  readonly uid: number;
  readonly gid: number;
  readonly pid: number;
  readonly pidfd?: FdHandle;
}

/** Accepted connections of a listening socket. */
export interface Listener extends AsyncIterable<ByteChannel> {
  /** Canonical varlink address, e.g. "unix:/run/x" or "tcp:127.0.0.1:41234". */
  readonly address: string;
  close(): Promise<void>;
}
