// Introspection proxy (DESIGN.md §5.3, §4.11): one frozen function per method, input always encoded, replies
// and error parameters validated against the fetched interface.
/* eslint-disable @typescript-eslint/require-await -- streaming handlers are async generators without awaits */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InterfaceNotFoundError, isVarlinkError, ValidationError, VarlinkError } from "../../../src/index.ts";
import type { Interface } from "../../../src/idl/index.ts";
import { createConnection, createServer, type ProxyMethod, type Server } from "../../../src/rpc/index.ts";
import { pair } from "../../../src/testing/index.ts";
import { connectRaw } from "./helpers.ts";

/** Exact type equality (compile time). */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the standard type-equality idiom
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const IDL = `interface org.example.px

method Echo(text: string) -> (text: string)

# [Supports 'more' flag]
method Count(n: int) -> (i: int)

method Bad() -> (n: int)

method Fail() -> ()

error Failed (why: string)
`;

function setup(reported: unknown[] = []): {
  server: Server;
  conn: ReturnType<typeof createConnection>;
  done: Promise<void>;
} {
  const server = createServer({ validateReplies: "off", onError: () => undefined });
  server.addInterface(IDL, {
    Echo: (p) => p,
    Count: async function* (p: { n: number }) {
      for (let i = 0; i < p.n - 1; i++) yield { i };
      return { i: p.n - 1 };
    },
    Bad: () => ({ n: "not a number" }),
    Fail: () => {
      throw new VarlinkError("org.example.px.Failed", { why: 42 });
    },
  });
  const [a, b] = pair();
  const done = server.handle(b);
  return { server, conn: createConnection(a, { onError: (_e, info) => reported.push(info) }), done };
}

describe("proxy", () => {
  test("one frozen function per method plus .stream/.collect/.oneway; name and interface", async () => {
    const { conn, done } = setup();
    const px = await conn.proxy("org.example.px");
    assert.equal(px.name, "org.example.px");
    assert.equal(px.interface.name, "org.example.px");
    assert.ok(Object.isFrozen(px));
    assert.equal(px.Nope, undefined);
    assert.equal(Object.getPrototypeOf(px), null);
    const echo = px.Echo;
    assert.ok(echo !== undefined);
    assert.deepEqual(await echo({ text: "hi" }), { text: "hi" });
    await echo.oneway({ text: "fire" });
    assert.deepEqual(await px.Count?.collect({ n: 2 }), [{ i: 0 }, { i: 1 }]);
    const got: unknown[] = [];
    for await (const r of px.Count?.stream({ n: 3 }) ?? []) got.push(r);
    assert.deepEqual(got, [{ i: 0 }, { i: 1 }, { i: 2 }]);
    await conn.close();
    await done;
  });

  test("Object.prototype names are undefined like any unknown method", async () => {
    const { conn, done } = setup();
    const px = await conn.proxy("org.example.px");
    const loose = px as unknown as Record<string, unknown>;
    for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"])
      assert.equal(loose[key], undefined, key);
    assert.deepEqual(Object.keys(px), ["Echo", "Count", "Bad", "Fail", "name", "interface"]);
    await conn.close();
    await done;
  });

  test("types: name is a string, interface the AST, methods ProxyMethod | undefined", async () => {
    const { conn, done } = setup();
    const px = await conn.proxy("org.example.px");
    // Compile-time checks (npm run typecheck); the intersection type used to make `name` a `ProxyMethod & string`.
    const checks: [
      Equal<typeof px.name, string>,
      Equal<typeof px.interface, Interface>,
      Equal<typeof px.Echo, ProxyMethod | undefined>,
    ] = [true, true, true];
    assert.deepEqual(checks, [true, true, true]);
    assert.equal(typeof px.name, "string");
    await conn.close();
    await done;
  });

  test("parameters are always encoded: ValidationError before anything is written", async () => {
    const { conn, reader, reply } = connectRaw();
    const fetch = conn.proxy("org.example.px");
    await reader.next();
    await reply({ parameters: { description: IDL } });
    const px = await fetch;
    await assert.rejects(px.Echo?.({ text: 1 }) ?? Promise.resolve(), ValidationError);
    await assert.rejects(px.Echo?.oneway({}) ?? Promise.resolve(), ValidationError);
    await assert.rejects(px.Count?.stream({ n: "x" }).next() ?? Promise.resolve(), ValidationError);
    const p = px.Echo?.({ text: "ok" });
    assert.deepEqual((await reader.next()).parameters, { text: "ok" });
    await reply({ parameters: { text: "ok" } });
    await p;
    await conn.close();
  });

  test('replies are validated ("throw" default; "off" gives raw values)', async () => {
    const { conn, done } = setup();
    const strict = await conn.proxy("org.example.px");
    await assert.rejects(strict.Bad?.() ?? Promise.resolve(), ValidationError);
    assert.equal(conn.isClosed, false);
    const lax = await conn.proxy("org.example.px", { validateReplies: "off" });
    assert.deepEqual(await lax.Bad?.(), { n: "not a number" });
    await conn.close();
    await done;
  });

  test("error parameters are validated against the fetched interface's errors", async () => {
    const reported: unknown[] = [];
    const { conn, reader, reply } = connectRaw({ onError: (_e, info) => reported.push(info) });
    const fetch = conn.proxy("org.example.px");
    await reader.next();
    await reply({ parameters: { description: IDL } });
    const px = await fetch;
    const bad = { error: "org.example.px.Failed", parameters: { why: 42 } };
    const p1 = px.Fail?.() ?? Promise.resolve();
    await reader.next();
    await reply(bad);
    // why: 42 does not match `why: string`: a plain VarlinkError with the raw parameters.
    await assert.rejects(p1, (e: unknown) => isVarlinkError(e, "org.example.px.Failed") && e.parameters.why === 42);
    assert.deepEqual(reported, [{ method: "org.example.px.Fail", reason: "invalid-error" }]);
    const p2 = px.Fail?.() ?? Promise.resolve();
    await reader.next();
    await reply({ error: "org.example.px.Failed", parameters: { why: "because", extra: 1 } });
    await assert.rejects(
      p2,
      (e: unknown) => isVarlinkError(e) && e.parameters.why === "because" && !("extra" in e.parameters),
    );
    // The plain connection does not know org.example.px: no validation, no report.
    const p3 = conn.call("org.example.px.Fail");
    await reader.next();
    await reply(bad);
    await assert.rejects(p3, VarlinkError);
    assert.equal(reported.length, 1);
    await conn.close();
  });

  test("an unknown interface rejects with InterfaceNotFound; the proxy is not registered for validation", async () => {
    const { conn, done } = setup();
    await assert.rejects(conn.proxy("org.example.none"), InterfaceNotFoundError);
    await conn.proxy("org.example.px");
    // The plain connection still does not validate org.example.px.
    assert.deepEqual(await conn.call("org.example.px.Bad"), { n: "not a number" });
    await conn.close();
    await done;
  });
});
