// Types of varlink-js-native (DESIGN.md §4.15). The socket API is low level: varlink-js/node builds its
// ByteChannel on it; applications pass the module to `connect(…, { native })` / `listen(…, { native })`.

/** Peer credentials of a unix socket: SO_PEERCRED (Linux) or getpeereid + LOCAL_PEERPID (macOS). */
export interface NativePeerCredentials {
  readonly uid: number;
  readonly gid: number;
  readonly pid: number;
}

/** An error from a system call: `code` is the errno name, `errno` its negative value (as Node reports them). */
export interface NativeErrnoError extends Error {
  readonly code: string;
  readonly errno: number;
  readonly syscall: string;
}

/**
 * A non-blocking unix stream socket polled by libuv. Callbacks are properties set by the user. While a read, a
 * write wait or a connect is pending the socket keeps the event loop alive (and itself from being collected); an
 * idle socket that becomes unreachable is closed by its finalizer.
 */
export interface NativeSocket {
  /**
   * One recvmsg's outcome, after {@link read}: an error, or `bytes` (null at EOF). `fds` only while fd input is
   * accepted ({@link setAcceptFds}; the read then ends at the next NUL, so fds stay with their message); otherwise
   * fds that arrived were closed silently. `truncated`: MSG_CTRUNC (or fds that could not be handed over), every fd
   * received was closed and the bytes are delivered anyway.
   */
  onread:
    | ((
        error: NativeErrnoError | null,
        bytes: Uint8Array | null | undefined,
        fds: number[] | undefined,
        truncated: boolean | undefined,
      ) => void)
    | undefined;
  /** After {@link wantWrite}: the socket is writable (or polling failed). */
  onwritable: ((error: NativeErrnoError | null) => void) | undefined;
  /** A pending connect finished ({@link isConnecting} was true). */
  onconnect: ((error: NativeErrnoError | null) => void) | undefined;
  /** Arms one recvmsg; the result comes through {@link onread}. */
  read(): void;
  /** {@link onwritable} once the socket is writable. */
  wantWrite(): void;
  /**
   * sendmsg (MSG_NOSIGNAL): bytes written, or -1 when the socket buffer is full (call {@link wantWrite}). `fds`
   * (at most 253; more is ENOBUFS) ride with the first byte; pass them only with a message's first part. The fds
   * are not closed: the kernel duplicates them into the message.
   */
  send(bytes: Uint8Array, fds?: readonly number[]): number;
  /** shutdown(SHUT_WR). */
  shutdownWrite(): void;
  /** Stops polling and closes the fd (idempotent). */
  close(): void;
  /** A connect is pending (EINPROGRESS); {@link onconnect} reports its end. */
  isConnecting(): boolean;
  /** The socket's fd (-1 once closed). Do not close it. */
  getFd(): number;
  /**
   * Deliver received fds (else close them silently). Off by default. `passRights` (strict mode): also set
   * SO_PASSRIGHTS (Linux ≥ 6.16) to `on`: always on the first such call (the value may be inherited from the listening
   * socket), later only if it changes; otherwise the socket keeps the kernel default (on).
   */
  setAcceptFds(on: boolean, passRights?: boolean): void;
  /** Test hook: the recvmsg control buffer's capacity in fds (0-253; default 253). */
  setControlBufferFds(n: number): void;
  peerCred(): NativePeerCredentials;
  /**
   * A new close-on-exec pidfd of the peer (SO_PEERPIDFD, Linux ≥ 6.5) that the caller owns (close it any way), or
   * null. `track` is for varlink-js (see {@link dup}).
   */
  peerPidfd(track?: boolean): number | null;
  ref(): void;
  unref(): void;
}

/** Why the addon did not load, or undefined if it did. */
export declare const loadError: Error | undefined;
/** Whether the addon loaded (Node on Linux, or macOS for development, after `npm run build`). */
export declare function isAvailable(): boolean;
/** The kernel's per-message fd limit (SCM_MAX_FD). */
export declare const SCM_MAX_FD: number;
/**
 * A socket connected (or connecting) to the unix address `address`: the sun_path bytes, a leading NUL for an
 * abstract name. Errors (ENOENT, ECONNREFUSED, EAGAIN for a full backlog, …) throw.
 */
export declare function connect(address: Uint8Array): NativeSocket;
/** A socket over a close-on-exec, non-blocking duplicate of the socket `fd`; the caller keeps `fd`. */
export declare function adopt(fd: number): NativeSocket;
/**
 * A close-on-exec duplicate of `fd` (≥ 3) that the caller owns: close it any way (`fs.closeSync` too). `track` is for
 * varlink-js, for the fds it holds itself (like the fds it receives): tracked as held by this environment until
 * {@link close}d or {@link release}d, and closed when the environment (e.g. a worker) tears down, but only if the
 * number still looks like the same file (best effort: same st_dev/st_ino, file type and access mode), so a number
 * closed otherwise and reused is left alone when it can be told apart. It cannot be told apart when the reused number
 * names the same inode (a dup of the tracked file, or another open of it with the same access mode); on Linux an fd on
 * the shared anon inode (eventfd, epoll, timerfd, signalfd, inotify, pidfds before 6.9) is closed at teardown only if
 * it was tracked as a pidfd of a pid > 0 and /proc still shows a pidfd of the same pid; other anon-inode fds are left open.
 */
export declare function dup(fd: number, track?: boolean): number;
/** close(fd), forgetting it if tracked; EBADF throws. */
export declare function close(fd: number): void;
/** Stops tracking `fd` (handed to an owner who closes it); whether it was tracked. */
export declare function release(fd: number): boolean;
/**
 * Test hook, of this environment: tracked fds; bounded reads that stopped at a NUL with more queued; bounded reads
 * whose peek window was widened; SO_PASSRIGHTS setsockopt attempts of strict `setAcceptFds` calls; which fd type
 * identified the anon inode (Linux: `"eventfd"`, `"epoll"` if eventfd failed, `"none"` if both failed and teardown
 * then closes nothing; `"unsupported"` elsewhere). Process-wide: tracked fds environment teardowns left open.
 */
export declare function stats(): {
  trackedFds: number;
  boundedCuts: number;
  peekWidenings: number;
  passRightsCalls: number;
  anonProbe: "eventfd" | "epoll" | "none" | "unsupported";
  teardownSkipped: number;
};
/** Sets FD_CLOEXEC on `fd`. */
export declare function setCloexec(fd: number): void;
/** Whether `fd` is an AF_UNIX socket. */
export declare function isUnixSocket(fd: number): boolean;
/**
 * SO_PASSRIGHTS on `fd` (e.g. a listening socket, inherited by accepted ones): whether this kernel has the option
 * (Linux ≥ 6.16; then it was set). Off makes a peer's sendmsg with fds fail with EPERM.
 */
export declare function setPassRights(fd: number, on: boolean): boolean;
/** A close-on-exec pipe: `[readFd, writeFd]`. */
export declare function pipe(): [number, number];
/** `user.varlink` = `value` on socket `fd` (Linux; elsewhere ENOTSUP). */
export declare function setXattr(fd: number, value: string): void;
/** Removes `user.varlink` from socket `fd` (absent is fine; Linux). */
export declare function removeXattr(fd: number): void;
/** `user.varlink` = `value` on the file at `path` (Linux). */
export declare function setPathXattr(path: string, value: string): void;
/** A sealed, read-only memfd holding `bytes`, at offset 0 (Linux; elsewhere ENOSYS). */
export declare function memfdSealed(name: string, bytes: Uint8Array): number;
/** Test hook: a close-on-exec eventfd (Linux; elsewhere ENOSYS). */
export declare function eventfd(): number;
/** Test hook: a close-on-exec pidfd of process `pid` (pidfd_open, Linux ≥ 5.3; elsewhere ENOSYS). */
export declare function pidfdOpen(pid: number): number;
