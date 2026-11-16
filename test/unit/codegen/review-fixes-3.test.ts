// Regression tests for the M6 review-3 fixes (DESIGN.md §4.9, §4.11, §4.13): an interface without `int` binds in
// either `ints` mode, pool failures are per entry (a spread copy sharing method objects is not blocked once another
// entry with the same IDL text applied), and the `@` escaping of doc text covers `_` and `$`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { generate } from "../../../src/codegen/index.ts";
import { parseInterface } from "../../../src/core/idl/index.ts";
import { bindDescriptor, usesInt } from "../../../src/core/types/descriptors.ts";
import {
  createClient,
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
import { OrgExampleTyped } from "./generated/org.example.typed.ts";
import { importGenerated, RUNTIME_URL } from "./helpers.ts";

function dial(server: Server, options?: ConnectionOptions): Connection {
  const [a, b] = pair();
  void server.handle(b);
  return createConnection(a, options);
}

const INT_FREE_IDL = [
  "interface t.intfree",
  "",
  "type Point (x: float, y: float, tags: [string]string)",
  "",
  "method Echo(p: Point, words: []string) -> (p: Point, n: ?float)",
  "",
  "error Bad (why: string)",
  "",
].join("\n");

interface IntFreeClient {
  Echo(p: unknown): Promise<unknown>;
}
type IntFreeDescriptor = InterfaceDescriptor & { client(target: unknown): IntFreeClient };

/** The int-free interface generated in "number" mode, imported. */
async function intFree(): Promise<IntFreeDescriptor> {
  const mod = await importGenerated(generate(INT_FREE_IDL, { importPath: RUNTIME_URL }).code);
  const desc = mod.TIntfree as IntFreeDescriptor;
  assert.equal(desc.ints, "number");
  return desc;
}

const POINT = { x: 1.5, y: 2, tags: { a: "b" } };

describe("A: an interface without int binds in either ints mode", () => {
  test("usesInt finds int at any depth", () => {
    assert.equal(usesInt(parseInterface(INT_FREE_IDL)), false);
    assert.equal(usesInt(parseInterface(OrgVarlinkService.idl)), false);
    const positions = [
      "type T (a: int)",
      "type T (a: ?int)",
      "type T (a: []int)",
      "type T (a: [string]int)",
      "type T (a: [string]?[]int)",
      "type T (a: (b: (c: ?int)))",
      "method M(a: (b: []?int)) -> ()",
      "method M() -> (a: [string](b: int))",
      "error E (a: ?[]int)",
    ];
    for (const member of positions) assert.equal(usesInt(parseInterface(`interface t.u\n\n${member}\n`)), true, member);
    assert.equal(usesInt(parseInterface("interface t.u\n\ntype T (a: (b: [string]?[]float), e: (x, y))\n")), false);
  });

  test("bindDescriptor compiles an int-free descriptor with the runtime's mode, else asserts it", async () => {
    const desc = await intFree();
    assert.equal(bindDescriptor(desc, "bigint").ints, "bigint");
    assert.equal(bindDescriptor(desc, "number").ints, "number");
    assert.throws(() => bindDescriptor(OrgExampleTyped, "bigint"), /generated for ints: "number"/);
    assert.equal(bindDescriptor(BigTyped, "bigint").ints, "bigint");
  });

  test("OrgVarlinkService.client on a bigint connection", async () => {
    const conn = dial(createServer({ ints: "bigint" }), { ints: "bigint" });
    const svc = OrgVarlinkService.client(conn);
    assert.equal(
      (await svc.GetInterfaceDescription({ interface: "org.varlink.service" })).description,
      OrgVarlinkService.idl,
    );
    await conn.close();
  });

  test("a number-generated int-free descriptor on a bigint Connection, Pool and server.implement", async () => {
    const desc = await intFree();
    const server = createServer({ ints: "bigint" });
    server.implement(desc, {
      Echo: (p: { p: unknown; words: string[] }) => ({ p: p.p, n: p.words.length }),
    } as never);
    const conn = dial(server, { ints: "bigint" });
    assert.deepEqual(await desc.client(conn).Echo({ p: POINT, words: ["a", "b"] }), { p: POINT, n: 2 });
    await conn.close();
    const pool = createPool(() => Promise.resolve(dial(server, { ints: "bigint" })));
    assert.deepEqual(await desc.client(pool).Echo({ p: POINT, words: [] }), { p: POINT, n: 0 });
    await pool.close();
  });

  test("an int-using descriptor still throws the TypeError", async () => {
    const message = /generated for ints: "number", but the runtime uses "bigint"/;
    const conn = dial(createServer(), { ints: "bigint" });
    assert.throws(
      () => OrgExampleTyped.client(conn),
      (e) => e instanceof TypeError && message.test(e.message),
    );
    assert.throws(
      () => {
        createServer({ ints: "bigint" }).implement(OrgExampleTyped, {});
      },
      (e) => e instanceof TypeError && message.test(e.message),
    );
    await conn.close();
    const pool = createPool(() => Promise.resolve(dial(createServer(), { ints: "bigint" })));
    await assert.rejects(
      OrgExampleTyped.client(pool).Get({ id: 1 }),
      (e) => e instanceof TypeError && message.test(e.message),
    );
    await pool.close();
  });
});

describe("B: pool failures are per entry", () => {
  test("a rejected spread copy first, then the descriptor sharing its method objects", async () => {
    const server = createServer({ ints: "bigint" });
    const item = { id: 1n, name: "one", tags: {}, kind: "small" as const };
    server.implement(BigTyped, { Get: () => ({ item }) });
    const pool = createPool(() => Promise.resolve(dial(server, { ints: "bigint" })), { max: 1 });
    // Shares BigTyped's method objects; rejected on a bigint connection (the IDL uses int).
    const wrong: InterfaceDescriptor = { ...BigTyped, ints: "number" };
    assert.equal(wrong.methods.Get, BigTyped.methods.Get);
    await assert.rejects(
      createClient(wrong as typeof BigTyped, pool).Get({ id: 1n }),
      (e) => e instanceof TypeError && /generated for ints: "number"/.test(e.message),
    );
    // The same (already leased) connection accepts BigTyped: its methods are no longer blocked.
    assert.deepEqual(await BigTyped.client(pool).Get({ id: 1n }), { item });
    assert.deepEqual(await pool.call(BigTyped.methods.Get, { id: 1n }), { item });
    assert.equal(pool.size, 1);
    await pool.close();
  });

  test("the descriptor first, then a rejected spread copy sharing its method objects", async () => {
    const server = createServer({ ints: "bigint" });
    const item = { id: 1n, name: "one", tags: {}, kind: "small" as const };
    server.implement(BigTyped, { Get: () => ({ item }) });
    const pool = createPool(() => Promise.resolve(dial(server, { ints: "bigint" })), { max: 1 });
    assert.deepEqual(await BigTyped.client(pool).Get({ id: 1n }), { item });
    const wrong: InterfaceDescriptor = { ...BigTyped, ints: "number" };
    assert.deepEqual(await createClient(wrong as typeof BigTyped, pool).Get({ id: 1n }), { item });
    await pool.close();
  });
});

describe("C, D: `@` escaping in doc text", () => {
  test("`@` before `_` or `$` is escaped too", () => {
    const idl = "interface t.at\n\n# hints @__PURE__ @__NO_SIDE_EFFECTS__ @$x @_y, kept: @1 @ @-\ntype T ()\n";
    const comments = (generate(idl).code.match(/\/\*\*[\s\S]*?\*\//g) ?? []).join("\n");
    assert.ok(
      comments.includes("hints \\u0040__PURE__ \\u0040__NO_SIDE_EFFECTS__ \\u0040$x \\u0040_y, kept: @1 @ @-"),
      comments,
    );
  });

  test("the docs show the escape as the text \\u0040", () => {
    const source = readFileSync("src/codegen/generate.ts", "utf8");
    assert.match(source, /`@` before an ASCII letter, `_` or `\$` is written as the text\n \* `\\u0040`/);
    const design = readFileSync("docs/DESIGN.md", "utf8");
    assert.match(design, /letter, `_` or `\$` written as the text `\\u0040`/);
  });
});
