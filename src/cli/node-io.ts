// The process side of the CLI (DESIGN.md §4.14), used only by main.ts: a CliIo over process.stdin/stdout/stderr,
// SIGINT/SIGTERM → io.signal, and the cleanup that lets the process exit by itself.
import { closeSync, fstatSync, openSync } from "node:fs";
import { isatty } from "node:tty";
import {
  BrokenPipeError,
  CliError,
  describeError,
  isDisconnectCode,
  signalExitCode,
  type CliInput,
  type CliIo,
  type CliOutput,
} from "./io.ts";

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
    dispose() {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      // A bridge may stop while stdin is still open (peer EOF first): release it so the process can exit.
      if (stdinOpened) process.stdin.destroy();
    },
  };
}
