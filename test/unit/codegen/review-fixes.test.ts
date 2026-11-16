// Regression tests for the M6 review fixes (DESIGN.md §4.9, §4.11, §4.13, §5.3): typed calls always decode,
// per-interface pool failures, generated built-ins from other implementations, Object.prototype field names,
// user error registries, control characters and `@` in generated comments, generateFromService options.
/* eslint-disable @typescript-eslint/require-await -- streaming handlers are async generators without awaits */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generate, generateFromService } from "../../../src/codegen/index.ts";
import {
  compileInterfaceText,
  createConnection,
  createPool,
  createServer,
  ErrorRegistry,
  InternalError,
  InvalidParameterError,
  MethodNotFoundError,
  ORG_VARLINK_SERVICE,
  ValidationError,
  type Connection,
  type ConnectionOptions,
  type InterfaceDescriptor,
  type Server,
  type ServerOptions,
  type TypedClient,
} from "../../../src/index.ts";
import { OrgVarlinkService } from "../../../src/interfaces/index.ts";
import { pair } from "../../../src/testing/index.ts";
import { OrgExampleTyped as BigTyped } from "./generated/bigint/org.example.typed.ts";
import { OrgExampleTyped, type Item } from "./generated/org.example.typed.ts";
import { COLLISIONS_IDL, TEST_IDL } from "./fixtures.ts";
import { corpusFiles, importGenerated, readText, RUNTIME_URL } from "./helpers.ts";

const ITEM: Item = { id: 1, name: "one", tags: {}, kind: "small" };

function dial(server: Server, options?: ConnectionOptions): Connection {
  const [a, b] = pair();
  void server.handle(b);
  return createConnection(a, options);
}

/** A number-mode server whose Get replies `item` plus an undeclared field, unvalidated. */
function extraFieldServer(options?: ServerOptions): Server {
  const server = createServer({ validateReplies: "off", ...options });
  server.implement(OrgExampleTyped, {
    Get: () => ({ item: ITEM, extra: "x" }) as never,
    List: async function* () {
      yield { item: { id: "bad" } } as never;
      return { item: ITEM };
    },
  });
  return server;
}

function bigServer(): Server {
  const server = createServer({ ints: "bigint" });
  server.implement(BigTyped, {
    Get: ({ id }) => ({ item: { id, name: typeof id, tags: {}, kind: "large" } }),
  });
  return server;
}

describe('H1: typed calls decode replies even with validateReplies "off"', () => {
  test("bigint mode: a safe int comes back as a bigint (Connection)", async () => {
    const conn = dial(bigServer(), { ints: "bigint" });
    const { item } = await BigTyped.client(conn).Get({ id: 5n });
    assert.equal(typeof item.id, "bigint");
    assert.equal(item.id, 5n);
    const direct = await conn.call(BigTyped.methods.Get, { id: 6n });
    assert.equal(typeof direct.item.id, "bigint");
    // An untyped call keeps M4 behaviour ("off": raw parameters, a safe int is a number).
    const raw = (await conn.call("org.example.typed.Get", { id: 7 })) as { item: { id: unknown } };
    assert.equal(typeof raw.item.id, "number");
    await conn.close();
  });

  test("bigint mode: a safe int comes back as a bigint (Pool)", async () => {
    const server = bigServer();
    const pool = createPool(() => Promise.resolve(dial(server, { ints: "bigint" })));
    const { item } = await BigTyped.client(pool).Get({ id: 5n });
    assert.equal(typeof item.id, "bigint");
    assert.equal(typeof (await pool.call(BigTyped.methods.Get, { id: 6n })).item.id, "bigint");
    await pool.close();
  });

  test("number mode: unknown reply fields are dropped for typed calls, kept for untyped ones", async () => {
    const conn = dial(extraFieldServer());
    assert.deepEqual(await OrgExampleTyped.client(conn).Get({ id: 1 }), { item: ITEM });
    assert.deepEqual(await conn.call(OrgExampleTyped.methods.Get, { id: 1 }), { item: ITEM });
    // The interface is registered now, but untyped calls under "off" still get the raw reply.
    assert.deepEqual(await conn.call("org.example.typed.Get", { id: 1 }), { item: ITEM, extra: "x" });
    await conn.close();

    const pool = createPool(() => Promise.resolve(dial(extraFieldServer())));
    assert.deepEqual(await OrgExampleTyped.client(pool).Get({ id: 1 }), { item: ITEM });
    assert.deepEqual(await pool.call("org.example.typed.Get", { id: 1 }), { item: ITEM, extra: "x" });
    await pool.close();
  });

  test('an invalid reply to a typed call: raw value + onError "invalid-reply", as with "warn"', async () => {
    const reported: string[] = [];
    const conn = dial(extraFieldServer(), {
      onError: (_e, info) => {
        reported.push(`${info.reason} ${info.method}`);
      },
    });
    const replies = await OrgExampleTyped.client(conn).List.collect({});
    assert.deepEqual(replies, [{ item: { id: "bad" } }, { item: ITEM }]);
    assert.deepEqual(reported, ["invalid-reply org.example.typed.List"]);
    await conn.close();
  });

  test('number mode: an unsafe int in a typed reply rejects (int-range), as with "warn"', async () => {
    // A bigint server (same IDL) sends an int beyond 2^53 to a number-mode client.
    const server = createServer({ ints: "bigint" });
    server.implement(BigTyped, { Get: () => ({ item: { ...ITEM, id: 2n ** 60n } }) });
    const conn = dial(server);
    await assert.rejects(OrgExampleTyped.client(conn).Get({ id: 1 }), ValidationError);
  });
});

describe("M1: an interface a pool connection rejects fails only the operations that use it", () => {
  test("a bigint descriptor on a number-mode pool", async () => {
    const server = createServer();
    server.implement(OrgExampleTyped, { Get: () => ({ item: ITEM }) });
    let opened = 0;
    const pool = createPool(() => {
      opened++;
      return Promise.resolve(dial(server));
    });
    const big = BigTyped.client(pool);
    await assert.rejects(big.Get({ id: 1n }), (e) => e instanceof TypeError && /ints/.test(e.message));
    await assert.rejects(pool.call(BigTyped.methods.Get, { id: 1n }), TypeError);
    const it = big.Get.stream({ id: 1n });
    await assert.rejects(it.next(), TypeError);
    // Untyped calls into the interface fail with the recorded error while nothing registered it.
    await assert.rejects(pool.call("org.example.typed.Get", { id: 1 }), TypeError);
    // Everything else on the same pool (and the same connection) works.
    assert.ok((await pool.getInfo()).interfaces.includes("org.example.typed"));
    assert.equal(typeof (await pool.call("org.varlink.service.GetInfo")).vendor, "string");
    assert.equal(await pool.getInterfaceDescription("org.example.typed"), TEST_IDL);
    // A correct number-mode client of the same interface works; then so do untyped calls into it.
    const num = OrgExampleTyped.client(pool);
    assert.deepEqual(await num.Get({ id: 1 }), { item: ITEM });
    assert.deepEqual(await pool.call("org.example.typed.Get", { id: 1 }), { item: ITEM });
    // The rejected descriptor stays rejected.
    await assert.rejects(big.Get({ id: 1n }), TypeError);
    await assert.rejects(big.Get.collect({ id: 1n }), TypeError);
    assert.equal(opened, 1);
    assert.equal(pool.idle, 1);
    await pool.close();
  });
});

describe("M2: generated org.varlink.service from any implementation binds and calls", () => {
  const files = corpusFiles().filter((p) => /org\.varlink\.service\.varlink$/.test(p));

  test("the corpus has the five implementations' texts", () => {
    assert.equal(files.length, 5, files.join(", "));
  });

  for (const path of files)
    test(path, async () => {
      const idl = readText(path);
      const file = generate(idl, { importPath: RUNTIME_URL });
      const mod = await importGenerated(file.code);
      const desc = mod[file.constName] as InterfaceDescriptor & {
        client(target: unknown): TypedClient<InterfaceDescriptor>;
      };
      const server = createServer({ vendor: "v" });
      const conn = dial(server);
      if (idl !== OrgVarlinkService.idl) conn.addInterface(idl); // IDL text with a different text is accepted too
      const svc = desc.client(conn) as unknown as {
        GetInfo(): Promise<{ vendor: string; interfaces: string[] }>;
        GetInterfaceDescription(p: { interface: string }): Promise<unknown>;
      };
      const info = await svc.GetInfo();
      assert.equal(info.vendor, "v");
      assert.ok(info.interfaces.includes(ORG_VARLINK_SERVICE));
      // The built-in (UAPI) definition still validates: its errors map to the core classes.
      await assert.rejects(svc.GetInterfaceDescription({ interface: "no.such" }), (e) => e instanceof Error);
      await conn.close();

      const pool = createPool(() => Promise.resolve(dial(server)));
      pool.addInterface(OrgVarlinkService);
      pool.addInterface(idl);
      const viaPool = desc.client(pool) as unknown as typeof svc;
      assert.equal((await viaPool.GetInfo()).vendor, "v");
      assert.equal((await pool.getInfo()).vendor, "v");
      await pool.close();
    });

  test("other names keep the different-IDL TypeError", () => {
    const conn = dial(createServer(), { interfaces: [TEST_IDL] });
    assert.throws(() => {
      conn.addInterface(TEST_IDL.replace("method Log", "method Logs"));
    }, TypeError);
  });
});

describe("M3: absent optional fields named like Object.prototype members", () => {
  const NAMES: readonly string[] = ["constructor", "toString", "valueOf"];

  test("decode {} reads undefined for each; JSON omits them; other fields unchanged", () => {
    const t = compileInterfaceText(
      "interface t.m\n\ntype T (constructor: ?int, toString: ?string, valueOf: ?bool, other: ?int)\n",
    ).types.get("T");
    assert.ok(t);
    for (const unknownFields of ["reject", "drop"] as const) {
      const v = t.decode({}, { unknownFields }) as Record<string, unknown>;
      for (const n of NAMES) {
        assert.equal(v[n], undefined, n);
        assert.ok(Object.hasOwn(v, n), n);
      }
      assert.equal(Object.hasOwn(v, "other"), false);
      assert.equal(JSON.stringify(v), "{}");
    }
    assert.deepEqual(t.decode({ toString: "s", other: 1 }), {
      constructor: undefined,
      toString: "s",
      valueOf: undefined,
      other: 1,
    });
    // Encode is unchanged.
    assert.deepStrictEqual(t.encode({}), {});
  });

  test("server handler input and typed client result over pair()", async () => {
    const file = generate(COLLISIONS_IDL, { importPath: RUNTIME_URL });
    const mod = await importGenerated(file.code);
    const desc = mod[file.constName] as InterfaceDescriptor & {
      client(target: unknown): { Inherit(p: { t: object }): Promise<{ t: Record<string, unknown> }> };
    };
    const seen: Record<string, unknown>[] = [];
    const server = createServer();
    server.implement(desc, {
      Inherit: ({ t }: { t: Record<string, unknown> }) => {
        seen.push(t);
        return { t: {} };
      },
    } as never);
    const conn = dial(server, { validateReplies: "throw" });
    const { t } = await desc.client(conn).Inherit({ t: {} });
    const all = [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
    ];
    for (const v of [t, seen[0]]) {
      assert.ok(v);
      for (const n of all) assert.equal(v[n], undefined, n);
    }
    await conn.close();
  });
});

describe("L1: a user-supplied error registry is never changed in its existing entries", () => {
  class MyInvalid extends InvalidParameterError {}

  test("a custom subclass is kept and used for an InvalidParameter error reply", async () => {
    const errors = new ErrorRegistry().register(MyInvalid);
    const server = createServer();
    server.implement(OrgExampleTyped, { Get: () => ({ item: ITEM }) });
    const conn = dial(server, { errors });
    assert.equal(errors.get(InvalidParameterError.errorName), MyInvalid);
    // A generated built-in client does not replace it either.
    OrgVarlinkService.client(conn);
    assert.equal(errors.get(InvalidParameterError.errorName), MyInvalid);
    // Gaps are filled with the core classes.
    assert.equal(errors.get(MethodNotFoundError.errorName), MethodNotFoundError);
    await assert.rejects(conn.call("org.example.typed.Get", {}), (e) => e instanceof MyInvalid);
    await conn.close();
  });

  test("an empty registry gets the core classes", () => {
    const errors = new ErrorRegistry();
    dial(createServer(), { errors });
    assert.equal(errors.get(InvalidParameterError.errorName), InvalidParameterError);
    assert.equal(errors.get(InternalError.errorName), InternalError);
  });
});

describe("L2 / Nit-a: generated comments and the IDL literal", () => {
  const BAD = ["\u0000", "\u001b", "\u007f", "\u0085", "\u202e", "\u061c", "\u2066", "\u0008", "\t"];
  const idl = [
    "# Doc with NUL \u0000, ESC \u001b[31m, DEL \u007f, NEL \u0085, RLO \u202e, ALM \u061c, LRI \u2066, BS \u0008.",
    "# Tab\there; @internal and @deprecated are not tags; {@link x}.",
    "interface t.ctl",
    "",
    "# Type doc \u202e reversed @alpha.",
    "# [Experimental]",
    "type T (",
    "  # field \u0000 doc @beta",
    "  a: ?int,",
    "  e: (",
    "    # value \u001b doc @see",
    "    x,",
    "    y",
    "  )",
    ")",
    "",
    "# method \u0085 doc",
    "method M() -> ()",
    "",
  ].join("\n");

  test("no raw controls or bidi characters anywhere; the IDL round-trips byte-exactly", async () => {
    const { code, constName } = generate(idl, { importPath: RUNTIME_URL });
    for (const ch of BAD.slice(0, -1)) assert.equal(code.includes(ch), false, JSON.stringify(ch));
    // TAB stays raw only in the IDL template literal (it round-trips there); comments escape it.
    const comments = code.match(/\/\*\*[\s\S]*?\*\//g) ?? [];
    assert.ok(comments.length > 0);
    for (const c of comments) assert.equal(c.includes("\t"), false, c);
    assert.match(code, /Doc with NUL \\u0000, ESC \\u001b\[31m, DEL \\u007f, NEL \\u0085, RLO \\u202e/);
    const mod = await importGenerated(code);
    assert.equal(mod[`${constName}_IDL`], idl);
    assert.equal((mod[constName] as InterfaceDescriptor).idl, idl);
  });

  test("@ from IDL docs is escaped; the generator's own tags are not", () => {
    const { code } = generate(idl);
    const comments = (code.match(/\/\*\*[\s\S]*?\*\//g) ?? []).join("\n");
    for (const tag of ["internal", "deprecated", "alpha", "beta", "see"])
      assert.equal(comments.includes(`@${tag}`), false, tag);
    assert.match(code, /\\u0040internal and \\u0040deprecated/);
    assert.match(code, /\{\\u0040link x\}/);
    assert.match(code, /^ \* @experimental$/m);
    // The IDL literal keeps the doc text verbatim.
    assert.ok(code.includes("# Tab\there; @internal and @deprecated are not tags; {@link x}."));
  });
});

describe("L3: generateFromService validates its options before any I/O", () => {
  test("non-object, null, array, bad signal, bad timeout → TypeError, nothing called", async () => {
    let calls = 0;
    const target = {
      getInterfaceDescription: () => {
        calls++;
        return Promise.resolve(TEST_IDL);
      },
    } as unknown as Connection;
    const bad: unknown[] = [
      "bigint",
      null,
      [],
      42,
      { signal: "x" },
      { signal: {} },
      { timeout: "5" },
      { timeout: 5n },
      { ints: "big" },
      { importPath: "" },
    ];
    for (const options of bad)
      await assert.rejects(
        generateFromService(target, "org.example.typed", options as never),
        TypeError,
        JSON.stringify(options, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v)),
      );
    assert.equal(calls, 0);
    const ok = await generateFromService(target, "org.example.typed", {
      signal: new AbortController().signal,
      timeout: 1000,
    });
    assert.equal(ok.interfaceName, "org.example.typed");
    assert.equal(calls, 1);
  });

  test("an out-of-range timeout is left to the call (RangeError)", async () => {
    const conn = dial(createServer());
    await assert.rejects(generateFromService(conn, ORG_VARLINK_SERVICE, { timeout: -1 }), RangeError);
    await conn.close();
  });
});

describe("Pool.stream(name) resolves names like Connection.stream", () => {
  test('an untyped stream into a pool.addInterface(idl) interface is validated ("throw")', async () => {
    // The pool's connection closes on the invalid reply: the server's send of the rest fails (expected).
    const server = extraFieldServer({ onError: () => undefined });
    const pool = createPool(() => Promise.resolve(dial(server, { validateReplies: "throw" })));
    pool.addInterface(TEST_IDL);
    const it = pool.stream("org.example.typed.List", {});
    await assert.rejects(it.next(), ValidationError);
    await pool.close();
  });
});
