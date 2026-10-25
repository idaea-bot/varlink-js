// ServerSession (DESIGN.md §4.5, §4.10): in-order processing, backpressure, EOF, malformed input, upgrade pause.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MessageTooLargeError, ProtocolError } from "../../../src/core/errors/index.ts";
import { DEFAULT_MAX_QUEUED_CALLS, ServerSession, type ServerEvent } from "../../../src/core/protocol/index.ts";
import { concat, frame, messages, msg, utf8 } from "./helpers.ts";

const M = "org.example.test.Method";

function callOf(ev: ServerEvent | null): { id: number; method: string; parameters: Record<string, unknown> } {
  assert.ok(ev?.type === "call", `expected a call, got ${JSON.stringify(ev)}`);
  return { id: ev.id, method: ev.call.method, parameters: ev.call.parameters };
}

function reply(s: ServerSession, id: number, parameters: Record<string, unknown> = {}): unknown[] {
  const b = s.reply(id, parameters);
  assert.ok(b !== null);
  return messages(b);
}

describe("ServerSession ordering", () => {
  test("calls are handed out one at a time, in order", () => {
    const s = new ServerSession();
    s.receive(concat([1, 2, 3].map((n) => msg({ method: M, parameters: { n } }))));
    const first = callOf(s.nextEvent());
    assert.equal(first.parameters.n, 1);
    assert.equal(s.nextEvent(), null); // call 1 still active
    assert.deepEqual(reply(s, first.id, { r: 1 }), [{ parameters: { r: 1 } }]);
    const second = callOf(s.nextEvent());
    assert.equal(second.parameters.n, 2);
    assert.equal(second.id, first.id + 1);
    assert.deepEqual(messages(s.error(second.id, "a.b.C", { x: 1 }) ?? new Uint8Array(0)), [
      { error: "a.b.C", parameters: { x: 1 } },
    ]);
    const third = callOf(s.nextEvent());
    assert.equal(third.parameters.n, 3);
    reply(s, third.id);
    assert.equal(s.nextEvent(), null);
  });

  test("more: continues replies keep the call active", () => {
    const s = new ServerSession();
    s.receive(concat([msg({ method: M, more: true }), msg({ method: M })]));
    const { id } = callOf(s.nextEvent());
    assert.deepEqual(messages(s.reply(id, { i: 0 }, { continues: true }) ?? new Uint8Array(0)), [
      { parameters: { i: 0 }, continues: true },
    ]);
    assert.equal(s.nextEvent(), null);
    reply(s, id, { i: 1 });
    callOf(s.nextEvent());
  });

  test("continues without more is a TypeError and changes nothing", () => {
    const s = new ServerSession();
    s.receive(msg({ method: M }));
    const { id } = callOf(s.nextEvent());
    assert.throws(() => s.reply(id, {}, { continues: true }), TypeError);
    reply(s, id);
  });

  test("exactly one final reply: a second one, a wrong id or a reply after close are TypeErrors", () => {
    const s = new ServerSession();
    s.receive(concat([msg({ method: M }), msg({ method: M })]));
    const { id } = callOf(s.nextEvent());
    assert.throws(() => s.reply(id + 1, {}), TypeError);
    reply(s, id);
    assert.throws(() => s.reply(id, {}), TypeError);
    assert.throws(() => s.error(id, "a.b.C"), TypeError);
    s.finish(id); // no-op: final reply already produced
    const next = callOf(s.nextEvent());
    s.close();
    assert.throws(() => s.reply(next.id, {}), TypeError);
    s.close();
    assert.deepEqual(s.nextEvent(), { type: "close" }); // the driver's final event
    assert.equal(s.nextEvent(), null);
    s.close();
    assert.equal(s.nextEvent(), null);
    assert.equal(s.state, "closed");
  });

  test("close() after the close event was delivered produces no second one", () => {
    const s = new ServerSession();
    s.receiveEnd();
    assert.deepEqual(s.nextEvent(), { type: "close" });
    s.close();
    assert.equal(s.nextEvent(), null);
  });

  test("close() keeps a pending close event with its error", () => {
    const s = new ServerSession({ maxMessageSize: 64 });
    s.receive(concat([msg({ method: M, upgrade: true }), utf8("x".repeat(100))]));
    s.receive(utf8("dropped"));
    const { id } = callOf(s.nextEvent());
    assert.equal(s.reply(id, {}), null); // the upgrade remainder was lost: closed, error event pending
    s.close();
    const close = s.nextEvent();
    assert.ok(close?.type === "close" && close.error instanceof MessageTooLargeError);
    assert.equal(s.nextEvent(), null);
  });

  test("a re-entrant reply from toJSON during encoding: the outer reply throws and produces nothing", () => {
    const s = new ServerSession();
    s.receive(concat([msg({ method: M }), msg({ method: M })]));
    const { id } = callOf(s.nextEvent());
    const inner: (Uint8Array | null)[] = [];
    const value = {
      toJSON(): number {
        inner.push(s.reply(id, { inner: true }));
        return 1;
      },
    };
    assert.throws(() => s.reply(id, { v: value }), /re-entrant reply/);
    assert.deepEqual(messages(inner[0] ?? new Uint8Array(0)), [{ parameters: { inner: true } }]);
    assert.equal(callOf(s.nextEvent()).id, id + 1); // exactly one final reply ended call 1
  });

  test("a close() from toJSON during encoding: the reply throws and produces nothing", () => {
    const s = new ServerSession();
    s.receive(msg({ method: M }));
    const { id } = callOf(s.nextEvent());
    const value = {
      toJSON(): number {
        s.close();
        return 1;
      },
    };
    assert.throws(() => s.error(id, "a.b.C", { v: value }), /re-entrant reply/);
    assert.deepEqual(s.nextEvent(), { type: "close" });
  });

  test("a re-entrant error reply from a getter during encoding throws too", () => {
    const s = new ServerSession();
    s.receive(msg({ method: M }));
    const { id } = callOf(s.nextEvent());
    const parameters = {
      get v(): number {
        s.error(id, "a.b.Inner");
        return 1;
      },
    };
    assert.throws(() => s.error(id, "a.b.Outer", parameters), /re-entrant reply/);
  });

  test("an encode failure rethrows and keeps the call active", () => {
    const s = new ServerSession();
    s.receive(msg({ method: M }));
    const { id } = callOf(s.nextEvent());
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => s.reply(id, cyclic), TypeError);
    assert.throws(() => s.error(id, "a.b.C", { n: Number.NaN }), TypeError);
    assert.deepEqual(messages(s.error(id, "a.b.C") ?? new Uint8Array(0)), [{ error: "a.b.C", parameters: {} }]);
  });

  test("finish() on a non-oneway call before its final reply is a TypeError", () => {
    const s = new ServerSession();
    s.receive(msg({ method: M }));
    const { id } = callOf(s.nextEvent());
    assert.throws(() => {
      s.finish(id);
    }, TypeError);
    assert.throws(() => {
      s.finish(99);
    }, TypeError);
  });

  test("oneway: replies return null and do not end the call; finish() does", () => {
    const s = new ServerSession();
    s.receive(concat([msg({ method: M, oneway: true }), msg({ method: M })]));
    const { id } = callOf(s.nextEvent());
    assert.equal(s.reply(id, { ignored: true }), null);
    assert.equal(s.error(id, "a.b.C"), null);
    assert.equal(s.nextEvent(), null);
    s.finish(id);
    callOf(s.nextEvent());
  });
});

describe("ServerSession backpressure", () => {
  test("wantsInput is false while maxQueuedCalls complete messages are buffered", () => {
    const s = new ServerSession({ maxQueuedCalls: 2 });
    assert.equal(s.wantsInput, true);
    s.receive(msg({ method: M }));
    assert.equal(s.wantsInput, true);
    s.receive(concat([msg({ method: M }), utf8('{"method":')]));
    assert.equal(s.wantsInput, false);
    const { id } = callOf(s.nextEvent()); // decoding takes one out of the framer
    assert.equal(s.wantsInput, true);
    reply(s, id);
    assert.equal(DEFAULT_MAX_QUEUED_CALLS, 64);
  });

  test("wantsInput also bounds bytes: 64 pipelined ~1 MiB calls never buffer more than 2 MiB + one chunk", () => {
    const max = 1024 * 1024;
    const chunk = 64 * 1024;
    const s = new ServerSession({ maxMessageSize: max });
    const one = msg({ method: M, parameters: { x: "x".repeat(max - 100) } });
    assert.ok(one.length - 1 <= max && one.length > max - 100);
    const stream = concat(Array.from({ length: 64 }, () => one));
    let sent = 0;
    let calls = 0;
    let maxBuffered = 0;
    // A driver: read while wantsInput, else take (and answer) one call.
    while (calls < 64) {
      if (s.wantsInput && sent < stream.length) {
        s.receive(stream.subarray(sent, sent + chunk));
        sent = Math.min(stream.length, sent + chunk);
        const buffered = sent - calls * one.length; // every call taken consumed exactly one message
        maxBuffered = Math.max(maxBuffered, buffered);
        assert.ok(buffered <= 2 * max + chunk, `buffered ${String(buffered)} after ${String(sent)} bytes`);
        continue;
      }
      const { id } = callOf(s.nextEvent());
      reply(s, id);
      calls++;
    }
    assert.equal(sent, stream.length);
    assert.ok(maxBuffered > max); // the bound was actually exercised
  });

  test("wantsInput byte bound: only with a complete message buffered; a lone partial message keeps reading", () => {
    const s = new ServerSession({ maxMessageSize: 100 });
    s.receive(utf8(`{"method":"${M}","parameters":{"x":"${"x".repeat(20)}`));
    assert.equal(s.wantsInput, true);
    s.receive(utf8('"}}\0{"method":'));
    assert.equal(s.wantsInput, true); // one complete message, but buffered < maxMessageSize
    s.receive(utf8(`"${M}","parameters":{"x":"${"y".repeat(30)}`));
    assert.equal(s.wantsInput, false); // a complete message and ≥ maxMessageSize bytes
    reply(s, callOf(s.nextEvent()).id);
    assert.equal(s.wantsInput, true); // only the partial one is left: it needs more bytes
  });

  test("maxQueuedCalls must be a positive integer", () => {
    for (const bad of [0, -1, 1.5]) assert.throws(() => new ServerSession({ maxQueuedCalls: bad }), RangeError);
  });

  test("wantsInput is false after EOF and when closed", () => {
    const s = new ServerSession();
    s.receiveEnd();
    assert.equal(s.wantsInput, false);
    const t = new ServerSession();
    t.close();
    assert.equal(t.wantsInput, false);
  });
});

describe("ServerSession EOF and malformed input", () => {
  test("receiveEnd with queued calls: they are delivered, then close without error", () => {
    const s = new ServerSession();
    s.receive(concat([msg({ method: M, parameters: { n: 1 } }), msg({ method: M, parameters: { n: 2 } }), utf8("{")]));
    s.receiveEnd();
    const a = callOf(s.nextEvent());
    reply(s, a.id);
    const b = callOf(s.nextEvent());
    assert.equal(s.nextEvent(), null);
    reply(s, b.id);
    assert.deepEqual(s.nextEvent(), { type: "close" });
    assert.equal(s.state, "closed");
    assert.equal(s.nextEvent(), null);
  });

  const malformed: [string, Uint8Array][] = [
    ["not json", frame("not json")],
    ["null", frame("null")],
    ["42", frame("42")],
    ["[]", frame("[]")],
    ['"x"', frame('"x"')],
    ["invalid UTF-8", new Uint8Array([0x7b, 0xc0, 0xaf, 0x7d, 0])],
    ["bad header", msg({ method: M, continues: true })],
    ["two flags", msg({ method: M, more: true, oneway: true })],
  ];
  for (const [name, bytes] of malformed) {
    test(`malformed after good calls (${name}): good calls first, then close with ProtocolError`, () => {
      const s = new ServerSession();
      s.receive(concat([msg({ method: M }), bytes, msg({ method: M })]));
      const { id } = callOf(s.nextEvent());
      reply(s, id);
      const close = s.nextEvent();
      assert.ok(close?.type === "close");
      assert.ok(close.error instanceof ProtocolError);
      assert.equal(s.state, "closed");
      assert.equal(s.nextEvent(), null);
      assert.equal(s.wantsInput, false);
    });
  }

  test("a too large call closes with MessageTooLargeError after earlier calls", () => {
    const s = new ServerSession({ maxMessageSize: 40 });
    s.receive(concat([msg({ method: M }), utf8("x".repeat(41))]));
    assert.equal(s.wantsInput, false);
    reply(s, callOf(s.nextEvent()).id);
    const close = s.nextEvent();
    assert.ok(close?.type === "close" && close.error instanceof MessageTooLargeError);
  });
});

describe("ServerSession upgrade", () => {
  test("pause after an upgrade call; an error reply resumes", () => {
    const s = new ServerSession();
    s.receive(concat([msg({ method: M, upgrade: true }), msg({ method: M, parameters: { after: 1 } })]));
    const { id } = callOf(s.nextEvent());
    assert.equal(s.wantsInput, false);
    assert.equal(s.nextEvent(), null);
    s.error(id, "org.varlink.service.MethodNotImplemented", { method: M });
    assert.equal(s.state, "open");
    assert.equal(s.wantsInput, true);
    assert.equal(callOf(s.nextEvent()).parameters.after, 1);
  });

  test("success: everything after the call's NUL is the remainder, never decoded", () => {
    const s = new ServerSession();
    s.receive(concat([msg({ method: M }), msg({ method: M, upgrade: true }), utf8("not json\0[]\0")]));
    reply(s, callOf(s.nextEvent()).id);
    const { id } = callOf(s.nextEvent());
    s.receive(utf8("later"));
    assert.deepEqual(reply(s, id, { ok: true }), [{ parameters: { ok: true } }]);
    assert.equal(s.state, "upgraded");
    assert.equal(s.wantsInput, false);
    assert.equal(s.nextEvent(), null);
    s.receive(utf8("+after"));
    assert.deepEqual(s.takeUpgradeRemainder(), utf8("not json\0[]\0later+after"));
    assert.throws(() => s.reply(id, {}), TypeError);
  });

  test("bytes received after takeUpgradeRemainder accumulate for the next take", () => {
    const s = new ServerSession();
    s.receive(concat([msg({ method: M, upgrade: true }), utf8("one")]));
    reply(s, callOf(s.nextEvent()).id);
    assert.deepEqual(s.takeUpgradeRemainder(), utf8("one"));
    assert.deepEqual(s.takeUpgradeRemainder(), new Uint8Array(0));
    s.receive(utf8("two"));
    s.receive(utf8("+three"));
    assert.deepEqual(s.takeUpgradeRemainder(), utf8("two+three"));
    assert.deepEqual(s.takeUpgradeRemainder(), new Uint8Array(0));
  });

  test("close() while upgraded queues no close event: the driver owns the stream", () => {
    const s = new ServerSession();
    s.receive(msg({ method: M, upgrade: true }));
    reply(s, callOf(s.nextEvent()).id, { ok: true });
    assert.equal(s.state, "upgraded");
    s.close();
    assert.equal(s.state, "closed");
    assert.equal(s.nextEvent(), null);
    assert.equal(s.nextEvent(), null);
  });

  test("takeUpgradeRemainder only when upgraded", () => {
    assert.throws(() => new ServerSession().takeUpgradeRemainder(), TypeError);
  });

  test("upgraded bytes lost to the size limit: no confirmation, the session closes instead of a truncated handover", () => {
    const s = new ServerSession({ maxMessageSize: 64 });
    s.receive(concat([msg({ method: M }), msg({ method: M, upgrade: true }), utf8("x".repeat(100))]));
    s.receive(utf8("dropped"));
    reply(s, callOf(s.nextEvent()).id);
    const { id } = callOf(s.nextEvent());
    assert.equal(s.reply(id, { ok: true }), null); // the peer must not see "upgraded"
    assert.equal(s.state, "closed");
    assert.throws(() => s.takeUpgradeRemainder(), TypeError);
    const close = s.nextEvent();
    assert.ok(close?.type === "close" && close.error instanceof MessageTooLargeError);
  });
});

describe("closedSignal", () => {
  test("aborts when the session becomes closed: local close, EOF, protocol error", () => {
    const a = new ServerSession();
    assert.equal(a.closedSignal.aborted, false);
    a.close();
    assert.equal(a.closedSignal.aborted, true);

    const b = new ServerSession();
    b.receiveEnd();
    assert.equal(b.closedSignal.aborted, false);
    assert.deepEqual(b.nextEvent(), { type: "close" });
    assert.equal(b.closedSignal.aborted, true);

    const c = new ServerSession();
    c.receive(utf8("not json\0"));
    assert.equal(c.nextEvent()?.type, "close");
    assert.equal(c.closedSignal.aborted, true);
  });
  test("closedSignal listeners see a consistent session: the pending close event is already queued", () => {
    const s = new ServerSession();
    s.receive(msg({ method: M }));
    assert.equal(s.nextEvent()?.type, "call");
    let seen: ServerEvent | null | undefined;
    s.closedSignal.addEventListener("abort", () => {
      seen = s.nextEvent();
    });
    s.close();
    assert.deepEqual(seen, { type: "close" });
    assert.equal(s.nextEvent(), null);
  });
});
