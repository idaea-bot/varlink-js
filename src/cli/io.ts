// The CLI's I/O seam (DESIGN.md §4.14): run() sees only a CliIo, never `process`, so it runs in-process under Node,
// Bun and Deno (tests pass a fake one; main.ts passes nodeIo()). Plus the small helpers every command shares.

/** Standard input: chunks of bytes. */
export interface CliInput extends AsyncIterable<Uint8Array> {
  readonly isTTY: boolean;
}

/** Standard output or error. */
export interface CliOutput {
  /**
   * Writes `data` (strings as UTF-8). Resolves once it was handed to the OS (so awaiting each write is the
   * backpressure and the per-record flush); rejects with {@link BrokenPipeError} when the reader went away (EPIPE).
   */
  write(data: string | Uint8Array): Promise<void>;
  readonly isTTY: boolean;
}

/** Everything run() may touch. */
export interface CliIo {
  readonly stdin: CliInput;
  readonly stdout: CliOutput;
  readonly stderr: CliOutput;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Aborted on SIGINT/SIGTERM, with the signal's name (`"SIGINT"`/`"SIGTERM"`) as the reason. */
  readonly signal?: AbortSignal | undefined;
}

/** stdout's reader went away (EPIPE, e.g. `| head -1`): the command stops quietly and exits 0. */
export class BrokenPipeError extends Error {
  override readonly name: string = "BrokenPipeError";
}

/** An expected failure: one line on stderr (escaped by run()), exit 1. */
export class CliError extends Error {
  override readonly name: string = "CliError";
}

/** A usage error: the message, then `See 'varlink-js --help'.`, exit 1. */
export class UsageError extends Error {
  override readonly name: string = "UsageError";
}

/** Exit status for a signal: 128 + its number (SIGINT 2 → 130, SIGTERM 15 → 143), like a shell reports it. */
export function signalExitCode(reason: unknown): number {
  return reason === "SIGTERM" ? 143 : 130;
}

/**
 * `s` with C0 controls, DEL and C1 controls written as `\xNN`, so peer-controlled text cannot drive the terminal.
 * Characters in `keep` (e.g. "\n\t" for IDL text) stay as they are.
 */
export function escapeControls(s: string, keep = ""): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) =>
    keep.includes(c) ? c : `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

/** A one-line description of an error for stderr (unescaped): its message, plus its cause's if it has one. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause: unknown = error.cause;
    const own = error.message === "" ? error.name : error.message;
    if (cause instanceof Error && cause.message !== "" && !own.includes(cause.message))
      return `${own}: ${cause.message}`;
    return own;
  }
  return String(error);
}

/** Rejects with the signal's reason as soon as it aborts; otherwise settles like `promise`. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the abort reason as is
      reject(signal.reason);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the error as is
        reject(error);
      },
    );
  });
}

/** Resolves when `signal` aborts (never, without one). */
export function aborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve();
    else
      signal.addEventListener(
        "abort",
        () => {
          resolve();
        },
        { once: true },
      );
  });
}

/** All of `input` (an abort of `signal` rejects with its reason and stops reading). */
export async function readAll(input: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const iterator = input[Symbol.asyncIterator]();
  try {
    for (;;) {
      const r = await abortable(iterator.next(), signal);
      if (r.done === true) break;
      chunks.push(r.value);
      length += r.value.length;
    }
  } catch (e) {
    void iterator.return?.().catch(() => undefined);
    throw e;
  }
  const all = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  return all;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Strict UTF-8 decoding; a leading BOM is dropped. @throws {TypeError} on invalid UTF-8. */
export function decodeUtf8(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

/** A deadline for one command: aborts `signal` with a CallTimeoutError-like reason after `ms`, or with `outer`'s. */
export interface Deadline {
  readonly signal: AbortSignal;
  /** Whether the timer (not `outer`) fired. */
  readonly timedOut: boolean;
  /** Clears the timer and the listener on `outer`. Idempotent. */
  dispose(): void;
}

/** Longest timer a runtime's setTimeout takes (2^31 − 1 ms, ~24.8 days); longer timeouts mean none. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Starts a deadline of `ms` milliseconds (`undefined` = none) linked to `outer` (io.signal): the signal aborts with
 * `timeoutReason()` when the timer fires, or with `outer`'s reason.
 */
export function startDeadline(
  ms: number | undefined,
  outer: AbortSignal | undefined,
  timeoutReason: () => Error,
): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onOuter = (): void => {
    controller.abort(outer?.reason);
  };
  if (outer?.aborted === true) controller.abort(outer.reason);
  else outer?.addEventListener("abort", onOuter, { once: true });
  if (ms !== undefined && ms <= MAX_TIMER_MS && !controller.signal.aborted)
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutReason());
    }, ms);
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      outer?.removeEventListener("abort", onOuter);
    },
  };
}
