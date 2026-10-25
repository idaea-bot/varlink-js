// What every command gets (DESIGN.md §4.14): the I/O, the parsed command line, and the shared steps (address
// parsing, the deadline, connecting, failure messages).
import { parseAddress, type AddressSpec } from "../core/address/index.ts";
import { CallTimeoutError, isVarlinkError } from "../core/errors/index.ts";
import type { CommandLine } from "./args.ts";
import { CliError, describeError, escapeControls, startDeadline, UsageError, type CliIo, type Deadline } from "./io.ts";
import type { JsonStyle } from "./json.ts";
import { openTarget, type Target } from "./target.ts";

/** varlinkctl's (sd-varlink's) default timeout: 45 s. */
export const DEFAULT_TIMEOUT_MS = 45_000;

/** A running command. */
export interface Context {
  readonly io: CliIo;
  readonly cli: CommandLine;
  /** Writes to stdout (rejects with BrokenPipeError when the reader went away). */
  out(data: string | Uint8Array): Promise<void>;
  /** Writes one line to stderr with control characters escaped; never rejects. */
  err(line: string): Promise<void>;
}

/** Creates the context of one command. */
export function createContext(io: CliIo, cli: CommandLine): Context {
  return {
    io,
    cli,
    out: (data) => io.stdout.write(data),
    err: (line) => io.stderr.write(`${escapeControls(line)}\n`).catch(() => undefined),
  };
}

/**
 * The JSON style of a command's output: `--json=pretty|short`, `-j` (pretty on a TTY, else short); `off` or nothing →
 * `undefined` (text), unless `jsonByDefault` (call: varlinkctl defaults to `-j` there, and treats `off` like it too).
 */
export function jsonStyle(ctx: Context, jsonByDefault = false): JsonStyle | undefined {
  let mode = ctx.cli.json;
  if (jsonByDefault && (mode === undefined || mode === "off")) mode = "auto";
  if (mode === "auto") return ctx.io.stdout.isTTY ? "pretty" : "short";
  return mode === "pretty" || mode === "short" ? mode : undefined;
}

/** The command's timeout in ms (`undefined` = none): `--timeout`, else 45 s. */
export function timeoutMs(ctx: Context): number | undefined {
  const t = ctx.cli.timeout;
  return t === undefined ? DEFAULT_TIMEOUT_MS : (t ?? undefined);
}

/** Starts the command's deadline (its timeout, and io.signal). */
export function deadline(ctx: Context): Deadline {
  const ms = timeoutMs(ctx);
  return startDeadline(ms, ctx.io.signal, () => new CallTimeoutError(`timed out after ${String((ms ?? 0) / 1000)}s`));
}

/** Parses an ADDRESS argument. @throws {CliError} for an invalid address. */
export function parseAddressArg(text: string): AddressSpec {
  try {
    return parseAddress(text);
  } catch (e) {
    throw new CliError(describeError(e));
  }
}

/** Connects to `address`. @throws {CliError} `Failed to connect to ADDRESS: …`. */
export async function connectTarget(address: string, spec: AddressSpec, dl: Deadline): Promise<Target> {
  try {
    return await openTarget(spec, dl.signal);
  } catch (e) {
    throw new CliError(`Failed to connect to ${address}: ${failureReason(e, dl)}`);
  }
}

/** Why an operation failed locally: the deadline's reason when it fired, else the error's description. */
export function failureReason(error: unknown, dl: Deadline): string {
  return describeError(dl.timedOut ? dl.signal.reason : error);
}

/** `Method call METHOD() failed: …` for a call that failed: the error name of an error reply, else the reason. */
export function callFailure(method: string, error: unknown, dl: Deadline): CliError {
  const why = isVarlinkError(error) ? error.error : failureReason(error, dl);
  return new CliError(`Method call ${method}() failed: ${why}`);
}

/** A call whose failure (error reply or local) is a {@link callFailure}. */
export async function callOrFail(
  target: Target,
  dl: Deadline,
  method: string,
  parameters: Record<string, unknown>,
  service?: string,
): Promise<Record<string, unknown>> {
  try {
    return await target.call(method, parameters, service);
  } catch (e) {
    throw callFailure(method, e, dl);
  }
}

/** Checks the number of positional arguments. @throws {UsageError} "Too few/many arguments." */
export function expectArgs(ctx: Context, min: number, max: number): void {
  if (ctx.cli.args.length < min) throw new UsageError("Too few arguments.");
  if (ctx.cli.args.length > max) throw new UsageError("Too many arguments.");
}

/** Runs `fn` against a fresh target and closes it on every path (and the deadline's timer). */
export async function withTarget<T>(
  ctx: Context,
  address: string,
  fn: (target: Target, dl: Deadline) => Promise<T>,
): Promise<T> {
  const spec = parseAddressArg(address);
  const dl = deadline(ctx);
  try {
    const target = await connectTarget(address, spec, dl);
    try {
      return await fn(target, dl);
    } finally {
      await target.close();
    }
  } finally {
    dl.dispose();
  }
}
