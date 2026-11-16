// The process side of the CLI (DESIGN.md §4.14), used only by main.ts: a CliIo over process.stdin/stdout/stderr,
// SIGINT/SIGTERM → io.signal, and the cleanup that lets the process exit by itself. M11: the optional
// varlink-js-native addon (`--push-fd=`, `--exec`) and the `--exec` command.
import { spawn, type StdioOptions } from "node:child_process";
import { closeSync, constants as fsConstants, fstatSync, openSync, readdirSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import { isatty } from "node:tty";
import { pathToFileURL } from "node:url";
import type { FdHandle } from "../core/protocol/index.ts";
import { closeFds } from "../core/protocol/framer.ts";
import { usableNative, type NativeAddon } from "../node/native.ts";
import {
  BrokenPipeError,
  CliError,
  describeError,
  escapeControls,
  isDisconnectCode,
  signalExitCode,
  type CliInput,
  type CliIo,
  type CliOutput,
  type ExecInput,
} from "./io.ts";

/**
 * The varlink-js-native addon: `VARLINK_JS_NATIVE` (a path to its index.js, for tests and unusual installs), else the
 * `varlink-js-native` package. Undefined when absent or unusable here (not built, not Linux/macOS).
 */
async function loadNative(env: NodeJS.ProcessEnv): Promise<NativeAddon | undefined> {
  const override = env.VARLINK_JS_NATIVE;
  const specifier =
    override !== undefined && override !== "" ? pathToFileURL(resolve(override)).href : "varlink-js-native";
  try {
    const mod = (await import(specifier)) as unknown;
    return usableNative(mod);
  } catch {
    return undefined;
  }
}

/** An fd the CLI owns, closed through the addon (idempotent). */
function ownedFd(fd: number, close: (fd: number) => void): FdHandle {
  let closed = false;
  return {
    fd,
    close() {
      if (closed) return;
      closed = true;
      try {
        close(fd);
      } catch {
        // Already closed.
      }
    },
  };
}

/** `--push-fd=`: a path opened read-only (close-on-exec, as Node opens files), or a duplicate of one of our fds. */
function openPushFd(spec: { fd: number } | { path: string }, native: NativeAddon): FdHandle {
  if ("path" in spec) return ownedFd(openSync(spec.path, fsConstants.O_RDONLY | fsConstants.O_NOCTTY), closeSync);
  return ownedFd(native.dup(spec.fd), (fd) => {
    native.close(fd);
  });
}

/**
 * varlinkctl's exec closes every fd but the ones it passes (close_all_fds, varlinkctl.c:686). A spawn cannot close
 * our fds in the child, but it does not inherit close-on-exec ones: with the addon, every open fd ≥ 3 is made so
 * (libuv's own are already). Best effort; without the addon, fds we inherited without it reach the command.
 */
function closeOnExecAll(native: NativeAddon | undefined): void {
  if (native === undefined) return;
  let names: string[];
  try {
    names = readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd");
  } catch {
    return;
  }
  for (const name of names) {
    const fd = Number(name);
    if (!Number.isSafeInteger(fd) || fd < 3) continue;
    try {
      native.setCloexec(fd);
    } catch {
      // Gone meanwhile (e.g. the directory's own fd).
    }
  }
}

/**
 * `call --exec` (varlinkctl.c:1122-1170, exec_with_listen_fds at 670-720): `command` runs with the reply on stdin (a
 * sealed memfd on Linux with the addon, as varlinkctl does; else a pipe), our stdout/stderr, and the reply's fds as
 * 3, 4, … with `LISTEN_FDS=n` and `LISTEN_PID` (the command's pid: set by `/bin/sh -c 'LISTEN_PID=$$ … exec …'`,
 * Node cannot set the environment after fork); `LISTEN_FDNAMES` is removed, and with no fds `LISTEN_FDS`/`LISTEN_PID`
 * too; `LISTEN_PIDFDID` is not set (Node cannot read a pidfd's inode id). The fds are closed here once the command
 * has them. Resolves with its exit status (128 + the signal's number after a signal). SIGTERM is passed on to it
 * (SIGINT from a terminal reaches it through the process group).
 */
function execCommand(command: readonly string[], input: ExecInput): Promise<number> {
  const [file, ...args] = command;
  if (file === undefined) return Promise.reject(new CliError("Expected command line to execute."));
  const native = input.native;
  let stdinFd: number | undefined;
  if (native !== undefined && process.platform === "linux") {
    try {
      stdinFd = native.memfdSealed?.("varlink-reply", input.reply);
    } catch {
      stdinFd = undefined;
    }
  }
  closeOnExecAll(native);
  const env: Record<string, string | undefined> = { ...input.env };
  delete env.LISTEN_FDNAMES;
  delete env.LISTEN_PIDFDID;
  const n = input.fds.length;
  let program = file;
  let argv = args;
  if (n > 0) {
    // The shell sets LISTEN_PID to the command's pid (Node cannot after fork). `exec -- "$0"` is not portable (dash
    // runs "--" as the command), so a command word starting with "-" must not reach `exec` as an option (bash's exec
    // takes -a/-c/-l): as a path it is made "./-…" (the same file), a bare name is refused.
    let target = file;
    if (target.startsWith("-")) {
      if (!target.includes("/"))
        return Promise.reject(
          new CliError(`Refusing to execute '${escapeControls(file)}': a command name may not start with '-'`),
        );
      target = `./${target}`;
    }
    env.LISTEN_FDS = String(n);
    delete env.LISTEN_PID;
    program = "/bin/sh";
    argv = ["-c", 'LISTEN_PID=$$; export LISTEN_PID; exec "$0" "$@"', target, ...args];
  } else {
    delete env.LISTEN_FDS;
    delete env.LISTEN_PID;
  }
  const stdio: StdioOptions = [stdinFd ?? "pipe", "inherit", "inherit", ...input.fds.map((f) => f.fd)];
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    const release = (): void => {
      if (stdinFd !== undefined) closeSync(stdinFd);
      stdinFd = undefined;
      closeFds(input.fds);
    };
    try {
      child = spawn(program, argv, { stdio, env });
    } catch (e) {
      release();
      process.stderr.write(`Failed to execute ${escapeControls(file)}: ${escapeControls(describeError(e))}\n`);
      resolvePromise(1);
      return;
    }
    const onAbort = (): void => {
      if (input.signal?.reason === "SIGTERM") child.kill("SIGTERM");
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("spawn", release);
    child.once("error", (e) => {
      release();
      input.signal?.removeEventListener("abort", onAbort);
      process.stderr.write(`Failed to execute ${escapeControls(file)}: ${escapeControls(describeError(e))}\n`);
      resolvePromise(1);
    });
    child.once("exit", (code, signal) => {
      input.signal?.removeEventListener("abort", onAbort);
      const number = signal === null ? undefined : (osConstants.signals as Record<string, number | undefined>)[signal];
      resolvePromise(code ?? 128 + (number ?? 0));
    });
    if (child.stdin !== null) {
      // The command may not read its stdin at all: EPIPE is fine.
      child.stdin.on("error", () => undefined);
      child.stdin.end(input.reply);
    }
  });
}

/** A CliIo bound to the process, plus `dispose()` (removes the signal handlers, releases stdin). */
export interface NodeIo extends CliIo {
  dispose(): void;
}

/** Resolves once `stream` emitted one of `events` (or at once if `ready`). */
function once(stream: NodeJS.WriteStream, events: readonly string[], ready: boolean): Promise<void> {
  if (ready) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      for (const event of events) stream.off(event, done);
      resolve();
    };
    for (const event of events) stream.on(event, done);
  });
}

/**
 * Ends stdout/stderr early so the reader sees EOF now, like socket-forward's socket_forward_direction_done:
 * `shutdown(SHUT_WR)`, or `close()` where the fd is no socket.
 * - A socket (also one shared with stdin, as socat's EXEC or inetd-style activation give it): `stream.end()`, which
 *   shuts its write side down once flushed; the fd stays open.
 * - Anything else (a pipe, a FIFO, a file): Node never closes fds 0-2, so once the stream has flushed and a later
 *   turn has come (libuv drops a pending writability watch on the fd first), the fd itself is closed and /dev/null
 *   opened in its place (the lowest free fd: the same number), so no later open reuses it. Not when stdout and stderr
 *   are the same file (same device and inode, e.g. `2>&1`): closing one fd would not end the reader's stream anyway,
 *   so that reader sees EOF when the process exits.
 *
 * A no-op on a TTY (nobody waits for its EOF) and on Windows; best effort, never rejects.
 */
async function endFd(stream: NodeJS.WriteStream, fd: number, tty: boolean): Promise<void> {
  if (tty || process.platform === "win32") return;
  try {
    // Everything written so far must reach the OS first (callers await each write, so this is normally at once; an
    // empty write's callback does not reliably fire on a pipe).
    await once(stream, ["drain", "close"], stream.writableLength === 0 || stream.destroyed);
    if (stream.destroyed) return;
    const stat = fstatSync(fd);
    if (stat.isSocket()) {
      // A failure (the reader is gone: ENOTCONN, EPIPE) reaches the `error` listener of output().
      const finished = once(stream, ["finish", "close", "error"], stream.writableFinished);
      stream.end();
      await finished;
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
    let other: { dev: number; ino: number } | undefined;
    try {
      other = fstatSync(fd === 1 ? 2 : 1);
    } catch {
      // The other fd is closed (`2>&-`): not the same file.
    }
    if (other !== undefined && other.dev === stat.dev && other.ino === stat.ino) return;
    closeSync(fd);
    // Kept open for good. Should some lower fd have been free, the placeholder got that number instead: kept too.
    openSync("/dev/null", "w");
  } catch {
    // Already closed, or /dev/null missing: the reader sees EOF at exit.
  }
}

/**
 * What a failed write to fd 1/2 rejects with: BrokenPipeError (the command stops quietly, exit 0) for EPIPE or any
 * other disconnect errno (ECONNRESET from a socket whose reader reset it; socket-forward ends that direction quietly
 * too), else a CliError.
 */
export function writeFailure(error: Error, fd: number): Error {
  return isDisconnectCode((error as NodeJS.ErrnoException).code)
    ? new BrokenPipeError(error.message)
    : new CliError(`Failed to write to ${fd === 1 ? "stdout" : "stderr"}: ${describeError(error)}`);
}

function output(stream: NodeJS.WriteStream, fd: number): CliOutput {
  let failure: Error | undefined;
  // Without a listener, an EPIPE `error` event would be an uncaught exception.
  stream.on("error", (error) => {
    failure ??= error;
  });
  const wrap = (error: Error): Error => writeFailure(error, fd);
  const tty = isatty(fd);
  return {
    isTTY: tty,
    end: () => endFd(stream, fd, tty),
    write(data) {
      return new Promise((resolve, reject) => {
        if (failure !== undefined) {
          reject(wrap(failure));
          return;
        }
        stream.write(data, (error) => {
          if (error) {
            failure ??= error;
            reject(wrap(error));
          } else {
            resolve();
          }
        });
      });
    },
  };
}

/**
 * The process's CliIo. stdin is opened only when a command reads it (isTTY comes from the fd, so asking does not
 * open it). The first SIGINT/SIGTERM aborts `signal` with the signal's name, so run() closes its connections and
 * returns 130/143; a second one exits at once with that status.
 *
 * Limit: an `exec:`/`ssh-*` child is SIGTERMed when the connection closes and SIGKILLed only after the library's
 * killTimeout (2 s). A second signal during that wait exits before the SIGKILL, so a child that ignores SIGTERM
 * outlives the CLI; the Connection does not expose the child, so the CLI cannot SIGKILL it on demand (DESIGN.md §4.14).
 */
export function nodeIo(): NodeIo {
  const controller = new AbortController();
  let stdinOpened = false;
  const stdin: CliInput = {
    isTTY: isatty(0),
    [Symbol.asyncIterator]() {
      stdinOpened = true;
      return (process.stdin as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    },
  };
  const onSignal = (name: "SIGINT" | "SIGTERM"): void => {
    if (controller.signal.aborted) process.exit(signalExitCode(name));
    controller.abort(name);
  };
  const onInt = (): void => {
    onSignal("SIGINT");
  };
  const onTerm = (): void => {
    onSignal("SIGTERM");
  };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return {
    stdin,
    stdout: output(process.stdout, 1),
    stderr: output(process.stderr, 2),
    env: process.env,
    signal: controller.signal,
    loadNative: () => loadNative(process.env),
    openPushFd,
    exec: execCommand,
    dispose() {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      // A bridge may stop while stdin is still open (peer EOF first): release it so the process can exit.
      if (stdinOpened) process.stdin.destroy();
    },
  };
}
