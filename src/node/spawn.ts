// Spawned transports (DESIGN.md §4.6, §5.8): exec: (socket activation of a child), bridge argv (varlink on a
// child's stdio), ssh-unix: and ssh-exec:. Reference: sd-varlink.c (connect_exec, ssh_unix, ssh_exec).
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { closeSync, constants as fsConstants, openSync } from "node:fs";
import { access, mkdtemp, rename, rm } from "node:fs/promises";
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { AddressSpec } from "../core/address/parse.ts";
import { CallTimeoutError, OperationNotSupportedError, safeQuote } from "../core/errors/local.ts";
import type { ByteChannel, ReadChunk } from "../core/protocol/channel.ts";
import { createConnection, DEFAULT_TIMEOUT, type Connection, type ConnectionOptions } from "../rpc/connection.ts";
import { checkMode, checkTimeout } from "../rpc/util.ts";
import { ACTIVATION_HINT_ENV, inheritedActivationFds } from "./activation-fds.ts";
import { fromNodeSocket } from "./socket.ts";
import { fromNodeStreams } from "./spawn-channel.ts";

/** How a spawned child is run (every spawn kind). */
export interface SpawnProcessOptions {
  /**
   * The child's environment; default `process.env`. `LISTEN_PID`, `LISTEN_PIDFDID`, `LISTEN_FDS`, `LISTEN_FDNAMES`,
   * `SYSTEMD_VARLINK_LISTEN`, `VARLINK_ADDRESS` and `VARLINK_JS_ACTIVATION` are always removed (activation variables
   * meant for us must not leak to the child), then the kind's own variables are added. `undefined` values are
   * dropped.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /** The child's working directory; default ours. */
  cwd?: string;
  /** The child's stderr: our stderr (default) or `/dev/null`. */
  stderr?: "inherit" | "ignore";
  /**
   * ms between SIGTERM and SIGKILL when the channel closes while the child still runs; default 2000; 0 = SIGKILL
   * at once.
   */
  killTimeout?: number;
  /** ssh kinds: the ssh binary; default `$SYSTEMD_SSH`, else `ssh` (looked up in `PATH`). */
  ssh?: string;
}

/** {@link SpawnProcessOptions} plus the `exec:` specifics. */
export interface ExecProcessOptions extends SpawnProcessOptions {
  /**
   * The full argv including argv[0]; default `[command]`. The child is started through `/bin/sh -c '… exec "$0"
   * "$@"'` (to set `LISTEN_PID` to its own pid), so the argv[0] it sees is always `command`: argv[0] here is ignored.
   */
  argv?: readonly string[];
  /**
   * The activation socket the child gets as fd 3: `"connected"` (default; one end of a unix socketpair, what
   * sd-varlink/varlinkctl pass and systemd services expect; `VARLINK_JS_ACTIVATION=connected` is set too, so a
   * varlink-js child's `listenFromEnv` knows it without `/proc`) or `"listening"` (a listening unix socket in a
   * private 0700 directory, also named in `VARLINK_ADDRESS`, as libvarlink/python-varlink `--activate` do; we
   * connect to it). In `"listening"` mode the child's fd 3 is non-blocking (`O_NONBLOCK` lives on the open file
   * description we share, and libuv set it): a child doing a blocking `accept()` must handle `EAGAIN` (poll first).
   */
  socket?: "connected" | "listening";
}

/** Options for {@link connectBridge} (and the ssh kinds): the connection's options, the process options, `signal`. */
export interface SpawnOptions extends ConnectionOptions, SpawnProcessOptions {
  /** Aborts the connect phase (spawning; the promise rejects with the signal's reason; the child is killed). */
  signal?: AbortSignal;
}

/** Options for {@link connectExec}. */
export interface ExecOptions extends SpawnOptions, ExecProcessOptions {}

/** A channel to a spawned child (internal): closing it kills the child; `closed` waits for its exit. */
export interface SpawnedChannel extends ByteChannel {
  readonly child: ChildProcess;
}

/** Address kinds served by spawning a process. */
export type SpawnAddress = Extract<AddressSpec, { kind: "exec" | "ssh-unix" | "ssh-exec" }>;

/**
 * Activation variables never passed on to a child (an inherited LISTEN_PIDFDID would make it ignore its fds; the
 * listening mode sets its own VARLINK_ADDRESS, the connected one its own hint).
 */
const STRIPPED_ENV = [
  "LISTEN_PID",
  "LISTEN_PIDFDID",
  "LISTEN_FDS",
  "LISTEN_FDNAMES",
  "SYSTEMD_VARLINK_LISTEN",
  "VARLINK_ADDRESS",
  ACTIVATION_HINT_ENV,
];

/** Sets LISTEN_PID to the shell's pid, then execs the command in its place (Node cannot set env after fork). */
const LISTEN_PID_SCRIPT = 'LISTEN_PID=$$; export LISTEN_PID; exec "$0" "$@"';

/**
 * The connected mode's script: also the hint that fd 3 is connected (activation.ts), tied to the same pid as
 * LISTEN_PID so that a grandchild inheriting a stale copy ignores it.
 */
const CONNECTED_SCRIPT = `LISTEN_PID=$$; ${ACTIVATION_HINT_ENV}=connected:$$; export LISTEN_PID ${ACTIVATION_HINT_ENV}; exec "$0" "$@"`;

const DEFAULT_KILL_TIMEOUT = 2000;

interface CheckedProcessOptions {
  readonly env: Record<string, string>;
  readonly cwd: string | undefined;
  readonly stderr: "inherit" | "ignore";
  readonly killTimeout: number;
  readonly ssh: string;
  readonly argv: readonly string[] | undefined;
  readonly socket: "connected" | "listening";
}

function checkProcessOptions(options: ExecProcessOptions | undefined): CheckedProcessOptions {
  const o = options ?? {};
  const envOption: unknown = o.env;
  if (envOption !== undefined && (typeof envOption !== "object" || envOption === null))
    throw new TypeError("env must be an object");
  if (o.cwd !== undefined && typeof o.cwd !== "string") throw new TypeError("cwd must be a string");
  if (o.ssh !== undefined && (typeof o.ssh !== "string" || o.ssh === ""))
    throw new TypeError("ssh must be a non-empty string");
  if (o.argv !== undefined) {
    if (!Array.isArray(o.argv) || o.argv.length === 0 || !o.argv.every((a) => typeof a === "string"))
      throw new TypeError("argv must be a non-empty array of strings");
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(o.env ?? process.env))
    if (value !== undefined && !STRIPPED_ENV.includes(key)) env[key] = value;
  const fromEnv = process.env.SYSTEMD_SSH;
  return {
    env,
    cwd: o.cwd,
    stderr: checkMode(o.stderr, "stderr", ["inherit", "ignore"], "inherit"),
    killTimeout: checkTimeout(o.killTimeout, "killTimeout", DEFAULT_KILL_TIMEOUT),
    ssh: o.ssh ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : "ssh"),
    argv: o.argv,
    socket: checkMode(o.socket, "socket", ["connected", "listening"], "connected"),
  };
}

/** An absolute, normalized path without a trailing slash (sd-varlink's `path_is_absolute && path_is_normalized`). */
function isNormalizedAbsolute(path: string): boolean {
  return path.startsWith("/") && posix.normalize(path) === path && (path === "/" || !path.endsWith("/"));
}

/** ssh hosts: non-empty, no option injection (`-…`, stricter than sd-varlink), no whitespace or control chars. */
function checkHost(host: string): void {
  if (host === "") throw new TypeError("empty ssh host");
  if (host.startsWith("-")) throw new TypeError(`ssh host ${safeQuote(host)} must not start with '-'`);
  if (/[\s\p{Cc}]/u.test(host)) throw new TypeError(`ssh host ${safeQuote(host)} contains whitespace or controls`);
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  s: " ",
  "\\": "\\",
  '"': '"',
  "'": "'",
};

/** Parses the escape after a backslash at `text[i - 1]`; appends its bytes; returns the index after it. */
function unescapeAt(text: string, i: number, bytes: number[]): number {
  const bad = (why: string): never => {
    throw new TypeError(`invalid command line ${safeQuote(text)}: ${why}`);
  };
  const c = text[i];
  if (c === undefined) return bad("trailing backslash");
  const simple = SIMPLE_ESCAPES[c];
  if (simple !== undefined) {
    bytes.push(simple.charCodeAt(0));
    return i + 1;
  }
  const digits = (count: number, re: RegExp, radix: number): number => {
    const s = text.slice(i + 1, i + 1 + count);
    if (s.length !== count || !re.test(s)) bad(`\\${c} needs ${String(count)} digits`);
    const value = parseInt(s, radix);
    if (value === 0) bad("NUL in an escape");
    return value;
  };
  if (c === "x") {
    bytes.push(digits(2, /^[0-9a-fA-F]+$/, 16));
    return i + 3;
  }
  if (c === "u" || c === "U") {
    const count = c === "u" ? 4 : 8;
    const cp = digits(count, /^[0-9a-fA-F]+$/, 16);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) bad(`invalid code point in \\${c}`);
    bytes.push(...new TextEncoder().encode(String.fromCodePoint(cp)));
    return i + 1 + count;
  }
  if (c >= "0" && c <= "7") {
    // Exactly three octal digits, as sd's cunescape_one: \NNN (≤ \377).
    const s = text.slice(i, i + 3);
    if (!/^[0-7]{3}$/.test(s)) bad("octal escapes need 3 digits");
    const value = parseInt(s, 8);
    if (value === 0) bad("NUL in an escape");
    if (value > 0o377) bad("octal escape above \\377");
    bytes.push(value);
    return i + 3;
  }
  return bad(`unknown escape \\${c}`);
}

/**
 * Splits an `ssh-exec:` command line into words like sd-varlink (`strv_split_full(EXTRACT_UNQUOTE |
 * EXTRACT_CUNESCAPE)`): words are separated by spaces, tabs, CR and LF; `'…'` and `"…"` quote alike, backslash escapes
 * included (sd's extract_first_word: systemd 2336319d src/basic/extract-word.c); quotes may appear inside a word
 * (`a'b c'` is `ab c`) and `''` is an empty word; C escapes are decoded everywhere (`\a \b \f \n \r \t \v \s \\ \" \' \xNN \NNN` (3 octal digits) `\uXXXX \UXXXXXXXX`); the
 * resulting bytes must be valid UTF-8. Internal (exported for tests).
 *
 * @throws {TypeError} for an unterminated quote, a trailing backslash, an unknown or NUL escape, invalid UTF-8.
 */
export function splitCommandLine(text: string): string[] {
  const words: string[] = [];
  const encoder = new TextEncoder();
  const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
  let i = 0;
  for (;;) {
    while (i < text.length && isSpace(text.charAt(i))) i++;
    if (i >= text.length) return words;
    const bytes: number[] = [];
    let quote: "'" | '"' | undefined;
    while (i < text.length) {
      const c = String.fromCodePoint(text.codePointAt(i) ?? 0);
      if (quote === undefined && isSpace(c)) break;
      i += c.length;
      if (c === quote) quote = undefined;
      else if (quote === undefined && (c === "'" || c === '"')) quote = c;
      else if (c === "\\") i = unescapeAt(text, i, bytes);
      else bytes.push(...encoder.encode(c));
    }
    if (quote !== undefined) throw new TypeError(`invalid command line ${safeQuote(text)}: unterminated ${quote}`);
    try {
      words.push(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)));
    } catch {
      throw new TypeError(`invalid command line ${safeQuote(text)}: escapes do not form valid UTF-8`);
    }
  }
}

/** A spawned child: its exit, and the SIGTERM → SIGKILL sequence. */
class ChildHandle {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  readonly #killTimeout: number;
  #terminating = false;

  constructor(child: ChildProcess, killTimeout: number) {
    this.child = child;
    this.#killTimeout = killTimeout;
    this.exited = new Promise((resolve) => {
      child.once("exit", () => {
        resolve();
      });
      // A failed spawn (ENOENT, EACCES, …) emits `error` and never `exit`.
      child.once("error", () => {
        if (child.pid === undefined) resolve();
      });
    });
    // Always listening: a spawn or kill error must never be an unhandled `error` event.
    child.on("error", () => undefined);
  }

  get running(): boolean {
    const child = this.child;
    return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  }

  /** Resolves once the child spawned; rejects with the spawn error. */
  spawned(): Promise<void> {
    const child = this.child;
    return new Promise((resolve, reject) => {
      const onSpawn = (): void => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  /** SIGTERM now (unless killTimeout is 0), SIGKILL after killTimeout if it still runs. Idempotent. */
  terminate(): void {
    if (this.#terminating || !this.running) return;
    this.#terminating = true;
    if (this.#killTimeout === 0) {
      this.child.kill("SIGKILL");
      return;
    }
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (this.running) this.child.kill("SIGKILL");
    }, this.#killTimeout);
    timer.unref();
    void this.exited.then(() => {
      clearTimeout(timer);
    });
  }

  /** A failed connect phase: drop the pipes and kill the child. */
  abandon(): void {
    for (const stream of this.child.stdio) stream?.destroy();
    this.terminate();
  }
}

/**
 * The transport plus the child: `close()` SIGTERMs a still-running child (SIGKILL after killTimeout); `closed`
 * waits for the transport and the child's exit, then runs `cleanup`. A Connection closes its channel on EOF too, so
 * a child that shuts its side down while it still runs is signalled then (sd-varlink kills its exec child too); a
 * child that already exited is not signalled.
 */
class ChildChannel implements SpawnedChannel {
  readonly capabilities: ByteChannel["capabilities"] = {};
  readonly closed: Promise<void>;
  readonly child: ChildProcess;
  readonly #inner: ByteChannel;
  readonly #handle: ChildHandle;

  constructor(inner: ByteChannel, handle: ChildHandle, cleanup?: () => Promise<void>) {
    this.#inner = inner;
    this.#handle = handle;
    this.child = handle.child;
    // Only close() signals the child, and only while it runs (an exited child is not signalled).
    this.closed = Promise.all([inner.closed, handle.exited])
      .then(() => cleanup?.())
      .then(
        () => undefined,
        () => undefined,
      );
  }

  read(): Promise<ReadChunk | null> {
    return this.#inner.read();
  }

  write(chunk: Uint8Array): Promise<void> {
    return this.#inner.write(chunk);
  }

  end(): Promise<void> {
    return this.#inner.end();
  }

  close(reason?: unknown): void {
    this.#inner.close(reason);
    this.#handle.terminate();
  }
}

/** A child's stdio as an array (one entry per fd). */
type StdioSlots = Extract<StdioOptions, readonly unknown[]>;

/** The stdio of a child: stdin ignored or a pipe, stdout to our fd 2 or a pipe, stderr per option, then fd 3. */
function stdioFor(kind: "exec" | "stdio", stderr: "inherit" | "ignore", fd3?: number | "pipe"): StdioSlots {
  const err = stderr === "inherit" ? 2 : "ignore";
  // exec: the child's stdout goes to our stderr, never our stdout (we may be a stdio-served varlink server).
  if (kind === "exec") return fd3 === undefined ? ["ignore", 2, err] : ["ignore", 2, err, fd3];
  return ["pipe", "pipe", err];
}

/** The activation fds we inherited (`listenFromEnv`) that a child with `slots` stdio entries would get as they are. */
function uncoveredActivationFds(slots: number): number[] {
  return inheritedActivationFds().filter((fd) => fd >= 3 && fd >= slots);
}

/**
 * Spawns with `stdio` extended by `/dev/null` on every uncovered activation fd: those are not close-on-exec (Node
 * cannot set FD_CLOEXEC), and our children must not get them. They are contiguous from 3, so the array gets no gaps.
 */
function spawnChild(file: string, args: readonly string[], o: CheckedProcessOptions, stdio: StdioSlots): ChildHandle {
  const options = { env: o.env, ...(o.cwd === undefined ? {} : { cwd: o.cwd }) };
  const slots = [...stdio];
  const uncovered = uncoveredActivationFds(slots.length);
  if (uncovered.length === 0) return new ChildHandle(spawn(file, args, { ...options, stdio }), o.killTimeout);
  // One /dev/null per spawn, which libuv dup2s onto each slot; ours is closed once the child has its copies.
  const devNull = openSync("/dev/null", "r+");
  let open = true;
  const release = (): void => {
    if (!open) return;
    open = false;
    closeSync(devNull);
  };
  for (const fd of uncovered) {
    while (slots.length < fd) slots.push("ignore");
    slots[fd] = devNull;
  }
  let child: ChildProcess;
  try {
    child = spawn(file, args, { ...options, stdio: slots });
  } catch (e) {
    release();
    throw e;
  }
  child.once("spawn", release);
  child.once("error", release);
  return new ChildHandle(child, o.killTimeout);
}

/** The private `_handle.fd` of a listening net.Server, or an OperationNotSupportedError. */
function listeningFd(server: Server): number {
  const fd = (server as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  if (typeof fd !== "number" || fd < 0)
    throw new OperationNotSupportedError("this runtime does not expose a listening socket's fd (exec: listening)");
  return fd;
}

function bindPath(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path }, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** Connects to a unix socket path; the attempt is destroyed when `phase` aborts. */
function connectPath(path: string, phase: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (phase.aborted) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the abort reason as is
      reject(phase.reason);
      return;
    }
    const socket = netConnect({ path, allowHalfOpen: true });
    const done = (error: unknown): void => {
      phase.removeEventListener("abort", onAbort);
      socket.off("connect", onConnect);
      socket.off("error", done);
      if (error === undefined) {
        resolve(socket);
        return;
      }
      socket.on("error", () => undefined);
      socket.destroy();
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the Node error or abort reason
      reject(error);
    };
    const onConnect = (): void => {
      done(undefined);
    };
    const onAbort = (): void => {
      done(phase.reason);
    };
    socket.once("connect", onConnect);
    socket.once("error", done);
    phase.addEventListener("abort", onAbort, { once: true });
  });
}

/** `exec:` (sd-varlink connect_exec): the child gets the activation socket as fd 3 and `LISTEN_*` set for it. */
async function openExec(command: string, o: CheckedProcessOptions, phase: AbortSignal): Promise<SpawnedChannel> {
  if (!isNormalizedAbsolute(command))
    throw new TypeError(`exec: needs an absolute, normalized path, not ${safeQuote(command)}`);
  // A missing or non-executable binary rejects with ENOENT/EACCES (the shell would only exit 126/127).
  await access(command, fsConstants.X_OK);
  phase.throwIfAborted();
  const argv = o.argv ?? [command];
  const env = { ...o.env, LISTEN_FDS: "1", LISTEN_FDNAMES: "varlink" };
  if (o.socket === "listening")
    return openExecListening(["-c", LISTEN_PID_SCRIPT, command, ...argv.slice(1)], { ...o, env }, phase);
  // The script tells a varlink-js child that fd 3 is connected where it cannot ask /proc (activation.ts).
  const args = ["-c", CONNECTED_SCRIPT, command, ...argv.slice(1)];
  const handle = spawnChild("/bin/sh", args, { ...o, env }, stdioFor("exec", o.stderr, "pipe"));
  try {
    await handle.spawned();
    phase.throwIfAborted();
  } catch (e) {
    handle.abandon();
    throw e;
  }
  // libuv makes "pipe" stdio an AF_UNIX socketpair: the child's fd 3 is a connected stream socket.
  const socket = handle.child.stdio[3] as Socket;
  // Our write side must outlive the child's FIN (and the child may still answer after ours).
  socket.allowHalfOpen = true;
  return new ChildChannel(fromNodeSocket(socket), handle);
}

/** `exec:` with a listening socket (python-varlink/libvarlink `--activate` style). */
async function openExecListening(
  args: readonly string[],
  o: CheckedProcessOptions,
  phase: AbortSignal,
): Promise<SpawnedChannel> {
  const dir = await mkdtemp(join(tmpdir(), "varlink-exec-"));
  const path = join(dir, "socket");
  const server = createServer();
  server.on("error", () => undefined);
  let handle: ChildHandle | undefined;
  try {
    // Bound under a temporary name and moved into place: libuv unlinks the bound name when we close our copy.
    await bindPath(server, `${path}.tmp`);
    await rename(`${path}.tmp`, path);
    const fd = listeningFd(server);
    phase.throwIfAborted();
    handle = spawnChild(
      "/bin/sh",
      args,
      { ...o, env: { ...o.env, VARLINK_ADDRESS: `unix:${path}` } },
      stdioFor("exec", o.stderr, fd),
    );
    try {
      await handle.spawned();
    } finally {
      // Only the child listens from now on (it has its own copy of the fd), so our connect is the child's to accept.
      server.close();
    }
    phase.throwIfAborted();
    const socket = await connectPath(path, phase);
    return new ChildChannel(fromNodeSocket(socket), handle, () => rm(dir, { recursive: true, force: true }));
  } catch (e) {
    if (server.listening) server.close();
    handle?.abandon();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

/** Varlink over a child's stdin/stdout (bridge, ssh-unix, ssh-exec). */
async function openStdio(
  file: string,
  args: readonly string[],
  o: CheckedProcessOptions,
  phase: AbortSignal,
): Promise<SpawnedChannel> {
  phase.throwIfAborted();
  const handle = spawnChild(file, args, o, stdioFor("stdio", o.stderr));
  try {
    await handle.spawned();
    phase.throwIfAborted();
  } catch (e) {
    handle.abandon();
    throw e;
  }
  const { stdin, stdout } = handle.child;
  if (stdin === null || stdout === null) {
    handle.abandon();
    throw new OperationNotSupportedError("the child has no stdio pipes");
  }
  return new ChildChannel(fromNodeStreams(stdout, stdin), handle);
}

/** The channel for a spawn address kind (internal; connect() and the tests use it). */
export async function openSpawned(
  spec: SpawnAddress,
  options: ExecProcessOptions | undefined,
  phase: AbortSignal,
): Promise<SpawnedChannel> {
  const o = checkProcessOptions(options);
  switch (spec.kind) {
    case "exec":
      return openExec(spec.path, o, phase);
    case "ssh-unix":
      checkHost(spec.host);
      if (!isNormalizedAbsolute(spec.path))
        throw new TypeError(`ssh-unix: needs an absolute, normalized path, not ${safeQuote(spec.path)}`);
      return openStdio(o.ssh, ["-W", spec.path, spec.host], o, phase);
    case "ssh-exec": {
      checkHost(spec.host);
      const words = splitCommandLine(spec.command);
      if (words.length === 0) throw new TypeError("ssh-exec: needs a command");
      return openStdio(o.ssh, ["-e", "none", "-T", spec.host, "env", "SYSTEMD_VARLINK_LISTEN=-", ...words], o, phase);
    }
  }
}

/** The bridge channel (internal; {@link connectBridge} and the tests use it). */
export async function openBridge(
  argv: readonly string[],
  options: SpawnProcessOptions | undefined,
  phase: AbortSignal,
): Promise<SpawnedChannel> {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string"))
    throw new TypeError("connectBridge needs a non-empty argv array of strings");
  const [file = "", ...args] = argv;
  return openStdio(file, args, checkProcessOptions(options), phase);
}

/** The connect phase as one signal: `timeout` (ms, 0 = none) and the caller's `signal`. */
function connectPhase(timeout: number, signal: AbortSignal | undefined): { signal: AbortSignal; done(): void } {
  const ac = new AbortController();
  const onAbort = (): void => {
    ac.abort(signal?.reason);
  };
  if (signal?.aborted === true) ac.abort(signal.reason);
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer =
    timeout > 0
      ? setTimeout(() => {
          ac.abort(new CallTimeoutError("connect timed out"));
        }, timeout)
      : undefined;
  return {
    signal: ac.signal,
    done: () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Separates the process options from the connection options. */
function splitOptions(options: ExecOptions | undefined): {
  processOptions: ExecProcessOptions;
  connection: ConnectionOptions;
  signal: AbortSignal | undefined;
} {
  const { signal, env, cwd, stderr, killTimeout, ssh, argv, socket, ...connection } = options ?? {};
  const processOptions: ExecProcessOptions = {
    ...(env === undefined ? {} : { env }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(stderr === undefined ? {} : { stderr }),
    ...(killTimeout === undefined ? {} : { killTimeout }),
    ...(ssh === undefined ? {} : { ssh }),
    ...(argv === undefined ? {} : { argv }),
    ...(socket === undefined ? {} : { socket }),
  };
  return { processOptions, connection, signal };
}

/** Opens a spawned channel within the connect phase and wraps it in a Connection. */
async function connectWith(
  connection: ConnectionOptions,
  signal: AbortSignal | undefined,
  open: (phase: AbortSignal) => Promise<SpawnedChannel>,
): Promise<Connection> {
  const timeout = checkTimeout(connection.timeout, "timeout", DEFAULT_TIMEOUT);
  const phase = connectPhase(timeout, signal);
  let channel: SpawnedChannel;
  try {
    channel = await open(phase.signal);
  } finally {
    phase.done();
  }
  try {
    return createConnection(channel, connection);
  } catch (e) {
    channel.close();
    throw e;
  }
}

/** connect() for the spawn kinds (internal): `spawn` holds the process options. */
export function connectSpawned(
  spec: SpawnAddress,
  connection: ConnectionOptions,
  spawnOptions: ExecProcessOptions | undefined,
  signal: AbortSignal | undefined,
): Promise<Connection> {
  return connectWith(connection, signal, (phase) => openSpawned(spec, spawnOptions, phase));
}

/**
 * Spawns `command` with socket activation and connects to it (`exec:` addresses, DESIGN.md §5.8; sd-varlink's
 * connect_exec). `command` must be an absolute, normalized path (else `TypeError`) and executable (else the
 * `ENOENT`/`EACCES` error). The child runs through `/bin/sh -c 'LISTEN_PID=$$; export LISTEN_PID; exec "$0" "$@"'`
 * (Node cannot set the environment after fork), so the argv[0] it sees is `command`; it gets `LISTEN_FDS=1`,
 * `LISTEN_FDNAMES=varlink`, fd 3 per `options.socket` (default a connected unix socket, plus
 * `VARLINK_JS_ACTIVATION=connected:<pid>`, set by the shell like `LISTEN_PID`; `"listening"` sets `VARLINK_ADDRESS`
 * instead), stdin from `/dev/null`, stdout
 * on our stderr, stderr per `options.stderr`, `/dev/null` on any other activation fd number we inherited, and the
 * environment of {@link SpawnProcessOptions.env} without the activation variables meant for us.
 *
 * Closing the connection destroys the transport and sends SIGTERM to a still-running child, SIGKILL after
 * `killTimeout`; `Connection.closed` resolves once the child exited (and the private directory of the listening
 * mode is removed). The connection closes on EOF too: a child that shuts its side down but keeps running is
 * signalled then (sd-varlink kills its exec child too); one that already exited is not. The connect phase
 * (spawning, the listening-mode connect) is bounded by `timeout` and `signal` as in `connect()`; the child is
 * killed on either.
 */
export function connectExec(command: string, options?: ExecOptions): Promise<Connection> {
  const { processOptions, connection, signal } = splitOptions(options);
  return connectWith(connection, signal, (phase) =>
    openSpawned({ kind: "exec", path: command }, processOptions, phase),
  );
}

/**
 * Spawns `argv[0]` with `argv.slice(1)` (no shell, `PATH` lookup as `execvp`) and speaks varlink over its stdin
 * and stdout (libvarlink/python-varlink `--bridge`). The child's environment and lifetime are as for
 * {@link connectExec} (no activation variables are added); a spawn failure (`ENOENT`, …) rejects.
 *
 * @throws {TypeError} (as a rejection) for an empty argv.
 */
export function connectBridge(argv: readonly string[], options?: SpawnOptions): Promise<Connection> {
  const { processOptions, connection, signal } = splitOptions(options);
  return connectWith(connection, signal, (phase) => openBridge(argv, processOptions, phase));
}
