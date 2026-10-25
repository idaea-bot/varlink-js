// The `varlink-js` CLI (DESIGN.md §4.14), after systemd's varlinkctl: run(argv, io) does everything but touch the
// process, so it is testable in-process and usable from Bun and Deno; main.ts wires it to the process.
import { parseCommandLine, type CommandLine } from "./args.ts";
import { bridge } from "./bridge.ts";
import { call } from "./call.ts";
import { certify } from "./certify.ts";
import { createContext, type Context } from "./context.ts";
import { codegen, format, validateIdl } from "./idl.ts";
import { info, introspect } from "./introspect.ts";
import {
  BrokenPipeError,
  CliError,
  describeError,
  escapeControls,
  signalExitCode,
  UsageError,
  type CliIo,
} from "./io.ts";
import { VERSION } from "./version.ts";

export type { CliInput, CliIo, CliOutput } from "./io.ts";

/** `varlink-js --help`. */
export const USAGE = `varlink-js [OPTIONS…] COMMAND …

Introspect, call and serve Varlink services; check, format and generate code from interface definitions.

Commands:
  info ADDRESS                 Show service information
  list-interfaces ADDRESS      List interfaces implemented by the service
  list-methods ADDRESS [INTERFACE…]
                               List methods of the service or of the given interfaces
  introspect ADDRESS [INTERFACE…]
                               Show interface definitions (all when none given)
  call ADDRESS METHOD [PARAMETERS]
                               Invoke a method (PARAMETERS: a JSON object; stdin when absent or '-')
  validate-idl [FILE]          Validate an interface definition (stdin when absent or '-')
  format [FILE…]               Print the canonical formatting of interface definitions
  codegen FILE…                Generate TypeScript from interface definitions
  codegen --address ADDRESS INTERFACE…
                               Generate TypeScript from a running service's interfaces
  bridge ADDRESS               Proxy raw bytes between stdin/stdout and ADDRESS (a --bridge command)
  certify server ADDRESS       Serve org.varlink.certification on ADDRESS
  certify client ADDRESS       Run the org.varlink.certification client against ADDRESS
  help                         Show this help

Options:
  -h --help                    Show this help
  -V --version                 Show the package version
     --json=MODE               Output JSON: pretty, short or off
  -j                           Same as --json=pretty on a terminal, --json=short otherwise
  -q --quiet                   Do not print replies (call), the formatting (validate-idl) or paths (codegen)
     --timeout=SECS            Time limit for the connect and the whole call (default 45s; 'infinity' for none;
                               units us, ms, s, sec, min, h)
call:
     --more                    Request multiple replies, printed as JSON-SEQ as they arrive
  -E                           Same as --more --timeout=infinity
     --collect                 Request multiple replies, printed as one JSON array
     --oneway                  Do not request a reply
     --graceful=ERROR          Treat the error reply ERROR as success (repeatable)
format:
     --check                   Print nothing; fail and name the files that are not canonical
  -i --in-place                Rewrite the files
codegen:
  -o --output=DIR              Write <DIR>/<interface>.ts (default: the code goes to stdout)
     --ints=number|bigint      TypeScript type of 'int' (default number)
     --import-path=SPEC        Module the generated code imports (default varlink-js)
     --address=ADDRESS         Fetch the interfaces from a running service

ADDRESS: unix:/path, /path, ./path, unix:@abstract (Linux), tcp:host:port, ws(s)://…, http(s)://… (HTTP bridge).
Exit status: 0 on success, 1 on any failure, 130/143 after SIGINT/SIGTERM.
`;

function dispatch(ctx: Context, cli: CommandLine): Promise<number> {
  switch (cli.command) {
    case "info":
      return info(ctx, false);
    case "list-interfaces":
      return info(ctx, true);
    case "list-methods":
      return introspect(ctx, true);
    case "introspect":
      return introspect(ctx, false);
    case "call":
      return call(ctx);
    case "validate-idl":
      return validateIdl(ctx);
    case "format":
      return format(ctx);
    case "codegen":
      return codegen(ctx);
    case "bridge":
      return bridge(ctx);
    case "certify":
      return certify(ctx);
    default:
      throw new UsageError(`Unknown command verb '${escapeControls(cli.command ?? "")}'.`);
  }
}

async function writeErr(io: CliIo, text: string): Promise<void> {
  try {
    await io.stderr.write(text);
  } catch {
    // Nowhere left to report it.
  }
}

/**
 * Runs the CLI with `argv` (the arguments after the script) on `io` and returns the exit status: 0 on success, 1 on
 * every failure (usage errors included, as varlinkctl), 130/143 when io.signal aborted with "SIGINT"/"SIGTERM".
 * Never calls `process.exit` and never throws: an unexpected error is one line on stderr (plus its stack when
 * VARLINK_JS_DEBUG is set) and 1. A stdout reader that went away (EPIPE) stops the command quietly with 0.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const cli = parseCommandLine(argv);
    if (cli.help || cli.command === "help") {
      await io.stdout.write(USAGE);
      return 0;
    }
    if (cli.version) {
      await io.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (cli.command === undefined) throw new UsageError("Command verb required.");
    return await dispatch(createContext(io, cli), cli);
  } catch (e) {
    if (e instanceof BrokenPipeError) return 0;
    if (io.signal?.aborted === true) return signalExitCode(io.signal.reason);
    if (e instanceof UsageError) {
      await writeErr(io, `${escapeControls(e.message)}\nSee 'varlink-js --help'.\n`);
      return 1;
    }
    if (e instanceof CliError) {
      await writeErr(io, `${escapeControls(e.message)}\n`);
      return 1;
    }
    await writeErr(io, `varlink-js: internal error: ${escapeControls(describeError(e))}\n`);
    if (io.env["VARLINK_JS_DEBUG"] !== undefined && e instanceof Error && e.stack !== undefined)
      await writeErr(io, `${e.stack}\n`);
    return 1;
  }
}
