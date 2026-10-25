// End-to-end regressions for the 0.1.x findings (DESIGN.md §3, §7.2; ~/oss/data/review-varlink-js.md), run over
// every transport in harness.ts (pair, unix, tcp): a real Server and Connection/Pool, or a raw byte-level peer.
// Socket-only cases (F3 with full socket buffers, F8) are in sockets.test.ts; F10–F14 and F16 in tooling.test.ts.
/* eslint-disable @typescript-eslint/require-await -- streaming handlers are async generators without awaits */
import assert from "node:assert/strict";
import { after, before, describe, mock, test } from "node:test";
import {
  CallTimeoutError,
  ConnectionClosedError,
  ExpectedMoreError,
  InterfaceNotFoundError,
  InternalError,
  InvalidParameterError,
  MessageTooLargeError,
  MethodNotFoundError,
  type CallContext,
} from "../../src/index.ts";
import {
  createConnection,
  createPool,
  createServer,
  type Server,
  type ServerErrorReason,
} from "../../src/rpc/index.ts";
import { pair } from "../../src/testing/index.ts";
import { transports, waitFor, type Endpoint } from "./harness.ts";

const IDL = `interface org.example.e2e

method Ping() -> ()

method Echo(text: string) -> (text: string)

method Hold() -> ()

method Plain() -> (n: int)

# [Supports 'more' flag]
method Count(n: int) -> (i: int)

# [Requires 'more' flag]
method Watch() -> (i: int)

method ThrowString() -> ()

method ThrowUndefined() -> ()

method RejectNonError() -> ()
`;
const I = "org.example.e2e";
const INTERNAL_WIRE = '{"error":"io.github.pzmarzly.varlinkjs.InternalError","parameters":{}}';
const encoder = new TextEncoder();
const wire = (v: unknown): Uint8Array => encoder.encode(`${JSON.stringify(v)}\0`);

interface Fixture {
  server: Server;
  reported: { error: unknown; reason: ServerErrorReason; method?: string | undefined }[];
  holds: AbortSignal[];
}

function makeServer(options: { maxMessageSize?: number } = {}): Fixture {
  const reported: Fixture["reported"] = [];
  const holds: AbortSignal[] = [];
  const server = createServer({ ...options, onError: (error, info) => reported.push({ error, ...info }) });
  server.addInterface(IDL, {
    Ping: () => ({}),
    Echo: (p: { text: string }) => ({ text: p.text }),
    Hold: (_p, ctx: CallContext) =>
      new Promise((resolve) => {
        holds.push(ctx.signal);
        ctx.signal.addEventListener("abort", () => {
          resolve({});
        });
      }),
    Plain: () => ({ n: 1 }),
    Count: async function* (p: { n: number }) {
      for (let i = 0; i < p.n - 1; i++) yield { i };
      return { i: p.n - 1 };
    },
    Watch: async function* () {
      yield { i: 0 };
    },
    ThrowString: () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- F7: a non-Error throw
      throw "x";
    },
    ThrowUndefined: () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- F7: a non-Error throw
      throw undefined;
    },
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- F7: a non-Error rejection
    RejectNonError: () => Promise.reject(42),
  });
  return { server, reported, holds };
}

for (const transport of transports) {
  describe(`e2e over ${transport.name}`, () => {
    let f: Fixture;
    let ep: Endpoint;
    before(async () => {
      f = makeServer();
      ep = await transport.start(f.server);
    });
    after(async () => {
      await ep.close();
      await f.server.shutdown({ graceful: false });
    });

    /** The server still answers a fresh connection. */
    async function alive(): Promise<void> {
      const conn = await ep.connect();
      assert.deepEqual(await conn.call(`${I}.Ping`), {});
      await conn.close();
    }

    describe("F1 a client reset or an idle client never kills the server", () => {
      test("reset mid-call: ctx.signal aborts, handle() resolves, other connections are served", async () => {
        const other = await ep.connect();
        const raw = await ep.raw();
        const before = f.holds.length;
        const reportedBefore = f.reported.length;
        await raw.write(wire({ method: `${I}.Hold` }));
        await waitFor(() => f.holds.length > before);
        const connections = f.server.connections;
        raw.reset();
        if (!transport.abruptReset) {
          // No RST on unix sockets: the server sees a clean EOF (half-close), so the call may still reply. It
          // must not crash anything; the connection closes when the server is done with it (here: shutdown).
          assert.deepEqual(await other.call(`${I}.Echo`, { text: "still here" }), { text: "still here" });
          assert.equal(f.reported.length, reportedBefore);
          await other.close();
          await alive();
          return;
        }
        const signal = f.holds[before];
        await waitFor(() => signal?.aborted === true);
        assert.ok(signal?.reason instanceof ConnectionClosedError);
        await waitFor(() => f.server.connections === connections - 1);
        assert.deepEqual(
          f.reported.slice(reportedBefore).map((r) => r.reason),
          ["transport-error"],
        );
        assert.deepEqual(await other.call(`${I}.Echo`, { text: "still here" }), { text: "still here" });
        await other.close();
        await alive();
      });

      test("an idle client longer than any timeout is not disconnected (no server idle timeout)", async () => {
        const conn = await ep.connect();
        await conn.call(`${I}.Ping`);
        // 0.1.x destroyed idle sockets after `timeout` (repro: 300 ms) and crashed. Advance a mocked clock far past
        // that: the server has no timer to fire, so nothing happens.
        mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
        try {
          mock.timers.tick(10 * 60_000);
        } finally {
          mock.timers.reset();
        }
        assert.deepEqual(await conn.call(`${I}.Echo`, { text: "after idle" }), { text: "after idle" });
        assert.equal(conn.isClosed, false);
        await conn.close();
      });
    });

    describe("F2 malformed input closes that connection, no reply, server alive", () => {
      for (const bad of ["not json", "null", "42"]) {
        test(JSON.stringify(bad), async () => {
          const raw = await ep.raw();
          const reportedBefore = f.reported.length;
          await raw.write(encoder.encode(`${bad}\0`));
          assert.deepEqual(await raw.readAll(), []);
          await waitFor(() => f.reported.length > reportedBefore);
          assert.equal(f.reported[reportedBefore]?.reason, "protocol-error");
          await alive();
        });
      }
    });

    describe("F3 large messages in both directions, then a call on the same connection", () => {
      test("4 MB echo, then Ping", async () => {
        const conn = await ep.connect();
        const text = "x".repeat(4_000_000);
        const r = await conn.call(`${I}.Echo`, { text });
        assert.equal((r as { text: string }).text.length, text.length);
        assert.deepEqual(await conn.call(`${I}.Ping`), {});
        await conn.close();
      });
    });

    describe("F4 closed connections are detected, never reused; the pool recovers", () => {
      test("server closes the connection: the pending call rejects, the next one rejects at once", async (t) => {
        if (ep.restart === undefined) {
          t.skip("transport cannot restart");
          return;
        }
        const conn = await ep.connect();
        const holdsBefore = f.holds.length;
        // Handled from the start: over sockets it rejects while restart() is still running.
        const pending = assert.rejects(conn.call(`${I}.Hold`), ConnectionClosedError);
        await waitFor(() => f.holds.length > holdsBefore);
        await ep.restart();
        await pending;
        await assert.rejects(conn.call(`${I}.Ping`), ConnectionClosedError);
        assert.equal(conn.isClosed, true);
      });

      test("the pool drops the dead connection and opens a new one", async (t) => {
        if (ep.restart === undefined) {
          t.skip("transport cannot restart");
          return;
        }
        let opened = 0;
        const pool = createPool(() => {
          opened++;
          return ep.connect();
        });
        await pool.call(`${I}.Ping`);
        await ep.restart();
        await waitFor(() => pool.size === 0);
        assert.deepEqual(await pool.call(`${I}.Echo`, { text: "recovered" }), { text: "recovered" });
        assert.equal(opened, 2);
        await pool.close();
      });

      test("client timeout, then a call: rejects at once; the pool recovers", async () => {
        const conn = await ep.connect({ timeout: 20 });
        await assert.rejects(conn.call(`${I}.Hold`), CallTimeoutError);
        await assert.rejects(conn.call(`${I}.Ping`), ConnectionClosedError);
        const pool = createPool(() => ep.connect({ timeout: 20 }));
        await assert.rejects(pool.call(`${I}.Hold`), CallTimeoutError);
        assert.deepEqual(await pool.call(`${I}.Ping`), {});
        await pool.close();
      });
    });

    describe("F5 nothing is written for a oneway call", () => {
      test("oneway to an unknown method, then a normal call: no off-by-one", async () => {
        const raw = await ep.raw();
        await raw.write(wire({ method: "com.unknown.Iface.Method", oneway: true }));
        await raw.write(wire({ method: `${I}.Nope`, oneway: true }));
        await raw.write(wire({ method: `${I}.ThrowString`, oneway: true }));
        await raw.write(wire({ method: `${I}.Echo`, parameters: { text: "mine" } }));
        await raw.end();
        assert.deepEqual(await raw.readAll(), ['{"parameters":{"text":"mine"}}']);
      });

      test("over a Connection: oneway then call", async () => {
        const conn = await ep.connect();
        await conn.oneway("com.unknown.Iface.Method");
        assert.deepEqual(await conn.call(`${I}.Echo`, { text: "ok" }), { text: "ok" });
        await conn.close();
      });
    });

    describe("F6 the §5.4 dispatch table", () => {
      test("MethodNotFound / InterfaceNotFound / InvalidParameter{method} / ExpectedMore", async () => {
        const conn = await ep.connect();
        await assert.rejects(
          conn.call(`${I}.Nope`),
          (e: unknown) => e instanceof MethodNotFoundError && e.parameters.method === `${I}.Nope`,
        );
        await assert.rejects(
          conn.call("com.unknown.Iface.Method"),
          (e: unknown) => e instanceof InterfaceNotFoundError && e.parameters.interface === "com.unknown.Iface",
        );
        await assert.rejects(
          conn.call("NotQualified"),
          (e: unknown) => e instanceof InvalidParameterError && e.parameters.parameter === "method",
        );
        await assert.rejects(conn.call(`${I}.Watch`), ExpectedMoreError);
        await conn.close();
      });

      test("plain handler called with more: a single reply without continues; non-oneway to a function", async () => {
        const raw = await ep.raw();
        await raw.write(wire({ method: `${I}.Plain`, more: true }));
        await raw.write(wire({ method: `${I}.Plain` }));
        await raw.end();
        assert.deepEqual(await raw.readAll(), ['{"parameters":{"n":1}}', '{"parameters":{"n":1}}']);
      });
    });

    describe("F7 every non-oneway call gets exactly one reply, whatever the handler throws", () => {
      for (const method of ["ThrowString", "ThrowUndefined", "RejectNonError"]) {
        test(method, async () => {
          const raw = await ep.raw();
          const reportedBefore = f.reported.length;
          await raw.write(wire({ method: `${I}.${method}` }));
          await raw.write(wire({ method: `${I}.Ping` }));
          await raw.end();
          assert.deepEqual(await raw.readAll(), [INTERNAL_WIRE, '{"parameters":{}}']);
          const r = f.reported[reportedBefore];
          assert.equal(r?.reason, "handler-threw");
          assert.equal(r.method, `${I}.${method}`);
        });
      }

      test("over a Connection the call rejects with InternalError", async () => {
        const conn = await ep.connect();
        await assert.rejects(conn.call(`${I}.ThrowString`), InternalError);
        await conn.close();
      });
    });

    describe("F9 GetInterfaceDescription answers from the registered map only", () => {
      for (const name of ["../../etc/hosts#", "__proto__", "constructor"]) {
        test(JSON.stringify(name), async () => {
          const conn = await ep.connect();
          await assert.rejects(
            conn.getInterfaceDescription(name),
            (e: unknown) => e instanceof InterfaceNotFoundError && e.parameters.interface === name,
          );
          await conn.close();
        });
      }
    });

    describe("F17 minimal wire output", () => {
      test("no continues:false / oneway:false; a more stream's final reply has no continues", async () => {
        const raw = await ep.raw();
        await raw.write(wire({ method: `${I}.Count`, parameters: { n: 3 }, more: true }));
        await raw.write(wire({ method: `${I}.Echo`, parameters: { text: "a" }, more: false, oneway: false }));
        await raw.end();
        const replies = await raw.readAll();
        assert.deepEqual(replies, [
          '{"parameters":{"i":0},"continues":true}',
          '{"parameters":{"i":1},"continues":true}',
          '{"parameters":{"i":2}}',
          '{"parameters":{"text":"a"}}',
        ]);
        const all = new TextDecoder().decode(raw.received());
        assert.doesNotMatch(all, /"continues":false|"oneway":false|"more":false/);
      });
    });
  });

  describe(`F15 64 MiB without NUL over ${transport.name}: closed, bounded memory, server alive`, () => {
    test("MessageTooLargeError reported as protocol-error; RSS growth < 4 × maxMessageSize", async () => {
      const maxMessageSize = 1024 * 1024;
      const fx = makeServer({ maxMessageSize });
      const ep2 = await transport.start(fx.server);
      try {
        const raw = await ep2.raw();
        const chunk = new Uint8Array(64 * 1024).fill(0x61);
        const rssBefore = process.memoryUsage().rss;
        let peak = rssBefore;
        let written = 0;
        try {
          while (written < 64 * 1024 * 1024) {
            await raw.write(chunk);
            written += chunk.length;
            if ((written & (1024 * 1024 - 1)) === 0) peak = Math.max(peak, process.memoryUsage().rss);
          }
        } catch {
          // The server closed the connection: later writes reject.
        }
        peak = Math.max(peak, process.memoryUsage().rss);
        // Accepted before the close: the limit plus what the socket buffers (kernel, Node) absorbed.
        assert.ok(written <= 16 * maxMessageSize, `the server read ${String(written)} bytes before closing`);
        assert.deepEqual(await raw.readAll(), []);
        await waitFor(() => fx.reported.length > 0);
        assert.deepEqual(
          fx.reported.map((r) => r.reason),
          ["protocol-error"],
        );
        assert.ok(fx.reported[0]?.error instanceof MessageTooLargeError);
        // pair: 4 × the limit. Sockets add a fresh Buffer per read (garbage until the next GC) and kernel buffers,
        // so they get 16 × — still a quarter of the 64 MiB input, which is what 0.1.x buffered.
        const bound = (transport.name === "pair" ? 4 : 16) * maxMessageSize;
        assert.ok(peak - rssBefore < bound, `RSS grew by ${String(peak - rssBefore)} bytes`);
        const conn = await ep2.connect();
        assert.deepEqual(await conn.call(`${I}.Ping`), {});
        await conn.close();
      } finally {
        await ep2.close();
        await fx.server.shutdown({ graceful: false });
      }
    });
  });
}

describe("F17 the client writes no false flags", () => {
  test("call / oneway / stream bytes", async () => {
    const [a, b] = pair();
    const conn = createConnection(a);
    void conn.oneway(`${I}.Ping`);
    void conn.call(`${I}.Ping`).catch(() => undefined);
    void conn
      .stream(`${I}.Count`, { n: 1 })
      .next()
      .catch(() => undefined);
    const got: string[] = [];
    let text = "";
    while (got.length < 3) {
      const chunk = await b.read();
      if (chunk === null) break;
      text += new TextDecoder().decode(chunk.bytes);
      got.splice(0, got.length, ...text.split("\0").slice(0, -1));
    }
    assert.deepEqual(got, [
      `{"method":"${I}.Ping","parameters":{},"oneway":true}`,
      `{"method":"${I}.Ping","parameters":{}}`,
      `{"method":"${I}.Count","parameters":{"n":1},"more":true}`,
    ]);
    await conn.close();
  });
});
