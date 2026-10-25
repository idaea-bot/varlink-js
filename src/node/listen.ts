// listen(): a Listener over a Node net.Server (DESIGN.md §4.1, §4.7, §4.11, §5.4, §5.8).
import { randomBytes } from "node:crypto";
import { chmod, link, lstat, unlink } from "node:fs/promises";
import { connect as netConnect, createServer, type ListenOptions as NetListenOptions, type Server } from "node:net";
import { basename, dirname, join } from "node:path";
import { formatAddress, parseAddress, type AddressSpec } from "../core/address/parse.ts";
import { OperationNotSupportedError } from "../core/errors/local.ts";
import type { ByteChannel, Listener } from "../core/protocol/channel.ts";
import { fromNodeSocket } from "./socket.ts";

/** Options for {@link listen}. */
export interface ListenOptions {
  /** unix paths: `chmod` the socket to this mode before it appears at its path; default: the umask result. */
  mode?: number;
  /** `listen(2)` backlog; default Node's (511). */
  backlog?: number;
  /**
   * Called with server errors after listening (accept failures such as `EMFILE`, `ENFILE`, `ECONNABORTED`); the
   * listener keeps accepting. Default: ignore them. Exceptions from it are swallowed.
   */
  onError?: (error: unknown) => void;
}

/** A {@link Listener} over a `net.Server`. */
export interface NodeListener extends Listener {
  /** The underlying server, for diagnostics. Do not close it directly: use {@link Listener.close}. */
  readonly server: Server;
}

interface Waiter {
  resolve(result: IteratorResult<ByteChannel>): void;
}

/** Identity of a filesystem entry. */
interface Inode {
  readonly dev: number;
  readonly ino: number;
}

function errnoError(code: string, message: string, extra: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, ...extra });
}

function codeOf(e: unknown): unknown {
  return typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
}

/** A unix socket path we publish; `inode` is set once our socket is at `path` (close() unlinks only that). */
interface UnixOwnership {
  readonly path: string;
  inode: Inode | undefined;
}

class NodeListenerImpl implements NodeListener {
  readonly server: Server;
  readonly address: string;
  readonly #queue: ByteChannel[] = [];
  readonly #unix: UnixOwnership | undefined;
  #waiter: Waiter | undefined;
  #iterating = false;
  #closing: Promise<void> | undefined;

  constructor(server: Server, address: string, onError: ((error: unknown) => void) | undefined, unix?: UnixOwnership) {
    this.server = server;
    this.address = address;
    this.#unix = unix;
    server.on("connection", (socket) => {
      const channel = fromNodeSocket(socket);
      if (this.#closing !== undefined) {
        channel.close();
        return;
      }
      const waiter = this.#waiter;
      if (waiter !== undefined) {
        this.#waiter = undefined;
        waiter.resolve({ value: channel, done: false });
      } else this.#queue.push(channel);
    });
    // Errors after listening are accept failures (EMFILE, ENFILE, ECONNABORTED, …): the server keeps listening
    // (libuv's EMFILE trick drops the pending connection, so the loop does not spin), and so do we.
    server.on("error", (error) => {
      try {
        onError?.(error);
      } catch {
        // onError must not throw; if it does, the listener carries on.
      }
    });
    // Closed behind our back (`listener.server.close()`): end the iterator as close() does.
    server.on("close", () => {
      void this.close();
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<ByteChannel> {
    if (this.#iterating) throw new TypeError("the listener is already being iterated");
    this.#iterating = true;
    let finished = false;
    const finish = (): IteratorResult<ByteChannel> => {
      if (!finished) {
        finished = true;
        this.#iterating = false;
      }
      return { value: undefined, done: true };
    };
    return {
      next: (): Promise<IteratorResult<ByteChannel>> => {
        if (finished) return Promise.resolve({ value: undefined, done: true });
        const channel = this.#queue.shift();
        if (channel !== undefined) return Promise.resolve({ value: channel, done: false });
        if (this.#closing !== undefined) return Promise.resolve(finish());
        if (this.#waiter !== undefined) return Promise.reject(new TypeError("next() called concurrently"));
        return new Promise<IteratorResult<ByteChannel>>((resolve) => {
          this.#waiter = { resolve };
        }).then((r) => (r.done === true ? finish() : r));
      },
      return: (): Promise<IteratorResult<ByteChannel>> => {
        const waiter = this.#waiter;
        this.#waiter = undefined;
        waiter?.resolve({ value: undefined, done: true });
        return Promise.resolve(finish());
      },
    };
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    // Stops listening at once; the `close` event would wait for the connections, which are not ours any more.
    if (this.server.listening) this.server.close();
    for (const channel of this.#queue.splice(0)) channel.close();
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.resolve({ value: undefined, done: true });
    const path = this.#unix?.path;
    const inode = this.#unix?.inode;
    if (path === undefined || inode === undefined) return;
    try {
      const st = await lstat(path);
      if (st.isSocket() && st.dev === inode.dev && st.ino === inode.ino) await unlink(path);
    } catch {
      // Already gone (or not ours to remove).
    }
  }
}

/** What `net.Server.listen` takes here: options, or an inherited listening fd (a separate overload). */
type BindOptions = NetListenOptions | { readonly fd: number; readonly backlog?: number };

function bind(server: Server, options: BindOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if ("fd" in options) server.listen({ fd: options.fd }, options.backlog);
    else server.listen(options);
  });
}

/** Connects to a stale-looking socket this many times, this far apart, before replacing it. */
const PROBE_ATTEMPTS = 3;
const PROBE_INTERVAL_MS = 20;

function addressInUse(path: string, why: string): Error {
  return errnoError("EADDRINUSE", `listen EADDRINUSE: address already in use ${path} (${why})`, {
    syscall: "listen",
    address: path,
  });
}

/** One connect to a unix socket: accepted (or EAGAIN, a full backlog on Linux) = live; refused; vanished. */
function probeOnce(path: string): Promise<"live" | "refused" | "gone"> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ path });
    socket.once("connect", () => {
      socket.destroy();
      resolve("live");
    });
    socket.once("error", (error) => {
      socket.destroy();
      const code = codeOf(error);
      if (code === "ECONNREFUSED") resolve("refused");
      else if (code === "ENOENT") resolve("gone");
      else if (code === "EAGAIN") resolve("live");
      else reject(error);
    });
  });
}

/**
 * What is at `path`: gone, or a stale socket (it refused every probe; with its identity). A live socket or a
 * non-socket rejects with `EADDRINUSE`.
 */
async function inspect(path: string): Promise<{ kind: "gone" } | { kind: "stale"; inode: Inode }> {
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    if (codeOf(e) === "ENOENT") return { kind: "gone" };
    throw e;
  }
  if (!st.isSocket()) throw addressInUse(path, "not a socket");
  for (let i = 0; i < PROBE_ATTEMPTS; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
    const result = await probeOnce(path);
    if (result === "gone") return { kind: "gone" };
    if (result === "live") throw addressInUse(path, "a server is listening on it");
  }
  return { kind: "stale", inode: { dev: st.dev, ino: st.ino } };
}

/**
 * Makes the socket bound at `temp` appear at `path` too, never overwriting: `link` fails with EEXIST (so of two
 * concurrent listen() calls only one wins). A stale socket there is unlinked (if it is still the probed inode) and
 * the link retried once; a second EEXIST is `EADDRINUSE`.
 */
async function publish(temp: string, path: string): Promise<void> {
  let removedStale = false;
  let vanished = 0;
  for (;;) {
    try {
      await link(temp, path);
      return;
    } catch (e) {
      if (codeOf(e) !== "EEXIST") throw e;
    }
    if (removedStale) throw addressInUse(path, "another listener took it");
    const found = await inspect(path);
    if (found.kind === "gone") {
      vanished++;
      if (vanished > PROBE_ATTEMPTS) throw addressInUse(path, "it keeps changing");
      continue;
    }
    try {
      const st = await lstat(path);
      if (st.dev !== found.inode.dev || st.ino !== found.inode.ino)
        throw addressInUse(path, "it was replaced while probing");
      await unlink(path);
    } catch (e) {
      if (codeOf(e) !== "ENOENT") throw e;
    }
    removedStale = true;
  }
}

async function listenUnix(path: string, options: ListenOptions): Promise<NodeListener> {
  // Bind on a temporary name next to the target (recognizable if a crash leaves it behind), chmod it, then publish
  // it with link() + unlink(temp): `mode` applies before the socket is reachable, an existing path is never
  // overwritten (publish()), and libuv's unlink-on-close hits the temporary name (which no longer exists), so
  // close() can remove the path only while it is still our inode.
  const temp = join(dirname(path), `.${basename(path)}.vjs-${randomBytes(3).toString("hex")}`);
  const server = createServer({ allowHalfOpen: true, pauseOnConnect: true });
  await bind(server, { path: temp, ...(options.backlog === undefined ? {} : { backlog: options.backlog }) });
  // Listeners before any other await: errors and connections during the setup are handled.
  const unix: UnixOwnership = { path, inode: undefined };
  const listener = new NodeListenerImpl(server, formatAddress({ kind: "unix", path }), options.onError, unix);
  try {
    if (options.mode !== undefined) await chmod(temp, options.mode);
    const st = await lstat(temp);
    await publish(temp, path);
    unix.inode = { dev: st.dev, ino: st.ino };
    await unlink(temp);
    return listener;
  } catch (e) {
    // close() leaves `path` alone unless it is ours (inode set): only a failed unlink(temp) gets here then.
    await listener.close();
    await unlink(temp).catch(() => undefined);
    throw e;
  }
}

async function listenServer(
  options: BindOptions,
  address: (server: Server) => string,
  onError: ((error: unknown) => void) | undefined,
): Promise<NodeListener> {
  const server = createServer({ allowHalfOpen: true, pauseOnConnect: true });
  await bind(server, options);
  try {
    return new NodeListenerImpl(server, address(server), onError);
  } catch (e) {
    server.close();
    throw e;
  }
}

/** The canonical address of a listening server (`{fd}`: a unix socket's path is unknown to Node → `fd:<n>`). */
function addressOf(server: Server, fd?: number): string {
  const a = server.address();
  if (a === null || a === "") return `fd:${String(fd)}`;
  if (typeof a === "string")
    return a.startsWith("\0")
      ? formatAddress({ kind: "unix-abstract", name: a.slice(1) })
      : formatAddress({ kind: "unix", path: a });
  return formatAddress({ kind: "tcp", host: a.address, port: a.port });
}

/**
 * Listens on a varlink address (DESIGN.md §5.4) and returns a {@link NodeListener}: an async iterable of accepted
 * connections (as {@link ByteChannel}s, for `server.serve()`), its canonical `address` and `close()`.
 *
 * - `unix:/path` (and bare paths): the socket is bound on a temporary name in the same directory
 *   (`.<basename>.vjs-<hex>`), `chmod`ed to `mode` and hard-linked to the path, which is never overwritten: an
 *   existing stale socket (it refused 3 connects ~20 ms apart) is unlinked first; a live socket, a non-socket, or a
 *   concurrent listen() that got there first rejects with `EADDRINUSE` and is left alone. `close()` unlinks the
 *   path only if it is still the socket we created.
 * - `unix:@name`: Linux only (else `OperationNotSupportedError`).
 * - `tcp:host:port`: port 0 picks a free port; `address` carries the real one (`tcp:[::1]:p` for IPv6).
 * - `{fd}`: an already-listening socket fd (socket activation, §5.8). `address` comes from the socket
 *   (`tcp:…`, `unix:@…`); Node cannot name a unix path socket inherited this way, so it is `fd:<n>` there.
 *
 * `listen()` rejects on `EADDRINUSE` and every other listen error (F8). Later server errors (accept failures such
 * as `EMFILE`) go to `options.onError` (default: ignored) and the listener keeps accepting. The iterator ends only
 * when `close()` is called or the server closes. `close()` stops listening, ends the iterator and destroys accepted
 * connections nobody took yet; it does not wait for taken ones. Iterating twice concurrently is a `TypeError`. Other
 * address kinds reject with `OperationNotSupportedError`.
 */
export async function listen(
  address: string | AddressSpec | { readonly fd: number },
  options?: ListenOptions,
): Promise<NodeListener> {
  const opts = options ?? {};
  if (opts.onError !== undefined && typeof opts.onError !== "function")
    throw new TypeError("onError must be a function");
  const backlog = opts.backlog === undefined ? {} : { backlog: opts.backlog };
  if (typeof address === "object" && "fd" in address) {
    const fd = address.fd;
    if (!Number.isSafeInteger(fd) || fd < 0) throw new TypeError("fd must be a non-negative integer");
    return listenServer({ fd, ...backlog }, (server) => addressOf(server, fd), opts.onError);
  }
  const spec = typeof address === "string" ? parseAddress(address) : address;
  switch (spec.kind) {
    case "unix":
      return listenUnix(spec.path, opts);
    case "unix-abstract":
      if (process.platform !== "linux")
        throw new OperationNotSupportedError(`abstract unix sockets (unix:@) need Linux, not ${process.platform}`);
      return listenServer({ path: `\0${spec.name}`, ...backlog }, () => formatAddress(spec), opts.onError);
    case "tcp":
      return listenServer(
        { host: spec.host, port: spec.port, ...backlog },
        (server) => addressOf(server),
        opts.onError,
      );
    default:
      throw new OperationNotSupportedError(`listen() does not support ${spec.kind} addresses`);
  }
}
