// The process side of the CLI (DESIGN.md §4.14), used only by main.ts: a CliIo over process.stdin/stdout/stderr,
// SIGINT/SIGTERM → io.signal, and the cleanup that lets the process exit by itself.
import { isatty } from "node:tty";
import {
  BrokenPipeError,
  CliError,
  describeError,
  signalExitCode,
  type CliInput,
  type CliIo,
  type CliOutput,
} from "./io.ts";

/** A CliIo bound to the process, plus `dispose()` (removes the signal handlers, releases stdin). */
export interface NodeIo extends CliIo {
  dispose(): void;
}

function output(stream: NodeJS.WriteStream, fd: number): CliOutput {
  let failure: Error | undefined;
  // Without a listener, an EPIPE `error` event would be an uncaught exception.
  stream.on("error", (error) => {
    failure ??= error;
  });
  const wrap = (error: Error): Error =>
    (error as NodeJS.ErrnoException).code === "EPIPE"
      ? new BrokenPipeError(error.message)
      : new CliError(`Failed to write to ${fd === 1 ? "stdout" : "stderr"}: ${describeError(error)}`);
  return {
    isTTY: isatty(fd),
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
