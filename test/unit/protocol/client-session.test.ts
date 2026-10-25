// ClientSession (DESIGN.md §4.5, §4.10): scripted reply sequences, no I/O.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ConnectionClosedError,
  MessageTooLargeError,
  ProtocolError,
  UpgradePendingError,
} from "../../../src/core/errors/index.ts";
import { ClientSession, type ClientEvent } from "../../../src/core/protocol/index.ts";
import { concat, frame, messages, msg, utf8 } from "./helpers.ts";

const M = "org.example.test.Method";

/** Events without `ext` and with errors reduced to class name + message, for compact assertions. */
function brief(events: ClientEvent[]): unknown[] {
  return events.map((e) => {
    if (e.type === "failed") return { type: "failed", id: e.id, error: e.error.constructor.name };
    if (e.type === "closed")
      return e.error === undefined ? { type: "closed" } : { type: "closed", error: e.error.name };
    const rest: Record<string, unknown> = { ...e };
    delete rest.ext;
    return rest;
  });
}

describe("ClientSession calls", () => {
  test("ids are positive and increasing; bytes are the framed call", () => {
    const s = new ClientSession();
    const a = s.call({ method: M, parameters: { x: 1 } });
    const b = s.call({ method: M, oneway: true });
    assert.equal(a.id, 1);
    assert.equal(b.id, 2);
    assert.deepEqual(messages(a.bytes), [{ method: M, parameters: { x: 1 } }]);
    assert.deepEqual(messages(b.bytes), [{ method: M, parameters: {}, oneway: true }]);
    assert.equal(a.bytes.at(-1), 0);
    assert.equal(s.pending, 1); // oneway never counts
  });

  test("pipelining 3 calls: replies matched in order", () => {
    const s = new ClientSession();
    const ids = [1, 2, 3].map((n) => s.call({ method: M, parameters: { n } }).id);
    assert.equal(s.pending, 3);
    const events = s.receive(concat([msg({ parameters: { r: 1 } }), msg({ parameters: { r: 2 } })]));
    assert.deepEqual(brief(events), [
      { type: "reply", id: ids[0], parameters: { r: 1 }, continues: false },
      { type: "reply", id: ids[1], parameters: { r: 2 }, continues: false },
    ]);
    assert.deepEqual(brief(s.receive(msg({ error: "org.example.test.Nope", parameters: { why: "x" } }))), [
      { type: "error", id: ids[2], error: "org.example.test.Nope", parameters: { why: "x" } },
    ]);
    assert.equal(s.pending, 0);
  });

  test("more: continues replies keep the head, the final one pops it", () => {
    const s = new ClientSession();
    const a = s.call({ method: M, more: true }).id;
    const b = s.call({ method: M }).id;
    const events = s.receive(
      concat([
        msg({ parameters: { i: 0 }, continues: true }),
        msg({ parameters: { i: 1 }, continues: true }),
        msg({ parameters: { i: 2 } }),
        msg({ parameters: { b: true } }),
      ]),
    );
    assert.deepEqual(brief(events), [
      { type: "reply", id: a, parameters: { i: 0 }, continues: true },
      { type: "reply", id: a, parameters: { i: 1 }, continues: true },
      { type: "reply", id: a, parameters: { i: 2 }, continues: false },
      { type: "reply", id: b, parameters: { b: true }, continues: false },
    ]);
  });

  test("an error ends a more stream", () => {
    const s = new ClientSession();
    const a = s.call({ method: M, more: true }).id;
    const events = s.receive(concat([msg({ parameters: {}, continues: true }), msg({ error: "a.b.C" })]));
    assert.deepEqual(
      events.map((e) => e.type),
      ["reply", "error"],
    );
    assert.equal(events[1]?.type === "error" ? events[1].id : 0, a);
    assert.equal(s.pending, 0);
  });

  test("oneway interleaved never consumes a reply", () => {
    const s = new ClientSession();
    const a = s.call({ method: M }).id;
    s.call({ method: M, oneway: true });
    const c = s.call({ method: M }).id;
    s.call({ method: M, oneway: true });
    const events = s.receive(concat([msg({ parameters: { r: "a" } }), msg({ parameters: { r: "c" } })]));
    assert.deepEqual(
      events.map((e) => (e.type === "reply" ? [e.id, e.parameters.r] : e.type)),
      [
        [a, "a"],
        [c, "c"],
      ],
    );
  });

  test("ext of replies is reported", () => {
    const s = new ClientSession();
    s.call({ method: M });
    const [e] = s.receive(msg({ parameters: {}, "com.example.x": 1 }));
    assert.deepEqual(e?.type === "reply" ? e.ext : null, { "com.example.x": 1 });
  });
});

describe("ClientSession protocol violations", () => {
  test("a reply without a call closes the session", () => {
    const s = new ClientSession();
    const events = s.receive(msg({ parameters: {} }));
    assert.deepEqual(brief(events), [{ type: "closed", error: "ProtocolError" }]);
    assert.equal(s.state, "closed");
    assert.deepEqual(s.receive(msg({})), []);
    assert.deepEqual(s.receiveEnd(), []);
    assert.deepEqual(s.close(), []);
    assert.throws(() => s.call({ method: M }), ConnectionClosedError);
  });

  test("continues on a non-more call: earlier events first, then failed for every pending call, then closed", () => {
    const s = new ClientSession();
    const a = s.call({ method: M }).id;
    const b = s.call({ method: M }).id;
    const c = s.call({ method: M, more: true }).id;
    const events = s.receive(concat([msg({ parameters: { ok: 1 } }), msg({ parameters: {}, continues: true })]));
    assert.deepEqual(brief(events), [
      { type: "reply", id: a, parameters: { ok: 1 }, continues: false },
      { type: "failed", id: b, error: "ConnectionClosedError" },
      { type: "failed", id: c, error: "ConnectionClosedError" },
      { type: "closed", error: "ProtocolError" },
    ]);
    const failed = events[1];
    assert.ok(failed?.type === "failed");
    assert.ok(failed.error.cause instanceof ProtocolError);
    const closed = events.at(-1);
    assert.ok(closed?.type === "closed");
    assert.equal(failed.error.cause, closed.error);
  });

  test("continues on an upgrade call is a violation", () => {
    const s = new ClientSession();
    s.call({ method: M, upgrade: true });
    assert.deepEqual(brief(s.receive(msg({ continues: true }))).at(-1), { type: "closed", error: "ProtocolError" });
  });

  const malformed: [string, Uint8Array][] = [
    ["invalid JSON", frame("not json")],
    ["null", frame("null")],
    ["array", frame("[]")],
    ["bad header", msg({ parameters: {}, method: M })],
    ["invalid UTF-8", new Uint8Array([0x7b, 0xff, 0x7d, 0])],
    ["continues + error", msg({ continues: true, error: "a.b.C" })],
  ];
  for (const [name, bytes] of malformed) {
    test(`${name} closes the session`, () => {
      const s = new ClientSession();
      const a = s.call({ method: M }).id;
      const events = s.receive(bytes);
      assert.deepEqual(brief(events), [
        { type: "failed", id: a, error: "ConnectionClosedError" },
        { type: "closed", error: "ProtocolError" },
      ]);
    });
  }

  test("a too large reply closes the session with MessageTooLargeError", () => {
    const s = new ClientSession({ maxMessageSize: 16 });
    s.call({ method: M });
    const events = s.receive(utf8("x".repeat(17)));
    const closed = events.at(-1);
    assert.ok(closed?.type === "closed");
    assert.ok(closed.error instanceof MessageTooLargeError);
  });
});

describe("ClientSession upgrade", () => {
  test("calls are refused while an upgrade is pending", () => {
    const s = new ClientSession();
    s.call({ method: M, upgrade: true });
    assert.throws(() => s.call({ method: M }), UpgradePendingError);
    assert.throws(() => s.call({ method: M, oneway: true }), UpgradePendingError);
    assert.equal(s.pending, 1);
  });

  test("an error reply leaves the session open and accepting calls", () => {
    const s = new ClientSession();
    const u = s.call({ method: M, upgrade: true }).id;
    assert.deepEqual(brief(s.receive(msg({ error: "org.varlink.service.ExpectedUpgrade" }))), [
      { type: "error", id: u, error: "org.varlink.service.ExpectedUpgrade", parameters: {} },
    ]);
    assert.equal(s.state, "open");
    assert.equal(s.call({ method: M }).id, u + 1);
  });

  test("success: bytes after the NUL in the same chunk and later chunks are the remainder", () => {
    const s = new ClientSession();
    const a = s.call({ method: M }).id;
    const u = s.call({ method: M, upgrade: true }).id;
    const events = s.receive(
      concat([msg({ parameters: { first: 1 } }), msg({ parameters: { up: true } }), utf8("RAW\0{not json")]),
    );
    assert.deepEqual(brief(events), [
      { type: "reply", id: a, parameters: { first: 1 }, continues: false },
      { type: "upgraded", id: u, parameters: { up: true } },
    ]);
    assert.equal(s.state, "upgraded");
    assert.deepEqual(s.receive(utf8(" more")), []);
    assert.throws(() => s.call({ method: M }), ConnectionClosedError);
    assert.deepEqual(s.takeUpgradeRemainder(), utf8("RAW\0{not json more"));
    assert.throws(() => s.takeUpgradeRemainder(), TypeError);
    assert.deepEqual(s.receiveEnd(), []);
    assert.deepEqual(brief(s.close()), [{ type: "closed" }]);
  });

  test("takeUpgradeRemainder only when upgraded", () => {
    const s = new ClientSession();
    assert.throws(() => s.takeUpgradeRemainder(), TypeError);
    s.call({ method: M, upgrade: true });
    s.receive(msg({}));
    assert.deepEqual(s.takeUpgradeRemainder(), new Uint8Array(0));
  });
});

describe("ClientSession EOF and close", () => {
  test("EOF with pending calls: failed (connection closed by peer), then closed without error", () => {
    const s = new ClientSession();
    const a = s.call({ method: M }).id;
    const b = s.call({ method: M, more: true }).id;
    s.receive(utf8('{"parameters":')); // partial message: discarded, not a protocol error
    const events = s.receiveEnd();
    assert.deepEqual(brief(events), [
      { type: "failed", id: a, error: "ConnectionClosedError" },
      { type: "failed", id: b, error: "ConnectionClosedError" },
      { type: "closed" },
    ]);
    assert.ok(events[0]?.type === "failed");
    assert.equal(events[0].error.message, "connection closed by peer");
    assert.deepEqual(s.receiveEnd(), []);
  });

  test("close is idempotent and carries the reason as cause", () => {
    const s = new ClientSession();
    const a = s.call({ method: M }).id;
    const reason = new Error("bye");
    const events = s.close(reason);
    assert.deepEqual(brief(events), [{ type: "failed", id: a, error: "ConnectionClosedError" }, { type: "closed" }]);
    assert.ok(events[0]?.type === "failed");
    assert.equal(events[0].error.cause, reason);
    assert.deepEqual(s.close(), []);
    assert.equal(s.pending, 0);
  });

  test("call() does not change state when it throws", () => {
    const s = new ClientSession();
    assert.throws(() => s.call({ method: M, parameters: [] as unknown as Record<string, unknown> }), TypeError);
    assert.throws(() => s.call({ method: M, more: true, oneway: true }), TypeError);
    assert.equal(s.pending, 0);
    assert.equal(s.call({ method: M }).id, 1);
  });
});
