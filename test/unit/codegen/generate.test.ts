// generate() (DESIGN.md §4.13): one test group per mapping and naming rule, docs, flags, the built-in exception,
// options, determinism and generateFromService().
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { generate, generateFromService, GENERATOR_VERSION } from "../../../src/codegen/index.ts";
import { sha256Utf8 } from "../../../src/codegen/sha256.ts";
import { IdlSyntaxError } from "../../../src/core/idl/index.ts";
import {
  compileDescriptor,
  createConnection,
  createPool,
  createServer,
  INTERNAL_ERROR_INTERFACE,
  INTERNAL_ERROR_INTERFACE_IDL,
  isVarlinkError,
  ORG_VARLINK_SERVICE,
  ORG_VARLINK_SERVICE_IDL,
  VarlinkError,
  type InterfaceDescriptor,
} from "../../../src/index.ts";
import { pair } from "../../../src/testing/index.ts";
import { COLLISIONS_IDL, TEST_IDL } from "./fixtures.ts";
import { corpusFiles, importGenerated, readText, RUNTIME_URL } from "./helpers.ts";

/** The TS text of field `f` in `type T (f: <type>, g: bool)`. */
function fieldText(type: string, ints: "number" | "bigint" = "number"): string {
  const idl = `interface t.m\n\ntype Named (x: int)\n\ntype T (\n  f: ${type},\n  g: bool\n)\n`;
  const code = generate(idl, { ints }).code;
  const m = /export type T = \{\n {2}([\s\S]*?)\n {2}g: boolean;/.exec(code);
  assert.ok(m?.[1] !== undefined, code);
  return m[1];
}

async function load(idl: string, ints: "number" | "bigint" = "number"): Promise<Record<string, unknown>> {
  return importGenerated(generate(idl, { ints, importPath: RUNTIME_URL }).code);
}

describe("type mapping", () => {
  const cases: [string, string][] = [
    ["bool", "f: boolean;"],
    ["int", "f: number;"],
    ["float", "f: number;"],
    ["string", "f: string;"],
    ["object", "f: { [key: string]: unknown };"],
    ["any", "f: $vjs.JsonValue;"],
    ["?string", "f?: string | null;"],
    ["?any", "f?: $vjs.JsonValue | null;"],
    ["[]string", "f: string[];"],
    ["[]?string", "f: (string | null)[];"],
    ["?[]?string", "f?: (string | null)[] | null;"],
    ["[][]int", "f: number[][];"],
    ["[string]int", "f: { [key: string]: number };"],
    ["[string]?int", "f: { [key: string]: number | null };"],
    ["?[string]?int", "f?: { [key: string]: number | null } | null;"],
    ["[string]()", "f: { [key: string]: { [key: string]: never } };"],
    ["()", "f: { [key: string]: never };"],
    ["(a, b)", 'f: "a" | "b";'],
    ["?(a, b)", 'f?: "a" | "b" | null;'],
    ["[](a, b)", 'f: ("a" | "b")[];'],
    ["(x: int, y: ?string)", "f: {\n    x: number;\n    y?: string | null;\n  };"],
    ["?(x: int)", "f?: {\n    x: number;\n  } | null;"],
    ["[]?(x: int)", "f: ({\n    x: number;\n  } | null)[];"],
    ["Named", "f: Named;"],
    ["?Named", "f?: Named | null;"],
  ];
  for (const [idl, ts] of cases)
    test(`${idl} → ${ts.split("\n").join(" ")}`, () => {
      assert.equal(fieldText(idl), ts);
    });

  test('int is bigint with ints: "bigint", everywhere', () => {
    assert.equal(fieldText("int", "bigint"), "f: bigint;");
    assert.equal(fieldText("[string]?int", "bigint"), "f: { [key: string]: bigint | null };");
    assert.equal(fieldText("float", "bigint"), "f: number;");
    assert.match(generate("interface t.m\n\ntype Named (x: int)\n", { ints: "bigint" }).code, /x: bigint;/);
  });

  test("structs are type aliases; the empty struct is { [key: string]: never }", () => {
    const code = generate("interface t.m\n\ntype E ()\n\ntype S (a: int)\n\nmethod M() -> ()\n").code;
    assert.match(code, /^export type E = \{ \[key: string\]: never \};$/m);
    assert.match(code, /^export type S = \{\n {2}a: number;\n\};$/m);
    assert.match(code, /^export type M_Input = \{ \[key: string\]: never \};$/m);
    assert.match(code, /^export type M_Output = \{ \[key: string\]: never \};$/m);
    assert.doesNotMatch(code, /^export interface/m);
  });

  test("recursive types refer to themselves", () => {
    const code = generate("interface t.m\n\ntype Node (children: []Node, parent: ?Node)\n").code;
    assert.match(code, /children: Node\[\];\n {2}parent\?: Node \| null;/);
  });

  test("a named enum gets a union type and a _Values const in IDL order; inline enums get none", async () => {
    const idl = "interface t.m\n\ntype Color (red, green, blue)\n\ntype T (mode: (on, off), c: Color)\n";
    const code = generate(idl).code;
    assert.match(code, /^export type Color = "red" \| "green" \| "blue";$/m);
    assert.match(code, /^export const Color_Values = \["red", "green", "blue"\] as const;$/m);
    assert.match(code, /mode: "on" \| "off";/);
    assert.doesNotMatch(code, /mode_Values|T_Values/);
    const mod = await load(idl);
    assert.deepEqual(mod.Color_Values, ["red", "green", "blue"]);
  });

  test("field names are emitted bare, reserved words included", () => {
    const code = generate("interface t.m\n\ntype T (enum: int, new: int, class: ?string, constructor: bool)\n").code;
    assert.match(
      code,
      /\n {2}enum: number;\n {2}new: number;\n {2}class\?: string \| null;\n {2}constructor: boolean;\n/,
    );
  });
});

describe("docs and flags", () => {
  const idl = `# Interface doc.
# Second line with */ inside.
interface t.docs

# A type.
# [Experimental]
type T (
  # Field doc */.
  a: int,
  # [Experimental]
  b: ?string,
  c: (
    # first
    one,
    # [Experimental]
    two,
    three
  )
)

# An enum.
type E (
  # value doc
  # on two lines
  x,
  y
)

# Requires more.
# [Requires 'more' flag]
method More() -> ()

# [Supports 'more' flag]
# [Requires 'upgrade' flag]
method Both() -> ()

# [Supports 'upgrade' flag]
# [Experimental]
method Up() -> ()

method Plain() -> ()

# An error.
error Oops ()
`;
  const code = generate(idl).code;

  test("doc comments become TSDoc; */ is escaped", () => {
    assert.match(
      code,
      /\/\*\*\n \* Interface doc\.\n \* Second line with \*\\\/ inside\.\n \*\/\nexport const TDocs_IDL/,
    );
    assert.match(code, /\/\*\*\n \* A type\.\n \*\n \* @experimental\n \*\/\nexport type T = \{/);
    assert.match(code, /\/\*\* Field doc \*\\\/\. \*\/\n {2}a: number;/);
    assert.match(code, /\/\*\* @experimental \*\/\n {2}b\?: string \| null;/);
    assert.match(
      code,
      /\/\*\*\n {3}\* - `one`: first\n {3}\* - `two` \(experimental\)\n {3}\*\/\n {2}c: "one" \| "two" \| "three";/,
    );
    assert.match(
      code,
      /\/\*\*\n \* An enum\.\n \*\n \* - `x`: value doc on two lines\n \*\/\nexport type E = "x" \| "y";/,
    );
    assert.match(code, /\/\*\* An error\. \*\/\nexport class Oops /);
    // Every comment is well formed: no `*/` before its end.
    for (const c of code.match(/\/\*\*[\s\S]*?\*\//g) ?? []) assert.doesNotMatch(c.slice(3, -2), /\*\//);
  });

  test("method flags: descriptor entries and notes in the TSDoc", async () => {
    assert.match(
      code,
      /Requires more\.\n {5}\*\n {5}\* Requires the `more` flag: call it with `\.stream\(\)` or `\.collect\(\)`\./,
    );
    assert.match(
      code,
      /Supports the `more` flag \(`\.stream\(\)`, `\.collect\(\)`\)\.\n {5}\* Requires the `upgrade` flag/,
    );
    assert.match(code, /Supports the `upgrade` flag \(protocol upgrade\)\.\n {5}\*\n {5}\* @experimental/);
    const mod = await load(idl);
    const desc = mod.TDocs as InterfaceDescriptor;
    assert.deepEqual(desc.methods, {
      More: { interface: "t.docs", name: "More", method: "t.docs.More", more: "requires" },
      Both: { interface: "t.docs", name: "Both", method: "t.docs.Both", more: "supports", upgrade: "requires" },
      Up: { interface: "t.docs", name: "Up", method: "t.docs.Up", upgrade: "supports", experimental: true },
      Plain: { interface: "t.docs", name: "Plain", method: "t.docs.Plain" },
    });
    for (const md of Object.values(desc.methods)) {
      assert.equal("~types" in md, false);
      assert.ok(Object.isFrozen(md));
    }
    assert.ok(Object.isFrozen(desc) && Object.isFrozen(desc.methods) && Object.isFrozen(desc.errors));
    compileDescriptor(desc);
  });
});

describe("error classes", () => {
  const idl = "interface t.err\n\nerror Req (a: int, b: ?string)\n\nerror Opt (b: ?string)\n\nerror Empty ()\n";

  test("constructor parameters are optional iff no field is required", () => {
    const code = generate(idl).code;
    assert.match(code, /constructor\(parameters: Req_Parameters, options\?: \$vjs\.VarlinkErrorOptions\)/);
    assert.match(code, /constructor\(parameters\?: Opt_Parameters, options\?: \$vjs\.VarlinkErrorOptions\)/);
    assert.match(code, /constructor\(parameters\?: Empty_Parameters, options\?: \$vjs\.VarlinkErrorOptions\)/);
    assert.match(code, /static readonly errorName = "t\.err\.Req";/);
  });

  test("classes extend VarlinkError with errorName, is() and the descriptor's errors", async () => {
    const mod = await load(idl);
    const Req = mod.Req as new (p: object, o?: ErrorOptions) => VarlinkError & { constructor: unknown };
    const ReqClass = mod.Req as { errorName: string; is(e: unknown): boolean };
    const cause = new Error("x");
    const e = new Req({ a: 1 }, { cause });
    assert.ok(e instanceof VarlinkError);
    assert.equal(e.error, "t.err.Req");
    assert.equal(e.name, "Req");
    assert.equal(e.cause, cause);
    assert.deepEqual(e.parameters, { a: 1 });
    assert.equal(ReqClass.errorName, "t.err.Req");
    assert.equal(ReqClass.is(e), true);
    assert.equal(ReqClass.is(new VarlinkError("t.err.Req")), true); // by name, like the core classes
    assert.equal(ReqClass.is(new VarlinkError("t.err.Opt")), false);
    assert.equal(isVarlinkError(e, "t.err.Req"), true);
    const Empty = mod.Empty as new () => VarlinkError;
    assert.deepEqual(new Empty().parameters, {});
    const desc = mod.TErr as InterfaceDescriptor & Record<string, unknown>;
    assert.deepEqual(desc.errors, { Req: mod.Req, Opt: mod.Opt, Empty: mod.Empty });
    assert.equal(desc.Req, mod.Req);
    compileDescriptor(desc);
  });
});

describe("names", () => {
  test("the const name is the PascalCase of the interface name, - segments joined", () => {
    const cases: [string, string][] = [
      ["org.example.ftl", "OrgExampleFtl"],
      ["io.systemd.Resolve.Monitor", "IoSystemdResolveMonitor"],
      ["org.example.my-iface", "OrgExampleMyIface"],
      ["org.example.x--y", "OrgExampleXY"],
      ["org.3d.thing", "Org3dThing"],
    ];
    for (const [name, constName] of cases) {
      const file = generate(`interface ${name}\n\nmethod M() -> ()\n`);
      assert.deepEqual(file, { ...file, fileName: `${name}.ts`, interfaceName: name, constName });
      for (const suffix of ["_IDL", "_Descriptor", "_Client", "_Handlers"])
        assert.match(file.code, new RegExp(`export (const|type) ${constName}${suffix}\\b`));
      assert.match(file.code, new RegExp(`export const ${constName}: ${constName}_Descriptor`));
    }
  });

  test("a member named like the const name moves it to <Const>_Interface", () => {
    for (const kind of ["method VjsCollide() -> ()", "error VjsCollide ()", "type VjsCollide (a: int)"]) {
      const file = generate(`interface vjs.collide\n\n${kind}\n`);
      assert.equal(file.constName, "VjsCollide_Interface", kind);
      assert.match(file.code, /export const VjsCollide_Interface: VjsCollide_Interface_Descriptor =/);
    }
    assert.equal(generate(COLLISIONS_IDL).constName, "VjsCollide_Interface");
  });

  test("generated code never names a global that a varlink type could shadow", () => {
    const { code } = generate(COLLISIONS_IDL);
    for (const global of [
      "Object.",
      "Record<",
      "Array<",
      "Promise<",
      "ReturnType<",
      "Partial<",
      "ConstructorParameters<",
    ])
      assert.equal(code.includes(global), false, global);
    // The constructor's options use the runtime's alias, not the (here shadowed) global ErrorOptions.
    assert.match(code, /constructor\(parameters: TypeError_Parameters, options\?: \$vjs\.VarlinkErrorOptions\)/);
    // Every generator-made name has a `_` or `$`, so it cannot collide with a member.
    for (const m of code.matchAll(/^export (?:const|type|class) (\w+)/gm)) {
      const name = m[1] ?? "";
      const members = ["Record", "Array", "Promise", "Error", "ErrorOptions", "Object", "String", "Symbol"];
      const more = [
        "JsonValue",
        "VarlinkError",
        "ConstructorParameters",
        "Readonly",
        "TypeError",
        "Partial",
        "Inherited",
      ];
      assert.ok(name.includes("_") || [...members, ...more, "ReturnType"].includes(name), name);
    }
  });
});

describe("the built-in exception (org.varlink.service, INTERNAL_ERROR_INTERFACE)", () => {
  test("no error classes: the errors are the core classes, also as top-level aliases", async () => {
    for (const idl of [
      ORG_VARLINK_SERVICE_IDL,
      ...corpusFiles()
        .filter((f) => f.endsWith("org.varlink.service.varlink"))
        .map(readText),
    ]) {
      const code = generate(idl).code;
      assert.doesNotMatch(code, /export class/);
      assert.match(
        code,
        /^export const InterfaceNotFound: typeof \$vjs\.InterfaceNotFoundError = \$vjs\.InterfaceNotFoundError;$/m,
      );
      assert.match(code, /^export type InterfaceNotFound = \$vjs\.InterfaceNotFoundError;$/m);
    }
    const mod = await load(INTERNAL_ERROR_INTERFACE_IDL);
    const root = await import("../../../src/index.ts");
    assert.equal(mod.InternalError, root.InternalError);
    assert.equal((mod.IoGithubPzmarzlyVarlinkjs as InterfaceDescriptor).errors.InternalError, root.InternalError);
  });

  test("an error without a core class is a TypeError", () => {
    assert.throws(
      () => generate(ORG_VARLINK_SERVICE_IDL + "\nerror Bogus ()\n"),
      (e) => e instanceof TypeError && e.message.includes(`${ORG_VARLINK_SERVICE}.Bogus`),
    );
    assert.throws(
      () => generate(INTERNAL_ERROR_INTERFACE_IDL + "\nerror InternalErrorToo ()\n"),
      (e) => e instanceof TypeError && e.message.includes(`${INTERNAL_ERROR_INTERFACE}.InternalErrorToo`),
    );
  });
});

describe("options, header, determinism", () => {
  const idl = readText("test/corpus/uapi/org.example.ftl.varlink");

  test("invalid options are TypeErrors; invalid IDL is an IdlSyntaxError", () => {
    const bad: unknown[] = [
      null,
      "number",
      { ints: "Number" },
      { ints: 64 },
      { importPath: "" },
      { importPath: 5 },
      { importPath: 'a"b' },
      { importPath: "a'b" },
      { importPath: "a`b" },
      { importPath: "a\\b" },
      { importPath: "a\nb" },
      { importPath: "a\u0000b" },
      { importPath: `a${String.fromCharCode(0x2028)}b` },
    ];
    for (const options of bad) assert.throws(() => generate(idl, options as never), TypeError, JSON.stringify(options));
    assert.throws(() => generate(42 as never), TypeError);
    assert.throws(() => generate("interface bad"), IdlSyntaxError);
    assert.throws(() => generate("interface t.m\n\ntype T (a: Missing)\n"), IdlSyntaxError);
  });

  test("the header names the version, interface, ints mode and source hash, and nothing else", () => {
    const { code } = generate(idl, { ints: "bigint", importPath: "./rt.ts" });
    const lines = code.split("\n");
    assert.deepEqual(lines.slice(0, 3), [
      `// Generated by varlink-js codegen ${GENERATOR_VERSION} from interface org.example.ftl (ints: bigint).`,
      `// Source sha256: ${sha256Utf8(idl)}. Do not edit; regenerate instead.`,
      'import * as $vjs from "./rt.ts";',
    ]);
    assert.ok(code.endsWith("});\n"));
  });

  test("GENERATOR_VERSION is the package version", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    assert.equal(GENERATOR_VERSION, pkg.version);
  });

  test("identical input and options give identical bytes", () => {
    for (const ints of ["number", "bigint"] as const)
      assert.equal(generate(idl, { ints }).code, generate(idl, { ints }).code);
    assert.notEqual(generate(idl).code, generate(idl, { ints: "bigint" }).code);
  });

  test("the IDL constant round-trips byte-exactly (escapes, CRLF, non-ASCII)", async () => {
    const c = (cp: number): string => String.fromCodePoint(cp);
    const idl2 =
      `# Back\`tick, \${dollar}, $x and \\backslash,\ttab ${c(0xa0)}nbsp ${c(0xfeff)}bom ${c(0x3000)}ideographic\r\n` +
      `interface t.weird\r\n\r\n# caf${c(0xe9)} ${c(0x2713)} ${c(0x1f98a)}\r\ntype T (a: int)\r\n`;
    const { code } = generate(idl2, { importPath: RUNTIME_URL });
    for (const cp of [0xa0, 0xfeff, 0x3000]) assert.equal(code.includes(c(cp)), false, cp.toString(16));
    const mod = await load(idl2);
    assert.equal(mod.TWeird_IDL, idl2);
    assert.equal((mod.TWeird as InterfaceDescriptor).idl, idl2);
  });
});

describe("generateFromService", () => {
  function serve(): { conn: ReturnType<typeof createConnection>; dial: () => ReturnType<typeof createConnection> } {
    const server = createServer({ validateReplies: "off" });
    server.addInterface(TEST_IDL);
    const dial = (): ReturnType<typeof createConnection> => {
      const [a, b] = pair();
      void server.handle(b);
      return createConnection(a);
    };
    return { conn: dial(), dial };
  }

  test("generates from GetInterfaceDescription on a Connection or a Pool", async () => {
    const { conn, dial } = serve();
    assert.deepEqual(await generateFromService(conn, "org.example.typed"), generate(TEST_IDL));
    assert.deepEqual(
      await generateFromService(conn, "org.example.typed", { ints: "bigint", timeout: 1000 }),
      generate(TEST_IDL, { ints: "bigint" }),
    );
    const pool = createPool(() => Promise.resolve(dial()));
    assert.deepEqual(await generateFromService(pool, "org.example.typed"), generate(TEST_IDL));
    await pool.close();
    await conn.close();
  });

  test("a description declaring another interface is a TypeError; options are checked; signal applies", async () => {
    const fake = { getInterfaceDescription: () => Promise.resolve(TEST_IDL) } as never;
    await assert.rejects(generateFromService(fake, "org.example.other"), TypeError);
    const { conn } = serve();
    await assert.rejects(generateFromService(conn, "org.example.typed", { ints: "x" as never }), TypeError);
    await assert.rejects(generateFromService(conn, 5 as never), TypeError);
    const reason = new Error("stop");
    await assert.rejects(
      generateFromService(conn, "org.example.typed", { signal: AbortSignal.abort(reason) }),
      (e) => e === reason,
    );
    await assert.rejects(generateFromService(conn, "org.example.nope"), (e) =>
      isVarlinkError(e, `${ORG_VARLINK_SERVICE}.InterfaceNotFound`),
    );
    await conn.close();
  });
});
