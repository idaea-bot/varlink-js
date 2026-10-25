// Regression tests for the M6 review-2 fixes (DESIGN.md §4.11, §4.13): built-in names accept only IDL compatible
// with the built-in definition, `@internal` in a peer's doc survives `stripInternal`, per-entry pool failures ask
// the leased connection, and optional fields named like Object.prototype members are typed `| undefined`.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import ts from "typescript";
import { generate } from "../../../src/codegen/index.ts";
import {
  createConnection,
  createPool,
  createServer,
  type Connection,
  type ConnectionOptions,
  type InterfaceDescriptor,
  type Server,
} from "../../../src/index.ts";
import { OrgVarlinkService } from "../../../src/interfaces/index.ts";
import { pair } from "../../../src/testing/index.ts";
import { OrgExampleTyped as BigTyped } from "./generated/bigint/org.example.typed.ts";
import { OrgExampleTyped, type Item } from "./generated/org.example.typed.ts";
import { COLLISIONS_IDL } from "./fixtures.ts";
import { importGenerated, RUNTIME_URL } from "./helpers.ts";

const ITEM: Item = { id: 1, name: "one", tags: {}, kind: "small" };

function dial(server: Server, options?: ConnectionOptions): Connection {
  const [a, b] = pair();
  void server.handle(b);
  return createConnection(a, options);
}

describe("M1: a built-in name accepts only IDL compatible with the built-in definition", () => {
  const BASE = OrgVarlinkService.idl;
  const variants: [label: string, idl: string, message: RegExp][] = [
    [
      "A: an extra output field",
      BASE.replace("  interfaces: []string\n", "  interfaces: []string,\n  build: string\n"),
      /^interface org\.varlink\.service: method GetInfo differs from the built-in definition$/,
    ],
    [
      "B: an extra method",
      BASE + "\nmethod Ping(x: int) -> (n: int)\n",
      /^interface org\.varlink\.service: method Ping is not in the built-in definition$/,
    ],
    [
      "an error with other parameters",
      BASE.replace("error PermissionDenied ()", "error PermissionDenied (why: string)"),
      /error PermissionDenied differs/,
    ],
    [
      "an error declared as a type",
      BASE.replace("error ExpectedMore ()", "type ExpectedMore ()"),
      /type ExpectedMore differs/,
    ],
  ];

  for (const [label, idl, message] of variants)
    test(label, async () => {
      assert.notEqual(idl, BASE, "the variant changes the text");
      const server = createServer();
      const conn = dial(server, { ints: "bigint" });
      assert.throws(
        () => {
          conn.addInterface(idl);
        },
        (e) => e instanceof TypeError && message.test(e.message),
      );
      const pool = createPool(() => Promise.resolve(dial(server, { ints: "bigint" })));
      assert.throws(
        () => {
          pool.addInterface(idl);
        },
        (e) => e instanceof TypeError && message.test(e.message),
      );
      // The generated (bigint) client of that text rejects on both too.
      const file = generate(idl, { ints: "bigint", importPath: RUNTIME_URL });
      const mod = await importGenerated(file.code);
      const desc = mod[file.constName] as InterfaceDescriptor & { client(target: unknown): unknown };
      assert.throws(() => desc.client(conn), TypeError);
      assert.throws(() => desc.client(pool), TypeError);
      // Nothing was registered: the built-in still validates and works.
      assert.equal(typeof (await conn.getInfo()).vendor, "string");
      assert.equal(typeof (await pool.getInfo()).vendor, "string");
      await conn.close();
      await pool.close();
    });

  test("docs, member order and markers are ignored", async () => {
    const reordered = [
      "# Another implementation's text.",
      "# [Experimental]",
      "interface org.varlink.service",
      "",
      "error InterfaceNotFound (interface: string)",
      "",
      "# [Supports 'more' flag]",
      "method GetInterfaceDescription(",
      "  # which one",
      "  interface: string",
      ") -> (description: string)",
      "",
      "method GetInfo() -> (vendor: string, product: string, version: string, url: string, interfaces: []string)",
      "",
    ].join("\n");
    const conn = dial(createServer({ vendor: "v" }));
    conn.addInterface(reordered);
    const pool = createPool(() => Promise.resolve(dial(createServer({ vendor: "v" }))));
    pool.addInterface(reordered);
    const file = generate(reordered, { importPath: RUNTIME_URL });
    const mod = await importGenerated(file.code);
    const desc = mod[file.constName] as InterfaceDescriptor & {
      client(target: unknown): { GetInfo(): Promise<{ vendor: string }> };
    };
    assert.equal((await desc.client(conn).GetInfo()).vendor, "v");
    assert.equal((await desc.client(pool).GetInfo()).vendor, "v");
    await conn.close();
    await pool.close();
  });
});

describe("L1: a peer's @internal doc does not make stripInternal drop declarations", () => {
  const idl = [
    "interface t.strip",
    "",
    "# @internal secret type; @deprecated too; mail a@b.c, a lone @ and @1",
    "type Secret (a: ?int)",
    "",
    "method M(s: Secret) -> ()",
    "",
  ].join("\n");

  test("transpileDeclaration with stripInternal keeps type Secret", () => {
    const { code } = generate(idl);
    const comments = (code.match(/\/\*\*[\s\S]*?\*\//g) ?? []).join("\n");
    assert.equal(comments.includes("@internal"), false);
    assert.equal(comments.includes("@deprecated"), false);
    // Only `@` before an ASCII letter is escaped.
    assert.ok(
      comments.includes("\\u0040internal secret type; \\u0040deprecated too; mail a\\u0040b.c, a lone @ and @1"),
    );
    const out = ts.transpileDeclaration(code, {
      compilerOptions: { stripInternal: true, isolatedDeclarations: true, strict: true },
      reportDiagnostics: true,
    });
    assert.deepEqual(
      (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
      [],
    );
    assert.match(out.outputText, /export type Secret = \{/);
    assert.match(out.outputText, /s: Secret;/);
  });
});

describe("L2: a pool blocks untyped calls only if the leased connection lacks the interface", () => {
  test("connections with `interfaces: [Num.idl]`, then Big.client(pool)", async () => {
    const server = createServer();
    server.implement(OrgExampleTyped, { Get: () => ({ item: ITEM }) });
    const pool = createPool(() => Promise.resolve(dial(server, { interfaces: [OrgExampleTyped.idl] })));
    const big = BigTyped.client(pool);
    assert.deepEqual(await pool.call("org.example.typed.Get", { id: 1 }), { item: ITEM });
    await assert.rejects(big.Get({ id: 1n }), (e) => e instanceof TypeError && /ints/.test(e.message));
    await assert.rejects(pool.call(BigTyped.methods.Get, { id: 1n }), TypeError);
    const it = pool.stream("org.example.typed.Get", { id: 1 });
    assert.deepEqual((await it.next()).value, { item: ITEM });
    await it.return();
    await pool.close();
  });
});

describe("Nit: optional fields named like Object.prototype members are typed `| undefined`", () => {
  test("only those fields get `| undefined`", () => {
    const { code } = generate(COLLISIONS_IDL);
    const withUndefined = [...code.matchAll(/^\s*(\w+)\?: .*\| undefined;$/gm)].map((m) => m[1]);
    assert.deepEqual(withUndefined, [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
    ]);
    assert.equal(code.split("| undefined").length - 1, withUndefined.length);
    // A required field of such a name is unchanged.
    assert.match(code, /^ {2}constructor: string;$/m);
  });
});
