// The transport interface (DESIGN.md §4.1): every transport is a ByteChannel. Types (and one constant) only.

/** A chunk read from a {@link ByteChannel}. */
export interface ReadChunk {
  readonly bytes: Uint8Array;
  /**
   * fds that arrived with the first byte of `bytes` (SCM_RIGHTS). Only on fd-capable channels whose input is
   * accepted ({@link FdPassing.setAcceptInput}). Owned by whoever read the chunk: close them or hand them on.
   */
  readonly fds?: FdHandle[];
  /**
   * `"truncated"`: fds came with this chunk but the kernel truncated the control data (MSG_CTRUNC, e.g. an LSM
   * refused some), and the channel closed what it got. Not a protocol error: the message goes on without fds (a
   * handler asking for one gets InvalidParameter), and the drivers report it (server `onError` "fds-dropped"), as
   * sd-varlink logs, drops and continues (json-stream.c:1308-1317). fds that come while input is not accepted are
   * dropped silently instead (json-stream.c:1318-1321 reads with plain recv(), the kernel discards them).
   */
  readonly fdError?: "truncated";
}

/** A bidirectional byte stream: pull-based reads, promise-returning writes (backpressure). */
export interface ByteChannel {
  /** Next chunk, or null on orderly EOF. Rejects on transport error. Never called concurrently. */
  read(): Promise<ReadChunk | null>;
  /**
   * Resolves when the chunk is handed to the OS (backpressure). Rejects if closed. `fds` are attached to the first
   * byte of `chunk`; callers pass one whole message per call when sending fds. The channel does not take ownership
   * of `fds` (it neither duplicates nor closes them): they must stay open until the promise settled.
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
    /** Peer credentials (M11), read once when the connection was made. */
    readonly peer?: () => PeerCredentials;
    /**
     * Called once when the connection is upgraded to another protocol (M9/M11): the native channel removes its
     * `user.varlink` xattr there (sd-varlink.c:1524-1527).
     */
    readonly upgraded?: () => void;
  };
}

/**
 * A file descriptor with an owner. Closing is the owner's job; received fds nobody claimed are closed when their
 * message is done.
 */
export interface FdHandle {
  readonly fd: number;
  /** Closes the fd (idempotent for the handles the library creates). */
  close(): void;
}

/** The kernel's per-message fd limit (SCM_MAX_FD); sd-varlink refuses more early too (sd-varlink.c:3268). */
export const SCM_MAX_FD = 253;

/** fd passing controls of an fd-capable channel. */
export interface FdPassing {
  /**
   * Receiving is opt-in (UAPI). Off by default: fds that arrive are closed silently and the message goes on without
   * them, as sd-varlink's plain recv() (json-stream.c:1318-1321). On: reads stop at message boundaries, so fds stay
   * with the message they were sent with (json-stream.c:1187-1227). SO_PASSRIGHTS (Linux ≥ 6.16) is left at the
   * kernel default (on), as sd-varlink leaves it unless the state changes (json-stream.c:691-692) and, for server
   * connections, unless SD_VARLINK_SERVER_FD_PASSING_INPUT_STRICT is set (sd-varlink.c:3347-3352): only a strict
   * channel (the native addon's `fdPassingInputStrict` listeners) sets it from this, making a sender's sendmsg with
   * fds fail with EPERM while input is off.
   */
  setAcceptInput(on: boolean): void;
  /** Sending is opt-in too: while off, `write()` with fds rejects (OperationNotSupportedError). Off by default. */
  setAllowOutput(on: boolean): void;
  /** A close-on-exec duplicate of `fd`, owned by the caller (so a message can carry it after the original closed). */
  duplicate(fd: number): FdHandle;
}

/** Credentials of the peer process (SO_PEERCRED / pidfd). */
export interface PeerCredentials {
  readonly uid: number;
  readonly gid: number;
  readonly pid: number;
  /**
   * SO_PEERPIDFD (Linux ≥ 6.5), fetched on first access; owned by the channel and closed with the connection. What
   * you get is a view: `close()` does nothing and `fd` is -1 once the connection closed it.
   */
  readonly pidfd?: FdHandle | undefined;
}

/** Accepted connections of a listening socket. */
export interface Listener extends AsyncIterable<ByteChannel> {
  /** Canonical varlink address, e.g. "unix:/run/x" or "tcp:127.0.0.1:41234". */
  readonly address: string;
  close(): Promise<void>;
}
