// The defaults README.md's "Limits and defaults" table lists, each checked here (exported constants by value, the
// others by behaviour), so the table cannot drift from the code silently. Some rows point at older tests instead
// (framer, server-session, connection, codec, validators, idl, activation tests); see the table.
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { describe, mock, test } from "node:test";
import { DEFAULT_MAX_QUEUED_CALLS } from "../../src/core/protocol/server-session.ts";
import {
  CallTimeoutError,
  createConnection,
  createPool,
  createServer,
  DEFAULT_COLLECT_MAX,
  DEFAULT_HIGH_WATER_MARK,
  DEFAULT_MAX_MESSAGE_SIZE,
  DEFAULT_TIMEOUT,
  MAX_VALUE_DEPTH,
  type ByteChannel,
  type Connection,
  type Server,
} from "../../src/index.ts";
import { MAX_TYPE_DEPTH } from "../../src/idl/index.ts";
import { pair } from "../../src/testing/index.ts";
import { DEFAULT_MAX_BUFFERED_BYTES, DEFAULT_WRITE_HIGH_WATER_MARK } from "../../src/websocket/channel.ts";

const MiB = 1024 * 1024;

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
`;

/** A server whose Hold() waits until release(), and a factory connecting to it over pair(). */
function fixture(): { server: Server; factory: () => Promise<Connection>; opened: () => number; release(): void } {
  const server = createServer({ onError: () => undefined });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  server.addInterface(IDL, { Hold: () => gate.then(() => ({})) });
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
});
