// Pool (DESIGN.md §5.2, §4.11): exclusive leases, reuse, eviction of closed connections (F4), FIFO waiting,
// factory failures, idle timeout, close.
/* eslint-disable @typescript-eslint/require-await -- streaming handlers are async generators without awaits */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CallTimeoutError, ConnectionClosedError, type CallContext } from "../../../src/index.ts";
import { createConnection, createPool, createServer, type Connection, type Server } from "../../../src/rpc/index.ts";
import { pair } from "../../../src/testing/index.ts";
import { isPending, settle, sleep, trackTimers } from "./helpers.ts";

const IDL = `interface org.example.p

method Echo(text: string) -> (text: string)

method Hold() -> ()

# [Supports 'more' flag]
method Count(n: int) -> (i: int)
`;

interface Fixture {
  server: Server;
  opened: Connection[];
  factory: (signal: AbortSignal) => Promise<Connection>;
  release(): void;
}

/** A server plus a factory connecting to it over pair(); Hold() waits until release() is called. */
function fixture(): Fixture {
  const server = createServer({ onError: () => undefined });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const opened: Connection[] = [];
  server.addInterface(IDL, {
    Echo: (p) => p,
    Hold: () => gate.then(() => ({})),
    Count: async function* (p: { n: number }) {
      for (let i = 0; i < p.n - 1; i++) yield { i };
      return { i: p.n - 1 };
    },
  });
  return {
    server,
    opened,
    factory: () => {
      const [a, b] = pair();
      void server.handle(b);
      const conn = createConnection(a);
      opened.push(conn);
      return Promise.resolve(conn);
    },
    release: () => {
      release();
    },
  };
}

describe("Pool", () => {
  test("sequential operations reuse one idle connection", async () => {
    const f = fixture();
    const pool = createPool(f.factory, { idleTimeout: 0 });
    assert.deepEqual(await pool.call("org.example.p.Echo", { text: "a" }), { text: "a" });
    assert.deepEqual(await pool.collect("org.example.p.Count", { n: 2 }), [{ i: 0 }, { i: 1 }]);
    await pool.oneway("org.example.p.Echo", { text: "b" });
    assert.equal((await pool.getInfo()).interfaces.length, 3);
    assert.equal((await pool.getInterface("org.example.p")).name, "org.example.p");
    assert.equal(await pool.getInterfaceDescription("org.example.p"), IDL);
    assert.equal(f.opened.length, 1);
    assert.equal(pool.size, 1);
    assert.equal(pool.idle, 1);
    await pool.close();
    await f.server.shutdown();
  });

  test("each operation leases exclusively; at max, operations wait FIFO", async () => {
    const f = fixture();
    const pool = createPool(f.factory, { max: 1, idleTimeout: 0 });
    const order: string[] = [];
    const held = pool.call("org.example.p.Hold", {}).then(() => order.push("hold"));
    const w1 = pool.call("org.example.p.Echo", { text: "1" }).then(() => order.push("1"));
    const w2 = pool.call("org.example.p.Echo", { text: "2" }).then(() => order.push("2"));
    await settle();
    assert.equal(await isPending(w1), true);
    assert.equal(f.opened.length, 1);
    f.release();
    await Promise.all([held, w1, w2]);
    assert.deepEqual(order, ["hold", "1", "2"]);
    await pool.close();
    await f.server.shutdown();
  });

  test("waiting respects the operation's signal", async () => {
    const f = fixture();
    const pool = createPool(f.factory, { max: 1, idleTimeout: 0 });
    const held = pool.call("org.example.p.Hold", {});
    const ac = new AbortController();
    const waiting = pool.call("org.example.p.Echo", { text: "x" }, { signal: ac.signal });
    const behind = pool.call("org.example.p.Echo", { text: "y" });
    await settle();
    ac.abort(new Error("gave up"));
    await assert.rejects(waiting, /gave up/);
    f.release();
    await held;
    assert.deepEqual(await behind, { text: "y" });
    await assert.rejects(pool.call("org.example.p.Echo", {}, { signal: AbortSignal.abort("no") }), (e) => e === "no");
    await pool.close();
    await f.server.shutdown();
  });

  test("a closed connection is dropped and never handed out again (F4)", async () => {
    const f = fixture();
    const pool = createPool(f.factory, { idleTimeout: 0 });
    await pool.call("org.example.p.Echo", { text: "a" });
    const first = f.opened[0];
    assert.ok(first !== undefined);
    await first.close();
    await settle();
    assert.equal(pool.size, 0);
    assert.deepEqual(await pool.call("org.example.p.Echo", { text: "b" }), { text: "b" });
    assert.equal(f.opened.length, 2);
    await pool.close();
    await f.server.shutdown();
  });

  test("a failing factory rejects that operation only", async () => {
    const f = fixture();
    let fail = true;
    const pool = createPool(
      (signal) => {
        if (fail) {
          fail = false;
          return Promise.reject(new Error("ECONNREFUSED"));
        }
        return f.factory(signal);
      },
      { max: 1, idleTimeout: 0 },
    );
    const p1 = pool.call("org.example.p.Echo", { text: "1" });
    const p2 = pool.call("org.example.p.Echo", { text: "2" });
    await assert.rejects(p1, /ECONNREFUSED/);
    assert.deepEqual(await p2, { text: "2" });
    await pool.close();
    await f.server.shutdown();
  });

  test("a synchronously throwing factory rejects the operation", async () => {
    const pool = createPool(() => {
      throw new Error("sync");
    });
    await assert.rejects(pool.call("x.y.Z"), /sync/);
    await pool.close();
  });

  test("idle connections close after idleTimeout; the timer is cleared on lease and close", async () => {
    const timers = trackTimers();
    try {
      const f = fixture();
      const pool = createPool(f.factory, { idleTimeout: 20 });
      await pool.call("org.example.p.Echo", { text: "a" });
      assert.equal(timers.live(), 1);
      await pool.call("org.example.p.Echo", { text: "b" });
      assert.equal(timers.live(), 1);
      await sleep(40);
      assert.equal(f.opened[0]?.isClosed, true);
      assert.equal(pool.size, 0);
      await pool.call("org.example.p.Echo", { text: "c" });
      await pool.close();
      assert.equal(timers.live(), 0);
      await f.server.shutdown();
    } finally {
      timers.restore();
    }
  });

  test("close(): waiters reject, every connection (in-flight too) closes, later operations reject", async () => {
    const f = fixture();
    const pool = createPool(f.factory, { max: 1, idleTimeout: 0 });
    const inflight = pool.call("org.example.p.Hold", {});
    const waiter = pool.call("org.example.p.Echo", { text: "w" });
    await settle();
    await pool.close();
    await assert.rejects(waiter, ConnectionClosedError);
    await assert.rejects(inflight, ConnectionClosedError);
    assert.equal(f.opened[0]?.isClosed, true);
    await assert.rejects(pool.call("org.example.p.Echo", { text: "late" }), ConnectionClosedError);
    await assert.rejects(pool.stream("org.example.p.Count", { n: 1 }).next(), ConnectionClosedError);
    f.release();
    await f.server.shutdown();
  });

  test("a stream holds its lease until the final reply; return() early closes only its connection", async () => {
    const f = fixture();
    const pool = createPool(f.factory, { max: 2, idleTimeout: 0 });
    const st = pool.stream("org.example.p.Count", { n: 3 });
    const got: unknown[] = [];
    for await (const r of st) got.push(r);
    assert.deepEqual(got, [{ i: 0 }, { i: 1 }, { i: 2 }]);
    assert.equal(pool.idle, 1);

    const early = pool.stream("org.example.p.Count", { n: 3 });
    for await (const r of early) {
      assert.deepEqual(r, { i: 0 });
      break;
    }
    await settle();
    assert.equal(f.opened[0]?.isClosed, true);
    assert.deepEqual(await pool.call("org.example.p.Echo", { text: "ok" }), { text: "ok" });
    await pool.close();
    await f.server.shutdown();
  });

  test("the factory signal aborts when the waiting operation gives up", async () => {
    let seen: AbortSignal | undefined;
    let resolveConn: (c: Connection) => void = () => undefined;
    const pool = createPool(
      (signal) =>
        new Promise<Connection>((resolve) => {
          seen = signal;
          resolveConn = resolve;
        }),
    );
    const ac = new AbortController();
    const p = pool.call("x.y.Z", {}, { signal: ac.signal });
    await settle();
    ac.abort("stop");
    await assert.rejects(p, (e) => e === "stop");
    assert.equal(seen?.aborted, true);
    // A connection that arrives anyway goes idle, not wasted.
    const [a] = pair();
    resolveConn(createConnection(a));
    await settle();
    assert.equal(pool.idle, 1);
    await pool.close();
  });

  test("waiting for a lease is bounded by the operation's timeout, else the pool's", async () => {
    const f = fixture();
    const pool = createPool(f.factory, { max: 1, idleTimeout: 0, timeout: 30 });
    const held = pool.call("org.example.p.Hold", {});
    await settle();
    const waitTimeout = (e: unknown): boolean =>
      e instanceof CallTimeoutError && e.message === "timed out waiting for a pool connection";
    await assert.rejects(pool.call("org.example.p.Echo", { text: "x" }, { timeout: 10 }), waitTimeout);
    await assert.rejects(pool.call("org.example.p.Echo", { text: "y" }), waitTimeout);
    const st = pool.stream("org.example.p.Count", { n: 2 }, { timeout: 10 });
    await assert.rejects(st.next(), waitTimeout);
    assert.deepEqual(await st.next(), { value: undefined, done: true });
    // timeout 0: waits as long as it takes; the timed-out waiters are gone, so it is next in line.
    const patient = pool.call("org.example.p.Echo", { text: "z" }, { timeout: 0 });
    f.release();
    await held;
    assert.deepEqual(await patient, { text: "z" });
    assert.equal(f.opened.length, 1);
    await pool.close();
    await f.server.shutdown();
  });

  test("a stream whose lease failed: next() rejects once, then is done", async () => {
    const pool = createPool(() => Promise.reject(new Error("no route")));
    const st = pool.stream("org.example.p.Count", { n: 2 });
    await assert.rejects(st.next(), /no route/);
    assert.deepEqual(await st.next(), { value: undefined, done: true });
    assert.deepEqual(await st.next(), { value: undefined, done: true });
    await pool.close();
    const closed = pool.stream("org.example.p.Count", { n: 2 });
    await assert.rejects(closed.next(), ConnectionClosedError);
    assert.deepEqual(await closed.next(), { value: undefined, done: true });
  });

  test("options are checked", () => {
    assert.throws(() => createPool(() => Promise.reject(new Error()), { max: 0 }), RangeError);
    assert.throws(() => createPool(() => Promise.reject(new Error()), { idleTimeout: -5 }), RangeError);
    assert.throws(() => createPool(() => Promise.reject(new Error()), { timeout: -1 }), RangeError);
    assert.throws(() => createPool(5 as never), TypeError);
  });

  test("operations on a leased connection see the handler context", async () => {
    const server = createServer();
    let more: boolean | undefined;
    server.addInterface(IDL, {
      Count: (_p, ctx: CallContext) => {
        more = ctx.more;
        return { i: 0 };
      },
    });
    const pool = createPool(() => {
      const [a, b] = pair();
      void server.handle(b);
      return Promise.resolve(createConnection(a));
    });
    assert.deepEqual(await pool.collect("org.example.p.Count", { n: 1 }), [{ i: 0 }]);
    assert.equal(more, true);
    await pool.close();
    await server.shutdown();
  });
});
