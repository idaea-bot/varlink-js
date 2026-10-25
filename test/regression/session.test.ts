// Regression tests for the 0.1.x findings (DESIGN.md §3, §7.2) at the session level: scripted bytes through
// ServerSession + dispatchCall, no I/O. M4 runs the same scenarios end to end over pair() and real sockets.
/* eslint-disable @typescript-eslint/require-await -- streaming handlers are async generators without awaits */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MessageTooLargeError, ProtocolError, VarlinkError } from "../../src/core/errors/index.ts";
import {
  ClientSession,
  dispatchCall,
  ServerSession,
  type CallContext,
  type ClientEvent,
  type DispatchErrorReason,
  type Handler,
} from "../../src/core/protocol/index.ts";
import { compileInterfaceText } from "../../src/core/types/index.ts";
import { concat, frame, msg, serve, tableOf, utf8 } from "../unit/protocol/helpers.ts";

const IDL = `interface org.example.reg

method Echo(text: string) -> (text: string)

method Fail() -> ()

# [Supports 'more' flag]
method Stream() -> (n: ?int)
`;
const REG = compileInterfaceText(IDL);
const I = "org.example.reg";
const INTERNAL = { error: "io.github.pzmarzly.varlinkjs.InternalError", parameters: {} };

const echo = (p: { text: string }): { text: string } => ({ text: p.text });

function table(handlers: Record<string, Handler<never>> = {}): ReturnType<typeof tableOf> {
  const full: Record<string, Handler<never>> = { [`${I}.Echo`]: echo };
  for (const [k, h] of Object.entries(handlers)) full[`${I}.${k}`] = h;
  return tableOf([REG], full);
}

describe("F2 malformed input closes the connection, no crash, no reply", () => {
  const inputs: [string, Uint8Array][] = [
    ["not json", frame("not json")],
    ["null", frame("null")],
    ["42", frame("42")],
    ["[]", frame("[]")],
    ['"x"', frame('"x"')],
    ["invalid UTF-8", new Uint8Array([0x7b, 0xed, 0xa0, 0x80, 0x7d, 0])],
  ];
  for (const [name, bad] of inputs) {
    test(name, async () => {
      const r = await serve(
        concat([msg({ method: `${I}.Echo`, parameters: { text: "before" } }), bad, msg({ method: `${I}.Echo` })]),
        table(),
      );
      // The earlier pipelined call is still answered; nothing for the bad message or anything after it.
      assert.deepEqual(r.replies, [{ parameters: { text: "before" } }]);
      assert.ok(r.close?.type === "close" && r.close.error instanceof ProtocolError);
    });
  }
});

describe("F5 the server never writes anything for a oneway call", () => {
  test("oneway to an unknown method, then a normal call: the reply is the normal call's own", async () => {
    const r = await serve(
      concat([
        msg({ method: "com.unknown.Iface.Method", oneway: true }),
        msg({ method: `${I}.Nope`, oneway: true }),
        msg({ method: `${I}.Echo`, parameters: { text: "mine" } }),
      ]),
      table(),
    );
    assert.deepEqual(r.replies, [{ parameters: { text: "mine" } }]);
  });

  test("oneway whose handler throws, and oneway with invalid parameters: zero bytes", async () => {
    const reported: DispatchErrorReason[] = [];
    const r = await serve(
      concat([
        msg({ method: `${I}.Fail`, oneway: true }),
        msg({ method: `${I}.Echo`, oneway: true, parameters: { text: 1 } }),
        msg({ method: `${I}.Echo`, oneway: true, parameters: { text: "ignored" } }),
      ]),
      table({
        Fail: () => {
          throw new Error("oneway bug");
        },
      }),
      { onError: (_e, info) => reported.push(info.reason) },
    );
    assert.equal(r.output.length, 0);
    assert.deepEqual(reported, ["handler-threw"]);
    assert.equal(r.calls.length, 3);
  });
});

describe("F6 standard errors and flags per the §5.4 table", () => {
  test("MethodNotFound with {method}, InterfaceNotFound with {interface}", async () => {
    const r = await serve(concat([msg({ method: `${I}.Missing` }), msg({ method: "com.other.X.Y" })]), table());
    assert.deepEqual(r.replies, [
      { error: "org.varlink.service.MethodNotFound", parameters: { method: `${I}.Missing` } },
      { error: "org.varlink.service.InterfaceNotFound", parameters: { interface: "com.other.X" } },
    ]);
  });

  test("more on a plain handler → a single reply without continues", async () => {
    const r = await serve(msg({ method: `${I}.Echo`, more: true, parameters: { text: "x" } }), table());
    assert.deepEqual(r.replies, [{ parameters: { text: "x" } }]);
  });

  test("a non-more call to a generator handler → a single reply", async () => {
    const r = await serve(
      msg({ method: `${I}.Stream` }),
      table({
        Stream: async function* () {
          yield { n: 1 };
          yield { n: 2 };
        },
      }),
    );
    assert.deepEqual(r.replies, [{ parameters: { n: 1 } }]);
  });

  test("a generic exception → InternalError without its message", async () => {
    const r = await serve(
      msg({ method: `${I}.Fail` }),
      table({
        Fail: () => {
          throw new Error("secret detail");
        },
      }),
    );
    assert.deepEqual(r.replies, [INTERNAL]);
    assert.ok(!new TextDecoder().decode(r.output).includes("secret"));
  });
});

describe("F7 every non-oneway call ends with exactly one final reply", () => {
  const throwers: [string, Handler<never>, unknown][] = [];
  const add = (name: string, value: unknown, make: (v: unknown) => Handler<never>): void => {
    throwers.push([name, make(value), value]);
  };
  const syncThrow =
    (v: unknown): Handler<never> =>
    () => {
      throw v;
    };
  add('throw "x"', "x", syncThrow);
  add("throw undefined", undefined, syncThrow);
  add("throw null", null, syncThrow);
  add("sync throw of an Error", new Error("sync"), syncThrow);
  const rejection = new Error("async");
  throwers.push(["rejected promise", () => Promise.reject(rejection), rejection]);
  add(
    "generator throwing after a yield",
    new Error("gen"),
    (v) =>
      async function* () {
        yield {};
        throw v;
      },
  );
  for (const [name, handler, value] of throwers) {
    test(name, async () => {
      const seen: unknown[] = [];
      const r = await serve(
        concat([msg({ method: `${I}.Stream` }), msg({ method: `${I}.Echo`, parameters: { text: "next" } })]),
        table({ Stream: handler }),
        { onError: (e) => seen.push(e) },
      );
      if (name.startsWith("generator")) {
        // Without more, the first yield is the single reply and return() closes the generator before its throw.
        assert.deepEqual(r.replies, [{ parameters: {} }, { parameters: { text: "next" } }]);
        assert.deepEqual(seen, []);
      } else {
        assert.deepEqual(r.replies, [INTERNAL, { parameters: { text: "next" } }]);
        assert.deepEqual(seen, [value]);
      }
    });
  }

  test("generator throwing after a yield with more: continues, then one error reply", async () => {
    const r = await serve(
      msg({ method: `${I}.Stream`, more: true }),
      table({
        Stream: async function* () {
          yield { n: 1 };
          throw new VarlinkError("com.other.Gone");
        },
      }),
    );
    assert.deepEqual(r.replies, [
      { parameters: { n: 1 }, continues: true },
      { error: "com.other.Gone", parameters: {} },
    ]);
  });
});

describe("F15 bounded buffer, linear framing", () => {
  test("64 MiB without NUL: memory bounded, session closes with MessageTooLargeError", () => {
    const s = new ServerSession();
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    let fed = 0;
    while (fed < 64 * 1024 * 1024) {
      s.receive(chunk);
      fed += chunk.length;
      if (!s.wantsInput) break; // the driver stops reading once the framer gave up
    }
    assert.ok(fed <= 16 * 1024 * 1024 + chunk.length, `fed ${String(fed)} bytes before backpressure`);
    // Even a driver that ignores wantsInput cannot grow memory: later pushes are dropped.
    for (let i = 0; i < 100; i++) s.receive(chunk);
    const close = s.nextEvent();
    assert.ok(close?.type === "close" && close.error instanceof MessageTooLargeError);
  });

  test("a 4 MiB message in single-byte pushes is framed in linear time", () => {
    const s = new ServerSession();
    const body = utf8(`{"method":"${I}.Echo","parameters":{"text":"`);
    const tail = utf8('"}}\0');
    const size = 4 * 1024 * 1024;
    const started = performance.now();
    const one = new Uint8Array(1);
    for (const b of body) {
      one[0] = b;
      s.receive(one);
    }
    one[0] = 0x61;
    for (let i = body.length + tail.length; i < size; i++) s.receive(one);
    for (const b of tail) {
      one[0] = b;
      s.receive(one);
    }
    const ev = s.nextEvent();
    const elapsed = performance.now() - started;
    assert.ok(ev?.type === "call");
    assert.equal(String(ev.call.parameters.text).length, size - body.length - tail.length);
    assert.ok(elapsed < 5000, `took ${String(Math.round(elapsed))} ms`);
  });
});

describe("F17 no default-valued headers on the wire", () => {
  test("a whole session conversation never writes false flags", async () => {
    const client = new ClientSession();
    const server = new ServerSession();
    const toServer: Uint8Array[] = [];
    const toClient: Uint8Array[] = [];
    toServer.push(client.call({ method: `${I}.Echo`, parameters: { text: "a" }, more: false, oneway: false }).bytes);
    toServer.push(client.call({ method: `${I}.Stream`, more: true }).bytes);
    toServer.push(client.call({ method: `${I}.Stream`, upgrade: false }).bytes);
    toServer.push(client.call({ method: `${I}.Echo`, oneway: true, parameters: { text: "b" } }).bytes);
    toServer.push(client.call({ method: `${I}.Fail` }).bytes);
    const t = table({
      Stream: async function* (_p: unknown, ctx: CallContext) {
        yield { n: 1 };
        await ctx.notify({ n: 2 });
        return { n: 3 };
      },
      Fail: () => {
        throw new VarlinkError("com.other.Nope");
      },
    });
    server.receive(concat(toServer));
    server.receiveEnd();
    for (let ev = server.nextEvent(); ev?.type === "call"; ev = server.nextEvent()) {
      await dispatchCall(server, ev.id, ev.call, t, (b) => {
        toClient.push(b);
        return Promise.resolve();
      });
    }
    const events: ClientEvent[] = client.receive(concat(toClient));
    assert.equal(events.filter((e) => e.type === "error" || (e.type === "reply" && !e.continues)).length, 4);
    const wire = new TextDecoder().decode(concat([...toServer, ...toClient]));
    for (const forbidden of ['"continues":false', '"oneway":false', '"more":false', '"upgrade":false', '"error":null'])
      assert.ok(!wire.includes(forbidden), forbidden);
    assert.ok(wire.includes('"continues":true'));
  });
});
