// Socket activation (DESIGN.md §5.8): listeners from LISTEN_FDS/LISTEN_FDNAMES, SYSTEMD_VARLINK_LISTEN, stdio.
// Reference: sd-daemon.c (sd_listen_fds, sd_listen_fds_with_names), sd-varlink.c (sd_varlink_server_listen_name,
// sd_varlink_server_listen_auto).
import { readFileSync, readlinkSync } from "node:fs";
import { Socket } from "node:net";
import { formatAddress, type AddressSpec } from "../core/address/parse.ts";
import { OperationNotSupportedError } from "../core/errors/local.ts";
import type { ByteChannel, Listener } from "../core/protocol/channel.ts";
import type { ServeListener } from "../rpc/server.ts";
import { checkMode } from "../rpc/util.ts";
import { ACTIVATION_HINT_ENV, recordActivationFds } from "./activation-fds.ts";
import { listen } from "./listen.ts";
import { fromNodeSocket } from "./socket.ts";
import { fromNodeStreams } from "./spawn-channel.ts";

export { inheritedActivationFds } from "./activation-fds.ts";

/** Options for {@link listenFromEnv} (and {@link listenAuto}). */
export interface ActivationOptions {
  /** The `LISTEN_FDNAMES` name of the fds to use; default `"varlink"`. */
  name?: string;
  /**
   * Delete `LISTEN_PID`, `LISTEN_PIDFDID`, `LISTEN_FDS` and `LISTEN_FDNAMES` from `process.env` (like
   * `sd_listen_fds(1)`), whatever the outcome; default true.
   */
  unsetEnvironment?: boolean;
  /**
   * Whether an fd is a listening socket or an already-accepted connection (systemd `Accept=yes`, or a connected
   * `exec:` socketpair). `"auto"` (default) asks `/proc` on Linux; where `/proc` says nothing about an fd (other
   * systems, or a socket it does not know) the fd is taken as connected if `VARLINK_JS_ACTIVATION=connected` is set
   * (see {@link listenFromEnv}), else as listening: on other systems a connected fd passed by anyone but a
   * varlink-js `exec:` needs `"connected"`.
   */
  accept?: "auto" | "listening" | "connected";
}

/** Options for {@link listenAuto}. */
export interface ListenAutoOptions extends ActivationOptions {
  /** `SYSTEMD_VARLINK_LISTEN` naming a unix path: the socket's mode (see `listen()`). */
  mode?: number;
}

/** The variables `listenFromEnv` reads (and by default unsets). */
const ACTIVATION_ENV = ["LISTEN_PID", "LISTEN_PIDFDID", "LISTEN_FDS", "LISTEN_FDNAMES", ACTIVATION_HINT_ENV];

/** The first passed fd (SD_LISTEN_FDS_START). */
const LISTEN_FDS_START = 3;

/** More than this many fds in `LISTEN_FDS` is taken for garbage. */
const MAX_LISTEN_FDS = 1024;

/** What `/proc` says about a socket. */
interface ProcSocket {
  readonly listening: boolean;
  /** The bound address of a unix socket, if it has one. */
  readonly address?: string;
}

/** __SO_ACCEPTCON in the Flags column of /proc/net/unix. */
const SO_ACCEPTCON = 0x10000;

/** TCP_LISTEN in the st column of /proc/net/tcp{,6}. */
const TCP_LISTEN = "0A";

function readProc(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function unixAddress(path: string): string | undefined {
  // /proc shows an abstract name with a leading '@' (and its NULs as '@').
  const spec: AddressSpec = path.startsWith("@")
    ? { kind: "unix-abstract", name: path.slice(1) }
    : { kind: "unix", path };
  try {
    return formatAddress(spec);
  } catch {
    return undefined;
  }
}

/** Sockets by inode, from /proc/self/net/{unix,tcp,tcp6} (Linux; empty where unreadable). */
function procSockets(): Map<string, ProcSocket> {
  const sockets = new Map<string, ProcSocket>();
  // Num RefCount Protocol Flags Type St Inode [Path]
  const unixLine = /^\S+:\s+\S+\s+\S+\s+([0-9A-Fa-f]+)\s+\S+\s+\S+\s+(\d+)(?: (.*))?$/;
  for (const line of (readProc("/proc/self/net/unix") ?? "").split("\n").slice(1)) {
    const m = unixLine.exec(line);
    if (m === null) continue;
    const [, flags = "0", inode = "", path] = m;
    const address = path === undefined || path === "" ? undefined : unixAddress(path);
    sockets.set(inode, {
      listening: (parseInt(flags, 16) & SO_ACCEPTCON) !== 0,
      ...(address === undefined ? {} : { address }),
    });
  }
  // sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode …
  for (const table of ["/proc/self/net/tcp", "/proc/self/net/tcp6"])
    for (const line of (readProc(table) ?? "").split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const st = fields[3];
      const inode = fields[9];
      if (st === undefined || inode === undefined) continue;
      sockets.set(inode, { listening: st.toUpperCase() === TCP_LISTEN });
    }
  return sockets;
}

/** The socket inode of an fd (`socket:[ino]`), or undefined. */
function socketInode(fd: number): string | undefined {
  try {
    return /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/self/fd/${String(fd)}`))?.[1];
  } catch {
    return undefined;
  }
}

/** A listener that yields one channel (made on first `next()`), then ends. No `bindRegistry`: nothing to publish. */
class OneShotListener implements Listener {
  readonly address: string;
  #take: (() => ByteChannel) | undefined;
  readonly #discard: () => void;
  #iterating = false;

  constructor(address: string, take: () => ByteChannel, discard: () => void) {
    this.address = address;
    this.#take = take;
    this.#discard = discard;
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
        const take = this.#take;
        if (finished || take === undefined) return Promise.resolve(finish());
        this.#take = undefined;
        try {
          return Promise.resolve({ value: take(), done: false });
        } catch (e) {
          finish();
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the error as is
          return Promise.reject(e);
        }
      },
      return: (): Promise<IteratorResult<ByteChannel>> => Promise.resolve(finish()),
    };
  }

  close(): Promise<void> {
    if (this.#take !== undefined) {
      this.#take = undefined;
      this.#discard();
    }
    return Promise.resolve();
  }
}

/** A connected activation fd: one channel over it. */
function connectedListener(fd: number, address: string | undefined): Listener {
  const socket = new Socket({ fd, readable: true, writable: true, allowHalfOpen: true });
  const channel = fromNodeSocket(socket);
  return new OneShotListener(
    address ?? `fd:${String(fd)}`,
    () => channel,
    () => {
      channel.close();
    },
  );
}

/** `it.return()`, its failure (a throw or a rejection from a user's listener) ignored. */
function quietReturn(it: AsyncIterator<ByteChannel>): void {
  try {
    it.return?.().catch(() => undefined);
  } catch {
    // Nothing to report it to: the merged iteration is over either way.
  }
}

/** Per-iteration state of a {@link mergeListeners} listener. */
interface MergeState {
  readonly queue: ByteChannel[];
  readonly iterators: AsyncIterator<ByteChannel>[];
  waiter: { resolve(r: IteratorResult<ByteChannel>): void; reject(e: unknown): void } | undefined;
  error: { value: unknown } | undefined;
  active: number;
  finished: boolean;
}

class MergedListener implements Listener {
  readonly address: string;
  declare readonly bindRegistry?: ServeListener["bindRegistry"];
  readonly #sources: readonly Listener[];
  #state: MergeState | undefined;
  #closing: Promise<void> | undefined;

  constructor(sources: readonly Listener[], address: string) {
    this.#sources = sources;
    this.address = address;
    // The registry names the first unix path socket among the sources (the others have no path to link to).
    const bindable = (sources as readonly ServeListener[]).find((s) => typeof s.bindRegistry === "function");
    if (bindable !== undefined)
      this.bindRegistry = (interfaces, options) =>
        bindable.bindRegistry?.(interfaces, options) ??
        Promise.reject(new OperationNotSupportedError("the listener lost its bindRegistry"));
  }

  [Symbol.asyncIterator](): AsyncIterator<ByteChannel> {
    if (this.#state !== undefined) throw new TypeError("the listener is already being iterated");
    const iterators: AsyncIterator<ByteChannel>[] = [];
    try {
      for (const source of this.#sources) iterators.push(source[Symbol.asyncIterator]());
    } catch (e) {
      for (const it of iterators) quietReturn(it);
      throw e;
    }
    const state: MergeState = {
      queue: [],
      iterators,
      waiter: undefined,
      error: undefined,
      active: iterators.length,
      finished: false,
    };
    this.#state = state;
    for (const it of iterators) void this.#pump(state, it);
    return {
      next: (): Promise<IteratorResult<ByteChannel>> => {
        if (state.finished) return Promise.resolve({ value: undefined, done: true });
        if (state.waiter !== undefined) return Promise.reject(new TypeError("next() called concurrently"));
        return new Promise((resolve, reject) => {
          state.waiter = { resolve, reject };
          this.#wake(state);
        });
      },
      return: (): Promise<IteratorResult<ByteChannel>> => {
        const waiter = state.waiter;
        state.waiter = undefined;
        this.#finish(state);
        waiter?.resolve({ value: undefined, done: true });
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  close(): Promise<void> {
    // Every source is closed and the queue cleaned up even if one fails; then the first failure rejects.
    this.#closing ??= Promise.allSettled(this.#sources.map(async (s) => s.close())).then((results) => {
      const state = this.#state;
      if (state !== undefined) {
        for (const channel of state.queue.splice(0)) channel.close();
        this.#wake(state);
      }
      const failed = results.find((r) => r.status === "rejected");
      if (failed !== undefined) throw failed.reason;
    });
    return this.#closing;
  }

  async #pump(state: MergeState, it: AsyncIterator<ByteChannel>): Promise<void> {
    try {
      for (;;) {
        const r = await it.next();
        if (r.done === true) break;
        // Arrived after the iteration ended (or the listener closed): nobody will take it.
        if (state.finished || this.#closing !== undefined) {
          r.value.close();
          continue;
        }
        state.queue.push(r.value);
        this.#wake(state);
      }
    } catch (e) {
      if (!state.finished) state.error ??= { value: e };
    } finally {
      state.active--;
      this.#wake(state);
    }
  }

  /** Settles the pending next(): a queued channel, then a source's error (once), then done when all ended. */
  #wake(state: MergeState): void {
    const waiter = state.waiter;
    if (waiter === undefined) return;
    const channel = state.queue.shift();
    if (channel !== undefined) {
      state.waiter = undefined;
      waiter.resolve({ value: channel, done: false });
      return;
    }
    const error = state.error;
    if (error !== undefined) {
      state.error = undefined;
      state.waiter = undefined;
      waiter.reject(error.value);
      return;
    }
    if (state.active === 0 || this.#closing !== undefined) {
      state.waiter = undefined;
      this.#finish(state);
      waiter.resolve({ value: undefined, done: true });
    }
  }

  #finish(state: MergeState): void {
    if (state.finished) return;
    state.finished = true;
    if (this.#state === state) this.#state = undefined;
    for (const it of state.iterators) quietReturn(it);
    for (const channel of state.queue.splice(0)) channel.close();
  }
}

/**
 * One {@link Listener} over several: iterating it yields the channels of all of them until all ended (an
 * iteration error of one is delivered once to `next()`); `close()` closes all; `address` is the first one's. One
 * iteration at a time (a second concurrent one is a `TypeError`); after `return()` it may be iterated again. It has
 * `bindRegistry` (§5.4) if a source has one: the first such source's (a unix path socket).
 *
 * @throws {TypeError} for an empty list.
 */
export function mergeListeners(listeners: readonly Listener[]): Listener {
  const first = listeners[0];
  if (first === undefined) throw new TypeError("mergeListeners needs at least one listener");
  return new MergedListener([...listeners], first.address);
}

/**
 * The socket-activation listener (DESIGN.md §5.8; sd_listen_fds_with_names + sd_varlink_server_listen_name), or
 * `null` if we were not activated (`LISTEN_PID` absent or not our pid; `LISTEN_FDS` absent) or no fd has the name.
 * `LISTEN_PIDFDID` is ignored: Node cannot read the inode id of its own pidfd. `LISTEN_FDS` must be a positive
 * decimal ≤ 1024 and `LISTEN_FDNAMES`, if set, must have as many `:`-separated names (empty ones count). The fds
 * (3, 4, …) named `options.name` (default `"varlink"`) are used; without `LISTEN_FDNAMES` a single fd is used too
 * (sd-varlink would name it "unknown"). Each becomes a listener per `options.accept`: a listening socket via
 * `listen({fd})` (address from `/proc` on Linux, else as `listen()` derives it), a connected one as a listener that
 * yields that one connection, then ends. Several fds give one merged listener ({@link mergeListeners}). The
 * variables (and `VARLINK_JS_ACTIVATION`, below) are unset unless `unsetEnvironment` is false, also when this throws
 * (invalid options included) or returns `null`.
 *
 * `VARLINK_JS_ACTIVATION=connected` is a varlink-js-private hint that a connected-mode `exec:` of varlink-js sets:
 * with `accept: "auto"`, an fd `/proc` says nothing about (any system but Linux, or a socket `/proc` does not list)
 * is then taken as connected instead of listening. Any other value, or the variable absent, changes nothing; it is
 * never consulted in the other `accept` modes or where `/proc` knows the socket.
 *
 * The activation fds are not close-on-exec (systemd's `sd_listen_fds` sets `FD_CLOEXEC`; Node cannot without the
 * native addon, M11), so a child process inherits fds 3 … 3 + `LISTEN_FDS` − 1, listening sockets included. Every
 * fd seen in `LISTEN_FDS` is recorded, and varlink-js's own spawners (`exec:`, bridges, ssh) put `/dev/null` on
 * those fd numbers in their children; a `child_process` spawn of your own does not: pass `/dev/null` (or
 * `"ignore"` and an `stdio` array that covers those numbers) for them yourself.
 *
 * @throws {TypeError} (as a rejection) for invalid options or malformed `LISTEN_FDS`/`LISTEN_FDNAMES`.
 */
export async function listenFromEnv(options?: ActivationOptions): Promise<Listener | null> {
  const env = process.env;
  const pid = env.LISTEN_PID;
  const count = env.LISTEN_FDS;
  const names = env.LISTEN_FDNAMES;
  const hint = env[ACTIVATION_HINT_ENV];
  // Unset before anything can throw (only an explicit `false` keeps them; an invalid value throws below).
  if (options?.unsetEnvironment !== false) for (const key of ACTIVATION_ENV) Reflect.deleteProperty(env, key);
  const name = options?.name ?? "varlink";
  if (typeof name !== "string") throw new TypeError("name must be a string");
  const unset = options?.unsetEnvironment ?? true;
  if (typeof unset !== "boolean") throw new TypeError("unsetEnvironment must be a boolean");
  const accept = checkMode(options?.accept, "accept", ["auto", "listening", "connected"], "auto");
  if (pid === undefined || !/^[0-9]+$/.test(pid) || Number(pid) !== process.pid) return null;
  if (count === undefined) return null;
  if (!/^[0-9]+$/.test(count) || Number(count) < 1 || Number(count) > MAX_LISTEN_FDS)
    throw new TypeError(`LISTEN_FDS must be a decimal from 1 to ${String(MAX_LISTEN_FDS)}`);
  const n = Number(count);
  // All of them, whatever their names: none may leak into our children (spawn.ts).
  recordActivationFds(LISTEN_FDS_START, n);
  const fdNames = names?.split(":");
  if (fdNames !== undefined && fdNames.length !== n)
    throw new TypeError(`LISTEN_FDNAMES has ${String(fdNames.length)} names for ${String(n)} fds (LISTEN_FDS)`);
  const selected: number[] = [];
  for (let i = 0; i < n; i++)
    if (fdNames === undefined ? n === 1 : fdNames[i] === name) selected.push(LISTEN_FDS_START + i);
  if (selected.length === 0) return null;
  const proc = process.platform === "linux" ? procSockets() : new Map<string, ProcSocket>();
  const listeners: Listener[] = [];
  try {
    for (const fd of selected) {
      const inode = proc.size === 0 ? undefined : socketInode(fd);
      const info = inode === undefined ? undefined : proc.get(inode);
      // /proc silent (not Linux, or an unknown inode): only our own exec:'s hint can say "connected".
      const connected = info === undefined ? hint === "connected" : !info.listening;
      const mode = accept === "auto" ? (connected ? "connected" : "listening") : accept;
      if (mode === "connected") listeners.push(connectedListener(fd, info?.address));
      else listeners.push(await listen({ fd }, info?.address === undefined ? {} : { address: info.address }));
    }
  } catch (e) {
    await Promise.allSettled(listeners.map((l) => l.close()));
    throw e;
  }
  const [only] = listeners;
  return listeners.length === 1 && only !== undefined ? only : mergeListeners(listeners);
}

/** Ends `process.stdout` (on a socket: FIN; elsewhere harmless); never throws. */
function endStdout(): void {
  try {
    process.stdout.end();
  } catch {
    // A stdout that cannot end has nothing to tell the peer either.
  }
}

/**
 * The stdio channel: Node never closes fds 0 and 1 (destroying `process.stdout` leaves the fd open), so `end()` and
 * `close()` also end `process.stdout`, which on a socket (libuv's `"pipe"` stdio, ssh) sends FIN.
 */
function stdioChannel(): ByteChannel {
  const inner = fromNodeStreams(process.stdin, process.stdout);
  return {
    capabilities: inner.capabilities,
    closed: inner.closed,
    read: () => inner.read(),
    write: (chunk) => inner.write(chunk),
    end: () => {
      endStdout();
      return inner.end();
    },
    close: (reason) => {
      endStdout();
      inner.close(reason);
    },
  };
}

/**
 * A listener that yields one connection over `process.stdin`/`process.stdout` ({@link fromNodeStreams}), then ends
 * (`SYSTEMD_VARLINK_LISTEN=-`, what `ssh-exec:` and bridges rely on). `address` is `stdio:`, which is not a dialable
 * varlink address. Nothing else may write to stdout while it is served (use stderr for logs). The streams are
 * touched only when the channel is taken; `close()` before that leaves them alone.
 *
 * **A stdio-served process must exit when this connection ends.** Node cannot close fds 0 and 1 (sd-varlink
 * `dup`s them away; that needs the native addon): closing the channel ends `process.stdout`, which sends FIN on a
 * socket stdout (what our spawners and ssh give a child) but cannot close a pipe or a terminal, so the peer may see
 * EOF only when the process exits. Serve with `exitOnIdle` and `await server.closed; process.exit()`.
 */
export function listenStdio(): Listener {
  return new OneShotListener("stdio:", stdioChannel, () => undefined);
}

/**
 * Everything we were given to serve on, like `sd_varlink_server_listen_auto`: the fds from {@link listenFromEnv}
 * plus, if `SYSTEMD_VARLINK_LISTEN` is set, `-` → {@link listenStdio}, anything else → `listen(value, { mode })`;
 * merged into one listener, or `null` if there is nothing. `SYSTEMD_VARLINK_LISTEN` is not unset (sd-varlink
 * parity; our spawners strip it from children). Typical activated service:
 * `server.serve((await listenAuto()) ?? (await listen(fallback))); await server.closed; process.exit(0)` with
 * `exitOnIdle` set: a stdio-served process must exit when its connection ends (see {@link listenStdio}).
 *
 * @throws as {@link listenFromEnv} and `listen()` (as a rejection; what was opened is closed again).
 */
export async function listenAuto(options?: ListenAutoOptions): Promise<Listener | null> {
  const { mode, ...activation } = options ?? {};
  const fromEnv = await listenFromEnv(activation);
  const value = process.env.SYSTEMD_VARLINK_LISTEN;
  if (value === undefined) return fromEnv;
  let extra: Listener;
  try {
    extra = value === "-" ? listenStdio() : await listen(value, mode === undefined ? {} : { mode });
  } catch (e) {
    await fromEnv?.close().catch(() => undefined);
    throw e;
  }
  return fromEnv === null ? extra : mergeListeners([fromEnv, extra]);
}
