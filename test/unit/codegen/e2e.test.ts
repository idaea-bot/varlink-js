// Typed end-to-end tests over pair() (DESIGN.md §4.13, §5.3): generated descriptors with server.implement() and
// X.client(conn | pool), plus compile-time checks of the generated Handlers and client types.
/* eslint-disable @typescript-eslint/require-await -- streaming handlers are async generators without awaits */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createClient,
  createConnection,
  createPool,
  createServer,
  ExpectedMoreError,
  MethodNotImplementedError,
  ValidationError,
  VarlinkError,
  type Connection,
  type ConnectionOptions,
  type Server,
  type ServerOptions,
} from "../../../src/index.ts";
import { OrgVarlinkService } from "../../../src/interfaces/index.ts";
import { IdlSyntaxError } from "../../../src/idl/index.ts";
import { pair } from "../../../src/testing/index.ts";
import { OrgExampleTyped as BigTyped } from "./generated/bigint/org.example.typed.ts";
import { OrgExampleFtl } from "./generated/org.example.ftl.ts";
import {
  Busy,
  NotFound,
  OrgExampleTyped,
  type Item,
  type OrgExampleTyped_Client,
  type OrgExampleTyped_Handlers,
} from "./generated/org.example.typed.ts";
import { TEST_IDL } from "./fixtures.ts";

const ITEMS: Item[] = [
  { id: 1, name: "one", tags: { a: "b" }, kind: "small" },
  { id: 2, name: "two", tags: {}, note: "n", extra: [1, "x"], raw: { k: true }, kind: "large" },
  { id: 3, name: "three", tags: {}, kind: "small" },
];

function handlers(logged: string[]): OrgExampleTyped_Handlers {
  return {
    Get: ({ id }) => {
      if (id === 0) throw new Busy();
      const item = ITEMS.find((i) => i.id === id);
      if (item === undefined) throw new NotFound({ id });
      return { item };
    },
    async *List({ limit }) {
      const items = ITEMS.slice(0, limit ?? ITEMS.length);
      for (const item of items.slice(0, -1)) yield { item };
      const last = items.at(-1);
      return last === undefined ? undefined : { item: last };
    },
    async *Watch() {
      yield { event: "a" };
      yield { event: "b" };
      return { event: "c" };
    },
    Log: ({ message }) => {
      logged.push(message);
      return {};
    },
    Echo: ({ value, obj }) => (obj == null ? { value } : { value, obj }),
  };
}

function typedServer(options?: ServerOptions): { server: Server; logged: string[] } {
  const logged: string[] = [];
  const server = createServer(options);
  server.implement(OrgExampleTyped, handlers(logged));
  return { server, logged };
}

function dial(server: Server, options?: ConnectionOptions): Connection {
  const [a, b] = pair();
  void server.handle(b);
  return createConnection(a, options);
}

describe("typed client over a Connection", () => {
  test("single call, stream, collect, oneway, with typed results", async () => {
    const { server, logged } = typedServer();
    const conn = dial(server);
    const client = OrgExampleTyped.client(conn);
    const { item } = await client.Get({ id: 2 });
    assert.deepEqual(item, ITEMS[1]);
    const events: string[] = [];
    for await (const r of client.Watch.stream()) events.push(r.event);
    assert.deepEqual(events, ["a", "b", "c"]);
    assert.deepEqual(
      (await client.List.collect({ limit: 2 })).map((r) => r.item.id),
      [1, 2],
    );
    assert.deepEqual(
      (await client.List.collect({})).map((r) => r.item.name),
      ["one", "two", "three"],
    );
    await client.Log.oneway({ message: "hello" });
    assert.deepEqual(await client.Echo({ value: { x: [1, null] } }), { value: { x: [1, null] } });
    // Calls are handled in order on a connection: the oneway call ran before this one.
    assert.deepEqual(logged, ["hello"]);
    await conn.close();
  });

  test("the client is a frozen null-prototype object with frozen methods", async () => {
    const { server } = typedServer();
    const conn = dial(server);
    const client = OrgExampleTyped.client(conn);
    assert.equal(Object.getPrototypeOf(client), null);
    assert.ok(Object.isFrozen(client));
    assert.deepEqual(Object.keys(client), ["Get", "List", "Watch", "Log", "Echo", "Unimplemented"]);
    assert.ok(Object.isFrozen(client.Get));
    assert.ok(["stream", "collect", "oneway"].every((k) => k in client.Get));
    assert.equal("toString" in client, false);
    assert.throws(() => createClient(OrgExampleTyped, {} as never), TypeError);
    assert.throws(() => OrgExampleTyped.client(null as never), TypeError);
    await conn.close();
  });

  test("error replies map to the generated classes, built-in errors to the core classes", async () => {
    const { server } = typedServer();
    const conn = dial(server);
    const client = OrgExampleTyped.client(conn);
    await assert.rejects(client.Get({ id: 99 }), (e) => {
      assert.ok(e instanceof NotFound);
      assert.ok(e instanceof VarlinkError);
      assert.equal(OrgExampleTyped.NotFound.is(e), true);
      assert.equal(e.parameters.id, 99);
      return true;
    });
    await assert.rejects(client.Get({ id: 0 }), (e) => e instanceof Busy && Busy.is(e) && !NotFound.is(e));
    await assert.rejects(client.Unimplemented(), (e) => {
      assert.ok(e instanceof MethodNotImplementedError);
      assert.ok(e instanceof OrgVarlinkService.MethodNotImplemented);
      assert.equal(e.parameters.method, "org.example.typed.Unimplemented");
      return true;
    });
    // Watch requires `more`: a single call is ExpectedMore.
    await assert.rejects(client.Watch(), (e) => e instanceof ExpectedMoreError);
    // Parameters are encoded with the IDL before anything is written.
    await assert.rejects(client.Get({ id: "1" } as never), ValidationError);
    await conn.close();
  });

  test('validateReplies: "throw" on the connection rejects an invalid reply; "off" acts as "warn"', async () => {
    const server = createServer({ validateReplies: "off" });
    const bad = { item: { id: "not an int" } };
    server.implement(OrgExampleTyped, { Get: () => bad as never });
    const strict = OrgExampleTyped.client(dial(server, { validateReplies: "throw" }));
    await assert.rejects(strict.Get({ id: 1 }), ValidationError);
    const reported: string[] = [];
    const onError = (_e: unknown, info: { reason: string }): void => {
      reported.push(info.reason);
    };
    const lax = OrgExampleTyped.client(dial(server, { onError }));
    assert.deepEqual(await lax.Get({ id: 1 }), bad);
    assert.deepEqual(reported, ["invalid-reply"]);
  });

  test("client() on a connection that has a different IDL under the name is a TypeError", () => {
    const { server } = typedServer();
    const other = TEST_IDL.replace("method Unimplemented() -> ()", "method Other() -> ()");
    const conn = dial(server, { interfaces: [other] });
    assert.throws(() => OrgExampleTyped.client(conn), TypeError);
    // The same IDL text is fine (idempotent), also twice.
    const conn2 = dial(server, { interfaces: [TEST_IDL] });
    OrgExampleTyped.client(conn2);
    OrgExampleTyped.client(conn2);
  });

  test("GetInterfaceDescription of an implemented generated interface is the IDL verbatim", async () => {
    const { server } = typedServer();
    const conn = dial(server);
    assert.equal(await conn.getInterfaceDescription("org.example.typed"), TEST_IDL);
    assert.equal(OrgExampleTyped.idl, TEST_IDL);
    const svc = OrgVarlinkService.client(conn);
    const info = await svc.GetInfo();
    assert.deepEqual(info.interfaces, ["org.varlink.service", "org.example.typed", "io.github.pzmarzly.varlinkjs"]);
    const { description } = await svc.GetInterfaceDescription({ interface: "org.example.typed" });
    assert.equal(description, TEST_IDL);
    await conn.close();
  });
});

describe('ints: "bigint"', () => {
  test("a bigint-generated descriptor end to end", async () => {
    const server = createServer({ ints: "bigint" });
    const big = 2n ** 60n + 1n;
    server.implement(BigTyped, {
      Get: ({ id }) => ({ item: { id, name: typeof id, tags: {}, kind: "large" } }),
    });
    const conn = dial(server, { ints: "bigint" });
    const client = BigTyped.client(conn);
    const { item } = await client.Get({ id: big });
    assert.equal(item.id, big);
    assert.equal(item.name, "bigint"); // the handler saw a bigint
    await conn.close();
  });

  test("a number-generated descriptor on a bigint connection or server is a TypeError", () => {
    const conn = dial(createServer(), { ints: "bigint" });
    assert.throws(() => OrgExampleTyped.client(conn), TypeError);
    assert.throws(() => {
      createServer({ ints: "bigint" }).implement(OrgExampleTyped, {});
    }, TypeError);
    assert.throws(() => BigTyped.client(dial(createServer())), TypeError);
  });

  test("a bigint server and connection still serve org.varlink.service (built-ins compile in either mode)", async () => {
    const server = createServer({ ints: "bigint" });
    server.implement(BigTyped, {});
    const conn = dial(server, { ints: "bigint" });
    const info = await conn.getInfo();
    assert.deepEqual(info.interfaces, ["org.varlink.service", "org.example.typed", "io.github.pzmarzly.varlinkjs"]);
    // The generated built-in says ints "number"; it has no int, so it binds to a bigint connection as is.
    const svc = OrgVarlinkService.client(conn);
    assert.equal(
      (await svc.GetInterfaceDescription({ interface: "org.varlink.service" })).description,
      OrgVarlinkService.idl,
    );
    await conn.close();
  });
});

describe("typed client over a Pool", () => {
  test("leases a connection per call: typed results, streams, generated error classes", async () => {
    const { server, logged } = typedServer();
    let opened = 0;
    const pool = createPool(() => {
      opened++;
      return Promise.resolve(dial(server));
    });
    const client = OrgExampleTyped.client(pool);
    assert.deepEqual((await client.Get({ id: 1 })).item, ITEMS[0]);
    await assert.rejects(client.Get({ id: 42 }), (e) => e instanceof NotFound && e.parameters.id === 42);
    const events: string[] = [];
    for await (const r of client.Watch.stream()) events.push(r.event);
    assert.deepEqual(events, ["a", "b", "c"]);
    assert.equal((await client.List.collect({ limit: 3 })).length, 3);
    await client.Log.oneway({ message: "m" });
    assert.deepEqual(await client.Echo({ value: 5 }), { value: 5 });
    assert.deepEqual(logged, ["m"]);
    assert.equal(opened, 1);
    assert.equal(pool.idle, 1);
    // A second client registers nothing new; untyped calls on the same pool still work.
    OrgExampleTyped.client(pool);
    assert.deepEqual(await pool.call("org.example.typed.Get", { id: 3 }), { item: ITEMS[2] });
    await pool.close();
  });

  test("addInterface applies to idle connections too, and is checked eagerly", async () => {
    const { server } = typedServer();
    const pool = createPool(() => Promise.resolve(dial(server)));
    await pool.getInfo(); // one idle connection, opened before the interface was added
    assert.equal(pool.idle, 1);
    pool.addInterface(OrgExampleTyped);
    pool.addInterface(OrgExampleTyped); // the same value again: no-op
    pool.addInterface(TEST_IDL); // the same IDL as text: fine
    await assert.rejects(pool.call(OrgExampleTyped.methods.Get, { id: 7 }), (e) => e instanceof NotFound);
    assert.equal(pool.size, 1);
    assert.throws(() => {
      pool.addInterface(TEST_IDL.replace("method Log", "method Logs"));
    }, TypeError);
    assert.throws(() => {
      pool.addInterface({ ...OrgExampleTyped, idl: OrgExampleFtl.idl });
    }, TypeError);
    assert.throws(() => {
      pool.addInterface("interface bad");
    }, IdlSyntaxError);
    await pool.close();
  });

  test("a pool whose connections use the other ints mode rejects the operation and releases the lease", async () => {
    const pool = createPool(() => Promise.resolve(dial(createServer({ ints: "bigint" }), { ints: "bigint" })));
    const client = OrgExampleTyped.client(pool);
    await assert.rejects(client.Get({ id: 1 }), TypeError);
    assert.equal(pool.size, 1);
    assert.equal(pool.idle, 1);
    const it = client.Watch.stream();
    await assert.rejects(it.next(), TypeError);
    assert.deepEqual(await it.next(), { value: undefined, done: true });
    assert.equal(pool.idle, 1);
    await pool.close();
  });
});

// Compile-time checks only (never called): the generated types reject wrong use.
export function typeChecks(client: OrgExampleTyped_Client): unknown[] {
  const ok: OrgExampleTyped_Handlers = {
    Get: (p) => ({ item: { id: p.id, name: "", tags: {}, kind: "small" } }),
    Log: () => ({}),
  };
  const unknownKey: OrgExampleTyped_Handlers = {
    // @ts-expect-error -- not a method of the interface
    Nope: () => ({}),
  };
  const wrongReturn: OrgExampleTyped_Handlers = {
    // @ts-expect-error -- item.kind must be "small" | "large"
    Get: () => ({ item: { id: 1, name: "", tags: {}, kind: "medium" } }),
  };
  const wrongParam: OrgExampleTyped_Handlers = {
    Get: (p) => {
      // @ts-expect-error -- id is a number
      const s: string = p.id;
      return { item: { id: s.length, name: s, tags: {}, kind: "small" } };
    },
  };
  // Inline handlers passed to implement() are contextually typed too (literal results stay literal).
  const server = createServer();
  server.implement(OrgExampleTyped, {
    Get: ({ id }) => ({ item: { id, name: "", tags: {}, kind: "large" } }),
    Echo: async ({ value }) => ({ value }),
  });
  server.implement(OrgExampleTyped, {
    // @ts-expect-error -- unknown handler key, inline
    Nope: () => ({}),
  });
  server.implement(OrgExampleTyped, {
    // @ts-expect-error -- wrong result, inline
    Get: () => ({ item: { id: "x", name: "", tags: {}, kind: "large" } }),
  });
  void client.Get({ id: 1 });
  // @ts-expect-error -- id is required
  void client.Get({});
  // @ts-expect-error -- parameters are required (Get has a required field)
  void client.Get();
  // @ts-expect-error -- id is a number
  void client.Get({ id: "1" });
  // @ts-expect-error -- unknown parameter
  void client.Get({ id: 1, extra: true });
  void client.Watch(); // no required field: parameters optional
  void client.List.collect();
  // @ts-expect-error -- no such method
  const nope: unknown = client.Nope;
  void client.Get({ id: 1 }).then((r) => {
    const n: number = r.item.id;
    // @ts-expect-error -- a string field
    const m: number = r.item.name;
    return [n, m];
  });
  return [ok, unknownKey, wrongReturn, wrongParam, nope];
}
