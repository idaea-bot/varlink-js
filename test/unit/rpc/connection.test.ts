// Connection (DESIGN.md §5.1, §4.11) against a scripted raw peer: write path, reader loop, close, timeouts, abort,
// backpressure, validation and error mapping.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import {
  CallTimeoutError,
  ConnectionClosedError,
  createErrorRegistry,
  IntegerRangeError,
  InternalError,
  isVarlinkError,
  MethodNotFoundError,
  ProtocolError,
  ValidationError,
  VarlinkError,
  type InterfaceDescriptor,
  type MethodDescriptor,
} from "../../../src/index.ts";
import { IdlSyntaxError } from "../../../src/idl/index.ts";
import { createConnection } from "../../../src/rpc/index.ts";
import { pair } from "../../../src/testing/index.ts";
import { abortListeners, connectRaw, controllable, frame, isPending, settle, sleep, trackTimers } from "./helpers.ts";

const IDL = `interface org.example.c

method Ping(text: string) -> (text: string)

# [Supports 'more' flag]
method Count(n: int) -> (i: int)

method Big() -> (n: int)

error Oops (code: int)
`;

class OopsError extends VarlinkError<{ code: number }> {
  static readonly errorName: string = "org.example.c.Oops";
  constructor(parameters: { code: number }, options?: ErrorOptions) {
    super(OopsError.errorName, parameters, options);
  }
  static is(e: unknown): e is OopsError {
    return isVarlinkError(e, OopsError.errorName);
  }
}

const Ping: MethodDescriptor<{ text: string }, { text: string }> = {
  interface: "org.example.c",
  name: "Ping",
  method: "org.example.c.Ping",
};
const DESC: InterfaceDescriptor = {
  name: "org.example.c",
  idl: IDL,
  ints: "number",
  methods: {
    Ping,
    Count: { interface: "org.example.c", name: "Count", method: "org.example.c.Count", more: "supports" },
    Big: { interface: "org.example.c", name: "Big", method: "org.example.c.Big" },
  },
  errors: { Oops: OopsError },
};

const quiet = { onError: () => undefined };

describe("Connection: calls and the write path", () => {
  test("call writes a minimal message and resolves with the reply", async () => {
    const { conn, reader, reply } = connectRaw();
    const p = conn.call("org.example.c.Ping", { text: "hi" });
    assert.equal(await reader.nextText(), '{"method":"org.example.c.Ping","parameters":{"text":"hi"}}');
    await reply({ parameters: { text: "hi" } });
    assert.deepEqual(await p, { text: "hi" });
    await conn.close();
  });

  test("pipelined calls are written in call order and matched in order", async () => {
    const { conn, reader, reply } = connectRaw();
    const ps = [1, 2, 3].map((i) => conn.call("org.example.c.Ping", { text: String(i) }));
    for (const i of [1, 2, 3]) assert.deepEqual((await reader.next()).parameters, { text: String(i) });
    for (const i of [1, 2, 3]) await reply({ parameters: { text: `r${String(i)}` } });
    assert.deepEqual(await Promise.all(ps), [{ text: "r1" }, { text: "r2" }, { text: "r3" }]);
    await conn.close();
  });

  test("oneway sets the flag, resolves when written and consumes no reply", async () => {
    const { conn, reader, reply } = connectRaw();
    await conn.oneway("org.example.c.Ping", { text: "x" });
    const p = conn.call("org.example.c.Ping", { text: "y" });
    assert.equal(await reader.nextText(), '{"method":"org.example.c.Ping","parameters":{"text":"x"},"oneway":true}');
    await reader.next();
    await reply({ parameters: { text: "y" } });
    assert.deepEqual(await p, { text: "y" });
    await conn.close();
  });

  test("oneway waits for the write (backpressure)", async () => {
    const { conn, reader } = connectRaw({}, { highWaterMark: 0 });
    const p = conn.oneway("org.example.c.Ping", { text: "x" });
    assert.equal(await isPending(p), true);
    await reader.next();
    await p;
    await conn.close();
  });

  test("an unencodable call rejects with TypeError; the connection is intact", async () => {
    const { conn, reader, reply } = connectRaw();
    await assert.rejects(conn.call("org.example.c.Ping", { n: NaN }), TypeError);
    await assert.rejects(conn.call("org.example.c.Ping", [] as unknown as Record<string, unknown>), TypeError);
    const p = conn.call("org.example.c.Ping", {});
    await reader.next();
    await reply({ parameters: {} });
    assert.deepEqual(await p, {});
    assert.equal(conn.isClosed, false);
    await conn.close();
  });

  test("a write failure closes the connection: every call rejects with ConnectionClosedError(cause)", async () => {
    const [a] = pair();
    const ch = controllable(a);
    const boom = new Error("EPIPE");
    ch.failWrites(boom);
    const conn = createConnection(ch);
    const p1 = conn.call("org.example.c.Ping", {});
    const p2 = conn.call("org.example.c.Ping", {});
    for (const p of [p1, p2])
      await assert.rejects(p, (e: unknown) => e instanceof ConnectionClosedError && e.cause === boom);
    assert.equal(conn.closeReason, boom);
    await conn.closed;
  });
});

describe("Connection: stream and collect", () => {
  test("stream yields every reply including the final one", async () => {
    const { conn, reader, reply } = connectRaw();
    const it = conn.stream("org.example.c.Count", { n: 3 });
    assert.equal(await reader.nextText(), '{"method":"org.example.c.Count","parameters":{"n":3},"more":true}');
    await reply({ parameters: { i: 0 }, continues: true });
    await reply({ parameters: { i: 1 }, continues: true });
    await reply({ parameters: { i: 2 } });
    const got: unknown[] = [];
    for await (const r of it) got.push(r);
    assert.deepEqual(got, [{ i: 0 }, { i: 1 }, { i: 2 }]);
    assert.equal(conn.isClosed, false);
    await conn.close();
  });

  test("an error reply rejects next() after the earlier replies were consumed", async () => {
    const { conn, reader, reply } = connectRaw();
    const it = conn.stream("org.example.c.Count", {});
    await reader.next();
    await reply({ parameters: { i: 0 }, continues: true });
    await reply({ error: "org.example.c.Gone", parameters: {} });
    await settle();
    assert.deepEqual(await it.next(), { value: { i: 0 }, done: false });
    await assert.rejects(it.next(), (e: unknown) => isVarlinkError(e, "org.example.c.Gone"));
    assert.deepEqual(await it.next(), { value: undefined, done: true });
    assert.equal(conn.isClosed, false);
    await conn.close();
  });

  test("breaking out before the final reply closes the connection; after it, return() is a no-op", async () => {
    const { conn, reader, reply } = connectRaw();
    const later = conn.call("org.example.c.Ping", {});
    const it = conn.stream("org.example.c.Count", {});
    await reader.next();
    await reader.next();
    await reply({ parameters: {} });
    await later;
    await reply({ parameters: { i: 0 }, continues: true });
    for await (const r of it) {
      assert.deepEqual(r, { i: 0 });
      break;
    }
    assert.equal(conn.isClosed, true);
    assert.equal(conn.closeReason, undefined);

    const raw2 = connectRaw();
    const it2 = raw2.conn.stream("org.example.c.Count", {});
    await raw2.reader.next();
    await raw2.reply({ parameters: { i: 9 } });
    assert.deepEqual(await it2.next(), { value: { i: 9 }, done: false });
    await it2.return();
    assert.equal(raw2.conn.isClosed, false);
    await raw2.conn.close();
  });

  test("return() on a stream still in the write queue just drops it", async () => {
    const { conn, reader, reply } = connectRaw({}, { highWaterMark: 0 });
    const first = conn.call("org.example.c.Ping", {});
    const it = conn.stream("org.example.c.Count", {});
    await it.return();
    await reader.next();
    await reply({ parameters: {} });
    await first;
    const after = conn.call("org.example.c.Ping", { text: "after" });
    assert.deepEqual((await reader.next()).parameters, { text: "after" });
    await reply({ parameters: {} });
    await after;
    assert.equal(conn.isClosed, false);
    await conn.close();
  });

  test("collect gathers every reply; over max it rejects with RangeError and closes", async () => {
    const { conn, reader, reply } = connectRaw();
    const p = conn.collect("org.example.c.Count", {});
    await reader.next();
    await reply({ parameters: { i: 0 }, continues: true });
    await reply({ parameters: { i: 1 } });
    assert.deepEqual(await p, [{ i: 0 }, { i: 1 }]);

    const exact = conn.collect("org.example.c.Count", {}, { max: 2 });
    await reader.next();
    await reply({ parameters: { i: 0 }, continues: true });
    await reply({ parameters: { i: 1 } });
    assert.equal((await exact).length, 2);

    const over = conn.collect("org.example.c.Count", {}, { max: 2 });
    await reader.next();
    for (let i = 0; i < 3; i++) await reply({ parameters: { i }, continues: true });
    await assert.rejects(over, RangeError);
    assert.equal(conn.isClosed, true);
    assert.ok(conn.closeReason instanceof RangeError);
  });

  test("collect max defaults to 1024", async () => {
    const { conn, reader, peer } = connectRaw();
    const p = conn.collect("org.example.c.Count", {});
    await reader.next();
    const one = frame(JSON.stringify({ parameters: {}, continues: true }));
    const chunk = new Uint8Array(one.length * 1025);
    for (let i = 0; i < 1025; i++) chunk.set(one, i * one.length);
    await peer.write(chunk);
    await assert.rejects(p, /more than 1024 replies/);
  });
});

describe("Connection: close", () => {
  test("close(): pending calls reject, closed resolves, later calls reject at once without writing", async () => {
    const { conn, reader } = connectRaw();
    const reason = new Error("bye");
    const p = conn.call("org.example.c.Ping", {});
    const it = conn.stream("org.example.c.Count", {});
    await reader.next();
    await reader.next();
    await conn.close(reason);
    await assert.rejects(p, (e: unknown) => e instanceof ConnectionClosedError && e.cause === reason);
    await assert.rejects(it.next(), ConnectionClosedError);
    assert.equal(conn.isClosed, true);
    assert.equal(conn.closeReason, reason);
    await conn.closed;
    await conn.close(); // idempotent
    await assert.rejects(conn.call("org.example.c.Ping", {}), ConnectionClosedError);
    await assert.rejects(conn.oneway("org.example.c.Ping", {}), ConnectionClosedError);
    await assert.rejects(conn.stream("org.example.c.Count", {}).next(), ConnectionClosedError);
    assert.deepEqual(await reader.drainToEof(), []);
  });

  test("peer EOF: pending calls reject with ConnectionClosedError, closeReason undefined", async () => {
    const { conn, reader, peer } = connectRaw();
    const p = conn.call("org.example.c.Ping", {});
    await reader.next();
    await peer.end();
    await assert.rejects(p, ConnectionClosedError);
    await conn.closed;
    assert.equal(conn.closeReason, undefined);
  });

  test("peer close (server closes the connection) rejects pending calls (F4)", async () => {
    const { conn, reader, peer } = connectRaw();
    const p = conn.call("org.example.c.Ping", {});
    await reader.next();
    peer.close();
    await assert.rejects(p, ConnectionClosedError);
    await assert.rejects(conn.call("org.example.c.Ping", {}), ConnectionClosedError);
  });

  test("a read() rejection closes with ConnectionClosedError(cause), closeReason = the error", async () => {
    const [a] = pair();
    const ch = controllable(a);
    const conn = createConnection(ch);
    const p = conn.call("org.example.c.Ping", {});
    await settle();
    const rst = new Error("ECONNRESET");
    ch.failRead(rst);
    await assert.rejects(p, (e: unknown) => e instanceof ConnectionClosedError && e.cause === rst);
    assert.equal(conn.closeReason, rst);
    await conn.closed;
  });

  test("a protocol error closes the connection; closeReason is the ProtocolError", async () => {
    const { conn, reader, peer } = connectRaw();
    const p = conn.call("org.example.c.Ping", {});
    await reader.next();
    await peer.write(frame("not json"));
    await assert.rejects(p, (e: unknown) => e instanceof ConnectionClosedError && e.cause instanceof ProtocolError);
    assert.ok(conn.closeReason instanceof ProtocolError);
  });

  test("a reply with no pending call is a protocol error", async () => {
    const { conn, reply } = connectRaw();
    await reply({ parameters: {} });
    await conn.closed;
    assert.ok(conn.closeReason instanceof ProtocolError);
  });
});

describe("Connection: timeouts", () => {
  test("expiry rejects that call with CallTimeoutError and closes; others get ConnectionClosedError(cause)", async () => {
    const { conn, reader } = connectRaw({ timeout: 20 });
    const p1 = conn.call("org.example.c.Ping", {});
    const p2 = conn.call("org.example.c.Ping", {}, { timeout: 0 });
    await reader.next();
    await assert.rejects(p1, CallTimeoutError);
    await assert.rejects(p2, (e: unknown) => e instanceof ConnectionClosedError && e.cause instanceof CallTimeoutError);
    assert.ok(conn.closeReason instanceof CallTimeoutError);
  });

  test("the clock starts at the head of the reply queue, not when enqueued", async () => {
    const { conn, reader, reply } = connectRaw({ timeout: 0 });
    const slow = conn.call("org.example.c.Ping", {});
    const queued = conn.call("org.example.c.Ping", {}, { timeout: 30 });
    await reader.next();
    await reader.next();
    await sleep(50); // longer than queued's timeout, but it is not at the head yet
    await reply({ parameters: { text: "slow" } });
    await reply({ parameters: { text: "queued" } });
    assert.deepEqual(await slow, { text: "slow" });
    assert.deepEqual(await queued, { text: "queued" });
    await conn.close();
  });

  test("stream: timeout only until the first reply, idleTimeout between replies", async () => {
    const { conn, reader, reply } = connectRaw({ timeout: 20 });
    const it = conn.stream("org.example.c.Count", {});
    await reader.next();
    await reply({ parameters: { i: 0 }, continues: true });
    await sleep(40); // past the timeout, but the first reply arrived
    await reply({ parameters: { i: 1 } });
    assert.equal((await it.next()).done, false);
    assert.equal((await it.next()).done, false);

    const idle = conn.stream("org.example.c.Count", {}, { idleTimeout: 20 });
    await reader.next();
    await reply({ parameters: { i: 0 }, continues: true });
    assert.deepEqual(await idle.next(), { value: { i: 0 }, done: false });
    await assert.rejects(idle.next(), CallTimeoutError);
    assert.equal(conn.isClosed, true);
  });

  test("timers and abort listeners are cleared on every settle path", async () => {
    const timers = trackTimers();
    try {
      const ac = new AbortController();
      const { conn, reader, reply } = connectRaw({ timeout: 10_000 });
      const opts = { signal: ac.signal };
      const ok = conn.call("org.example.c.Ping", {}, opts);
      const err = conn.call("org.example.c.Ping", {}, opts);
      const st = conn.stream("org.example.c.Count", {}, { ...opts, idleTimeout: 10_000 });
      const ow = conn.oneway("org.example.c.Ping", {}, opts);
      for (let i = 0; i < 4; i++) await reader.next();
      await ow;
      await reply({ parameters: {} });
      await reply({ error: "org.example.c.Nope", parameters: {} });
      await reply({ parameters: { i: 0 }, continues: true });
      await reply({ parameters: { i: 1 } });
      await ok;
      await assert.rejects(err);
      const streamed: unknown[] = [];
      for await (const x of st) streamed.push(x);
      assert.equal(streamed.length, 2);
      assert.equal(timers.live(), 0);
      assert.equal(abortListeners(ac.signal), 0);
      // Close path.
      const pending = conn.call("org.example.c.Ping", {}, opts);
      await reader.next();
      await conn.close();
      await assert.rejects(pending);
      assert.equal(timers.live(), 0);
      assert.equal(abortListeners(ac.signal), 0);
    } finally {
      timers.restore();
    }
  });

  test("options are checked", () => {
    const [a] = pair();
    assert.throws(() => createConnection(a, { timeout: -1 }), RangeError);
    assert.throws(() => createConnection(a, { highWaterMark: 0 }), RangeError);
    assert.throws(() => createConnection(a, { validateReplies: "x" as "off" }), TypeError);
    assert.throws(() => createConnection(a, { ints: "x" as "number" }), TypeError);
    assert.throws(() => createConnection(a, { maxMessageSize: 0 }), RangeError);
    a.close();
  });
});

describe("Connection: abort", () => {
  test("already aborted: rejects with the reason, nothing is written", async () => {
    const { conn, reader } = connectRaw();
    const reason = new Error("nope");
    await assert.rejects(
      conn.call("org.example.c.Ping", {}, { signal: AbortSignal.abort(reason) }),
      (e) => e === reason,
    );
    await assert.rejects(
      conn.oneway("org.example.c.Ping", {}, { signal: AbortSignal.abort(reason) }),
      (e) => e === reason,
    );
    await conn.close();
    assert.deepEqual(await reader.drainToEof(), []);
  });

  test("aborted while still in the write queue: removed, the connection stays open", async () => {
    const { conn, reader, reply } = connectRaw({}, { highWaterMark: 0 });
    const ac = new AbortController();
    const first = conn.call("org.example.c.Ping", { text: "1" });
    const queued = conn.call("org.example.c.Ping", { text: "2" }, { signal: ac.signal });
    const third = conn.call("org.example.c.Ping", { text: "3" });
    ac.abort("why");
    await assert.rejects(queued, (e) => e === "why");
    assert.deepEqual((await reader.next()).parameters, { text: "1" });
    assert.deepEqual((await reader.next()).parameters, { text: "3" });
    await reply({ parameters: { text: "a" } });
    await reply({ parameters: { text: "b" } });
    assert.deepEqual(await first, { text: "a" });
    assert.deepEqual(await third, { text: "b" });
    assert.equal(conn.isClosed, false);
    await conn.close();
  });

  test("aborted after it was written: rejects with the reason and closes; others get ConnectionClosedError", async () => {
    const { conn, reader } = connectRaw();
    const ac = new AbortController();
    const p = conn.call("org.example.c.Ping", {}, { signal: ac.signal });
    const other = conn.call("org.example.c.Ping", {});
    await reader.next();
    await reader.next();
    const reason = new Error("stop");
    ac.abort(reason);
    await assert.rejects(p, (e) => e === reason);
    await assert.rejects(other, (e: unknown) => e instanceof ConnectionClosedError && e.cause === reason);
    assert.equal(conn.closeReason, reason);
  });

  test("an aborted stream rejects next() with the reason and closes", async () => {
    const { conn, reader, reply } = connectRaw();
    const ac = new AbortController();
    const it = conn.stream("org.example.c.Count", {}, { signal: ac.signal });
    await reader.next();
    await reply({ parameters: { i: 0 }, continues: true });
    assert.equal((await it.next()).done, false);
    ac.abort(new Error("enough"));
    await assert.rejects(it.next(), /enough/);
    assert.equal(conn.isClosed, true);
  });
});

describe("Connection: backpressure", () => {
  test("a full stream buffer stops reading: the server's writes block, and resume when consumed", async () => {
    const { conn, reader, peer } = connectRaw({ highWaterMark: 2 }, { highWaterMark: 0 });
    const it = conn.stream("org.example.c.Count", {});
    await reader.next();
    const one = (i: number): Uint8Array => frame(JSON.stringify({ parameters: { i }, continues: true }));
    // highWaterMark 0: each write resolves once the client read it.
    await peer.write(one(0));
    await peer.write(one(1));
    await settle();
    const blocked = peer.write(one(2));
    assert.equal(await isPending(blocked), true, "the client stopped reading at 2 buffered replies");
    assert.deepEqual(await it.next(), { value: { i: 0 }, done: false });
    await blocked;
    const final = peer.write(frame(JSON.stringify({ parameters: { i: 3 } })));
    assert.equal(await isPending(final), true, "full again at 2");
    const rest: unknown[] = [];
    for await (const r of it) rest.push(r);
    await final;
    assert.deepEqual(rest, [{ i: 1 }, { i: 2 }, { i: 3 }]);
    await conn.close();
  });

  test("the idle timer pauses while the buffer is full", async () => {
    const { conn, reader, reply } = connectRaw({ highWaterMark: 1 });
    const it = conn.stream("org.example.c.Count", {}, { idleTimeout: 20 });
    await reader.next();
    await reply({ parameters: { i: 0 }, continues: true });
    await sleep(40);
    assert.deepEqual(await it.next(), { value: { i: 0 }, done: false });
    assert.equal(conn.isClosed, false);
    await reply({ parameters: { i: 1 } });
    assert.deepEqual(await it.next(), { value: { i: 1 }, done: false });
    await conn.close();
  });
});

describe("Connection: validation of registered interfaces", () => {
  test("parameters are encoded first: a ValidationError rejects before anything is written", async () => {
    const { conn, reader, reply } = connectRaw({ interfaces: [IDL] });
    await assert.rejects(conn.call("org.example.c.Ping", { text: 1 }), ValidationError);
    await assert.rejects(conn.call("org.example.c.Ping", { text: "a", extra: 1 }), ValidationError);
    const p = conn.call("org.example.c.Ping", { text: "ok" });
    assert.deepEqual((await reader.next()).parameters, { text: "ok" });
    await reply({ parameters: { text: "ok" } });
    await p;
    await conn.close();
  });

  test('"off" (default) returns raw parameters, bigints included', async () => {
    const { conn, reader, peer } = connectRaw({ interfaces: [IDL] });
    const p = conn.call("org.example.c.Big", {});
    await reader.next();
    await peer.write(frame('{"parameters":{"n":12345678901234567890,"extra":1}}'));
    assert.deepEqual(await p, { n: 12345678901234567890n, extra: 1 });
    await conn.close();
  });

  test('"warn" decodes (unknown fields dropped); a mismatch delivers the raw value and calls onError', async () => {
    const errors: unknown[] = [];
    const { conn, reader, reply } = connectRaw({
      interfaces: [IDL],
      validateReplies: "warn",
      onError: (e, info) => errors.push([e, info]),
    });
    const p1 = conn.call("org.example.c.Ping", { text: "a" });
    await reader.next();
    await reply({ parameters: { text: "a", extra: 1 } });
    assert.deepEqual(await p1, { text: "a" });
    const p2 = conn.call("org.example.c.Ping", { text: "a" });
    await reader.next();
    await reply({ parameters: { text: 5 } });
    assert.deepEqual(await p2, { text: 5 });
    assert.equal(errors.length, 1);
    const [e, info] = errors[0] as [unknown, unknown];
    assert.ok(e instanceof ValidationError);
    assert.deepEqual(info, { method: "org.example.c.Ping", reason: "invalid-reply" });
    await conn.close();
  });

  test('"throw": a single call rejects (connection intact); a stream with more pending closes', async () => {
    const { conn, reader, reply } = connectRaw({ interfaces: [IDL], validateReplies: "throw" });
    const p = conn.call("org.example.c.Ping", { text: "a" });
    await reader.next();
    await reply({ parameters: {} });
    await assert.rejects(p, ValidationError);
    assert.equal(conn.isClosed, false);
    const it = conn.stream("org.example.c.Count", { n: 1 });
    await reader.next();
    await reply({ parameters: { i: "x" }, continues: true });
    await assert.rejects(it.next(), ValidationError);
    assert.equal(conn.isClosed, true);
    assert.ok(conn.closeReason instanceof ValidationError);
  });

  test("an unsafe int rejects with IntegerRangeError in every mode except off", async () => {
    for (const mode of ["warn", "throw"] as const) {
      const { conn, reader, peer } = connectRaw({ interfaces: [IDL], validateReplies: mode, ...quiet });
      const p = conn.call("org.example.c.Big", {});
      await reader.next();
      await peer.write(frame('{"parameters":{"n":12345678901234567890}}'));
      await assert.rejects(p, IntegerRangeError, mode);
      assert.equal(conn.isClosed, false);
      await conn.close();
    }
  });

  test("unregistered interfaces are not validated", async () => {
    const { conn, reader, reply } = connectRaw({ validateReplies: "throw" });
    const p = conn.call("org.example.c.Ping", { text: 1 });
    assert.deepEqual((await reader.next()).parameters, { text: 1 });
    await reply({ parameters: { anything: true } });
    assert.deepEqual(await p, { anything: true });
    await conn.close();
  });
});

describe("Connection: error replies", () => {
  test("a registered interface's error: validated, mapped to its class", async () => {
    const { conn, reader, reply } = connectRaw({ interfaces: [DESC] });
    const p = conn.call(Ping, { text: "a" });
    await reader.next();
    await reply({ error: "org.example.c.Oops", parameters: { code: 7, extra: 1 } });
    await assert.rejects(
      p,
      (e: unknown) => e instanceof OopsError && e.parameters.code === 7 && !("extra" in e.parameters),
    );
    await conn.close();
  });

  test("invalid parameters or an undeclared error: plain VarlinkError and onError invalid-error", async () => {
    const reported: unknown[] = [];
    const { conn, reader, reply } = connectRaw({ interfaces: [DESC], onError: (_e, info) => reported.push(info) });
    const p1 = conn.call("org.example.c.Ping", { text: "a" });
    const p2 = conn.call("org.example.c.Ping", { text: "a" });
    const p3 = conn.call("org.example.c.Ping", { text: "a" });
    for (let i = 0; i < 3; i++) await reader.next();
    await reply({ error: "org.example.c.Oops", parameters: { code: "seven" } });
    await reply({ error: "org.example.c.Undeclared", parameters: { x: 1 } });
    await reply({ error: "org.varlink.service.MethodNotFound", parameters: {} });
    for (const [p, name, params] of [
      [p1, "org.example.c.Oops", { code: "seven" }],
      [p2, "org.example.c.Undeclared", { x: 1 }],
      [p3, "org.varlink.service.MethodNotFound", {}],
    ] as const) {
      const e = await p.then(
        () => assert.fail("resolved"),
        (x: unknown) => x,
      );
      assert.equal(Object.getPrototypeOf(e), VarlinkError.prototype);
      assert.ok(e instanceof VarlinkError && e.error === name);
      assert.deepEqual(e.parameters, params);
    }
    assert.deepEqual(reported, [
      { method: "org.example.c.Ping", reason: "invalid-error" },
      { method: "org.example.c.Ping", reason: "invalid-error" },
      { method: "org.example.c.Ping", reason: "invalid-error" },
    ]);
    await conn.close();
  });

  test("standard errors map to their classes; unregistered interfaces give a plain VarlinkError", async () => {
    const errors = createErrorRegistry().register(OopsError);
    const { conn, reader, reply } = connectRaw({ errors });
    const p1 = conn.call("x.y.Z", {});
    const p2 = conn.call("x.y.Z", {});
    const p3 = conn.call("x.y.Z", {});
    for (let i = 0; i < 3; i++) await reader.next();
    await reply({ error: "org.varlink.service.MethodNotFound", parameters: { method: "x.y.Z" } });
    await reply({ error: "io.github.pzmarzly.varlinkjs.InternalError", parameters: {} });
    await reply({ error: "org.example.c.Oops", parameters: { code: 1 } });
    await assert.rejects(p1, (e: unknown) => e instanceof MethodNotFoundError && e.parameters.method === "x.y.Z");
    await assert.rejects(p2, (e: unknown) => e instanceof InternalError);
    // org.example.c is not registered on the connection: never the registered subclass.
    await assert.rejects(p3, (e: unknown) => Object.getPrototypeOf(e) === VarlinkError.prototype);
    await conn.close();
  });
});

describe("Connection: interfaces and typed calls", () => {
  test("addInterface: same text is a no-op, a different one a TypeError; descriptor checks", async () => {
    const { conn } = connectRaw();
    conn.addInterface(IDL);
    conn.addInterface(IDL);
    assert.throws(() => {
      conn.addInterface(IDL.replace("Big()", "Bigger()"));
    }, TypeError);
    assert.throws(() => {
      conn.addInterface("interface bad");
    }, IdlSyntaxError);
    assert.throws(() => {
      conn.addInterface({ ...DESC, ints: "bigint" });
    }, TypeError);
    await conn.close();
  });

  test("a typed call needs its interface registered", async () => {
    const { conn, reader, reply } = connectRaw();
    await assert.rejects(conn.call(Ping, { text: "x" }), TypeError);
    conn.addInterface(DESC);
    const p = conn.call(Ping, { text: "x" });
    // The rejected call wrote nothing: this is the first message.
    assert.deepEqual(await reader.next(), { method: "org.example.c.Ping", parameters: { text: "x" } });
    await reply({ parameters: { text: "y" } });
    const out: { text: string } = await p;
    assert.equal(out.text, "y");
    await conn.close();
  });
});

describe("Connection: introspection", () => {
  test("getInterface parses and validates; a different interface name is a TypeError", async () => {
    const { conn, reader, reply } = connectRaw();
    const p1 = conn.getInterface("org.example.c");
    assert.deepEqual((await reader.next()).parameters, { interface: "org.example.c" });
    await reply({ parameters: { description: IDL } });
    assert.equal((await p1).name, "org.example.c");
    const p2 = conn.getInterface("org.example.d");
    await reader.next();
    await reply({ parameters: { description: IDL } });
    await assert.rejects(p2, TypeError);
    const p3 = conn.getInterface("org.example.c");
    await reader.next();
    await reply({ parameters: { description: "interface org.example.c\nmethod X(" } });
    await assert.rejects(p3, IdlSyntaxError);
    const p4 = conn.getInfo();
    await reader.next();
    await reply({ parameters: { vendor: 1 } });
    await assert.rejects(p4, ValidationError);
    await conn.close();
  });
});

describe("Connection: onError default", () => {
  let warn: ReturnType<typeof mock.method>;
  beforeEach(() => {
    warn = mock.method(console, "warn", () => undefined);
  });
  afterEach(() => {
    warn.mock.restore();
  });

  test("one console.warn line naming method and reason, never values", async () => {
    const { conn, reader, reply } = connectRaw({ interfaces: [IDL], validateReplies: "warn" });
    const p = conn.call("org.example.c.Ping", { text: "a" });
    await reader.next();
    await reply({ parameters: { text: "SECRET-VALUE".length } });
    await p;
    assert.equal(warn.mock.callCount(), 1);
    const line = String(warn.mock.calls[0]?.arguments[0]);
    assert.match(line, /invalid-reply/);
    assert.match(line, /org\.example\.c\.Ping/);
    assert.doesNotMatch(line, /\n/);
    await conn.close();
  });
});
