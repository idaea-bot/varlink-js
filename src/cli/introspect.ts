// `info`, `list-interfaces`, `list-methods`, `introspect` (DESIGN.md §4.14), after varlinkctl's verb_info and
// verb_introspect: GetInfo / GetInterfaceDescription, printed as text or JSON.
import { formatInterface, IdlSyntaxError, isInterfaceName, parseInterface, type Interface } from "../core/idl/index.ts";
import { callOrFail, expectArgs, failureReason, jsonStyle, withTarget, type Context } from "./context.ts";
import { CliError, escapeControls, type Deadline } from "./io.ts";
import { formatJson } from "./json.ts";
import type { Target } from "./target.ts";

const GET_INFO = "org.varlink.service.GetInfo";
const GET_INTERFACE_DESCRIPTION = "org.varlink.service.GetInterfaceDescription";

/** Byte-order comparison of ASCII names (strcmp, as strv_sort does); sorted copy without duplicates. */
function sortUnique(names: readonly string[]): string[] {
  return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function stringField(reply: Record<string, unknown>, key: string): string {
  const v = reply[key];
  if (typeof v !== "string") throw new CliError(`Invalid ${GET_INFO}() reply: '${key}' is not a string.`);
  return v;
}

function interfacesField(reply: Record<string, unknown>): string[] {
  const v = reply["interfaces"];
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string"))
    throw new CliError(`Invalid ${GET_INFO}() reply: 'interfaces' is not an array of strings.`);
  return v;
}

/** The service an `org.varlink.service` call goes to (simple HTTP mode); failures are CliErrors. */
async function service(target: Target, dl: Deadline, iface?: string): Promise<string | undefined> {
  try {
    return await target.introspectionService(iface);
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`Failed to list the bridge's services: ${failureReason(e, dl)}`);
  }
}

/** The vertical table of varlinkctl's `info`: labels right-aligned, continuation lines aligned. */
function infoTable(rows: readonly (readonly [string, readonly string[]])[]): string {
  const width = Math.max(...rows.map(([label]) => label.length));
  let out = "";
  for (const [label, values] of rows) {
    const [first = "", ...rest] = values.map((v) => escapeControls(v));
    out += `${label.padStart(width)}: ${first}`.trimEnd() + "\n";
    for (const v of rest) out += `${" ".repeat(width + 2)}${v}\n`;
  }
  return out;
}

/** `info ADDRESS` and `list-interfaces ADDRESS`. */
export async function info(ctx: Context, listOnly: boolean): Promise<number> {
  expectArgs(ctx, 1, 1);
  const [address = ""] = ctx.cli.args;
  const style = jsonStyle(ctx);
  const reply = await withTarget(ctx, address, async (target, dl) =>
    callOrFail(target, dl, GET_INFO, {}, await service(target, dl)),
  );
  if (style !== undefined) {
    await ctx.out(formatJson(listOnly ? reply["interfaces"] : reply, style));
    return 0;
  }
  const interfaces = sortUnique(interfacesField(reply));
  if (listOnly) {
    await ctx.out(interfaces.map((i) => `${escapeControls(i)}\n`).join(""));
    return 0;
  }
  const rows: [string, string[]][] = [
    ["Vendor", [stringField(reply, "vendor")]],
    ["Product", [stringField(reply, "product")]],
    ["Version", [stringField(reply, "version")]],
    ["URL", [stringField(reply, "url")]],
    ["Interfaces", interfaces],
  ];
  await ctx.out(infoTable(rows));
  return 0;
}

function position(e: IdlSyntaxError): string {
  return e.position === undefined ? "" : ` at ${String(e.position.line)}:${String(e.position.column)}`;
}

/** `introspect ADDRESS [INTERFACE…]` and `list-methods ADDRESS [INTERFACE…]`. */
export async function introspect(ctx: Context, listMethods: boolean): Promise<number> {
  expectArgs(ctx, 1, Infinity);
  const [address = "", ...requested] = ctx.cli.args;
  for (const name of requested)
    if (!isInterfaceName(name)) throw new CliError(`Not a valid Varlink interface name: '${name}'`);
  const style = jsonStyle(ctx);
  const methods: string[] = [];
  const experimental = new Set<string>();

  await withTarget(ctx, address, async (target, dl) => {
    let interfaces = requested;
    // Without names: everything GetInfo lists, asked of the service that answered GetInfo.
    let fixedService: string | undefined;
    if (interfaces.length === 0) {
      fixedService = await service(target, dl);
      interfaces = sortUnique(interfacesField(await callOrFail(target, dl, GET_INFO, {}, fixedService)));
      if (interfaces.length === 0) throw new CliError("Service doesn't report any implemented interfaces.");
    }
    // varlinkctl switches to JSON-SEQ when it prints more than one JSON object.
    const seq = interfaces.length > 1;
    let first = true;
    for (const name of interfaces) {
      const svc = fixedService ?? (await service(target, dl, name));
      const reply = await callOrFail(target, dl, GET_INTERFACE_DESCRIPTION, { interface: name }, svc);
      if (style !== undefined && !listMethods) {
        await ctx.out(formatJson(reply, style, seq));
        continue;
      }
      const description = reply["description"];
      if (typeof description !== "string")
        throw new CliError(`Invalid ${GET_INTERFACE_DESCRIPTION}() reply: 'description' is not a string.`);
      let iface: Interface;
      try {
        iface = parseInterface(description);
      } catch (e) {
        if (!(e instanceof IdlSyntaxError)) throw e;
        if (listMethods)
          throw new CliError(`Failed to parse returned interface description${position(e)}: ${e.reason}`);
        await ctx.err(
          `Failed to parse returned interface description${position(e)}, showing raw interface description: ${e.reason}`,
        );
        if (!first) await ctx.out("\n");
        first = false;
        const raw = description.endsWith("\n") ? description : `${description}\n`;
        await ctx.out(escapeControls(raw, "\n\t"));
        continue;
      }
      if (listMethods) {
        for (const member of iface.members) {
          if (member.kind !== "method") continue;
          const qualified = `${iface.name}.${member.name}`;
          methods.push(qualified);
          if (iface.experimental || member.experimental) experimental.add(qualified);
        }
        continue;
      }
      if (!first) await ctx.out("\n");
      first = false;
      await ctx.out(escapeControls(formatInterface(iface), "\n\t"));
    }
  });

  if (listMethods) {
    const sorted = sortUnique(methods);
    if (style !== undefined) {
      await ctx.out(formatJson(sorted, style));
    } else {
      // Marked only on a TTY, so the output stays parsable (shell completion), like varlinkctl.
      const mark = ctx.io.stdout.isTTY;
      await ctx.out(
        sorted.map((m) => `${escapeControls(m)}${mark && experimental.has(m) ? " (experimental)" : ""}\n`).join(""),
      );
    }
  }
  return 0;
}
