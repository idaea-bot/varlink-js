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
import { listen } from "./listen.ts";
import { fromNodeSocket } from "./socket.ts";
import { fromNodeStreams } from "./spawn-channel.ts";

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
   * `exec:` socketpair). `"auto"` (default) asks `/proc` on Linux and assumes `"listening"` elsewhere (or when
   * `/proc` does not know the socket): on other systems a connected fd needs `"connected"`.
   */
  accept?: "auto" | "listening" | "connected";
}

/** Options for {@link listenAuto}. */
export interface ListenAutoOptions extends ActivationOptions {
  /** `SYSTEMD_VARLINK_LISTEN` naming a unix path: the socket's mode (see `listen()`). */
  mode?: number;
}

/** The variables `listenFromEnv` reads (and by default unsets). */
const ACTIVATION_ENV = ["LISTEN_PID", "LISTEN_PIDFDID", "LISTEN_FDS", "LISTEN_FDNAMES"];

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
      for (const it of iterators) void it.return?.();
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
    this.#closing ??= Promise.all(this.#sources.map((s) => s.close())).then(() => {
      const state = this.#state;
      if (state !== undefined) {
        for (const channel of state.queue.splice(0)) channel.close();
        this.#wake(state);
      }
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
    for (const it of state.iterators) void it.return?.();
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
 * variables are unset unless `unsetEnvironment` is false, also when this throws or returns `null`.
 *
 * @throws {TypeError} (as a rejection) for invalid options or malformed `LISTEN_FDS`/`LISTEN_FDNAMES`.
 */
export async function listenFromEnv(options?: ActivationOptions): Promise<Listener | null> {
  const name = options?.name ?? "varlink";
  if (typeof name !== "string") throw new TypeError("name must be a string");
  const unset = options?.unsetEnvironment ?? true;
  if (typeof unset !== "boolean") throw new TypeError("unsetEnvironment must be a boolean");
  const accept = checkMode(options?.accept, "accept", ["auto", "listening", "connected"], "auto");
  const env = process.env;
  const pid = env.LISTEN_PID;
  const count = env.LISTEN_FDS;
  const names = env.LISTEN_FDNAMES;
  if (unset) for (const key of ACTIVATION_ENV) Reflect.deleteProperty(env, key);
  if (pid === undefined || !/^[0-9]+$/.test(pid) || Number(pid) !== process.pid) return null;
  if (count === undefined) return null;
  if (!/^[0-9]+$/.test(count) || Number(count) < 1 || Number(count) > MAX_LISTEN_FDS)
    throw new TypeError(`LISTEN_FDS must be a decimal from 1 to ${String(MAX_LISTEN_FDS)}`);
  const n = Number(count);
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
      const mode = accept === "auto" ? (info === undefined || info.listening ? "listening" : "connected") : accept;
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

/**
 * A listener that yields one connection over `process.stdin`/`process.stdout` ({@link fromNodeStreams}), then ends
 * (`SYSTEMD_VARLINK_LISTEN=-`, what `ssh-exec:` and bridges rely on). `address` is `stdio:`, which is not a dialable
 * varlink address. Nothing else may write to stdout while it is served (use stderr for logs). The streams are
 * touched only when the channel is taken; `close()` before that leaves them alone.
 */
export function listenStdio(): Listener {
  return new OneShotListener(
    "stdio:",
    () => fromNodeStreams(process.stdin, process.stdout),
    () => undefined,
  );
}

/**
 * Everything we were given to serve on, like `sd_varlink_server_listen_auto`: the fds from {@link listenFromEnv}
 * plus, if `SYSTEMD_VARLINK_LISTEN` is set, `-` → {@link listenStdio}, anything else → `listen(value, { mode })`;
 * merged into one listener, or `null` if there is nothing. `SYSTEMD_VARLINK_LISTEN` is not unset (sd-varlink
 * parity; our spawners strip it from children). Typical activated service:
 * `server.serve((await listenAuto()) ?? (await listen(fallback))); await server.closed; process.exit(0)`.
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
