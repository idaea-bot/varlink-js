// `call ADDRESS METHOD [PARAMETERS]` (DESIGN.md §4.14), after varlinkctl's verb_call: parameters from argv or stdin,
// parsed losslessly; one reply, `--more` (JSON-SEQ, flushed per record), `--collect` (one array) or `--oneway`.
import { isVarlinkError, jsonCodec } from "../index.ts";
import { isQualifiedName } from "./args.ts";
import { callFailure, expectArgs, jsonStyle, parseAddressArg, withTarget, type Context } from "./context.ts";
import { BrokenPipeError, CliError, decodeUtf8, describeError, readAll, type Deadline } from "./io.ts";
import { formatJson, type JsonStyle } from "./json.ts";

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
    const bytes = await readAll(ctx.io.stdin, ctx.io.signal);
    try {
      raw = decodeUtf8(bytes);
    } catch {
      throw new CliError("Failed to parse parameters at <stdin>: not valid UTF-8");
    }
  } else {
    source = "<argv>";
    raw = text;
  }
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
  if (error instanceof BrokenPipeError) throw error;
  if (!isVarlinkError(error)) throw callFailure(method, error, dl);
  const name = error.error;
  const graceful = ctx.cli.graceful.includes(name);
  if (graceful) {
    if (!ctx.cli.quiet) await ctx.err(`Method call ${method}() returned expected error: ${name}`);
  } else if (name === EXPECTED_MORE) {
    await ctx.err(`Method call ${method}() failed: called without 'more' flag, but flag needs to be set.`);
  } else {
    await ctx.err(`Method call ${method}() failed: ${name}`);
  }
  if (!ctx.cli.quiet) await ctx.out(formatJson(error.parameters, style, seq));
  return graceful ? 0 : 1;
}

/** `call`. */
export async function call(ctx: Context): Promise<number> {
  expectArgs(ctx, 2, 3);
  const [address = "", method = "", text] = ctx.cli.args;
  if (!isQualifiedName(method))
    throw new CliError(
      `Not a valid qualified method name: '${method}' (Expected valid Varlink interface name, followed by a dot, followed by a valid Varlink symbol name.)`,
    );
  parseAddressArg(address);
  const parameters = await readParameters(ctx, text);
  const style = jsonStyle(ctx, true) ?? "short";
  const quiet = ctx.cli.quiet;

  return withTarget(ctx, address, async (target, dl) => {
    switch (ctx.cli.mode) {
      case "oneway":
        try {
          await target.oneway(method, parameters);
        } catch (e) {
          throw callFailure(method, e, dl);
        }
        return 0;
      case "more":
        try {
          for await (const reply of target.stream(method, parameters))
            if (!quiet) await ctx.out(formatJson(reply, style, true));
        } catch (e) {
          return failed(ctx, method, e, dl, style, true);
        }
        return 0;
      case "collect": {
        let replies: Params[];
        try {
          replies = await target.collect(method, parameters);
        } catch (e) {
          return failed(ctx, method, e, dl, style, false);
        }
        if (!quiet) await ctx.out(formatJson(replies, style));
        return 0;
      }
      case "single": {
        let reply: Params;
        try {
          reply = await target.call(method, parameters);
        } catch (e) {
          return failed(ctx, method, e, dl, style, false);
        }
        if (!quiet) await ctx.out(formatJson(reply, style));
        return 0;
      }
    }
  });
}
