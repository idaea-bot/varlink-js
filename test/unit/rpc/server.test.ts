// Server (DESIGN.md §5.4, §4.11): registration, built-ins, limits, the connection driver, shutdown, onError.
/* eslint-disable @typescript-eslint/require-await -- streaming handlers are async generators without awaits */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import {
  ConnectionClosedError,
  ExpectedMoreError,
  ExpectedUpgradeError,
  INTERNAL_ERROR_INTERFACE,
  INTERNAL_ERROR_INTERFACE_IDL,
  InterfaceNotFoundError,
  InternalError,
  isVarlinkError,
  MessageTooLargeError,
  MethodNotImplementedError,
  ORG_VARLINK_SERVICE_IDL,
  ProtocolError,
  VarlinkError,
  type CallContext,
  type InterfaceDescriptor,
  type MethodDescriptor,
} from "../../../src/index.ts";
import { IdlSyntaxError } from "../../../src/idl/index.ts";
import {
  createConnection,
  createServer,
  type Server,
  type ServerErrorReason,
  type ServerOptions,
} from "../../../src/rpc/index.ts";
import { faulty, pair } from "../../../src/testing/index.ts";
import { concat, controllable, isPending, MemoryListener, MessageReader, msg, settle, sleep, utf8 } from "./helpers.ts";

const IDL = `# A test interface. Comments are served verbatim.
interface org.example.s

# Echoes.
method Echo(text: string) -> (text: string)

# [Supports 'more' flag]
method Count(n: int) -> (i: int)

# [Requires 'more' flag]
method Watch() -> (i: int)

# [Supports 'upgrade' flag]
method Up() -> ()

method Wait() -> ()

error Failed (why: string)
`;

const Echo: MethodDescriptor<{ text: string }, { text: string }> = {
  interface: "org.example.s",
  name: "Echo",
  method: "org.example.s.Echo",
};
const DESC = {
  name: "org.example.s",
  idl: IDL,
  ints: "number",
  methods: {
    Echo,
    Count: { interface: "org.example.s", name: "Count", method: "org.example.s.Count", more: "supports" },
    Watch: { interface: "org.example.s", name: "Watch", method: "org.example.s.Watch", more: "requires" },
    Up: { interface: "org.example.s", name: "Up", method: "org.example.s.Up", upgrade: "supports" },
    Wait: { interface: "org.example.s", name: "Wait", method: "org.example.s.Wait" },
  },
  errors: {
    Failed: class extends VarlinkError {
      static readonly errorName = "org.example.s.Failed";
      constructor(p: never) {
        super("org.example.s.Failed", p);
      }
      static is(e: unknown): boolean {
        return isVarlinkError(e, "org.example.s.Failed");
      }
    },
  },
} as const satisfies InterfaceDescriptor;

const OTHER = `interface org.example.other

method Ping() -> ()
`;

type Reported = { error: unknown; reason: ServerErrorReason; method?: string | undefined }[];

function makeServer(options: ServerOptions = {}): { server: Server; reported: Reported } {
  const reported: Reported = [];
  const server = createServer({
    vendor: "V",
    product: "P",
    version: "1",
    url: "https://example.com",
    onError: (error, info) => reported.push({ error, ...info }),
    ...options,
  });
  return { server, reported };
}

/** A connection to `server` over a fresh pair; `handled` is server.handle()'s promise. */
function connect(server: Server): { conn: ReturnType<typeof createConnection>; handled: Promise<void> } {
  const [a, b] = pair();
  const handled = server.handle(b);
  return { conn: createConnection(a), handled };
}

describe("Server: registration", () => {
  test("built-in or taken names, bad handlers and descriptor mismatches are TypeErrors", () => {
    const { server } = makeServer();
    assert.throws(() => {
      server.addInterface(ORG_VARLINK_SERVICE_IDL);
    }, TypeError);
    assert.throws(() => {
      server.addInterface(INTERNAL_ERROR_INTERFACE_IDL);
    }, TypeError);
    server.addInterface(OTHER);
    assert.throws(() => {
      server.addInterface(OTHER);
    }, TypeError);
    assert.throws(() => {
      server.addInterface(IDL, { Nope: () => ({}) });
    }, TypeError);
    assert.throws(() => {
      server.addInterface(IDL, { toString: () => ({}) });
    }, TypeError);
    assert.throws(() => {
      server.addInterface(IDL, { Echo: 5 as never });
    }, TypeError);
    assert.throws(() => {
      server.addInterface(IDL, { Echo: { handler: () => ({}), requiresMore: false as never } });
    }, TypeError);
    assert.throws(() => {
      server.implement({ ...DESC, ints: "bigint" }, {});
    }, TypeError);
    assert.throws(() => {
      server.addInterface("interface x\nmethod (");
    }, IdlSyntaxError);
    // None of the failed registrations took effect.
    server.implement(DESC, {});
  });

  test("implement: typed handlers; missing ones answer MethodNotImplemented", async () => {
    const { server } = makeServer();
    server.implement(DESC, { Echo: (p) => ({ text: p.text.toUpperCase() }) });
    const { conn, handled } = connect(server);
    conn.addInterface(DESC);
    assert.deepEqual(await conn.call(Echo, { text: "hi" }), { text: "HI" });
    await assert.rejects(conn.call("org.example.s.Wait", {}), MethodNotImplementedError);
    await conn.close();
    await handled;
  });

  test("requiresMore/requiresUpgrade raise the IDL flag, never lower it", async () => {
    const { server } = makeServer();
    server.addInterface(IDL, {
      Echo: { handler: (p) => p, requiresMore: true },
      Wait: { handler: () => ({}), requiresUpgrade: true },
      Watch: async function* () {
        yield { i: 1 };
      },
    });
    const { conn, handled } = connect(server);
    await assert.rejects(conn.call("org.example.s.Echo", { text: "x" }), ExpectedMoreError);
    assert.deepEqual(await conn.collect("org.example.s.Echo", { text: "x" }), [{ text: "x" }]);
    await assert.rejects(conn.call("org.example.s.Wait", {}), ExpectedUpgradeError);
    await assert.rejects(conn.call("org.example.s.Watch", {}), ExpectedMoreError);
    await conn.close();
    await handled;
  });

  test("registration while serving takes effect for new calls", async () => {
    const { server } = makeServer();
    const { conn, handled } = connect(server);
    await assert.rejects(conn.call("org.example.other.Ping", {}), InterfaceNotFoundError);
    server.addInterface(OTHER, { Ping: () => ({}) });
    assert.deepEqual(await conn.call("org.example.other.Ping", {}), {});
    await conn.close();
    await handled;
  });
});

describe("Server: org.varlink.service", () => {
  test("GetInfo: info fields; service first, registration order, InternalError interface last", async () => {
    const { server } = makeServer();
    server.addInterface(OTHER);
    server.implement(DESC, {});
    const { conn, handled } = connect(server);
    assert.deepEqual(await conn.getInfo(), {
      vendor: "V",
      product: "P",
      version: "1",
      url: "https://example.com",
      interfaces: ["org.varlink.service", "org.example.other", "org.example.s", INTERNAL_ERROR_INTERFACE],
    });
    await conn.close();
    await handled;
  });

  test("GetInfo defaults to empty strings", async () => {
    const server = createServer();
    const { conn, handled } = connect(server);
    const info = await conn.getInfo();
    assert.deepEqual([info.vendor, info.product, info.version, info.url], ["", "", "", ""]);
    await conn.close();
    await handled;
  });

  test("GetInterfaceDescription: the registered text verbatim; built-ins too", async () => {
    const { server } = makeServer();
    server.addInterface(IDL);
    const { conn, handled } = connect(server);
    assert.equal(await conn.getInterfaceDescription("org.example.s"), IDL);
    assert.equal(await conn.getInterfaceDescription("org.varlink.service"), ORG_VARLINK_SERVICE_IDL);
    assert.equal(await conn.getInterfaceDescription(INTERNAL_ERROR_INTERFACE), INTERNAL_ERROR_INTERFACE_IDL);
    assert.equal((await conn.getInterface("org.example.s")).doc, "A test interface. Comments are served verbatim.");
    await conn.close();
    await handled;
  });

  test("never the filesystem or Object keys: InterfaceNotFound (F9)", async () => {
    const { server } = makeServer();
    const { conn, handled } = connect(server);
    for (const name of ["../../etc/hosts#", "__proto__", "toString", "constructor", "hasOwnProperty", ""])
      await assert.rejects(
        conn.getInterfaceDescription(name),
        (e: unknown) => e instanceof InterfaceNotFoundError && e.parameters.interface === name,
        name,
      );
    await conn.close();
    await handled;
  });
});

describe("Server: dispatch through the driver", () => {
  test("validateReplies defaults to warn: an invalid reply is sent and reported", async () => {
    const { server, reported } = makeServer();
    server.addInterface(IDL, { Echo: () => ({ text: 5 }) });
    const { conn, handled } = connect(server);
    assert.deepEqual(await conn.call("org.example.s.Echo", { text: "x" }), { text: 5 });
    assert.deepEqual(
      reported.map((r) => [r.reason, r.method]),
      [["invalid-reply", "org.example.s.Echo"]],
    );
    await conn.close();
    await handled;
  });

  test("handler-threw reaches onError with the method; the reply is InternalError", async () => {
    const { server, reported } = makeServer();
    server.addInterface(IDL, {
      Echo: () => {
        throw new Error("secret");
      },
    });
    const { conn, handled } = connect(server);
    await assert.rejects(conn.call("org.example.s.Echo", { text: "x" }), InternalError);
    assert.equal(reported[0]?.reason, "handler-threw");
    assert.equal(reported[0].method, "org.example.s.Echo");
    await conn.close();
    await handled;
  });

  test("onError exceptions are swallowed", async () => {
    const server = createServer({
      onError: () => {
        throw new Error("bad hook");
      },
    });
    server.addInterface(IDL, {
      Echo: () => {
        throw new Error("x");
      },
    });
    const { conn, handled } = connect(server);
    await assert.rejects(conn.call("org.example.s.Echo", { text: "x" }), InternalError);
    await conn.close();
    await handled;
  });

  test("streams over the connection; calls after a stream are answered in order", async () => {
    const { server } = makeServer();
    server.addInterface(IDL, {
      Count: async function* (p: { n: number }) {
        for (let i = 0; i < p.n - 1; i++) yield { i };
        return { i: p.n - 1 };
      },
      Echo: (p) => p,
    });
    const { conn, handled } = connect(server);
    const st = conn.stream("org.example.s.Count", { n: 3 });
    const after = conn.call("org.example.s.Echo", { text: "after" });
    const got: unknown[] = [];
    for await (const r of st) got.push(r);
    assert.deepEqual(got, [{ i: 0 }, { i: 1 }, { i: 2 }]);
    assert.deepEqual(await after, { text: "after" });
    await conn.close();
    await handled;
  });

  test("an upgrade nobody claims closes the connection (upgrade-unclaimed)", async () => {
    const { server, reported } = makeServer();
    server.addInterface(IDL, { Up: () => ({}) });
    const [a, b] = pair();
    const handled = server.handle(b);
    const reader = new MessageReader(a);
    await a.write(msg({ method: "org.example.s.Up", upgrade: true }));
    assert.deepEqual(await reader.next(), { parameters: {} });
    assert.equal(await reader.nextText(), null);
    await handled;
    assert.ok(reported.some((r) => r.reason === "upgrade-unclaimed"));
    a.close();
  });

  test("clean EOF after pipelined calls: every call is still answered (UAPI half-close)", async () => {
    const { server } = makeServer();
    server.addInterface(IDL, { Echo: async (p: { text: string }) => sleep(5).then(() => p) });
    const [a, b] = pair();
    const handled = server.handle(b);
    await a.write(msg({ method: "org.example.s.Echo", parameters: { text: "1" } }));
    await a.write(msg({ method: "org.example.s.Echo", parameters: { text: "2" } }));
    await a.end();
    const reader = new MessageReader(a);
    assert.deepEqual(await reader.drainToEof(), ['{"parameters":{"text":"1"}}', '{"parameters":{"text":"2"}}']);
    await handled;
  });
});

describe("Server: connection errors and limits", () => {
  test("malformed input: protocol-error, connection closed, server alive", async () => {
    const { server, reported } = makeServer();
    server.addInterface(IDL, { Echo: (p) => p });
    const [a, b] = pair();
    const handled = server.handle(b);
    await a.write(utf8("not json\0"));
    const reader = new MessageReader(a);
    assert.deepEqual(await reader.drainToEof(), []);
    await handled;
    assert.equal(reported[0]?.reason, "protocol-error");
    assert.ok(reported[0].error instanceof ProtocolError);
    const { conn, handled: h2 } = connect(server);
    assert.deepEqual(await conn.call("org.example.s.Echo", { text: "x" }), { text: "x" });
    await conn.close();
    await h2;
  });

  test("maxMessageSize: MessageTooLargeError reported as protocol-error", async () => {
    const { server, reported } = makeServer({ maxMessageSize: 64 });
    const [a, b] = pair();
    const handled = server.handle(b);
    void a.write(new Uint8Array(200).fill(0x20)).catch(() => undefined);
    await handled;
    assert.ok(reported[0]?.error instanceof MessageTooLargeError);
    assert.equal(reported[0].reason, "protocol-error");
    a.close();
  });

  test("a read() rejection: transport-error, ctx.signal aborted with ConnectionClosedError, handle() resolves", async () => {
    const { server, reported } = makeServer();
    let ctxSignal: AbortSignal | undefined;
    server.addInterface(IDL, {
      Wait: (_p, ctx: CallContext) =>
        new Promise((resolve) => {
          ctxSignal = ctx.signal;
          ctx.signal.addEventListener("abort", () => {
            resolve({});
          });
        }),
    });
    const [a, b] = pair();
    const ch = controllable(b);
    const handled = server.handle(ch);
    await a.write(msg({ method: "org.example.s.Wait" }));
    while (ctxSignal === undefined) await settle(1);
    const rst = new Error("ECONNRESET");
    ch.failRead(rst);
    await handled;
    assert.equal(ctxSignal.aborted, true);
    assert.ok(ctxSignal.reason instanceof ConnectionClosedError);
    assert.deepEqual(
      reported.map((r) => r.reason),
      ["transport-error"],
    );
    assert.equal(reported[0]?.error, rst);
    a.close();
  });

  test("maxConnections: a channel over the limit is closed at once (connection-limit)", async () => {
    const { server, reported } = makeServer({ maxConnections: 1 });
    const first = connect(server);
    assert.equal(server.connections, 1);
    const [a, b] = pair();
    await server.handle(b);
    assert.equal(await new MessageReader(a).nextText(), null);
    assert.equal(reported[0]?.reason, "connection-limit");
    await first.conn.close();
    await first.handled;
    assert.equal(server.connections, 0);
    const second = connect(server);
    await second.conn.getInfo();
    await second.conn.close();
    await second.handled;
  });

  test("maxQueuedCalls: reading stops while that many calls are buffered", async () => {
    const { server } = makeServer({ maxQueuedCalls: 2 });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    server.addInterface(IDL, { Wait: () => gate.then(() => ({})), Echo: (p) => p });
    const [a, b] = pair({ highWaterMark: 0 });
    const handled = server.handle(b);
    await a.write(msg({ method: "org.example.s.Wait" }));
    await a.write(msg({ method: "org.example.s.Echo", parameters: { text: "1" } }));
    await a.write(msg({ method: "org.example.s.Echo", parameters: { text: "2" } }));
    const blocked = a.write(msg({ method: "org.example.s.Echo", parameters: { text: "3" } }));
    assert.equal(await isPending(blocked), true);
    release();
    const reader = new MessageReader(a);
    const replies = (async () => {
      const out: unknown[] = [];
      for (let i = 0; i < 4; i++) out.push((await reader.next()).parameters);
      return out;
    })();
    await blocked;
    assert.deepEqual(await replies, [{}, { text: "1" }, { text: "2" }, { text: "3" }]);
    await a.end();
    await handled;
  });

  test("a full call queue: taking a call wakes the reader, so a failing read (reset) aborts the handler", async () => {
    const { server, reported } = makeServer();
    let ctxSignal: AbortSignal | undefined;
    server.addInterface(IDL, {
      Wait: (_p, ctx: CallContext) =>
        new Promise((resolve) => {
          ctxSignal = ctx.signal;
          ctx.signal.addEventListener("abort", () => {
            resolve({});
          });
        }),
      Echo: (p) => p,
    });
    const [a, b] = pair();
    // Only read() reports the reset (as on a socket whose RST is seen by the next read); `closed` stays pending.
    const side = controllable(b);
    const handled = server.handle(side);
    // Exactly maxQueuedCalls (64) calls in one write: the reader stops on a full queue; the dispatcher taking Wait
    // makes room for one more, and must wake the reader.
    const calls = [msg({ method: "org.example.s.Wait" })];
    for (let i = 0; i < 63; i++) calls.push(msg({ method: "org.example.s.Echo", parameters: { text: "x" } }));
    await a.write(concat(calls));
    while (ctxSignal === undefined) await settle(1);
    await settle();
    side.failRead(new Error("ECONNRESET"));
    await settle();
    assert.equal(ctxSignal.aborted, true);
    assert.ok(ctxSignal.reason instanceof ConnectionClosedError);
    assert.deepEqual(
      reported.map((r) => r.reason),
      ["transport-error"],
    );
    await handled;
    a.close();
  });

  test("handle() never rejects with faulty() resets at every byte offset", async () => {
    const { server } = makeServer();
    server.addInterface(IDL, {
      Echo: (p) => p,
      Count: async function* () {
        yield { i: 0 };
        return { i: 1 };
      },
    });
    const exchange = [
      msg({ method: "org.example.s.Echo", parameters: { text: "abc" } }),
      msg({ method: "org.example.s.Count", parameters: { n: 2 }, more: true }),
      msg({ method: "org.example.s.Echo", parameters: { text: "x" }, oneway: true }),
    ];
    const total = exchange.reduce((s, m) => s + m.length, 0);
    for (let n = 0; n <= total; n++) {
      for (const side of ["read", "write"] as const) {
        const [a, b] = pair();
        const plan = side === "read" ? { resetAfterReadBytes: n } : { resetAfterWriteBytes: n };
        const handled = server.handle(faulty(b, { ...plan, splitReads: 3 }));
        for (const m of exchange) await a.write(m).catch(() => undefined);
        await a.end();
        await handled;
        a.close();
      }
    }
    assert.equal(server.connections, 0);
    const { conn, handled } = connect(server);
    assert.deepEqual(await conn.call("org.example.s.Echo", { text: "still" }), { text: "still" });
    await conn.close();
    await handled;
  });

  test("options are checked", () => {
    assert.throws(() => createServer({ maxConnections: 0 }), RangeError);
    assert.throws(() => createServer({ maxQueuedCalls: 1.5 }), RangeError);
    assert.throws(() => createServer({ vendor: 1 as never }), TypeError);
    assert.throws(() => createServer({ validateReplies: "loud" as never }), TypeError);
  });
});

describe("Server: serve and shutdown", () => {
  test("serve() accepts in the background; several listeners; connections count", async () => {
    const { server } = makeServer();
    server.addInterface(IDL, { Echo: (p) => p });
    const l1 = new MemoryListener();
    const l2 = new MemoryListener();
    server.serve(l1);
    server.serve(l2);
    const c1 = createConnection(l1.dial());
    const c2 = createConnection(l2.dial());
    assert.deepEqual(await c1.call("org.example.s.Echo", { text: "1" }), { text: "1" });
    assert.deepEqual(await c2.call("org.example.s.Echo", { text: "2" }), { text: "2" });
    assert.equal(server.connections, 2);
    await server.shutdown();
    assert.equal(l1.closeCalls, 1);
    assert.equal(l2.closeCalls, 1);
    await c1.closed;
    await c2.closed;
    assert.equal(server.connections, 0);
  });

  test("an accept-loop error is reported as accept-failed and ends that loop", async () => {
    const { server, reported } = makeServer();
    const broken: AsyncIterable<never> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("EMFILE")) }),
    };
    server.serve(broken);
    await settle();
    assert.equal(reported[0]?.reason, "accept-failed");
    await server.shutdown();
  });

  test("an accept loop that ends with an error closes its listener (close errors swallowed)", async () => {
    const { server, reported } = makeServer();
    let closeCalls = 0;
    const broken = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("boom")) }),
      close: () => {
        closeCalls++;
        return Promise.reject(new Error("close failed too"));
      },
    };
    server.serve(broken);
    await settle();
    assert.equal(closeCalls, 1);
    assert.deepEqual(
      reported.map((r) => r.reason),
      ["accept-failed"],
    );
    // shutdown() has nothing left to close.
    await server.shutdown();
    assert.equal(closeCalls, 1);
  });

  test("shutdown() checks its options synchronously; an invalid call stops nothing", async () => {
    const { server } = makeServer();
    server.addInterface(IDL, { Echo: (p) => p });
    assert.throws(() => server.shutdown({ timeout: -1 }), RangeError);
    assert.throws(() => server.shutdown({ graceful: "yes" as never }), TypeError);
    const { conn, handled } = connect(server);
    assert.deepEqual(await conn.call("org.example.s.Echo", { text: "still serving" }), { text: "still serving" });
    await server.shutdown({ timeout: 100 });
    await conn.closed;
    await handled;
  });

  test("graceful: active call's signal aborts, its reply is still written, buffered calls dropped", async () => {
    const { server } = makeServer();
    let started: () => void = () => undefined;
    const isStarted = new Promise<void>((r) => {
      started = r;
    });
    server.addInterface(IDL, {
      Wait: (_p, ctx: CallContext) =>
        new Promise((resolve) => {
          started();
          ctx.signal.addEventListener("abort", () => {
            resolve({});
          });
        }),
      Echo: (p) => p,
    });
    const busy = connect(server);
    const idle = connect(server);
    await idle.conn.getInfo();
    const waiting = busy.conn.call("org.example.s.Wait", {});
    const dropped = busy.conn.call("org.example.s.Echo", { text: "dropped" });
    await isStarted;
    await settle();
    await server.shutdown();
    assert.deepEqual(await waiting, {});
    await assert.rejects(dropped, ConnectionClosedError);
    await idle.conn.closed;
    await busy.handled;
    await idle.handled;
    // handle() after shutdown closes at once; shutdown is idempotent.
    const [a, b] = pair();
    await server.handle(b);
    assert.equal(await new MessageReader(a).nextText(), null);
    await server.shutdown();
  });

  test("graceful deadline: a handler ignoring its signal is closed at the timeout", async () => {
    const { server } = makeServer();
    let ctxSignal: AbortSignal | undefined;
    let finish: () => void = () => undefined;
    server.addInterface(IDL, {
      Wait: (_p, ctx: CallContext) =>
        new Promise((resolve) => {
          ctxSignal = ctx.signal;
          finish = () => {
            resolve({});
          };
        }),
    });
    const { conn, handled } = connect(server);
    const p = conn.call("org.example.s.Wait", {});
    while (ctxSignal === undefined) await settle(1);
    const t0 = Date.now();
    await server.shutdown({ timeout: 30 });
    assert.ok(Date.now() - t0 >= 25);
    await assert.rejects(p, ConnectionClosedError);
    await handled;
    assert.equal(ctxSignal.aborted, true);
    finish();
  });

  test("graceful with timeout 0: a peer that never reads or closes is closed after the linger (2000 ms)", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { server } = makeServer();
      const [a, b] = pair();
      const handled = server.handle(b);
      // A call answered, then the peer goes silent: it never reads our FIN nor closes its side.
      await a.write(msg({ method: "org.varlink.service.GetInfo" }));
      await new MessageReader(a).next();
      const stopped = server.shutdown({ timeout: 0 });
      await settle();
      mock.timers.tick(1999);
      await settle();
      assert.equal(await isPending(stopped), true);
      mock.timers.tick(1);
      await settle();
      assert.equal(await isPending(stopped), false);
      await handled;
      a.close();
    } finally {
      mock.timers.reset();
    }
  });

  test("a read rejecting during a graceful finish closes the connection", async () => {
    const { server } = makeServer();
    const [a, b] = pair();
    // read() rejects without `closed` settling (no socket close event would rescue us).
    const side = controllable(b);
    const handled = server.handle(side);
    await a.write(msg({ method: "org.varlink.service.GetInfo" }));
    await new MessageReader(a).next();
    const stopped = server.shutdown({ timeout: 0 });
    await settle();
    side.failRead(new Error("ECONNRESET"));
    await settle();
    assert.equal(await isPending(handled), false);
    await stopped;
    a.close();
  });

  test("serve() with a listener already being served is a TypeError; the listener stays open", async () => {
    const { server } = makeServer();
    server.addInterface(IDL, { Echo: (p) => p });
    const l = new MemoryListener();
    server.serve(l);
    assert.throws(() => {
      server.serve(l);
    }, TypeError);
    await settle();
    assert.equal(l.closeCalls, 0);
    const c = createConnection(l.dial());
    assert.deepEqual(await c.call("org.example.s.Echo", { text: "still" }), { text: "still" });
    await server.shutdown();
    assert.equal(l.closeCalls, 1);
  });

  test("non-graceful: everything is closed at once", async () => {
    const { server } = makeServer();
    let ctxSignal: AbortSignal | undefined;
    server.addInterface(IDL, {
      Wait: (_p, ctx: CallContext) =>
        new Promise((resolve) => {
          ctxSignal = ctx.signal;
          ctx.signal.addEventListener("abort", () => {
            resolve({});
          });
        }),
    });
    const { conn, handled } = connect(server);
    const p = conn.call("org.example.s.Wait", {});
    while (ctxSignal === undefined) await settle(1);
    await server.shutdown({ graceful: false });
    await assert.rejects(p, ConnectionClosedError);
    await handled;
    assert.equal(ctxSignal.aborted, true);
  });
});

describe("Server: onError default", () => {
  let warn: ReturnType<typeof mock.method>;
  beforeEach(() => {
    warn = mock.method(console, "warn", () => undefined);
  });
  afterEach(() => {
    warn.mock.restore();
  });

  test("one console.warn line with the reason and method", async () => {
    const server = createServer();
    server.addInterface(IDL, {
      Echo: () => {
        throw new Error("SECRET");
      },
    });
    const { conn, handled } = connect(server);
    await assert.rejects(conn.call("org.example.s.Echo", { text: "x" }));
    await conn.close();
    await handled;
    assert.equal(warn.mock.callCount(), 1);
    const line = String(warn.mock.calls[0]?.arguments[0]);
    assert.match(line, /handler-threw/);
    assert.match(line, /org\.example\.s\.Echo/);
    assert.doesNotMatch(line, /SECRET/);
  });
});
