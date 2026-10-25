// listen(): a Listener over a Node net.Server (DESIGN.md §4.1, §4.7, §4.11, §5.4, §5.8).
import { chmod, link, lstat, mkdtemp, rename, rm, rmdir, unlink } from "node:fs/promises";
import { connect as netConnect, createServer, type ListenOptions as NetListenOptions, type Server } from "node:net";
import { dirname, join, resolve } from "node:path";
import { formatAddress, parseAddress, type AddressSpec } from "../core/address/parse.ts";
import { OperationNotSupportedError } from "../core/errors/local.ts";
import type { ByteChannel, Listener } from "../core/protocol/channel.ts";
import type { RegistryBindOptions, RegistryBinding } from "../rpc/server.ts";
import { bindRegistry } from "./registry.ts";
import { fromNodeSocket } from "./socket.ts";

/** Options for {@link listen}. */
export interface ListenOptions {
  /**
   * unix paths: `chmod` the socket to this mode while it is still in a private 0700 directory, before it is
   * published at its path (so nobody can connect with weaker permissions); default: the umask result. In the
   * fallback without hard links it is applied right after `bind` (a short window with the umask mode).
   */
  mode?: number;
  /** `listen(2)` backlog; default Node's (511). */
  backlog?: number;
  /**
   * Called with server errors after listening (accept failures such as `EMFILE`, `ENFILE`, `ECONNABORTED`); the
   * listener keeps accepting. Default: ignore them. Exceptions from it are swallowed.
   */
  onError?: (error: unknown) => void;
  /**
   * `{fd}` only: the listener's `address` when it is known otherwise (e.g. from `/proc`, §5.8), replacing the one
   * derived from the socket (or the `fd:<n>` placeholder). Parsed and stored in canonical form; never unlinked.
   */
  address?: string;
}

/** A {@link Listener} over a `net.Server`. */
export interface NodeListener extends Listener {
  /** The underlying server, for diagnostics. Do not close it directly: use {@link Listener.close}. */
  readonly server: Server;
  /**
   * Present only on unix path listeners (also `{fd}` ones whose `address` option names a unix path): publishes the
   * socket in a registry directory (`bindRegistry` of `./registry.ts`), for `server.serve(listener, {registry})`.
   * For an `{fd}` listener (an inherited, socket-activated socket) the binding's `unbind()` does nothing: the
   * socket belongs to the service manager and outlives us, so its entries stay (a later binder adopts them).
   */
  readonly bindRegistry?: (interfaces: readonly string[], options: RegistryBindOptions) => Promise<RegistryBinding>;
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

/** The path of a `unix:/path` address (not `unix:@`, tcp or the `fd:<n>` placeholder). */
function unixPath(address: string): string | undefined {
  try {
    const spec = parseAddress(address);
    return spec.kind === "unix" ? spec.path : undefined;
  } catch {
    return undefined;
  }
}

/** A unix socket path we publish; `inode` is set once our socket is at `path` (close() unlinks only that). */
interface UnixOwnership {
  readonly path: string;
  inode: Inode | undefined;
}

/**
 * The binding of a socket we do not own (`{fd}`, socket activation): its entries stay at unbind, since the socket
 * belongs to the service manager and outlives us (a connect through the entry activates the service again). A
 * later binder adopts the entry; a stale one is replaced by binders and skipped by readers.
 */
function persistent(binding: RegistryBinding): RegistryBinding {
  return { entries: binding.entries, unbind: () => Promise.resolve() };
}

class NodeListenerImpl implements NodeListener {
  readonly server: Server;
  readonly address: string;
  declare readonly bindRegistry?: (
    interfaces: readonly string[],
    options: RegistryBindOptions,
  ) => Promise<RegistryBinding>;
  readonly #queue: ByteChannel[] = [];
  readonly #unix: UnixOwnership | undefined;
  #waiter: Waiter | undefined;
  #iterating = false;
  #closing: Promise<void> | undefined;

  constructor(server: Server, address: string, onError: ((error: unknown) => void) | undefined, unix?: UnixOwnership) {
    this.server = server;
    this.address = address;
    this.#unix = unix;
    // Only a unix path socket can be a registry entry's target (absolute: the cwd may change later).
    const path = unixPath(address);
    if (path !== undefined) {
      const target = resolve(path);
      // No `unix` ownership: an inherited ({fd}) socket, held by the service manager, that outlives us.
      this.bindRegistry =
        unix === undefined
          ? async (interfaces, options) => persistent(await bindRegistry(target, interfaces, options))
          : (interfaces, options) => bindRegistry(target, interfaces, options);
    }
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

const sameInode = (a: Inode, b: Inode): boolean => a.dev === b.dev && a.ino === b.ino;

/** Test hooks (internal): `beforeReplace` runs between probing a stale socket and moving it away. */
export interface PublishHooks {
  beforeReplace?: () => Promise<void>;
  /** Runs after a non-stale entry was moved away, before it is put back. */
  beforeRestore?: () => Promise<void>;
  /** Replaces `fs.promises.link` (to simulate a filesystem without hard links). */
  link?: (existing: string, target: string) => Promise<void>;
}

/** Errors from `publish` after which the private directory must stay: it holds someone else's live socket. */
const keepPrivateDir = new WeakSet<object>();

/** `link` (or `mkdtemp`) failing like this means the filesystem cannot do the private-directory publish. */
const NO_LINK_SUPPORT = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENAMETOOLONG"]);

/** Longest unix socket path `bind` takes: sun_path is 108 bytes on Linux, 104 elsewhere (less the NUL). */
const SUN_PATH_MAX = process.platform === "linux" ? 107 : 103;

/** Setup of `listen()` on one absolute path, serialized in this process (released when the setup settles). */
const setupLocks = new Map<string, Promise<void>>();

async function withPathLock<T>(key: string, setup: () => Promise<T>): Promise<T> {
  const previous = setupLocks.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  setupLocks.set(key, tail);
  await previous;
  try {
    return await setup();
  } finally {
    release();
    if (setupLocks.get(key) === tail) setupLocks.delete(key);
  }
}

/**
 * Makes the socket bound at `socket` (inside our private directory `dir`) appear at `path`, never overwriting:
 * `link` fails with EEXIST. A stale socket there is moved into `dir` with `rename` (atomic, whatever is at `path`
 * now); if what moved is the probed inode it is unlinked and the link retried once (a second EEXIST is
 * `EADDRINUSE`); if not, someone published a live socket meanwhile: it is moved back and we reject `EADDRINUSE`.
 * Returns `"unsupported"` if the first `link` fails for lack of hard-link support.
 */
async function publish(
  socket: string,
  path: string,
  dir: string,
  hooks: PublishHooks | undefined,
): Promise<"published" | "unsupported"> {
  let replacedStale = false;
  let vanished = 0;
  let first = true;
  const linkFn = hooks?.link ?? link;
  for (;;) {
    try {
      await linkFn(socket, path);
      return "published";
    } catch (e) {
      if (first && NO_LINK_SUPPORT.has(codeOf(e) as string)) return "unsupported";
      if (codeOf(e) !== "EEXIST") throw e;
    }
    first = false;
    if (replacedStale) throw addressInUse(path, "another listener took it");
    const found = await inspect(path);
    if (found.kind === "stale") {
      await hooks?.beforeReplace?.();
      const tomb = join(dir, "old");
      try {
        await rename(path, tomb);
      } catch (e) {
        if (codeOf(e) !== "ENOENT") throw e;
      }
      let st;
      try {
        st = await lstat(tomb);
      } catch (e) {
        if (codeOf(e) !== "ENOENT") throw e;
      }
      if (st !== undefined) {
        if (!sameInode(st, found.inode)) {
          await hooks?.beforeRestore?.();
          const restored = await restore(tomb, path);
          const err = addressInUse(path, `it was replaced while probing${restored.message}`);
          if (!restored.ok) keepPrivateDir.add(err);
          throw err;
        }
        await unlink(tomb);
        replacedStale = true;
        continue;
      }
    }
    // Gone (before or during the replace): link again, a bounded number of times.
    vanished++;
    if (vanished > PROBE_ATTEMPTS) throw addressInUse(path, "it keeps changing");
  }
}

/**
 * Puts back an entry `publish` moved away by mistake, never overwriting: `link` first (a third party may have
 * published at `path` meanwhile: EEXIST), `rename` only if `link` fails otherwise. `ok: false` means the entry is
 * still at `tomb` (its only name now): the caller must keep the private directory, and the message names it.
 */
async function restore(tomb: string, path: string): Promise<{ ok: boolean; message: string }> {
  try {
    await link(tomb, path);
    await unlink(tomb).catch(() => undefined);
    return { ok: true, message: "" };
  } catch (e) {
    if (codeOf(e) !== "EEXIST") {
      try {
        await rename(tomb, path);
        return { ok: true, message: "" };
      } catch (e2) {
        return {
          ok: false,
          message: `; it was moved to ${tomb} and could not be put back (${String(e)}; ${String(e2)})`,
        };
      }
    }
    return { ok: false, message: `; it was moved to ${tomb} and something else now occupies the path` };
  }
}

async function listenUnix(path: string, options: ListenOptions, hooks?: PublishHooks): Promise<NodeListener> {
  // A path that does not fit in sun_path could be published (link takes any length) but nobody could connect.
  if (Buffer.byteLength(path) > SUN_PATH_MAX)
    throw Object.assign(new Error(`unix socket path too long (over ${String(SUN_PATH_MAX)} bytes): ${path}`), {
      code: "ENAMETOOLONG",
    });
  return withPathLock(resolve(path), async () => {
    // The private socket path must fit in sun_path; else (or without hard links) bind at `path` directly.
    const placeholder = join(dirname(path), ".vjs-XXXXXX", "s");
    if (Buffer.byteLength(placeholder) > SUN_PATH_MAX) return listenUnixDirect(path, options);
    let dir: string;
    try {
      dir = await mkdtemp(join(dirname(path), ".vjs-"));
    } catch (e) {
      if (NO_LINK_SUPPORT.has(codeOf(e) as string)) return listenUnixDirect(path, options);
      throw e;
    }
    const listener = await listenPrivate(path, dir, options, hooks);
    return listener ?? listenUnixDirect(path, options);
  });
}

/**
 * Binds in the private 0700 directory `dir` (nobody else can connect there), `chmod`s, publishes at `path` with
 * `link`, then removes the private name and `dir`. libuv's unlink-on-close hits the private name (gone by then),
 * so close() can remove `path` only while it is still our inode. `undefined`: no hard links here (cleaned up).
 */
async function listenPrivate(
  path: string,
  dir: string,
  options: ListenOptions,
  hooks: PublishHooks | undefined,
): Promise<NodeListener | undefined> {
  const socket = join(dir, "s");
  const server = createServer({ allowHalfOpen: true, pauseOnConnect: true });
  try {
    await bind(server, { path: socket, ...(options.backlog === undefined ? {} : { backlog: options.backlog }) });
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  // Listeners before any other await: errors and connections during the setup are handled.
  const unix: UnixOwnership = { path, inode: undefined };
  const listener = new NodeListenerImpl(server, formatAddress({ kind: "unix", path }), options.onError, unix);
  try {
    if (options.mode !== undefined) await chmod(socket, options.mode);
    const st = await lstat(socket);
    if ((await publish(socket, path, dir, hooks)) === "unsupported") {
      await listener.close();
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      return undefined;
    }
    unix.inode = { dev: st.dev, ino: st.ino };
    await unlink(socket);
    await rmdir(dir);
    return listener;
  } catch (e) {
    // close() leaves `path` alone unless it is ours (inode set): only a failed cleanup gets here then.
    await listener.close();
    // A socket we could not put back lives on only in `dir` (named in the error): remove just our own name then.
    if (typeof e === "object" && e !== null && keepPrivateDir.has(e)) await unlink(socket).catch(() => undefined);
    else await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

/**
 * Fallback without hard links (or a private path too long for sun_path): a stale socket at `path` is unlinked
 * (check-then-act: another process may race us) and the socket bound at `path`, then `chmod`ed (so it briefly has
 * the umask mode). libuv unlinks `path` on close, even if it was replaced meanwhile.
 */
async function listenUnixDirect(path: string, options: ListenOptions): Promise<NodeListener> {
  const found = await inspect(path);
  if (found.kind === "stale") {
    try {
      const st = await lstat(path);
      if (!sameInode(st, found.inode)) throw addressInUse(path, "it was replaced while probing");
      await unlink(path);
    } catch (e) {
      if (codeOf(e) !== "ENOENT") throw e;
    }
  }
  const server = createServer({ allowHalfOpen: true, pauseOnConnect: true });
  await bind(server, { path, ...(options.backlog === undefined ? {} : { backlog: options.backlog }) });
  const unix: UnixOwnership = { path, inode: undefined };
  const listener = new NodeListenerImpl(server, formatAddress({ kind: "unix", path }), options.onError, unix);
  try {
    if (options.mode !== undefined) await chmod(path, options.mode);
    const st = await lstat(path);
    unix.inode = { dev: st.dev, ino: st.ino };
    return listener;
  } catch (e) {
    await listener.close();
    throw e;
  }
}

/** Test entry (internal): {@link listen} on a unix path with {@link PublishHooks}. */
export function listenUnixWithHooks(path: string, options: ListenOptions, hooks: PublishHooks): Promise<NodeListener> {
  return listenUnix(path, options, hooks);
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
  // Bun (1.4) reports an object without `address`/`port` for a unix socket inherited via {fd} (M10).
  if (typeof a.address !== "string" || a.address === "" || typeof a.port !== "number") return `fd:${String(fd)}`;
  return formatAddress({ kind: "tcp", host: a.address, port: a.port });
}

/**
 * Listens on a varlink address (DESIGN.md §5.4) and returns a {@link NodeListener}: an async iterable of accepted
 * connections (as {@link ByteChannel}s, for `server.serve()`), its canonical `address` and `close()`.
 *
 * - `unix:/path` (and bare paths): the socket is bound in a private 0700 directory next to the path (`.vjs-<hex>`,
 *   removed afterwards), `chmod`ed to `mode` and hard-linked to the path, which is never overwritten: an existing
 *   stale socket (it refused 3 connects ~20 ms apart) is moved away atomically and removed; a live socket, a
 *   non-socket, or a concurrent listen() that got there first rejects with `EADDRINUSE` and is left alone (on
 *   macOS/BSD a live socket whose backlog is full refuses connects as a stale one does, and may be replaced). Setups
 *   on one path are serialized within the process. Without hard-link support (or if the private path would not
 *   fit in sun_path) the socket is bound at the path directly after the stale check: `mode` is then applied after
 *   bind, and another process may race the stale replace. `close()` unlinks the path only if it is still the
 *   socket we created.
 * - `unix:@name`: Linux only (else `OperationNotSupportedError`).
 * - `tcp:host:port`: port 0 picks a free port; `address` carries the real one (`tcp:[::1]:p` for IPv6).
 * - `{fd}`: an already-listening socket fd (socket activation, §5.8). `address` comes from the socket
 *   (`tcp:…`, `unix:@…`); Node cannot name a unix path socket inherited this way, so it is `fd:<n>` there unless
 *   `options.address` names it. Closing never unlinks anything.
 *
 * `listen()` rejects on `EADDRINUSE` and every other listen error (F8). Later server errors (accept failures such
 * as `EMFILE`) go to `options.onError` (default: ignored) and the listener keeps accepting. The iterator ends only
 * when `close()` is called or the server closes. `close()` stops listening, ends the iterator and destroys accepted
 * connections nobody took yet; it does not wait for taken ones. Iterating twice concurrently is a `TypeError`. Other
 * address kinds reject with `OperationNotSupportedError`. Unix path listeners (and `{fd}` ones whose `address` names
 * a unix path) have `bindRegistry`, for `server.serve(listener, {registry})` (§5.4); the others do not. Entries of
 * an `{fd}` listener are not removed when it is unbound (see {@link NodeListener.bindRegistry}).
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
    const known = opts.address === undefined ? undefined : formatAddress(parseAddress(opts.address));
    return listenServer({ fd, ...backlog }, (server) => known ?? addressOf(server, fd), opts.onError);
  }
  if (opts.address !== undefined) throw new TypeError("the address option is only valid with {fd}");
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
