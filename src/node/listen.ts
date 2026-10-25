// listen(): a Listener over a Node net.Server (DESIGN.md §4.1, §4.7, §4.11, §5.4, §5.8).
import { randomBytes } from "node:crypto";
import { chmod, lstat, rename, unlink } from "node:fs/promises";
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
}

/** A {@link Listener} over a `net.Server`. */
export interface NodeListener extends Listener {
  /** The underlying server, for diagnostics. Do not close it directly: use {@link Listener.close}. */
  readonly server: Server;
}

interface Waiter {
  resolve(result: IteratorResult<ByteChannel>): void;
  reject(error: unknown): void;
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

class NodeListenerImpl implements NodeListener {
  readonly server: Server;
  readonly address: string;
  readonly #queue: ByteChannel[] = [];
  readonly #unixPath: string | undefined;
  readonly #inode: Inode | undefined;
  #waiter: Waiter | undefined;
  #iterating = false;
  #error: { value: unknown } | undefined;
  #closing: Promise<void> | undefined;

  constructor(server: Server, address: string, unixPath?: string, inode?: Inode) {
    this.server = server;
    this.address = address;
    this.#unixPath = unixPath;
    this.#inode = inode;
    server.on("connection", (socket) => {
      const channel = fromNodeSocket(socket);
      if (this.#closing !== undefined || this.#error !== undefined) {
        channel.close();
        return;
      }
      const waiter = this.#waiter;
      if (waiter !== undefined) {
        this.#waiter = undefined;
        waiter.resolve({ value: channel, done: false });
      } else this.#queue.push(channel);
    });
    // Errors after listening are stored and thrown by the iterator (the Server reports `accept-failed`).
    server.on("error", (error) => {
      this.#error ??= { value: error };
      const waiter = this.#waiter;
      this.#waiter = undefined;
      waiter?.reject(error);
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
        if (this.#error !== undefined) {
          const error = this.#error.value;
          finish();
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the server's error as is
          return Promise.reject(error);
        }
        if (this.#closing !== undefined) return Promise.resolve(finish());
        if (this.#waiter !== undefined) return Promise.reject(new TypeError("next() called concurrently"));
        return new Promise<IteratorResult<ByteChannel>>((resolve, reject) => {
          this.#waiter = { resolve, reject };
        }).then(
          (r) => (r.done === true ? finish() : r),
          (e: unknown) => {
            finish();
            throw e;
          },
        );
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
    const path = this.#unixPath;
    const inode = this.#inode;
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

/** Whether a unix socket at `path` accepts connections (false: refused, i.e. stale, or gone). */
function probe(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ path });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      socket.destroy();
      const code = codeOf(error);
      if (code === "ECONNREFUSED" || code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
}

function addressInUse(path: string, why: string): Error {
  return errnoError("EADDRINUSE", `listen EADDRINUSE: address already in use ${path} (${why})`, {
    syscall: "listen",
    address: path,
  });
}

async function listenUnix(path: string, options: ListenOptions): Promise<NodeListener> {
  // An existing path: a stale socket (connect refused) is replaced; a live socket or a non-socket is left alone.
  try {
    const st = await lstat(path);
    if (!st.isSocket()) throw addressInUse(path, "not a socket");
    if (await probe(path)) throw addressInUse(path, "a server is listening on it");
  } catch (e) {
    if (codeOf(e) !== "ENOENT") throw e;
  }
  // Bind on a temporary name next to the target and rename it into place: the replacement of a stale socket is
  // atomic, `mode` applies before the socket is reachable, and libuv's unlink-on-close hits the temporary name
  // (which no longer exists), so close() can remove the path only while it is still our inode.
  // The temporary name is no longer than the target where possible (sun_path is ~104 bytes).
  const length = Math.max(6, basename(path).length - 1);
  const temp = join(dirname(path), `.${randomBytes(length).toString("hex").slice(0, length)}`);
  const server = createServer({ allowHalfOpen: true, pauseOnConnect: true });
  await bind(server, { path: temp, ...(options.backlog === undefined ? {} : { backlog: options.backlog }) });
  try {
    if (options.mode !== undefined) await chmod(temp, options.mode);
    const st = await lstat(temp);
    await rename(temp, path);
    return new NodeListenerImpl(server, formatAddress({ kind: "unix", path }), path, { dev: st.dev, ino: st.ino });
  } catch (e) {
    server.close();
    await unlink(temp).catch(() => undefined);
    throw e;
  }
}

async function listenServer(options: BindOptions, address: (server: Server) => string): Promise<NodeListener> {
  const server = createServer({ allowHalfOpen: true, pauseOnConnect: true });
  await bind(server, options);
  try {
    return new NodeListenerImpl(server, address(server));
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
 * - `unix:/path` (and bare paths): an existing stale socket (connect refused) is replaced; a live socket or a
 *   non-socket rejects with `EADDRINUSE` and is left alone. `mode` is applied before the socket appears at its
 *   path. `close()` unlinks the path only if it is still the socket we created.
 * - `unix:@name`: Linux only (else `OperationNotSupportedError`).
 * - `tcp:host:port`: port 0 picks a free port; `address` carries the real one (`tcp:[::1]:p` for IPv6).
 * - `{fd}`: an already-listening socket fd (socket activation, §5.8). `address` comes from the socket
 *   (`tcp:…`, `unix:@…`); Node cannot name a unix path socket inherited this way, so it is `fd:<n>` there.
 *
 * `listen()` rejects on `EADDRINUSE` and every other listen error (F8). Later server errors are thrown by the
 * iterator (so `server.serve()` reports `accept-failed`), never from an event listener. `close()` stops listening,
 * ends the iterator and destroys accepted connections nobody took yet; it does not wait for taken ones. Iterating
 * twice concurrently is a `TypeError`. Other address kinds reject with `OperationNotSupportedError`.
 */
export async function listen(
  address: string | AddressSpec | { readonly fd: number },
  options?: ListenOptions,
): Promise<NodeListener> {
  const opts = options ?? {};
  const backlog = opts.backlog === undefined ? {} : { backlog: opts.backlog };
  if (typeof address === "object" && "fd" in address) {
    const fd = address.fd;
    if (!Number.isSafeInteger(fd) || fd < 0) throw new TypeError("fd must be a non-negative integer");
    return listenServer({ fd, ...backlog }, (server) => addressOf(server, fd));
  }
  const spec = typeof address === "string" ? parseAddress(address) : address;
  switch (spec.kind) {
    case "unix":
      return listenUnix(spec.path, opts);
    case "unix-abstract":
      if (process.platform !== "linux")
        throw new OperationNotSupportedError(`abstract unix sockets (unix:@) need Linux, not ${process.platform}`);
      return listenServer({ path: `\0${spec.name}`, ...backlog }, () => formatAddress(spec));
    case "tcp":
      return listenServer({ host: spec.host, port: spec.port, ...backlog }, (server) => addressOf(server));
    default:
      throw new OperationNotSupportedError(`listen() does not support ${spec.kind} addresses`);
  }
}
