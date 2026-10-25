// `validate-idl`, `format` and `codegen` (DESIGN.md §4.14): the IDL tools over files or stdin (`-`).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generate, generateFromService, type GeneratedFile, type GenerateOptions } from "../codegen/index.ts";
import { formatInterface, IdlSyntaxError, isInterfaceName, parseInterface, type Interface } from "../core/idl/index.ts";
import { callFailure, callOrFail, expectArgs, failureReason, withTarget, type Context } from "./context.ts";
import { CliError, decodeUtf8, describeError, readAll, UsageError } from "./io.ts";

const GET_INTERFACE_DESCRIPTION = "org.varlink.service.GetInterfaceDescription";
const STDIN_NAME = "<stdin>";

interface Input {
  /** For messages: the path, or `<stdin>`. */
  readonly name: string;
  readonly text: string;
}

/** Reads FILE, or stdin for `-`. @throws {CliError} on a read error or invalid UTF-8. */
async function readInput(ctx: Context, file: string): Promise<Input> {
  const name = file === "-" ? STDIN_NAME : file;
  let bytes: Uint8Array;
  try {
    bytes = file === "-" ? await readAll(ctx.io.stdin, ctx.io.signal) : await readFile(file);
  } catch (e) {
    if (ctx.io.signal?.aborted === true) throw e;
    throw new CliError(
      file === "-"
        ? `Failed to read interface description from stdin: ${describeError(e)}`
        : `Failed to read interface description file '${file}': ${describeError(e)}`,
    );
  }
  try {
    return { name, text: decodeUtf8(bytes) };
  } catch {
    throw new CliError(`${name}: not valid UTF-8`);
  }
}

/** `NAME:LINE:COL: reason` (or `NAME: reason` without a position) for an IDL error. */
function idlFailure(name: string, e: IdlSyntaxError): CliError {
  const at = e.position === undefined ? "" : `:${String(e.position.line)}:${String(e.position.column)}`;
  return new CliError(`${name}${at}: ${e.reason}`);
}

/** Parses and validates. @throws {CliError} as {@link idlFailure}. */
function parseOrFail(input: Input): Interface {
  try {
    return parseInterface(input.text);
  } catch (e) {
    if (e instanceof IdlSyntaxError) throw idlFailure(input.name, e);
    throw e;
  }
}

/** Checks that stdin (`-`) is named at most once. */
function checkStdinOnce(files: readonly string[]): void {
  if (files.filter((f) => f === "-").length > 1) throw new UsageError("Standard input ('-') can only be read once.");
}

/** `validate-idl [FILE]`: parse + validate; print the canonical formatting unless `-q`. */
export async function validateIdl(ctx: Context): Promise<number> {
  expectArgs(ctx, 0, 1);
  const iface = parseOrFail(await readInput(ctx, ctx.cli.args[0] ?? "-"));
  if (!ctx.cli.quiet) await ctx.out(formatInterface(iface));
  return 0;
}

/** `format [FILE…]`: print the canonical formatting; `--check` names the files that differ; `-i` rewrites them. */
export async function format(ctx: Context): Promise<number> {
  const files = ctx.cli.args.length === 0 ? ["-"] : ctx.cli.args;
  checkStdinOnce(files);
  if (ctx.cli.inPlace && files.includes("-")) throw new UsageError("--in-place cannot rewrite standard input.");
  let status = 0;
  let printed = false;
  for (const file of files) {
    let input: Input;
    let formatted: string;
    try {
      input = await readInput(ctx, file);
      formatted = formatInterface(parseOrFail(input));
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      await ctx.err(e.message);
      status = 1;
      continue;
    }
    if (ctx.cli.check) {
      if (formatted !== input.text) {
        await ctx.err(`${input.name}: not canonically formatted`);
        status = 1;
      }
    } else if (ctx.cli.inPlace) {
      if (formatted !== input.text) {
        try {
          await writeFile(file, formatted);
        } catch (e) {
          await ctx.err(`Failed to write '${file}': ${describeError(e)}`);
          status = 1;
        }
      }
    } else {
      // Several files: separated by a blank line, like `introspect`.
      if (printed) await ctx.out("\n");
      printed = true;
      await ctx.out(formatted);
    }
  }
  return status;
}

function generateOrFail(name: string, idl: string, options: GenerateOptions): GeneratedFile {
  try {
    return generate(idl, options);
  } catch (e) {
    if (e instanceof IdlSyntaxError) throw idlFailure(name, e);
    if (e instanceof TypeError) throw new CliError(`codegen: ${e.message}`);
    throw e;
  }
}

/** Generated files from a running service (`--address`). */
async function fromService(
  ctx: Context,
  address: string,
  names: readonly string[],
  options: GenerateOptions,
): Promise<GeneratedFile[]> {
  for (const name of names)
    if (!isInterfaceName(name)) throw new CliError(`Not a valid Varlink interface name: '${name}'`);
  return withTarget(ctx, address, async (target, dl) => {
    const files: GeneratedFile[] = [];
    for (const name of names) {
      const conn = target.connection;
      let file: GeneratedFile;
      if (conn !== undefined) {
        try {
          file = await generateFromService(conn, name, { ...options, signal: dl.signal });
        } catch (e) {
          if (e instanceof IdlSyntaxError) throw idlFailure(`the description of ${name}`, e);
          if (e instanceof TypeError) throw new CliError(`codegen: ${e.message}`);
          throw callFailure(GET_INTERFACE_DESCRIPTION, e, dl);
        }
      } else {
        let service: string | undefined;
        try {
          service = await target.introspectionService(name);
        } catch (e) {
          throw new CliError(`Failed to reach the service: ${failureReason(e, dl)}`);
        }
        const reply = await callOrFail(target, dl, GET_INTERFACE_DESCRIPTION, { interface: name }, service);
        const description = reply["description"];
        if (typeof description !== "string")
          throw new CliError(`Invalid ${GET_INTERFACE_DESCRIPTION}() reply: 'description' is not a string.`);
        file = generateOrFail(`the description of ${name}`, description, options);
        if (file.interfaceName !== name)
          throw new CliError(`codegen: the description of ${name} declares interface ${file.interfaceName}`);
      }
      files.push(file);
    }
    return files;
  });
}

/** `codegen FILE… [-o DIR]` and `codegen --address ADDRESS INTERFACE… [-o DIR]`. */
export async function codegen(ctx: Context): Promise<number> {
  const options: GenerateOptions = { ints: ctx.cli.ints ?? "number", importPath: ctx.cli.importPath ?? "varlink-js" };
  const out = ctx.cli.output;
  expectArgs(ctx, 1, Infinity);
  if (out === undefined && ctx.cli.args.length > 1)
    throw new UsageError("Without -o DIR, codegen takes one input (the code goes to stdout).");
  let files: GeneratedFile[];
  if (ctx.cli.address !== undefined) {
    files = await fromService(ctx, ctx.cli.address, ctx.cli.args, options);
  } else {
    checkStdinOnce(ctx.cli.args);
    files = [];
    for (const file of ctx.cli.args) {
      const input = await readInput(ctx, file);
      files.push(generateOrFail(input.name, input.text, options));
    }
  }
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.fileName)) throw new CliError(`codegen: interface ${f.interfaceName} is given more than once.`);
    seen.add(f.fileName);
  }
  if (out === undefined) {
    for (const f of files) await ctx.out(f.code);
    return 0;
  }
  try {
    await mkdir(out, { recursive: true });
  } catch (e) {
    throw new CliError(`Failed to create '${out}': ${describeError(e)}`);
  }
  for (const f of files) {
    const path = join(out, f.fileName);
    try {
      await writeFile(path, f.code);
    } catch (e) {
      throw new CliError(`Failed to write '${path}': ${describeError(e)}`);
    }
    if (!ctx.cli.quiet) await ctx.err(path);
  }
  return 0;
}
