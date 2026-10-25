// WebSocket mode end to end (DESIGN.md §4.12): connect()/createPool() with the runtime's own global WebSocket
// against the bridge fixture, in every framing mode.
import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { parseAddress } from "../../../src/core/address/index.ts";
import {
  CallTimeoutError,
  ConnectionClosedError,
  IntegerRangeError,
  OperationNotSupportedError,
  VarlinkError,
} from "../../../src/index.ts";
import { fromNodeSocket, listen, type NodeListener } from "../../../src/node/index.ts";
import { openSocket } from "../../../src/node/connect.ts";
import { connect, createPool, type WebSocketConstructorLike } from "../../../src/websocket/index.ts";
import { startBridge, type Bridge, type Framing } from "./bridge.ts";
import { createService, DESC, Echo, OopsError, SERVICE, startBackend, type Backend } from "./service.ts";

let backend: Backend;
let bridge: Bridge;
let url: string;

before(async () => {
  backend = startBackend();
  bridge = await startBridge({ backend: () => backend.connect(), services: [SERVICE, "org.varlink.service"] });
  url = bridge.wsUrl(SERVICE);
});

after(async () => {
  await bridge.close();
  await backend.stop();
});

afterEach(() => {
  bridge.reset();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

for (const framing of ["message", "split", "coalesce"] as const satisfies readonly Framing[]) {
  describe(`WebSocket mode, bridge framing "${framing}"`, () => {
    const open = async (options?: Parameters<typeof connect>[1]) => {
      bridge.knobs.framing = framing;
      return connect(url, options);
    };

    test("call, pipelined calls, and oneway (which consumes no reply)", async () => {
      const conn = await open();
      try {
        assert.deepEqual(await conn.call("org.example.ws.Echo", { text: "hi" }), { text: "hi" });
        const texts = Array.from({ length: 50 }, (_, i) => `m${String(i)}`);
        const replies = await Promise.all(texts.map((text) => conn.call("org.example.ws.Echo", { text })));
        assert.deepEqual(
          replies.map((r) => r.text),
          texts,
        );
        await conn.oneway("org.example.ws.Log", { text: `oneway-${framing}` });
        assert.deepEqual(await conn.call("org.example.ws.Echo", { text: "after" }), { text: "after" });
        assert.ok(backend.logged.includes(`oneway-${framing}`));
      } finally {
        await conn.close();
      }
    });

    test("a more stream with backpressure (highWaterMark 2, slow consumer), then a call", async () => {
      const conn = await open({ highWaterMark: 2 });
      try {
        const seen: unknown[] = [];
        for await (const r of conn.stream("org.example.ws.Count", { n: 100 })) {
          seen.push(r.i);
          if (seen.length % 25 === 0) await sleep(10);
        }
        assert.deepEqual(
          seen,
          Array.from({ length: 100 }, (_, i) => i),
        );
        assert.deepEqual(await conn.call("org.example.ws.Ping"), {});
      } finally {
        await conn.close();
      }
    });

    test("a 4 MiB message each way", async () => {
      const conn = await open();
      try {
        const text = "x".repeat(4 * 1024 * 1024);
        const r = await conn.call("org.example.ws.Echo", { text });
        assert.equal(r.text, text);
      } finally {
        await conn.close();
      }
    });
  });
}

describe("WebSocket mode: errors and closing", () => {
  test("typed interface errors (registered descriptor) and standard errors", async () => {
    const conn = await connect(url, { interfaces: [DESC], validateReplies: "warn" });
    try {
      await assert.rejects(conn.call("org.example.ws.Fail", { code: 7 }), (e: unknown) => {
        assert.ok(e instanceof OopsError);
        assert.deepEqual(e.parameters, { code: 7 });
        return true;
      });
      await assert.rejects(conn.call("org.example.ws.Nope"), (e: unknown) => e instanceof VarlinkError);
      assert.deepEqual(await conn.call(Echo, { text: "typed" }), { text: "typed" });
      // Lossless integers: a registered int field in "number" mode rejects the unsafe value.
      await assert.rejects(conn.call("org.example.ws.Big", {}), IntegerRangeError);
    } finally {
      await conn.close();
    }
  });

  test("the server closing cleanly mid-call: the pending call rejects with ConnectionClosedError", async () => {
    const conn = await connect(url);
    const p = conn.call("org.example.ws.Hang");
    await until(() => bridge.webSockets === 1, "the session");
    await sleep(20); // the call reached the service
    bridge.closeWebSockets();
    await assert.rejects(p, ConnectionClosedError);
    await conn.closed;
    assert.equal(conn.closeReason, undefined, "a clean close is a plain EOF");
  });

  test("the bridge dropping the TCP connection (1006) or closing with an error code: the reason says so", async () => {
    const conn = await connect(url);
    const p = conn.call("org.example.ws.Hang");
    await until(() => bridge.webSockets === 1, "the session");
    bridge.killWebSockets();
    await assert.rejects(p, ConnectionClosedError);
    await conn.closed;
    assert.ok(conn.closeReason instanceof ConnectionClosedError);
    assert.match(conn.closeReason.message, /^websocket (closed: code 1006|error)/);

    const conn2 = await connect(url);
    const p2 = conn2.call("org.example.ws.Hang");
    await until(() => bridge.webSockets === 1, "the session");
    bridge.closeWebSockets(4000, "going\naway");
    await assert.rejects(p2, ConnectionClosedError);
    await conn2.closed;
    assert.ok(conn2.closeReason instanceof ConnectionClosedError);
    assert.equal(conn2.closeReason.message, 'websocket closed: code 4000 "going\\u000aaway"');
  });

  test("the receive buffer cap closes the connection when a stream is not consumed", async () => {
    const conn = await connect(url, { maxBufferedBytes: 4096, highWaterMark: 1 });
    const it = conn.stream("org.example.ws.Count", { n: 2000 });
    await until(() => bridge.webSockets === 0, "the socket closed by the client");
    await assert.rejects(
      (async () => {
        for (;;) if ((await it.next()).done === true) return;
      })(),
      (e: unknown) =>
        e instanceof ConnectionClosedError &&
        e.cause instanceof ConnectionClosedError &&
        /receive buffer limit/.test(e.cause.message),
    );
    await conn.closed;
  });

  test("close() closes the socket; later calls reject", async () => {
    const conn = await connect(url);
    await conn.call("org.example.ws.Ping");
    await conn.close();
    await until(() => bridge.webSockets === 0, "the bridge to see the close");
    await assert.rejects(conn.call("org.example.ws.Ping"), ConnectionClosedError);
  });
});

describe("WebSocket mode: connecting", () => {
  test("address forms: ws://, http(s)://…/ws/services/<svc> (dialled as ws://), an AddressSpec", async () => {
    for (const address of [url, bridge.wsUrl(SERVICE, "http"), parseAddress(bridge.wsUrl(SERVICE, "http"))]) {
      const conn = await connect(address);
      assert.deepEqual(await conn.call("org.example.ws.Ping"), {});
      await conn.close();
    }
    const upgrades = bridge.requests.filter((r) => r.method === "UPGRADE");
    assert.equal(upgrades.length, 3);
    assert.ok(upgrades.every((r) => r.path === `/waldo/ws/services/${SERVICE}`));
  });

  test("a simple-mode base URL is a TypeError pointing to varlink-js/http; socket addresses are not supported", async () => {
    await assert.rejects(
      connect(bridge.base),
      (e: unknown) => e instanceof TypeError && /createHttpClient/.test(e.message),
    );
    for (const address of ["unix:/run/x", "tcp:127.0.0.1:1", "exec:/bin/true"])
      await assert.rejects(
        connect(address),
        (e: unknown) => e instanceof OperationNotSupportedError && /varlink-js\/node/.test(e.message),
      );
    await assert.rejects(connect("nonsense"), TypeError);
    // The WebSocket constructor refuses a fragment: its SyntaxError rejects as is.
    await assert.rejects(connect(`${url}#frag`), (e: unknown) => e instanceof Error && e.name === "SyntaxError");
  });

  test("an unreachable service (502) and an unknown service (404) reject with ConnectionClosedError", async () => {
    const down = await startBridge({ backend: () => Promise.reject(new Error("ECONNREFUSED")), services: [SERVICE] });
    try {
      await assert.rejects(
        connect(down.wsUrl(SERVICE)),
        (e: unknown) => e instanceof ConnectionClosedError && e.message === "websocket connect failed",
      );
      await assert.rejects(connect(down.wsUrl("org.example.unknown")), ConnectionClosedError);
    } finally {
      await down.close();
    }
  });

  test("the connect phase times out (a bridge that never answers the handshake) or is aborted", async () => {
    bridge.knobs.stallHandshake = true;
    await assert.rejects(
      connect(url, { timeout: 100 }),
      (e: unknown) => e instanceof CallTimeoutError && e.message === "connect timed out",
    );
    const reason = new Error("stop");
    const ac = new AbortController();
    const p = connect(url, { signal: ac.signal, timeout: 0 });
    setTimeout(() => {
      ac.abort(reason);
    }, 50);
    await assert.rejects(p, (e) => e === reason);
    await assert.rejects(connect(url, { signal: AbortSignal.abort(reason) }), (e) => e === reason);
    await assert.rejects(connect(url, { timeout: -1 }), RangeError);
    await assert.rejects(connect(url, { maxBufferedBytes: 0 }), RangeError);
  });

  test("protocols are requested; options.WebSocket replaces the global; no WebSocket at all is not supported", async () => {
    let constructed = 0;
    const Base = globalThis.WebSocket as unknown as WebSocketConstructorLike;
    const Counting = class extends (Base as unknown as new (u: string, p?: string | string[]) => object) {
      constructor(u: string, p?: string | string[]) {
        super(u, p);
        constructed++;
      }
    } as unknown as WebSocketConstructorLike;
    const conn = await connect(url, { protocols: ["varlink", "other"], WebSocket: Counting });
    assert.deepEqual(await conn.call("org.example.ws.Ping"), {});
    await conn.close();
    assert.equal(constructed, 1);
    assert.equal(bridge.wsProtocols.at(-1), "varlink, other");

    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    Object.defineProperty(globalThis, "WebSocket", { value: undefined, configurable: true, writable: true });
    try {
      await assert.rejects(connect(url), OperationNotSupportedError);
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "WebSocket");
      else Object.defineProperty(globalThis, "WebSocket", descriptor);
    }
  });

  test("createPool: calls lease WebSocket connections", async () => {
    const pool = createPool(url, { max: 2 });
    try {
      const replies = await Promise.all(["a", "b", "c", "d"].map((text) => pool.call("org.example.ws.Echo", { text })));
      assert.deepEqual(
        replies.map((r) => r.text),
        ["a", "b", "c", "d"],
      );
      assert.ok(pool.size >= 1 && pool.size <= 2);
    } finally {
      await pool.close();
    }
  });

  test("a backend over a real tcp listener (varlink-js/node)", async () => {
    const { server } = createService();
    const listener: NodeListener = await listen("tcp:127.0.0.1:0");
    server.serve(listener);
    const tcpBridge = await startBridge({
      backend: async () => fromNodeSocket(await openSocket(parseAddress(listener.address), 0, undefined)),
      services: [SERVICE],
    });
    try {
      const conn = await connect(tcpBridge.wsUrl(SERVICE));
      assert.deepEqual(await conn.collect("org.example.ws.Count", { n: 3 }), [{ i: 0 }, { i: 1 }, { i: 2 }]);
      await conn.close();
    } finally {
      await tcpBridge.close();
      await server.shutdown({ graceful: false });
    }
  });
});

describe("connect(): address errors never quote credentials", () => {
  test("a simple-mode URL with user:password is a TypeError without the password", async () => {
    await assert.rejects(
      connect("https://user:s3cret@bridge.example/waldo/"),
      (e: unknown) => e instanceof TypeError && /createHttpClient/.test(e.message) && !e.message.includes("s3cret"),
    );
  });
});
