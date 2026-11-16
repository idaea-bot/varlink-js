// `call ADDRESS METHOD [PARAMETERS]` (DESIGN.md §4.14), after varlinkctl's verb_call: parameters from argv or stdin,
// parsed losslessly; one reply, `--more` (JSON-SEQ, flushed per record), `--collect` (one array) or `--oneway`.
import type { FdHandle } from "../core/protocol/index.ts";
import { closeFds } from "../core/protocol/framer.ts";
import { isVarlinkError, jsonCodec, type WithFds } from "../index.ts";
import type { NativeAddon } from "../node/native.ts";
import { isQualifiedName } from "./args.ts";
import { callFailure, expectArgs, jsonStyle, parseAddressArg, printable, withTarget, type Context } from "./context.ts";
import {
  BrokenPipeError,
  CliError,
  decodeUtf8,
  describeError,
  escapeControls,
  readAll,
  UsageError,
  type Deadline,
} from "./io.ts";
import { formatJson, type JsonStyle } from "./json.ts";
import type { Target } from "./target.ts";
import { callUpgrade } from "./upgrade.ts";

type Params = Record<string, unknown>;

const EXPECTED_MORE = "org.varlink.service.ExpectedMore";
/** JSON's insignificant whitespace (an empty or blank PARAMETERS means `{}`, as in varlinkctl). */
const BLANK = /^[ \t\n\r]*$/;

/** The call's parameters: PARAMETERS, or all of stdin when it is absent or `-`. */
async function readParameters(ctx: Context, text: string | undefined): Promise<Params> {
  let source: string;
  let raw: string;
  if (text === undefined || text === "-") {
    if (ctx.io.stdin.isTTY && !ctx.cli.quiet)
      await ctx.err(
        "Expecting method call parameter JSON object on standard input. (Provide empty string or {} for no parameters.)",
      );
    source = "<stdin>";
    let bytes: Uint8Array;
    try {
      bytes = await readAll(ctx.io.stdin, ctx.io.signal);
    } catch (e) {
      if (e instanceof CliError) throw new CliError(`Failed to parse parameters at <stdin>: ${e.message}`);
      throw e;
    }
    try {
      raw = decodeUtf8(bytes);
    } catch {
      throw new CliError("Failed to parse parameters at <stdin>: not valid UTF-8");
    }
  } else {
    source = "<argv>";
    raw = text;
  }
  return parseParameters(raw, source);
}

/** PARAMETERS from argv only (`call --upgrade`: stdin carries the upgraded stream); absent or `-` → `{}`. */
function argvParameters(text: string | undefined): Params {
  return text === undefined || text === "-" ? {} : parseParameters(text, "<argv>");
}

/** A JSON object (blank = `{}`), parsed losslessly. @throws {CliError} `Failed to parse parameters at SOURCE: …`. */
function parseParameters(raw: string, source: string): Params {
  if (BLANK.test(raw)) return {};
  let value: unknown;
  try {
    value = jsonCodec.decode(raw);
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e;
    throw new CliError(`Failed to parse parameters at ${source}: ${describeError(cause)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CliError(`Failed to parse parameters at ${source}: not a JSON object`);
  return value as Params;
}

/**
 * Handles a failed call: an error reply is logged (`--graceful` ones as expected), its parameters printed unless
 * `-q`, and gives exit 0 (graceful) or 1; anything else is a local failure (thrown as a CliError).
 */
async function failed(
  ctx: Context,
  method: string,
  error: unknown,
  dl: Deadline,
  style: JsonStyle,
  seq: boolean,
): Promise<number> {
  if (error instanceof BrokenPipeError || error instanceof CliError) throw error;
  if (!isVarlinkError(error)) throw callFailure(method, error, dl);
  const name = error.error;
  const parameters = printable(method, error.parameters);
  const graceful = ctx.cli.graceful.includes(name);
  if (graceful) {
    if (!ctx.cli.quiet) await ctx.err(`Method call ${method}() returned expected error: ${name}`);
  } else if (name === EXPECTED_MORE) {
    await ctx.err(`Method call ${method}() failed: called without 'more' flag, but flag needs to be set.`);
  } else {
    await ctx.err(`Method call ${method}() failed: ${name}`);
  }
  if (!ctx.cli.quiet) await ctx.out(formatJson(parameters, style, seq));
  return graceful ? 0 : 1;
}

/** The addon, loaded once per command (only `--push-fd=`/`--exec` ask for it). */
async function loadNative(ctx: Context): Promise<NativeAddon | undefined> {
  try {
    return (await ctx.io.loadNative?.()) ?? undefined;
  } catch {
    return undefined;
  }
}

/** A system error's text without Node's `syscall CODE:` / `CODE:` prefix and `, syscall 'path'` suffix. */
function errnoText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return escapeControls(message.replace(/^(?:\w+ )?E[A-Z0-9]+: /, "").replace(/, \w+ '.*'$/s, ""));
}

/**
 * The `--push-fd=` values as fds the command owns (closed at the end by the caller), like varlinkctl's parse_argv
 * (varlinkctl.c:204-229 at 6bd4689f): `/…` and `./…` are opened read-only, anything else must be an fd number of
 * this process, which is duplicated (validated early; the same fd may be pushed twice).
 */
function openPushFds(ctx: Context, native: NativeAddon | undefined): FdHandle[] {
  const specs = ctx.cli.pushFds;
  if (specs.length === 0) return [];
  const open = ctx.io.openPushFd;
  if (native === undefined || open === undefined)
    throw new CliError("--push-fd= requires the optional varlink-js-native addon (Linux)");
  const handles: FdHandle[] = [];
  try {
    for (const spec of specs) {
      if (spec.startsWith("/") || spec.startsWith("./")) {
        try {
          handles.push(open({ path: spec }, native));
        } catch (e) {
          throw new CliError(`Failed to open '${escapeControls(spec)}': ${errnoText(e)}`);
        }
        continue;
      }
      if (!/^[0-9]+$/.test(spec) || Number(spec) > 0x7fffffff)
        throw new CliError(`Failed to parse --push-fd= parameter: ${escapeControls(spec)}`);
      const fd = Number(spec);
      try {
        handles.push(open({ fd }, native));
      } catch (e) {
        throw new CliError(`Failed to duplicate file descriptor ${String(fd)}: ${errnoText(e)}`);
      }
    }
  } catch (e) {
    closeFds(handles);
    throw e;
  }
  return handles;
}

/** `call`. */
export async function call(ctx: Context): Promise<number> {
  const exec = ctx.cli.exec;
  // varlinkctl's argument checks (verb_call): PARAMS is required before an --exec command line.
  if (!exec) expectArgs(ctx, 2, 3);
  else if (ctx.cli.args.length < 2) throw new UsageError("Too few arguments.");
  else if (ctx.cli.args.length < 4) throw new UsageError("Expected command line to execute.");
  const [address = "", method = "", text, ...command] = ctx.cli.args;
  if (!isQualifiedName(method))
    throw new CliError(
      `Not a valid qualified method name: '${method}' (Expected valid Varlink interface name, followed by a dot, followed by a valid Varlink symbol name.)`,
    );
  parseAddressArg(address);
  if (ctx.cli.mode === "upgrade") {
    if (exec) throw new CliError("--exec with --upgrade is not implemented by varlink-js");
    return callUpgrade(ctx, address, method, argvParameters(text));
  }
  if (exec && ctx.io.exec === undefined) throw new CliError("--exec is not available here");
  const native = ctx.cli.pushFds.length > 0 || exec ? await loadNative(ctx) : undefined;
  const pushed = openPushFds(ctx, native);
  try {
    return await callWith(ctx, address, method, text, command, native, pushed);
  } finally {
    closeFds(pushed);
  }
}

async function callWith(
  ctx: Context,
  address: string,
  method: string,
  text: string | undefined,
  command: readonly string[],
  native: NativeAddon | undefined,
  pushed: readonly FdHandle[],
): Promise<number> {
  const parameters = await readParameters(ctx, text);
  // --exec without an explicit JSON mode: short (plus the newline), as varlinkctl does for a program's input.
  const style = ctx.cli.exec && ctx.cli.json === undefined ? "short" : (jsonStyle(ctx, true) ?? "short");
  const quiet = ctx.cli.quiet;
  const fds = pushed.length > 0 ? pushed : undefined;

  return withTarget(
    ctx,
    address,
    async (target, dl) => {
      switch (ctx.cli.mode) {
        case "oneway":
          try {
            await target.oneway(method, parameters, fds);
          } catch (e) {
            throw callFailure(method, e, dl);
          }
          return 0;
        case "more":
          try {
            for await (const reply of target.stream(method, parameters, fds)) {
              printable(method, reply);
              if (!quiet) await ctx.out(formatJson(reply, style, true));
            }
          } catch (e) {
            return failed(ctx, method, e, dl, style, true);
          }
          return 0;
        case "collect": {
          let replies: Params[];
          try {
            replies = await target.collect(method, parameters, fds);
          } catch (e) {
            return failed(ctx, method, e, dl, style, false);
          }
          printable(method, replies);
          if (!quiet) await ctx.out(formatJson(replies, style));
          return 0;
        }
        case "single": {
          if (ctx.cli.exec) return execCall(ctx, target, dl, method, parameters, fds, style, command, native);
          let reply: Params;
          try {
            reply = await target.call(method, parameters, undefined, fds);
          } catch (e) {
            return failed(ctx, method, e, dl, style, false);
          }
          printable(method, reply);
          if (!quiet) await ctx.out(formatJson(reply, style));
          return 0;
        }
        case "upgrade":
          // Handled before stdin is read (callUpgrade).
          throw new Error("call --upgrade reached the plain call path");
      }
    },
    native,
  );
}

const encoder = new TextEncoder();

/**
 * `call --exec` (varlinkctl.c:1088-1170 at 6bd4689f): the call accepts fds (where the connection can receive them;
 * otherwise a plain call, as varlinkctl ignores a failure to enable fd input). An error reply fails as usual (its
 * parameters printed unless `-q`), except a `--graceful` one, which, as in varlinkctl, still runs the command with
 * the error's parameters. Then the connection is closed and the command runs with the formatted reply on stdin
 * (short JSON plus a newline unless `--json`/`-j` asked otherwise) and the reply's fds as fds 3, 4, … with
 * `LISTEN_FDS`/`LISTEN_PID`; its exit status is ours (a signal: 128 + its number; varlinkctl execs instead).
 */
async function execCall(
  ctx: Context,
  target: Target,
  dl: Deadline,
  method: string,
  parameters: Params,
  fds: readonly FdHandle[] | undefined,
  style: JsonStyle,
  command: readonly string[],
  native: NativeAddon | undefined,
): Promise<number> {
  let reply: WithFds;
  try {
    reply = await target.callAcceptingFds(method, parameters, fds);
  } catch (e) {
    // An error reply's fds (acceptFds) are on the error: the command takes them for a --graceful error, as
    // varlinkctl takes the fds of whatever message it got (varlinkctl.c:1122-1155); otherwise they are closed.
    const errorFds = (e as { fds?: FdHandle[] } | null)?.fds ?? [];
    if (!(isVarlinkError(e) && ctx.cli.graceful.includes(e.error))) {
      closeFds(errorFds);
      return failed(ctx, method, e, dl, style, false);
    }
    if (!ctx.cli.quiet) await ctx.err(`Method call ${method}() returned expected error: ${e.error}`);
    reply = { parameters: e.parameters, fds: errorFds };
  }
  try {
    printable(method, reply.parameters);
    const input = encoder.encode(formatJson(reply.parameters, style));
    // varlinkctl's exec leaves the connection behind (close_all_fds): ours is closed before the command starts.
    await target.close();
    const exec = ctx.io.exec;
    if (exec === undefined) throw new CliError("--exec is not available here");
    return await exec(command, { reply: input, fds: reply.fds, native, env: ctx.io.env, signal: ctx.io.signal });
  } finally {
    closeFds(reply.fds);
  }
}
