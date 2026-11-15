// The defaults README.md's "Limits and defaults" table lists, checked here by behaviour: an object created without
// the option enforces the documented value (and, where cheap, accepts exactly that value). The exported constants
// are also checked by value. Rows of the table that point at other tests (codec, validators, idl, activation) say so.
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { describe, mock, test } from "node:test";
import { DEFAULT_MAX_QUEUED_CALLS } from "../../src/core/protocol/server-session.ts";
import { createHttpClient } from "../../src/http/index.ts";
import {
  CallTimeoutError,
  ConnectionClosedError,
  createConnection,
  createPool,
  createServer,
  DEFAULT_COLLECT_MAX,
  DEFAULT_HIGH_WATER_MARK,
  DEFAULT_MAX_MESSAGE_SIZE,
  DEFAULT_TIMEOUT,
  MAX_VALUE_DEPTH,
  MessageTooLargeError,
  type ByteChannel,
  type Connection,
  type Server,
} from "../../src/index.ts";
import { MAX_TYPE_DEPTH } from "../../src/idl/index.ts";
import { connect, listen } from "../../src/node/index.ts";
import { pair } from "../../src/testing/index.ts";
import { DEFAULT_MAX_BUFFERED_BYTES, DEFAULT_WRITE_HIGH_WATER_MARK } from "../../src/websocket/channel.ts";
import { fromWebSocket } from "../../src/websocket/index.ts";
import { FakeWebSocket } from "../unit/websocket/fake.ts";

const MiB = 1024 * 1024;
const encoder = new TextEncoder();

/** `prefix`, `size` − prefix − suffix bytes of "x", then `suffix`: exactly `size` bytes of UTF-8. */
function padded(prefix: string, size: number, suffix: string): Uint8Array {
  const bytes = new Uint8Array(size).fill(0x78);
  bytes.set(encoder.encode(prefix), 0);
  bytes.set(encoder.encode(suffix), size - suffix.length);
  return bytes;
}

/** `message` followed by the NUL that ends a varlink message. */
function framed(message: Uint8Array): Uint8Array {
  const out = new Uint8Array(message.length + 1);
  out.set(message, 0);
  return out;
}

async function turns(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await turn();
}

/** Whether `p` is still pending after a few event-loop turns. */
async function pending(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  await turns(5);
  return !done;
}

const IDL = `interface org.example.defaults

method Hold() -> ()

method Size(s: string) -> (n: int)
`;

/** A server whose Hold() waits until release(), and a factory connecting to it over pair(). */
function fixture(): { server: Server; factory: () => Promise<Connection>; opened: () => number; release(): void } {
  const server = createServer({ onError: () => undefined });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  server.addInterface(IDL, {
    Hold: () => gate.then(() => ({})),
    Size: (p: { s: string }) => ({ n: p.s.length }),
  });
  let opened = 0;
  const factory = (): Promise<Connection> => {
    opened++;
    const [a, b] = pair();
    void server.handle(b);
    return Promise.resolve(createConnection(a, { timeout: 0 }));
  };
  return { server, factory, opened: () => opened, release };
}

/** Reads from a channel until it has seen one NUL-terminated message. */
async function readMessage(channel: ByteChannel): Promise<void> {
  for (;;) {
    const chunk = await channel.read();
    if (chunk === null) throw new Error("EOF");
    if (chunk.bytes.includes(0)) return;
  }
}

/** Reads one NUL-terminated message from a channel and parses it. */
async function readReply(channel: ByteChannel): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const chunk = await channel.read();
    if (chunk === null) throw new Error("EOF");
    const nul = chunk.bytes.indexOf(0);
    chunks.push(nul < 0 ? chunk.bytes : chunk.bytes.subarray(0, nul));
    if (nul >= 0) break;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

describe("exported default constants", () => {
  test("values", () => {
    assert.equal(DEFAULT_MAX_MESSAGE_SIZE, 16 * MiB);
    assert.equal(DEFAULT_MAX_QUEUED_CALLS, 64);
    assert.equal(DEFAULT_TIMEOUT, 45_000);
    assert.equal(DEFAULT_HIGH_WATER_MARK, 64);
    assert.equal(DEFAULT_COLLECT_MAX, 1024);
    assert.equal(MAX_VALUE_DEPTH, 1024);
    assert.equal(MAX_TYPE_DEPTH, 64);
    assert.equal(DEFAULT_MAX_BUFFERED_BYTES, 64 * MiB);
    assert.equal(DEFAULT_WRITE_HIGH_WATER_MARK, 1 * MiB);
  });
});

describe("behavioural defaults", () => {
  test("a call times out after 45 s by default, and that closes the connection", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const [a, b] = pair();
      const conn = createConnection(a);
      const p = conn.call("org.example.defaults.Hold");
      await readMessage(b);
      await turns(5);
      mock.timers.tick(44_999);
      assert.ok(await pending(p), "still pending at 44.999 s");
      mock.timers.tick(1);
      await assert.rejects(p, CallTimeoutError);
      await conn.closed;
      assert.ok(conn.closeReason instanceof CallTimeoutError);
    } finally {
      mock.timers.reset();
    }
  });

  test("a server accepts 4096 connections by default; the next one is closed at once", async () => {
    const reasons: string[] = [];
    const server = createServer({ onError: (_e, info) => reasons.push(info.reason) });
    const peers: ByteChannel[] = [];
    for (let i = 0; i < 4096; i++) {
      const [a, b] = pair();
      void server.handle(b);
      peers.push(a);
    }
    assert.equal(server.connections, 4096);
    assert.deepEqual(reasons, []);
    const [a, b] = pair();
    await server.handle(b);
    assert.deepEqual(reasons, ["connection-limit"]);
    assert.equal(await a.read(), null);
    assert.equal(server.connections, 4096);
    await server.shutdown({ graceful: false });
    for (const p of peers) p.close();
  });

  test("a pool opens at most 8 connections by default", async () => {
    const f = fixture();
    const pool = createPool(f.factory);
    const calls = Array.from({ length: 10 }, () => pool.call("org.example.defaults.Hold"));
    await turns(20);
    assert.equal(f.opened(), 8);
    assert.equal(pool.size, 8);
    f.release();
    await Promise.all(calls);
    assert.equal(f.opened(), 8);
    await pool.close();
    await f.server.shutdown();
  });

  test("a pool closes idle connections after 30 s by default", async () => {
    const f = fixture();
    const pool = createPool(f.factory);
    f.release();
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await pool.call("org.example.defaults.Hold");
      assert.equal(pool.idle, 1);
      mock.timers.tick(29_999);
      await turns(5);
      assert.equal(pool.size, 1);
      mock.timers.tick(1);
      await turns(5);
      assert.equal(pool.size, 0);
    } finally {
      mock.timers.reset();
    }
    await pool.close();
    await f.server.shutdown();
  });

  test("waiting for a pool connection is bounded by 45 s by default", async () => {
    const f = fixture();
    const pool = createPool(f.factory);
    const busy = Array.from({ length: 8 }, () => pool.call("org.example.defaults.Hold"));
    await turns(20);
    assert.equal(pool.size, 8);
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const waiting = pool.call("org.example.defaults.Hold");
      await turns(5);
      mock.timers.tick(44_999);
      assert.ok(await pending(waiting));
      mock.timers.tick(1);
      await assert.rejects(waiting, CallTimeoutError);
    } finally {
      mock.timers.reset();
    }
    f.release();
    await Promise.all(busy);
    await pool.close();
    await f.server.shutdown();
  });

  test("a graceful shutdown closes calls that ignore their signal after 5 s by default", async () => {
    const f = fixture();
    const [a, b] = pair();
    void f.server.handle(b);
    const conn = createConnection(a, { timeout: 0 });
    const call = conn.call("org.example.defaults.Hold");
    call.catch(() => undefined);
    await turns(10);
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const stopped = f.server.shutdown();
      await turns(5);
      mock.timers.tick(4_999);
      assert.ok(await pending(stopped), "still draining at 4.999 s");
      mock.timers.tick(1);
      await stopped;
    } finally {
      mock.timers.reset();
    }
    await conn.closed;
    f.release();
  });

  test("connect() times out after 45 s by default (mocked clock)", async () => {
    const server = createServer({ onError: () => undefined });
    const listener = await listen("tcp:127.0.0.1:0");
    server.serve(listener);
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      // Ticked before the socket's asynchronous `connect` event, as in test/unit/node/connect.test.ts.
      const late = connect(listener.address);
      mock.timers.tick(45_000);
      await assert.rejects(late, (e: unknown) => e instanceof CallTimeoutError && /connect timed out/.test(e.message));
      const inTime = connect(listener.address);
      mock.timers.tick(44_999);
      const conn = await inTime;
      await conn.close();
    } finally {
      mock.timers.reset();
      await server.shutdown();
    }
  });

  test("a connection accepts a 16 MiB reply by default and closes on a larger one", async () => {
    const [a, b] = pair();
    const conn = createConnection(a, { timeout: 0 });
    const ok = conn.call("org.example.defaults.Size", { s: "" });
    await readMessage(b);
    const prefix = '{"parameters":{"s":"';
    await b.write(framed(padded(prefix, 16 * MiB, '"}}')));
    assert.equal(((await ok).s as string).length, 16 * MiB - prefix.length - 3);

    const tooLarge = conn.call("org.example.defaults.Size", { s: "" });
    await readMessage(b);
    b.write(new Uint8Array(16 * MiB + 1).fill(0x78)).catch(() => undefined);
    await assert.rejects(tooLarge, ConnectionClosedError);
    await conn.closed;
    assert.ok(conn.closeReason instanceof MessageTooLargeError, String(conn.closeReason));
    b.close();
  });

  test("a server accepts a 16 MiB call by default and closes the connection on a larger one", async () => {
    const f = fixture();
    const prefix = '{"method":"org.example.defaults.Size","parameters":{"s":"';
    {
      const [a, b] = pair();
      const handled = f.server.handle(b);
      await a.write(framed(padded(prefix, 16 * MiB, '"}}')));
      assert.deepEqual(await readReply(a), { parameters: { n: 16 * MiB - prefix.length - 3 } });
      await a.end();
      await handled;
      a.close();
    }
    {
      const [a, b] = pair();
      const handled = f.server.handle(b);
      a.write(new Uint8Array(16 * MiB + 1).fill(0x78)).catch(() => undefined);
      assert.equal(await a.read(), null, "the server closed the connection without a reply");
      await handled;
      a.close();
    }
    await f.server.shutdown();
  });

  test("a server buffers 64 complete calls per connection by default, then stops reading", async () => {
    const f = fixture();
    // highWaterMark 0: a write resolves only once the server has read it.
    const [a, b] = pair({ highWaterMark: 0 });
    const handled = f.server.handle(b);
    const call = framed(encoder.encode('{"method":"org.example.defaults.Hold"}'));
    await a.write(call); // taken by the dispatcher, its handler waits for release()
    for (let i = 0; i < 64; i++) assert.ok(!(await pending(a.write(call))), `call ${String(i + 2)} is read`);
    const blocked = a.write(call);
    assert.ok(await pending(blocked), "the 66th call is not read while 64 wait");
    f.release();
    // Read the replies meanwhile: with highWaterMark 0 the server's writes wait for our reads too.
    const replies = (async () => {
      let n = 0;
      while (n < 66) {
        const chunk = await a.read();
        assert.ok(chunk !== null);
        n += chunk.bytes.filter((x) => x === 0).length;
      }
      return n;
    })();
    await blocked;
    assert.equal(await replies, 66);
    await a.end();
    await handled;
    a.close();
    await f.server.shutdown();
  });

  test("a connection stops reading after 64 unread stream replies by default", async () => {
    // highWaterMark 0: a write resolves only once the connection has read it.
    const [a, b] = pair({ highWaterMark: 0 });
    const conn = createConnection(a, { timeout: 0 });
    const replies = conn.stream("org.example.defaults.Hold")[Symbol.asyncIterator]();
    const first = replies.next(); // sends the call; this read takes the first reply
    await readMessage(b);
    const reply = framed(encoder.encode('{"parameters":{},"continues":true}'));
    let read = 0;
    for (; read < 1000; read++) if (await pending(b.write(reply))) break;
    assert.equal(read, 1 + 64, "the reply read by next(), then 64 buffered");
    await first;
    await conn.close();
    b.close();
  });

  test("a WebSocket channel holds 64 MiB unread by default; one more byte closes the socket", async () => {
    const ws = new FakeWebSocket();
    ws.holdClose = true;
    const ch = fromWebSocket(ws);
    const mebibyte = "x".repeat(MiB);
    for (let i = 0; i < 64; i++) ws.message(mebibyte);
    assert.deepEqual(ws.closes, [], "exactly 64 MiB is fine");
    ws.message("x");
    assert.deepEqual(ws.closes, [{ code: 1009, reason: "receive buffer limit exceeded" }]);
    ws.closed(1009, "", true);
    ch.close();
    await ch.closed;
  });

  test("a WebSocket write() resolves while bufferedAmount is at most 1 MiB by default", async () => {
    const ws = new FakeWebSocket();
    const ch = fromWebSocket(ws);
    ws.bufferedAmount = MiB;
    await ch.write(encoder.encode("a"));
    ws.bufferedAmount = MiB + 1;
    const waiting = ch.write(encoder.encode("b"));
    assert.ok(await pending(waiting), "waits above 1 MiB");
    ws.bufferedAmount = MiB;
    await waiting; // bufferedAmount is polled (at most every 50 ms)
    ch.close();
    await ch.closed;
  });

  test("an HTTP client accepts a 16 MiB response body by default and rejects a larger one", async () => {
    let body: Uint8Array = new Uint8Array(0);
    const client = createHttpClient("http://127.0.0.1:1/", {
      fetch: () =>
        Promise.resolve({
          status: 200,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(body);
              controller.close();
            },
          }),
        }),
    });
    body = padded('{"s":"', 16 * MiB, '"}');
    assert.equal(((await client.call("org.example.defaults.Size")).s as string).length, 16 * MiB - 8);
    body = padded('{"s":"', 16 * MiB + 1, '"}');
    await assert.rejects(client.call("org.example.defaults.Size"), MessageTooLargeError);
  });
});
