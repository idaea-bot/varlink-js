// Codegen (DESIGN.md §4.13, §5.7): one TypeScript module per varlink interface, with types, error classes, a
// frozen descriptor, its client() factory and Handlers type. Deterministic, laid out like prettier would.
import type { EnumType, Field, StructType, Type } from "../core/idl/ast.ts";
import { parseInterface } from "../core/idl/parser.ts";
import {
  ExpectedMoreError,
  ExpectedUpgradeError,
  INTERNAL_ERROR_INTERFACE,
  InterfaceNotFoundError,
  InternalError,
  InvalidParameterError,
  MethodNotFoundError,
  MethodNotImplementedError,
  ORG_VARLINK_SERVICE,
  PermissionDeniedError,
} from "../core/errors/standard.ts";
import type { ErrorClass } from "../core/errors/varlink-error.ts";
import { INHERITED_NAMES, type IntsMode } from "../core/types/compile.ts";
import type { CallOptions, Connection } from "../rpc/connection.ts";
import type { Pool } from "../rpc/pool.ts";
import { align, group, hardline, ifBreak, indent, join, line, print, softline, type Doc } from "./doc.ts";
import { sha256Utf8 } from "./sha256.ts";

/** Version of the generator, written into every header; equals the package version. */
export const GENERATOR_VERSION: string = "1.0.0-alpha.0";

/** Options for {@link generate}. */
export interface GenerateOptions {
  /** How `int` is typed: `number` (default) or `bigint`; recorded in the descriptor (§4.3). */
  ints?: IntsMode;
  /** Module specifier the generated code imports the runtime from; default `"varlink-js"`. */
  importPath?: string;
}

/** One generated module. */
export interface GeneratedFile {
  /** `${interfaceName}.ts` */
  fileName: string;
  code: string;
  interfaceName: string;
  /** Name of the exported descriptor constant, e.g. `OrgExampleFtl`. */
  constName: string;
}

/** Line width the layout aims at (the repo's prettier `printWidth`). */
const WIDTH = 120;

/** The core classes the built-in interfaces' errors map to, with their export names (§5.7). */
const CORE_CLASSES: readonly (readonly [ErrorClass, string])[] = [
  [InterfaceNotFoundError, "InterfaceNotFoundError"],
  [MethodNotFoundError, "MethodNotFoundError"],
  [MethodNotImplementedError, "MethodNotImplementedError"],
  [InvalidParameterError, "InvalidParameterError"],
  [PermissionDeniedError, "PermissionDeniedError"],
  [ExpectedMoreError, "ExpectedMoreError"],
  [ExpectedUpgradeError, "ExpectedUpgradeError"],
  [InternalError, "InternalError"],
];
const CORE_CLASS_BY_ERROR = new Map(CORE_CLASSES.map(([cls, name]) => [cls.errorName, name]));
const BUILTIN_INTERFACES = new Set([ORG_VARLINK_SERVICE, INTERNAL_ERROR_INTERFACE]);

/** A global regex matching any of `codes` (single code points or inclusive `[from, to]` ranges, all BMP). */
function codePointClass(codes: readonly (number | readonly [number, number])[]): RegExp {
  const hex = (c: number): string => "\\u" + c.toString(16).padStart(4, "0");
  const items = codes.map((c) => (typeof c === "number" ? hex(c) : `${hex(c[0])}-${hex(c[1])}`));
  return new RegExp(`[${items.join("")}]`, "g");
}

/** Quotes, backslashes, C0 controls, DEL and the line separators: not allowed in `importPath`. */
const BAD_IMPORT_PATH = new RegExp(`["'\`\\\\]|${codePointClass([[0, 0x1f], 0x7f, 0x2028, 0x2029]).source}`);

function checkOptions(options: unknown): { ints: IntsMode; importPath: string } {
  if (options === undefined) return { ints: "number", importPath: "varlink-js" };
  if (typeof options !== "object" || options === null || Array.isArray(options))
    throw new TypeError("options must be an object");
  const { ints, importPath } = options as { ints?: unknown; importPath?: unknown };
  if (ints !== undefined && ints !== "number" && ints !== "bigint")
    throw new TypeError('options.ints must be "number" or "bigint"');
  if (
    importPath !== undefined &&
    (typeof importPath !== "string" || importPath === "" || BAD_IMPORT_PATH.test(importPath))
  )
    throw new TypeError("options.importPath must be a non-empty string without quotes, backslashes or line breaks");
  return { ints: ints ?? "number", importPath: importPath ?? "varlink-js" };
}

// Characters ESLint's no-irregular-whitespace flags in comments and templates; written as \uXXXX.
const IRREGULAR = codePointClass([
  0x0b,
  0x0c,
  0x85,
  0xa0,
  0x1680,
  0x180e,
  [0x2000, 0x200b],
  0x2028,
  0x2029,
  0x202f,
  0x205f,
  0x3000,
  0xfeff,
]);

// C0 controls, DEL, C1 controls and the Bidi_Control characters (no raw control bytes or "Trojan Source"
// reordering in generated files); written as \uXXXX in comments and in the IDL template literal.
const CONTROLS = codePointClass([[0, 0x1f], [0x7f, 0x9f], 0x061c, 0x200e, 0x200f, [0x202a, 0x202e], [0x2066, 0x2069]]);

function hex4(c: string): string {
  return "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
}

/** The IDL as a template literal whose value is exactly `text`. */
function templateLiteral(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\\" || ch === "`") out += "\\" + ch;
    else if (ch === "$") out += "\\$";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\n" || ch === "\t") out += ch;
    else if (code >= 0xd800 && code <= 0xdfff) out += hex4(ch);
    else out += ch.replace(CONTROLS, hex4).replace(IRREGULAR, hex4);
  }
  return "`" + out + "`";
}

/**
 * Doc text from the IDL for a TSDoc comment: an `@` before an ASCII letter, `_` or `$` is written as the text
 * `\u0040`, so a peer's doc cannot add tags or bundler hints (`@__PURE__`), nor contain `@internal` (which
 * `stripInternal` finds by substring).
 */
function docText(text: string): string {
  return text.replace(/@(?=[A-Za-z_$])/g, "\\u0040");
}

/** A TSDoc comment from text lines (empty: none). `*\/` cannot end it early. */
function comment(lines: readonly string[]): Doc[] {
  if (lines.length === 0) return [];
  const clean = lines.map((l) => l.replaceAll("*/", "*\\/").replace(CONTROLS, hex4).replace(IRREGULAR, hex4).trimEnd());
  const [only] = clean;
  if (clean.length === 1 && only !== undefined && only !== "") return [`/** ${only} */`, hardline];
  return [
    "/**",
    hardline,
    join(
      hardline,
      clean.map((l) => (l === "" ? " *" : ` * ${l}`)),
    ),
    hardline,
    " */",
    hardline,
  ];
}

function docLines(doc: string | undefined): string[] {
  return doc === undefined ? [] : docText(doc).split("\n");
}

/** `lines`, then `extra` after a blank line if both are non-empty. */
function withSection(lines: string[], extra: readonly string[]): string[] {
  if (extra.length === 0) return lines;
  return lines.length === 0 ? [...extra] : [...lines, "", ...extra];
}

/** A list of the enum values that have docs or are experimental. */
function enumValueDocs(type: EnumType): string[] {
  const out: string[] = [];
  for (const v of type.values) {
    if (v.doc === undefined && !v.experimental) continue;
    const doc = v.doc === undefined ? "" : `: ${docText(v.doc).split("\n").join(" ")}`;
    out.push(`- \`${v.name}\`${doc}${v.experimental ? " (experimental)" : ""}`);
  }
  return out;
}

function experimental(lines: string[], flag: boolean): string[] {
  return flag ? withSection(lines, ["@experimental"]) : lines;
}

/** A TS type expression before layout: unions are flattened so `?T` of an enum is one union. */
type Expr =
  | { readonly k: "atom" | "object" | "array"; readonly doc: Doc }
  | { readonly k: "union"; readonly members: readonly Expr[] };

function atom(text: string): Expr {
  return { k: "atom", doc: text };
}

function isNull(e: Expr): boolean {
  return e.k === "atom" && e.doc === "null";
}

/** prettier keeps `{ … } | null` on one line (shouldHugType). */
function hugs(e: Expr): boolean {
  if (e.k !== "union") return false;
  const nonNull = e.members.filter((m) => !isNull(m));
  return nonNull.length === 1 && nonNull[0]?.k === "object";
}

function render(e: Expr): Doc {
  if (e.k !== "union") return e.doc;
  if (hugs(e)) return join(" | ", e.members.map(render));
  return group([
    ifBreak("| "),
    join(
      [line, "| "],
      e.members.map((m) => align(2, render(m))),
    ),
  ]);
}

/** The type after `name:`, `[key: string]:` or `=`: a union may move to the next line, then break at `|`. */
function rhs(e: Expr): Doc {
  if (e.k === "union" && !hugs(e)) return group(indent([line, render(e)]));
  return [" ", render(e)];
}

function mapOf(e: Expr): Expr {
  return { k: "object", doc: group(["{", indent([line, "[key: string]:", rhs(e)]), ifBreak(";"), line, "}"]) };
}

function arrayOf(e: Expr): Expr {
  if (e.k !== "union") return { k: "array", doc: [e.doc, "[]"] };
  if (hugs(e)) return { k: "array", doc: ["(", render(e), ")[]"] };
  return { k: "array", doc: ["(", group([indent([softline, render(e)]), softline]), ")[]"] };
}

/** Type expressions for one `ints` mode. */
class Generator {
  readonly #ints: IntsMode;

  constructor(ints: IntsMode) {
    this.#ints = ints;
  }

  expr(type: Type): Expr {
    switch (type.kind) {
      case "bool":
        return atom("boolean");
      case "int":
        return atom(this.#ints);
      case "float":
        return atom("number");
      case "string":
        return atom("string");
      case "object":
        return mapOf(atom("unknown"));
      case "any":
        return atom("$vjs.JsonValue");
      case "named":
        return atom(type.name);
      case "struct":
        return this.struct(type);
      case "enum":
        return { k: "union", members: type.values.map((v) => atom(JSON.stringify(v.name))) };
      case "array":
        return arrayOf(this.expr(type.element));
      case "map":
        return mapOf(this.expr(type.element));
      case "nullable": {
        const inner = this.expr(type.element);
        return { k: "union", members: [...(inner.k === "union" ? inner.members : [inner]), atom("null")] };
      }
    }
  }

  /** A struct is always multiline (prettier keeps it so); `()` is `{ [key: string]: never }`. */
  struct(type: StructType): Expr {
    if (type.fields.length === 0) return mapOf(atom("never"));
    const fields = type.fields.map((f) => this.field(f));
    return { k: "object", doc: ["{", indent([hardline, join(hardline, fields)]), hardline, "}"] };
  }

  field(f: Field): Doc {
    let lines = docLines(f.doc);
    const enumType = f.type.kind === "nullable" ? f.type.element : f.type;
    if (enumType.kind === "enum") lines = withSection(lines, enumValueDocs(enumType));
    lines = experimental(lines, f.experimental);
    const optional = f.type.kind === "nullable" ? "?" : "";
    let type = this.expr(f.type);
    // Decoding sets these absent fields to an own `undefined` (so they do not read as Object.prototype's).
    if (type.k === "union" && optional !== "" && INHERITED_NAMES.has(f.name))
      type = { k: "union", members: [...type.members, atom("undefined")] };
    return [...comment(lines), f.name, optional, ":", rhs(type), ";"];
  }
}

/** PascalCase of the dotted interface name, `-` segments joined. */
function pascalName(name: string): string {
  return name
    .split(/[.-]/)
    .filter((s) => s !== "")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

function hasRequiredField(type: StructType): boolean {
  return type.fields.some((f) => f.type.kind !== "nullable");
}

/** `(a, b)` breaking one per line with a trailing comma. */
function args(items: readonly Doc[]): Doc {
  return group(["(", indent([softline, join([",", line], items)]), ifBreak(","), softline, ")"]);
}

/** `<A, B>` breaking one per line (no trailing comma, like prettier for type arguments). */
function typeArgs(items: readonly Doc[]): Doc {
  return group(["<", indent([softline, join([",", line], items)]), softline, ">"]);
}

/** `key: "string"` in an object literal: the string may move to the next line. */
function stringProp(key: string, value: string): Doc {
  return [key, ":", group(indent([line, JSON.stringify(value)]))];
}

/**
 * Generates the TypeScript module for one interface (DESIGN.md §4.13). Deterministic: the same IDL text and
 * options always give the same bytes.
 *
 * @throws {IdlSyntaxError} if `idl` is not valid IDL.
 * @throws {TypeError} for invalid options, or an error of `org.varlink.service` / `INTERNAL_ERROR_INTERFACE`
 *   that has no core class.
 */
export function generate(idl: string, options?: GenerateOptions): GeneratedFile {
  if (typeof idl !== "string") throw new TypeError("idl must be a string");
  const { ints, importPath } = checkOptions(options);
  const iface = parseInterface(idl);
  const gen = new Generator(ints);
  const name = iface.name;
  const builtin = BUILTIN_INTERFACES.has(name);
  const memberNames = new Set(iface.members.map((m) => m.name));
  let constName = pascalName(name);
  if (memberNames.has(constName)) constName += "_Interface";
  const C = constName;

  const statements: Doc[] = [];
  const ifaceDoc = comment(experimental(docLines(iface.doc), iface.experimental));
  statements.push([...ifaceDoc, `export const ${C}_IDL: string = `, templateLiteral(idl), ";"]);

  const methods: { name: string; doc: Doc[]; entry: Doc }[] = [];
  const errors: string[] = [];
  for (const m of iface.members) {
    if (m.kind === "type") {
      const extra = m.type.kind === "enum" ? enumValueDocs(m.type) : [];
      const lines = experimental(withSection(docLines(m.doc), extra), m.experimental);
      statements.push([...comment(lines), `export type ${m.name} =`, rhs(gen.expr(m.type)), ";"]);
      if (m.type.kind === "enum") {
        const values = m.type.values.map((v) => JSON.stringify(v.name));
        const array = group(["[", indent([softline, join([",", line], values)]), ifBreak(","), softline, "]"]);
        statements.push([
          `/** The values of {@link ${m.name}}, in IDL order. */`,
          hardline,
          `export const ${m.name}_Values = `,
          array,
          " as const;",
        ]);
      }
    } else if (m.kind === "method") {
      statements.push([`export type ${m.name}_Input =`, rhs(gen.struct(m.input)), ";"]);
      statements.push([`export type ${m.name}_Output =`, rhs(gen.struct(m.output)), ";"]);
      const notes: string[] = [];
      if (m.more === "requires") notes.push("Requires the `more` flag: call it with `.stream()` or `.collect()`.");
      if (m.more === "supports") notes.push("Supports the `more` flag (`.stream()`, `.collect()`).");
      if (m.upgrade === "requires") notes.push("Requires the `upgrade` flag (protocol upgrade).");
      if (m.upgrade === "supports") notes.push("Supports the `upgrade` flag (protocol upgrade).");
      const doc = comment(experimental(withSection(docLines(m.doc), notes), m.experimental));
      const props: Doc[] = [
        stringProp("interface", name),
        stringProp("name", m.name),
        stringProp("method", `${name}.${m.name}`),
      ];
      if (m.more !== undefined) props.push(stringProp("more", m.more));
      if (m.upgrade !== undefined) props.push(stringProp("upgrade", m.upgrade));
      if (m.experimental) props.push("experimental: true");
      const entry = group(["{", indent([line, join([",", line], props)]), ifBreak(","), line, "}"]);
      methods.push({ name: m.name, doc, entry });
    } else {
      errors.push(m.name);
      const doc = comment(experimental(docLines(m.doc), m.experimental));
      if (builtin) {
        const errorName = `${name}.${m.name}`;
        const cls = CORE_CLASS_BY_ERROR.get(errorName);
        if (cls === undefined) throw new TypeError(`${errorName} has no core error class (built-in interface)`);
        statements.push([
          ...doc,
          `export const ${m.name}: typeof $vjs.${cls} =`,
          group(indent([line, `$vjs.${cls}`])),
          ";",
          hardline,
          ...doc,
          `export type ${m.name} =`,
          group(indent([line, `$vjs.${cls}`])),
          ";",
        ]);
        continue;
      }
      const E = m.name;
      statements.push([`export type ${E}_Parameters =`, rhs(gen.struct(m.type)), ";"]);
      const optional = hasRequiredField(m.type) ? "" : "?";
      statements.push([
        ...doc,
        `export class ${E} extends $vjs.VarlinkError<${E}_Parameters> {`,
        indent([
          hardline,
          "static readonly errorName =",
          group(indent([line, JSON.stringify(`${name}.${E}`)])),
          ";",
          hardline,
          group([
            "constructor(",
            indent([
              softline,
              join([",", line], [`parameters${optional}: ${E}_Parameters`, "options?: $vjs.VarlinkErrorOptions"]),
            ]),
            ifBreak(","),
            softline,
            ") {",
          ]),
          indent([hardline, "super", args([`${E}.errorName`, "parameters", "options"]), ";"]),
          hardline,
          "}",
          hardline,
          group(["static is(", indent([softline, "e: unknown"]), ifBreak(","), softline, `): e is ${E} {`]),
          indent([hardline, "return $vjs.isVarlinkError", args(["e", `${E}.errorName`]), ";"]),
          hardline,
          "}",
        ]),
        hardline,
        "}",
      ]);
    }
  }

  /** An object literal, one entry per line, trailing comma. */
  const block = (items: readonly Doc[]): Doc => [
    "{",
    indent([hardline, join([",", hardline], items)]),
    ",",
    hardline,
    "}",
  ];
  /** A type literal, one member (ending in `;`) per line. */
  const typeBlock = (members: readonly Doc[]): Doc => ["{", indent([hardline, join(hardline, members)]), hardline, "}"];
  // `{}` would trip @typescript-eslint/no-empty-object-type; a mapped type over never is the same type.
  const empty = "{ readonly [K in never]: never }";
  const methodTypes = methods.map((m) => [
    ...m.doc,
    `readonly ${m.name}: $vjs.MethodDescriptor`,
    typeArgs([`${m.name}_Input`, `${m.name}_Output`]),
    ";",
  ]);
  const descriptorType: Doc[] = [
    `readonly name: ${JSON.stringify(name)};`,
    "readonly idl: string;",
    `readonly ints: ${JSON.stringify(ints)};`,
    ["readonly methods: ", methods.length === 0 ? empty : typeBlock(methodTypes), ";"],
    [
      "readonly errors: ",
      errors.length === 0 ? empty : typeBlock(errors.map((e) => `readonly ${e}: typeof ${e};`)),
      ";",
    ],
    ...errors.map((e) => `readonly ${e}: typeof ${e};`),
    [
      comment([
        "A typed client over a connection or pool (registers this interface on it). An interface without `int`",
        "binds in either `ints` mode; otherwise regenerate with `generate(idl, { ints })` for the target's mode.",
      ]),
      group([
        "client(",
        indent([softline, "target: $vjs.Connection | $vjs.Pool"]),
        ifBreak(","),
        softline,
        `): ${C}_Client`,
      ]),
      ";",
    ],
  ];
  statements.push([
    `/** Type of {@link ${C}}, the \`${name}\` descriptor. */`,
    hardline,
    `export type ${C}_Descriptor = `,
    typeBlock(descriptorType),
    ";",
  ]);
  // Without methods both are `{}`; spelled as the mapped type, since a generic reference resolving to `{}` trips
  // @typescript-eslint/no-generated-empty-object-type.
  for (const [suffix, generic] of [
    ["Client", "$vjs.TypedClient"],
    ["Handlers", "$vjs.Handlers"],
  ] as const)
    statements.push([
      `export type ${C}_${suffix} =`,
      methods.length === 0 ? [" ", empty] : group(indent([line, generic, typeArgs([`${C}_Descriptor`])])),
      ";",
    ]);

  const entries: Doc[] = [
    stringProp("name", name),
    `idl: ${C}_IDL`,
    stringProp("ints", ints),
    methods.length === 0 ? "methods: {}" : ["methods: ", block(methods.map((m) => [...m.doc, `${m.name}: `, m.entry]))],
    errors.length === 0 ? "errors: {}" : ["errors: ", block(errors)],
    ...errors,
    ["client: (target) =>", group(indent([line, "$vjs.createClient", args([C, "target"])]))],
  ];
  const lhs = `export const ${C}: ${C}_Descriptor =`;
  const call = `$vjs.freezeDescriptor<${C}_Descriptor>(`;
  const rhsDoc: Doc = [call, block(entries), ");"];
  statements.push([
    ...ifaceDoc,
    lhs.length + 1 + call.length + 1 <= WIDTH ? [lhs, " ", rhsDoc] : [lhs, indent([hardline, rhsDoc])],
  ]);

  const header = [
    `// Generated by varlink-js codegen ${GENERATOR_VERSION} from interface ${name} (ints: ${ints}).`,
    hardline,
    `// Source sha256: ${sha256Utf8(idl)}. Do not edit; regenerate instead.`,
    hardline,
    `import * as $vjs from ${JSON.stringify(importPath)};`,
  ];
  const code = print([header, hardline, hardline, join([hardline, hardline], statements), hardline], WIDTH);
  return { fileName: `${name}.ts`, code, interfaceName: name, constName: C };
}

/** Options for {@link generateFromService}: {@link GenerateOptions} plus the introspection call's. */
export type GenerateFromServiceOptions = GenerateOptions & { signal?: AbortSignal; timeout?: number };

/**
 * Codegen from a running service: `GetInterfaceDescription` of `interfaceName` on `target`, then
 * {@link generate} (M6's "dynamic client from introspection"; the runtime one is `conn.proxy()`).
 *
 * @throws {TypeError} for invalid options, or if the description declares a different interface.
 */
export async function generateFromService(
  target: Connection | Pool,
  interfaceName: string,
  options?: GenerateFromServiceOptions,
): Promise<GeneratedFile> {
  if (typeof interfaceName !== "string") throw new TypeError("interfaceName must be a string");
  if (options !== undefined && (typeof options !== "object" || (options as unknown) === null || Array.isArray(options)))
    throw new TypeError("options must be an object");
  const { signal, timeout, ...rest } = options ?? {};
  if (signal !== undefined && !((signal as unknown) instanceof AbortSignal))
    throw new TypeError("options.signal must be an AbortSignal");
  // The range is checked by the call (like CallOptions.timeout); a non-number fails here, before any I/O.
  if (timeout !== undefined && typeof timeout !== "number") throw new TypeError("options.timeout must be a number");
  const genOptions = checkOptions(rest);
  const callOptions: CallOptions = {};
  if (signal !== undefined) callOptions.signal = signal;
  if (timeout !== undefined) callOptions.timeout = timeout;
  const idl = await target.getInterfaceDescription(interfaceName, callOptions);
  const file = generate(idl, genOptions);
  if (file.interfaceName !== interfaceName)
    throw new TypeError(`the description of ${interfaceName} declares interface ${file.interfaceName}`);
  return file;
}
