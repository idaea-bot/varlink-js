// The varlink-js-native integration (DESIGN.md §4.15): the addon is injected (`connect(address, { native })`,
// `listen(address, { native })`, `listenFromEnv({ native })`), never imported here. This module defines what
// src/node needs from it and builds the fd-capable ByteChannel over its sockets.
import { closeSync } from "node:fs";
import type { Socket } from "node:net";
import type { AddressSpec } from "../core/address/parse.ts";
import { CallTimeoutError, ConnectionClosedError, OperationNotSupportedError } from "../core/errors/local.ts";
import {
  SCM_MAX_FD,
  type ByteChannel,
  type FdHandle,
  type FdPassing,
  type PeerCredentials,
  type ReadChunk,
} from "../core/protocol/channel.ts";
import { fdNumber } from "../core/protocol/dispatch.ts";
import { closeFds } from "../core/protocol/framer.ts";

/** An error from the addon: `code` is the errno name. */
export interface NativeErrnoError extends Error {
  readonly code: string;
  /** The negative errno, as Node reports it. */
  readonly errno: number;
  readonly syscall: string;
}

/** A socket of the addon (see varlink-js-native's `index.d.ts`). */
export interface NativeSocket {
  onread:
    | ((
        error: NativeErrnoError | null,
        bytes: Uint8Array | null | undefined,
        fds: number[] | undefined,
        truncated: boolean | undefined,
      ) => void)
    | undefined;
  onwritable: ((error: NativeErrnoError | null) => void) | undefined;
  onconnect: ((error: NativeErrnoError | null) => void) | undefined;
  read(): void;
  wantWrite(): void;
  send(bytes: Uint8Array, fds?: readonly number[]): number;
  shutdownWrite(): void;
  close(): void;
  isConnecting(): boolean;
  getFd(): number;
  /** `passRights`: also SO_PASSRIGHTS, if that changes it (strict mode only). */
  setAcceptFds(on: boolean, passRights?: boolean): void;
  peerCred(): { readonly uid: number; readonly gid: number; readonly pid: number };
  /** A new pidfd of the peer that the caller owns (SO_PEERPIDFD), or null; `track`: closed at environment teardown. */
  peerPidfd(track?: boolean): number | null;
}

/**
 * What varlink-js/node needs from the optional `varlink-js-native` addon (Linux; macOS for development). Pass the
 * module itself: `import * as native from "varlink-js-native"`. When `isAvailable()` is false (not built, Bun, Deno)
 * it is ignored: connections are plain Node sockets without fd passing or peer credentials.
 */
export interface NativeAddon {
  isAvailable(): boolean;
  connect(address: Uint8Array): NativeSocket;
  adopt(fd: number): NativeSocket;
  /** A close-on-exec duplicate; `track`: held by the library, closed at environment teardown unless closed or released. */
  dup(fd: number, track?: boolean): number;
  close(fd: number): void;
  setCloexec(fd: number): void;
  isUnixSocket(fd: number): boolean;
  /** SO_PASSRIGHTS on a (listening) socket; false where the kernel has no such option (before Linux 6.16). */
  setPassRights(fd: number, on: boolean): boolean;
  /** Stops tracking an fd handed to a user (so environment teardown does not close it). */
  release?(fd: number): boolean;
  setXattr(fd: number, value: string): void;
  removeXattr(fd: number): void;
  setPathXattr(path: string, value: string): void;
  /** A sealed read-only memfd holding `bytes` (Linux; `call --exec`'s stdin). */
  memfdSealed?(name: string, bytes: Uint8Array): number;
}

/** `native` if it can be used here, else undefined. @throws {TypeError} for something that is not an addon. */
export function usableNative(native: unknown): NativeAddon | undefined {
  if (native === undefined) return undefined;
  if (typeof native !== "object" || native === null || typeof (native as NativeAddon).isAvailable !== "function")
    throw new TypeError("native must be the varlink-js-native module");
  return (native as NativeAddon).isAvailable() ? (native as NativeAddon) : undefined;
}

/** Best effort: the `user.varlink` xattr is advisory (sd-varlink ignores failures too, sd-varlink.c:165-190). */
function quietly(fn: () => void): void {
  try {
    fn();
  } catch {
    // EOPNOTSUPP (sockfs without user xattrs), EPERM, ENOTSUP (macOS), …: nothing to do.
  }
}

/** An fd the library owns, closed through the addon (idempotent). */
class NativeFd implements FdHandle {
  readonly fd: number;
  readonly #native: NativeAddon;
  #closed = false;

  constructor(fd: number, native: NativeAddon) {
    this.fd = fd;
    this.#native = native;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#native.close(this.fd);
    } catch {
      // EBADF: someone closed it behind our back; nothing left to release.
    }
  }

  /**
   * The fd goes to a user (`takeFd`, an `acceptFds` reply): the addon stops tracking it, so tearing down this
   * environment (a terminated worker) does not close it under its new owner (`handOver` in the core framer).
   */
  handOver(): void {
    if (!this.#closed) this.#native.release?.(this.fd);
  }
}

/**
 * An FdHandle over a raw fd number that the caller owns; `close()` closes it (`fs.closeSync`, idempotent). A Node
 * `fs.FileHandle` is an FdHandle already (`fd` and `close()`).
 */
export function fdHandle(fd: number): FdHandle {
  const n = fdNumber(fd);
  let closed = false;
  return {
    fd: n,
    close: () => {
      if (closed) return;
      closed = true;
      closeSync(n);
    },
  };
}

/**
 * A sendmsg with SCM_RIGHTS that failed with EPERM: Linux ≥ 6.16 refuses fds for a socket whose receiver has
 * SO_PASSRIGHTS off (it does not accept fds). Reported as an OperationNotSupportedError (`code` "EPERM", the errno
 * error as `cause`); like any write error it ends the connection's writes, as sd-varlink's json_stream_write returns
 * the errno (json-stream.c:1151-1161) and sd_varlink_process then disconnects (sd-varlink.c:1610-1614, 1675-1678).
 */
function fdsRefused(error: unknown): unknown {
  if ((error as { code?: unknown } | null)?.code !== "EPERM") return error;
  return Object.assign(
    new OperationNotSupportedError(
      "the peer does not accept file descriptors (sendmsg with SCM_RIGHTS: EPERM, its SO_PASSRIGHTS is off)",
      { cause: error },
    ),
    { code: "EPERM" },
  );
}

interface QueuedWrite {
  readonly bytes: Uint8Array;
  offset: number;
  readonly fds: readonly number[] | undefined;
  resolve(): void;
  reject(error: unknown): void;
}

/**
 * The fd-capable ByteChannel over an addon socket (DESIGN.md §4.15). Same contract as `fromNodeSocket` (§4.11):
 * reads one recvmsg at a time (the kernel's buffer is the backpressure); data before an error or EOF is delivered
 * first; a write error (EPIPE, ECONNRESET, …: no SIGPIPE) rejects that write and every later one but reads go on to
 * the peer's EOF or error; `end()` = shutdown(SHUT_WR) once queued writes went out; `close()` idempotent. Once the
 * peer's EOF (or a read error) was read and our side is ended (or failed), the channel closes on its own, like a
 * half-open Node socket. fds: `ReadChunk.fds` while input is accepted, `fdError` otherwise; `write(chunk, fds)` sends
 * them with the chunk's first byte (once, also over partial writes) while output is allowed.
 */
class NativeChannel implements ByteChannel {
  readonly capabilities: ByteChannel["capabilities"];
  readonly closed: Promise<void>;
  readonly #native: NativeAddon;
  readonly #sock: NativeSocket;
  readonly #queue: QueuedWrite[] = [];
  /** The peer's pidfd, fetched on first use (undefined: not yet; null: none), owned and closed by the channel. */
  #pidfd: NativeFd | null | undefined;
  #resolveClosed: () => void = () => undefined;
  #reader: { resolve(chunk: ReadChunk | null): void; reject(error: unknown): void } | undefined;
  #eof = false;
  #readFailed = false;
  #done = false;
  #writeShut = false;
  #writeError: { value: unknown } | undefined;
  #waitingWritable = false;
  #ending: Promise<void> | undefined;
  #resolveEnd: (() => void) | undefined;
  #ended = false;
  #allowOutput = false;

  /**
   * `strict` (server connections of a `fdPassingInputStrict` listener): setAcceptInput also sets SO_PASSRIGHTS, like
   * sd-varlink's per-connection setsockopt with SD_VARLINK_SERVER_FD_PASSING_INPUT_STRICT (sd-varlink.c:3347-3352,
   * applied at 3612); the first such call always sets it (the value may come from the listening socket). Otherwise
   * SO_PASSRIGHTS is never touched: the socket keeps the kernel default (on), and fds that come while input is off are
   * dropped by the read path (sd-varlink's plain recv(), json-stream.c:1318-1321), so a peer's sendmsg with fds never
   * fails with EPERM because of us. For clients this differs from sd-varlink, whose client connections always use the
   * setsockopt when input changes (`with_sockopt = !v->server || …STRICT`, sd-varlink.c:3347-3352): an sd-varlink client
   * that switches input off after having it on makes a later reply with fds fail the server's write (EPERM). Ours
   * switches input per call (`acceptFds`) and stays permissive: a reply's fds are dropped silently, no peer EPERM.
   */
  constructor(native: NativeAddon, sock: NativeSocket, role: "client" | "server", strict = false) {
    this.#native = native;
    this.#sock = sock;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    sock.onread = (error, bytes, fds, truncated) => {
      this.#onRead(error, bytes, fds, truncated === true);
    };
    sock.onwritable = (error) => {
      this.#onWritable(error);
    };
    // Read once, now; a failure is kept and rethrown by capabilities.peer(), so a server that needs the credentials
    // (the per-UID limit) refuses the connection, as sd-varlink does (sd-varlink.c:3568-3570).
    let peer: PeerCredentials | undefined;
    let peerError: unknown;
    try {
      const cred = sock.peerCred();
      const pidfd = (): FdHandle | undefined => this.#pidfdView();
      peer = {
        uid: cred.uid,
        gid: cred.gid,
        pid: cred.pid,
        get pidfd() {
          return pidfd();
        },
      };
    } catch (e) {
      peerError = e;
    }
    const fd = sock.getFd();
    // sd-varlink marks connection sockets "client" (connect) and "server" (accept): sd-varlink.c:230, 3685.
    quietly(() => {
      native.setXattr(fd, role);
    });
    // fd input is opt-in (UAPI) and starts off in the addon (fds that arrive are dropped). SO_PASSRIGHTS is left alone
    // here: json_stream_set_allow_fd_passing_input returns early when the state does not change (json-stream.c:691-692).
    const fdPassing: FdPassing = {
      setAcceptInput: (on) => {
        if (!this.#done) sock.setAcceptFds(on, strict);
      },
      setAllowOutput: (on) => {
        this.#allowOutput = on;
      },
      // Tracked: the library holds it (closed with the message it rides on, or at environment teardown).
      duplicate: (n) => new NativeFd(native.dup(fdNumber(n), true), native),
    };
    const caps: { fdPassing: FdPassing; peer?: () => PeerCredentials; upgraded: () => void } = {
      fdPassing,
      // An upgraded connection is no varlink socket any more (sd-varlink.c:1524-1527).
      upgraded: () => {
        if (!this.#done)
          quietly(() => {
            native.removeXattr(fd);
          });
      },
    };
    if (peer !== undefined) caps.peer = () => peer;
    else
      caps.peer = () => {
        throw peerError;
      };
    this.capabilities = caps;
  }

  /**
   * The peer's pidfd as handed to users (DESIGN.md §4.1): fetched on first access (SO_PEERPIDFD keeps naming the
   * process that connected), owned by the channel and closed with it. The handle given out has a no-op `close()`
   * and reports `fd` -1 once the channel closed it, so a user can neither close our fd nor keep using a number that
   * may have been reused.
   */
  #pidfdView(): FdHandle | undefined {
    if (this.#pidfd === undefined) {
      if (this.#done) return undefined;
      try {
        const n = this.#sock.peerPidfd(true);
        this.#pidfd = n === null ? null : new NativeFd(n, this.#native);
      } catch {
        this.#pidfd = null;
      }
    }
    const owned = this.#pidfd;
    if (owned === null) return undefined;
    return {
      get fd() {
        return owned.isClosed ? -1 : owned.fd;
      },
      close: () => undefined,
    };
  }

  read(): Promise<ReadChunk | null> {
    if (this.#reader !== undefined) return Promise.reject(new TypeError("read() called concurrently"));
    if (this.#done || this.#eof || this.#readFailed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.#reader = { resolve, reject };
      try {
        this.#sock.read();
      } catch (e) {
        this.#reader = undefined;
        this.#readFailed = true;
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the addon's error as is
        reject(e);
      }
    });
  }

  #onRead(
    error: NativeErrnoError | null,
    bytes: Uint8Array | null | undefined,
    fds: number[] | undefined,
    truncated: boolean,
  ): void {
    const handles = fds?.map((fd) => new NativeFd(fd, this.#native));
    const reader = this.#reader;
    this.#reader = undefined;
    if (this.#done || reader === undefined) {
      closeFds(handles);
      return;
    }
    if (error !== null) {
      this.#readFailed = true;
      reader.reject(error);
      this.#maybeAutoClose();
      return;
    }
    if (bytes === null || bytes === undefined) {
      this.#eof = true;
      reader.resolve(null);
      this.#maybeAutoClose();
      return;
    }
    const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (truncated) reader.resolve({ bytes: view, fdError: "truncated" });
    else if (handles !== undefined && handles.length > 0) reader.resolve({ bytes: view, fds: handles });
    else reader.resolve({ bytes: view });
  }

  write(chunk: Uint8Array, fds?: readonly FdHandle[]): Promise<void> {
    if (this.#writeError !== undefined)
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the socket's error as is
      return Promise.reject(this.#writeError.value);
    if (this.#writeShut || this.#done) return Promise.reject(new ConnectionClosedError("the socket is closed"));
    let numbers: number[] | undefined;
    if (fds !== undefined && fds.length > 0) {
      if (!this.#allowOutput)
        return Promise.reject(new OperationNotSupportedError("fd passing output is not enabled on this connection"));
      if (fds.length > SCM_MAX_FD)
        return Promise.reject(new RangeError(`at most ${String(SCM_MAX_FD)} fds per message (SCM_MAX_FD)`));
      if (chunk.length === 0) return Promise.reject(new TypeError("fds need at least one byte to ride on"));
      try {
        numbers = fds.map((f) => fdNumber(f));
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new TypeError("invalid fd"));
      }
    }
    return new Promise((resolve, reject) => {
      this.#queue.push({ bytes: chunk, offset: 0, fds: numbers, resolve, reject });
      this.#flush();
    });
  }

  /** Writes queued chunks until done or the socket buffer is full (then waits for writability). */
  #flush(): void {
    if (this.#waitingWritable || this.#done) return;
    for (;;) {
      const w = this.#queue[0];
      if (w === undefined) break;
      while (w.offset < w.bytes.length) {
        let n: number;
        try {
          // The fds go with the first byte only; a partial first write already carried them.
          n = w.offset === 0 ? this.#sock.send(w.bytes, w.fds) : this.#sock.send(w.bytes.subarray(w.offset));
        } catch (e) {
          this.#failWrites(w.offset === 0 && w.fds !== undefined && w.fds.length > 0 ? fdsRefused(e) : e);
          return;
        }
        if (n < 0) {
          this.#waitingWritable = true;
          try {
            this.#sock.wantWrite();
          } catch (e) {
            this.#waitingWritable = false;
            this.#failWrites(e);
          }
          return;
        }
        w.offset += n;
      }
      this.#queue.shift();
      w.resolve();
    }
    this.#maybeShutdown();
  }

  #onWritable(error: NativeErrnoError | null): void {
    this.#waitingWritable = false;
    if (this.#done) return;
    if (error !== null) this.#failWrites(error);
    else this.#flush();
  }

  /** A write failed: it and every later write reject with the error; reading goes on (the peer's data stays). */
  #failWrites(error: unknown): void {
    this.#writeError ??= { value: error };
    this.#writeShut = true;
    for (const w of this.#queue.splice(0)) w.reject(this.#writeError.value);
    this.#maybeShutdown();
    this.#maybeAutoClose();
  }

  end(): Promise<void> {
    this.#writeShut = true;
    if (this.#done) return Promise.resolve();
    this.#ending ??= new Promise((resolve) => {
      this.#resolveEnd = resolve;
      this.#maybeShutdown();
    });
    return this.#ending;
  }

  /** `end()` once the queue is empty: shutdown(SHUT_WR) (skipped after a write error), then resolve. */
  #maybeShutdown(): void {
    const resolve = this.#resolveEnd;
    if (resolve === undefined || this.#queue.length > 0) return;
    this.#resolveEnd = undefined;
    if (this.#writeError === undefined && !this.#done)
      try {
        this.#sock.shutdownWrite();
      } catch {
        // ENOTCONN: the peer is gone; our side is over either way.
      }
    this.#ended = true;
    resolve();
    this.#maybeAutoClose();
  }

  /** Both directions are over (EOF or a read error, and ended or failed): close, like a half-open Node socket. */
  #maybeAutoClose(): void {
    if (
      (this.#eof || this.#readFailed) &&
      (this.#ended || this.#writeError !== undefined) &&
      this.#reader === undefined
    )
      this.close();
  }

  close(): void {
    if (this.#done) return;
    this.#done = true;
    this.#writeShut = true;
    const error = new ConnectionClosedError("the channel was closed");
    for (const w of this.#queue.splice(0)) w.reject(error);
    const resolveEnd = this.#resolveEnd;
    this.#resolveEnd = undefined;
    resolveEnd?.();
    const reader = this.#reader;
    this.#reader = undefined;
    reader?.resolve(null);
    this.#sock.close();
    this.#pidfd?.close();
    this.#pidfd = null;
    this.#resolveClosed();
  }
}

/** A ByteChannel over a connected addon socket (internal; exported for tests). */
export function nativeChannel(
  native: NativeAddon,
  sock: NativeSocket,
  role: "client" | "server",
  strict = false,
): ByteChannel {
  return new NativeChannel(native, sock, role, strict);
}

/** The sun_path bytes of a unix address (a leading NUL for an abstract name). */
function socketAddress(spec: AddressSpec): Uint8Array {
  if (spec.kind === "unix") return Buffer.from(spec.path);
  if (spec.kind === "unix-abstract") {
    if (process.platform !== "linux")
      throw new OperationNotSupportedError(`abstract unix sockets (unix:@) need Linux, not ${process.platform}`);
    return Buffer.from(`\0${spec.name}`);
  }
  throw new OperationNotSupportedError(`varlink-js-native connects unix sockets only, not ${spec.kind}`);
}

/**
 * Connects a unix socket through the addon (`connect()` with `native`); the connect phase is bounded by `timeout`
 * (ms, 0 = none) and `signal`, as for a Node socket. Errors (ENOENT, ECONNREFUSED, EAGAIN for a full backlog) reject.
 */
export function connectNative(
  native: NativeAddon,
  spec: AddressSpec,
  timeout: number,
  signal: AbortSignal | undefined,
): Promise<ByteChannel> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the abort reason as is
      reject(signal.reason);
      return;
    }
    let sock: NativeSocket;
    try {
      sock = native.connect(socketAddress(spec));
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the addon's error as is
      reject(e);
      return;
    }
    if (!sock.isConnecting()) {
      resolve(new NativeChannel(native, sock, "client"));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      sock.onconnect = undefined;
    };
    const fail = (error: unknown): void => {
      cleanup();
      sock.close();
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the error or abort reason as is
      reject(error);
    };
    const onAbort = (): void => {
      fail(signal?.reason);
    };
    sock.onconnect = (error) => {
      if (error !== null) {
        fail(error);
        return;
      }
      cleanup();
      resolve(new NativeChannel(native, sock, "client"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeout > 0)
      timer = setTimeout(() => {
        fail(new CallTimeoutError("connect timed out"));
      }, timeout);
  });
}

/**
 * The channel for a connection accepted by a Node server created with `pauseOnConnect` (nothing was read from it):
 * the addon takes a close-on-exec duplicate of its fd and the Node socket is destroyed (closing Node's copy only).
 *
 * @throws the addon's error (e.g. EMFILE) or a TypeError for a socket without an fd. The Node socket is destroyed
 *   then too: a listener with the addon never serves a connection without it (it would have no credentials and
 *   escape the per-UID limit; sd-varlink refuses a connection whose credentials it cannot get, sd-varlink.c:3568-3570).
 */
export function adoptAccepted(native: NativeAddon, socket: Socket, strict = false): ByteChannel {
  socket.on("error", () => undefined);
  try {
    const fd = (socket as unknown as { _handle?: { fd?: unknown } | null })._handle?.fd;
    if (typeof fd !== "number" || fd < 0) throw new TypeError("the accepted socket has no fd to take over");
    return new NativeChannel(native, native.adopt(fd), "server", strict);
  } finally {
    socket.destroy();
  }
}

/**
 * The channel over a connected socket fd we own (socket activation, `Accept=yes`): adopted by the addon, then the
 * original fd is closed. Undefined (nothing done, `fd` untouched) when `fd` is not a unix socket (a pipe, say).
 *
 * @throws the addon's error when a unix socket cannot be adopted; `fd` is closed then (the connection is refused, as
 *   for an accepted one: it is not served without the addon, M1), so `listenFromEnv` leaves no activation fd
 *   half-owned (the other listeners it opened are closed by its error path, as before).
 */
export function adoptFd(native: NativeAddon, fd: number, strict = false): ByteChannel | undefined {
  let unix: boolean;
  try {
    unix = native.isUnixSocket(fd);
  } catch {
    return undefined;
  }
  if (!unix) return undefined;
  let sock: NativeSocket;
  try {
    sock = native.adopt(fd);
  } finally {
    // Ours either way: the duplicate is what we use, or the connection is refused.
    try {
      native.close(fd);
    } catch {
      // Already gone.
    }
  }
  return new NativeChannel(native, sock, "server", strict);
}

/**
 * Sets up a listening socket for the addon: the best-effort `user.varlink` xattr ("listen") and, in strict mode only
 * (`fdPassingInputStrict`), SO_PASSRIGHTS = `allowFdInput` before anything is accepted (accepted sockets inherit it,
 * so no client can slip fds in before the server decided). sd-varlink touches the listening socket only with
 * SD_VARLINK_SERVER_FD_PASSING_INPUT_STRICT (sd-varlink.c:3787-3792, 3851-3853); by default the kernel default (on)
 * stays and a server without fd input drops fds that come with calls. A kernel without the option (before Linux
 * 6.16) ignores it.
 */
export function prepareListener(
  native: NativeAddon,
  fd: number | undefined,
  strict: { readonly allowFdInput: boolean } | undefined,
): void {
  if (fd === undefined) return;
  if (strict !== undefined)
    quietly(() => {
      native.setPassRights(fd, strict.allowFdInput);
    });
  // sd-varlink.c:3798, 3850 ("listen" on the socket).
  quietly(() => {
    native.setXattr(fd, "listen");
  });
}

/** Best-effort `user.varlink` = "entrypoint" on an absolute socket path (sd-varlink.c:3863-3864). */
export function markEntrypoint(native: NativeAddon, path: string): void {
  if (path.startsWith("/"))
    quietly(() => {
      native.setPathXattr(path, "entrypoint");
    });
}
