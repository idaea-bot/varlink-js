// dispatchCall (DESIGN.md §5.4, §4.10): the dispatch table, the streaming handler contract, notify, error
// mapping, reply validation, send failures and aborts.
/* eslint-disable @typescript-eslint/require-await -- streaming handlers are async generators without awaits */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ConnectionClosedError,
  InvalidParameterError,
  MessageTooLargeError,
  PermissionDeniedError,
  ValidationError,
  VarlinkError,
} from "../../../src/core/errors/index.ts";
import {
  dispatchCall,
  encodeCall,
  parseMethodName,
  ServerSession,
  streamOf,
  type CallContext,
  type CallInit,
  type DispatchErrorReason,
  type DispatchOptions,
  type Handler,
  type MethodEntry,
} from "../../../src/core/protocol/index.ts";
import { compileInterfaceText, jsonCodec, type Codec } from "../../../src/core/types/index.ts";
import { concat, frame, messages, msg, serve, tableOf, type Served } from "./helpers.ts";

const IDL = `interface org.example.ftl

type Drive (name: string, size: int)

method Ping(ping: string) -> (pong: string)

# [Requires 'more' flag]
method Monitor() -> (n: ?int)

# [Supports 'more' flag]
method List() -> (name: ?string, size: ?int)

method Plain() -> (n: ?int)

# [Supports 'upgrade' flag]
method Up() -> (ok: bool)

# [Requires 'upgrade' flag]
method MustUp() -> ()

method NoHandler() -> ()

method Nested(drive: Drive) -> ()

method Untyped(o: object) -> (o: object)

error Broken (reason: string)
`;
const FTL = compileInterfaceText(IDL);
const I = "org.example.ftl";

interface Reported {
  reason: DispatchErrorReason;
  error: unknown;
  method: string;
}

/** Runs one call against FTL with `handlers` (short names); returns the replies and onError reports. */
async function run(
  handlers: Record<string, Handler<never>>,
  call: CallInit,
  options: DispatchOptions & { extra?: Record<string, MethodEntry>; session?: ServerSession; eof?: boolean } = {},
): Promise<Served & { reported: Reported[] }> {
  const reported: Reported[] = [];
  const full: Record<string, Handler<never>> = {};
  for (const [k, h] of Object.entries(handlers)) full[`${I}.${k}`] = h;
  const table = tableOf([FTL], full, options.extra);
  const served = await serve(frame(encodeCall(call, jsonCodec)), table, {
    ...options,
    onError: (error, info) => {
      reported.push({ error, ...info });
      options.onError?.(error, info);
    },
  });
  return { ...served, reported };
}

const internal = { error: "io.github.pzmarzly.varlinkjs.InternalError", parameters: {} };

function reasons(r: { reported: Reported[] }): DispatchErrorReason[] {
  return r.reported.map((x) => x.reason);
}

describe("parseMethodName", () => {
  test("splits at the last dot and checks both parts", () => {
    assert.deepEqual(parseMethodName("org.example.ftl.Jump"), { interface: "org.example.ftl", name: "Jump" });
    assert.deepEqual(parseMethodName("a.b.C"), { interface: "a.b", name: "C" });
    for (const bad of [
      "",
      "Jump",
      ".Jump",
      "org.example.ftl.",
      "org.example.ftl.jump",
      "a.Jump",
      "org..x.Jump",
      "org.example.ftl.Ju-mp",
      "1a.b.C",
    ])
      assert.equal(parseMethodName(bad), null, bad);
  });
});

describe("dispatch table (§5.4 rows, check order)", () => {
  test("1. method not interface.Method → InvalidParameter {parameter: method}", async () => {
    for (const method of ["Ping", "org.example.ftl.ping", "not a method", ""]) {
      const r = await run({}, { method });
      assert.deepEqual(r.replies, [
        { error: "org.varlink.service.InvalidParameter", parameters: { parameter: "method" } },
      ]);
    }
  });

  test("2. unknown interface → InterfaceNotFound {interface}", async () => {
    const r = await run({}, { method: "com.other.Thing.Do" });
    assert.deepEqual(r.replies, [
      { error: "org.varlink.service.InterfaceNotFound", parameters: { interface: "com.other.Thing" } },
    ]);
  });

  test("2. known interface, unknown method → MethodNotFound {method}", async () => {
    const r = await run({}, { method: `${I}.Nope`, more: true });
    assert.deepEqual(r.replies, [{ error: "org.varlink.service.MethodNotFound", parameters: { method: `${I}.Nope` } }]);
  });

  test("3. requires more, called without → ExpectedMore (before parameter validation)", async () => {
    const r = await run({ Monitor: () => ({}) }, { method: `${I}.Monitor`, parameters: { junk: 1 } });
    assert.deepEqual(r.replies, [{ error: "org.varlink.service.ExpectedMore", parameters: {} }]);
  });

  test("4. requires upgrade, called without → ExpectedUpgrade", async () => {
    const r = await run({ MustUp: () => ({}) }, { method: `${I}.MustUp`, more: true });
    assert.deepEqual(r.replies, [{ error: "org.varlink.service.ExpectedUpgrade", parameters: {} }]);
  });

  test("5. upgrade on a method without upgrade support → InvalidParameter {parameter: upgrade} (Q4, provisional)", async () => {
    const r = await run({ Ping: () => ({ pong: "x" }) }, { method: `${I}.Ping`, upgrade: true });
    assert.deepEqual(r.replies, [
      { error: "org.varlink.service.InvalidParameter", parameters: { parameter: "upgrade" } },
    ]);
  });

  test("6. no handler → MethodNotImplemented {method} (before validation)", async () => {
    const r = await run({}, { method: `${I}.NoHandler`, parameters: { junk: 1 } });
    assert.deepEqual(r.replies, [
      { error: "org.varlink.service.MethodNotImplemented", parameters: { method: `${I}.NoHandler` } },
    ]);
  });

  test("7. invalid parameters → InvalidParameter with the dotted path", async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["Ping", {}, "ping"],
      ["Ping", { ping: null }, "ping"],
      ["Ping", { ping: 1 }, "ping"],
      ["Ping", { ping: "x", extra: 1 }, "extra"],
      ["Nested", { drive: { name: "a", size: "big" } }, "drive.size"],
      ["Nested", { drive: { name: "a", size: 2 ** 60 } }, "drive.size"],
    ];
    for (const [m, parameters, parameter] of cases) {
      let called = false;
      const r = await run(
        {
          [m]: () => {
            called = true;
          },
        },
        { method: `${I}.${m}`, parameters },
      );
      assert.deepEqual(r.replies, [{ error: "org.varlink.service.InvalidParameter", parameters: { parameter } }]);
      assert.equal(called, false);
    }
  });

  test("7. a validator throwing something else → InternalError + handler-threw", async () => {
    const boom = new Error("validator bug");
    const r = await run(
      {},
      { method: "com.hand.Made.Do" },
      {
        extra: {
          "com.hand.Made.Do": {
            input: {
              decode: () => {
                throw boom;
              },
              encode: (v) => v,
            },
            handler: () => ({}),
          },
        },
      },
    );
    assert.deepEqual(r.replies, [internal]);
    assert.deepEqual(r.reported, [{ reason: "handler-threw", error: boom, method: "com.hand.Made.Do" }]);
  });

  test("hand-built entries without validators pass parameters through", async () => {
    let seen: unknown;
    const r = await run(
      {},
      { method: "com.hand.Made.Echo", parameters: { anything: [1, { x: 2n ** 64n }] } },
      {
        extra: {
          "com.hand.Made.Echo": {
            handler: (p: Record<string, unknown>) => {
              seen = p;
              return { got: p.anything };
            },
          },
        },
      },
    );
    // Unsafe integers in untyped content arrive as bigint (lossless codec) and go back out exactly.
    assert.deepEqual(seen, { anything: [1, { x: 2n ** 64n }] });
    assert.equal(new TextDecoder().decode(r.output), '{"parameters":{"got":[1,{"x":18446744073709551616}]}}\0');
  });

  test("validated parameters reach the handler, with the call's context", async () => {
    let ctx: CallContext | undefined;
    let params: unknown;
    const r = await run(
      {
        Ping: (p: { ping: string }, c: CallContext) => {
          params = p;
          ctx = c;
          return { pong: p.ping };
        },
      },
      { method: `${I}.Ping`, parameters: { ping: "hi" }, more: true, ext: { "com.example.trace": "t" } },
    );
    assert.deepEqual(params, { ping: "hi" });
    assert.equal(ctx?.method, `${I}.Ping`);
    assert.equal(ctx.more, true);
    assert.equal(ctx.oneway, false);
    assert.equal(ctx.upgrade, false);
    assert.deepEqual(ctx.ext, { "com.example.trace": "t" });
    assert.equal(ctx.signal.aborted, false);
    // Plain handler called with more: a single reply without continues (F6).
    assert.deepEqual(r.replies, [{ parameters: { pong: "hi" } }]);
  });
});

describe("plain handler results (rule 8)", () => {
  test("object, undefined, sync and async", async () => {
    assert.deepEqual((await run({ Plain: () => ({ n: 1 }) }, { method: `${I}.Plain` })).replies, [
      { parameters: { n: 1 } },
    ]);
    assert.deepEqual((await run({ Plain: () => undefined }, { method: `${I}.Plain` })).replies, [{ parameters: {} }]);
    assert.deepEqual(
      (
        await run(
          {
            Plain: async () => {
              await Promise.resolve();
            },
          },
          { method: `${I}.Plain` },
        )
      ).replies,
      [{ parameters: {} }],
    );
    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { n: 2 });
    assert.deepEqual((await run({ Plain: () => nullProto }, { method: `${I}.Plain` })).replies, [
      { parameters: { n: 2 } },
    ]);
  });

  test("anything else → bad-result + InternalError", async () => {
    const bads: unknown[] = [[1], "x", 1, null, new Date(), new Map(), true];
    for (const [i, bad] of bads.entries()) {
      const r = await run({ Plain: () => bad as Record<string, unknown> }, { method: `${I}.Plain` });
      assert.deepEqual(r.replies, [internal], `case ${String(i)}`);
      assert.deepEqual(reasons(r), ["bad-result"]);
    }
  });
});

describe("streaming handler contract", () => {
  test("more: each yield is a continues reply, the return value the final one", async () => {
    const r = await run(
      {
        List: async function* () {
          yield { name: "a" };
          yield { name: "b" };
          return { name: "c" };
        },
      },
      { method: `${I}.List`, more: true },
    );
    assert.deepEqual(r.replies, [
      { parameters: { name: "a" }, continues: true },
      { parameters: { name: "b" }, continues: true },
      { parameters: { name: "c" } },
    ]);
  });

  test("more: returning undefined after yields sends a final {}", async () => {
    const r = await run(
      {
        List: async function* () {
          yield { name: "a" };
        },
      },
      { method: `${I}.List`, more: true },
    );
    assert.deepEqual(r.replies, [{ parameters: { name: "a" }, continues: true }, { parameters: {} }]);
    assert.deepEqual(r.reported, []); // every output field is nullable, so {} validates
  });

  test("without more: the first yield is the single reply and the generator is closed", async () => {
    let finalized = false;
    let pulledSecond = false;
    const r = await run(
      {
        List: async function* () {
          try {
            yield { name: "first" };
            pulledSecond = true;
            yield { name: "second" };
          } finally {
            finalized = true;
          }
        },
      },
      { method: `${I}.List` },
    );
    assert.deepEqual(r.replies, [{ parameters: { name: "first" } }]);
    assert.equal(finalized, true);
    assert.equal(pulledSecond, false);
  });

  test("without more: a return without yield is the single reply", async () => {
    const r = await run(
      {
        // eslint-disable-next-line require-yield
        List: async function* () {
          await Promise.resolve();
          return { name: "only" };
        },
      },
      { method: `${I}.List` },
    );
    assert.deepEqual(r.replies, [{ parameters: { name: "only" } }]);
  });

  test("oneway generator: nothing sent, the generator is closed, the call finishes", async () => {
    let finalized = false;
    const table = tableOf([FTL], {
      [`${I}.List`]: async function* () {
        try {
          yield { name: "x" };
        } finally {
          finalized = true;
        }
      },
    });
    const r = await serve(
      concat([msg({ method: `${I}.List`, oneway: true }), msg({ method: `${I}.Ping`, parameters: { ping: 1 } })]),
      table,
    );
    // The next call is answered with its own reply (Ping has no handler in this table).
    assert.deepEqual(r.replies, [
      { error: "org.varlink.service.MethodNotImplemented", parameters: { method: `${I}.Ping` } },
    ]);
    assert.equal(finalized, true);
  });

  test("the generator throwing after a yield ends the stream with an error reply", async () => {
    const r = await run(
      {
        List: async function* () {
          yield { name: "a" };
          throw new PermissionDeniedError();
        },
      },
      { method: `${I}.List`, more: true },
    );
    assert.deepEqual(r.replies, [
      { parameters: { name: "a" }, continues: true },
      { error: "org.varlink.service.PermissionDenied", parameters: {} },
    ]);
  });

  test("the generator throwing before a yield (no more) → error reply", async () => {
    const r = await run(
      {
        // eslint-disable-next-line require-yield
        List: async function* () {
          await Promise.resolve();
          throw new Error("boom");
        },
      },
      { method: `${I}.List` },
    );
    assert.deepEqual(r.replies, [internal]);
    assert.deepEqual(reasons(r), ["handler-threw"]);
  });

  test("a non-plain yielded value → bad-result, generator closed, InternalError", async () => {
    let finalized = false;
    const r = await run(
      {
        List: async function* () {
          try {
            yield { name: "ok" };
            yield [1] as unknown as Record<string, unknown>;
          } finally {
            finalized = true;
          }
        },
      },
      { method: `${I}.List`, more: true },
    );
    assert.deepEqual(r.replies, [{ parameters: { name: "ok" }, continues: true }, internal]);
    assert.deepEqual(reasons(r), ["bad-result"]);
    assert.equal(finalized, true);
  });

  test("a yielded Proxy whose getPrototypeOf throws → bad-result, generator closed with return(), InternalError", async () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("trap");
        },
      },
    );
    for (const more of [true, false]) {
      let finalized = false;
      const r = await run(
        {
          List: async function* () {
            try {
              yield hostile;
              yield { name: "never" };
            } finally {
              finalized = true;
            }
          },
        },
        { method: `${I}.List`, more },
      );
      assert.deepEqual(r.replies, [internal]);
      assert.deepEqual(reasons(r), ["bad-result"]);
      assert.equal(finalized, true);
    }
  });

  test("a notify() that ends the call while a yield's send is pending: the generator is not resumed", async () => {
    const session = new ServerSession();
    session.receive(msg({ method: `${I}.List`, more: true }));
    const ev = session.nextEvent();
    assert.ok(ev?.type === "call");
    let afterYield = false;
    let finalized = false;
    let rejection: unknown;
    const table = tableOf([FTL], {
      [`${I}.List`]: async function* (_p: unknown, ctx: CallContext) {
        try {
          // Fires while dispatch awaits the send of the first yield.
          setImmediate(() => {
            ctx.notify({ size: "not an int" }).catch((e: unknown) => {
              rejection = e;
            });
          });
          yield { name: "a" };
          afterYield = true;
          yield { name: "b" };
        } finally {
          finalized = true;
        }
      },
    });
    const written: unknown[] = [];
    const reported: DispatchErrorReason[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const done = dispatchCall(
      session,
      ev.id,
      ev.call,
      table,
      async (bytes) => {
        await gate;
        written.push(...messages(bytes));
      },
      { validateReplies: "throw", onError: (_e, info) => reported.push(info.reason) },
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(reported, ["invalid-reply"]); // the notify ran while the first send was pending
    release();
    await done;
    assert.equal(afterYield, false);
    assert.equal(finalized, true);
    assert.ok(rejection instanceof ValidationError);
    assert.deepEqual(written, [{ parameters: { name: "a" }, continues: true }, internal]);
  });

  test("a throwing return() after the single reply → cleanup-threw, the reply is out", async () => {
    const r = await run(
      {
        List: async function* () {
          try {
            yield { name: "a" };
          } finally {
            // eslint-disable-next-line no-unsafe-finally
            throw new Error("cleanup");
          }
        },
      },
      { method: `${I}.List` },
    );
    assert.deepEqual(r.replies, [{ parameters: { name: "a" } }]);
    assert.deepEqual(reasons(r), ["cleanup-threw"]);
  });

  test("hand-written async iterators work too (Proxy-safe detection)", async () => {
    let i = 0;
    const iterator = {
      next: () =>
        Promise.resolve(i < 2 ? { done: false, value: { name: String(i++) } } : { done: true, value: undefined }),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const r = await run({ List: () => iterator }, { method: `${I}.List`, more: true });
    assert.deepEqual(r.replies, [
      { parameters: { name: "0" }, continues: true },
      { parameters: { name: "1" }, continues: true },
      { parameters: {} },
    ]);
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
        getPrototypeOf() {
          throw new Error("trap");
        },
      },
    );
    const p = await run({ Plain: () => hostile }, { method: `${I}.Plain` });
    assert.deepEqual(p.replies, [internal]);
  });

  for (const [name, result] of [
    ["null", null],
    ["5", 5],
  ] as const) {
    test(`an iterator result that is not an object (${name}) → handler-threw, InternalError, return() called`, async () => {
      for (const more of [true, false]) {
        let returned = 0;
        const iterator = {
          next: () => Promise.resolve(result),
          return: () => {
            returned++;
            return Promise.resolve({ done: true, value: undefined });
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
        const r = await run({ List: () => iterator }, { method: `${I}.List`, more });
        assert.deepEqual(r.replies, [internal]);
        assert.deepEqual(reasons(r), ["handler-threw"]);
        assert.ok(r.reported[0]?.error instanceof TypeError);
        assert.equal(returned, 1);
      }
    });
  }

  test("an iterator result whose done getter throws → handler-threw, InternalError, return() called", async () => {
    let returned = 0;
    const boom = new Error("getter");
    const iterator = {
      next: () =>
        Promise.resolve({
          get done(): boolean {
            throw boom;
          },
          value: {},
        }),
      return: () => {
        returned++;
        return Promise.resolve({ done: true, value: undefined });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const r = await run({ List: () => iterator }, { method: `${I}.List`, more: true });
    assert.deepEqual(r.replies, [internal]);
    assert.deepEqual(r.reported, [{ reason: "handler-threw", error: boom, method: `${I}.List` }]);
    assert.equal(returned, 1);
  });

  test("backpressure: the next value is pulled only after send resolved", async () => {
    const session = new ServerSession();
    session.receive(msg({ method: `${I}.List`, more: true }));
    const ev = session.nextEvent();
    assert.ok(ev?.type === "call");
    const log: string[] = [];
    const releases: (() => void)[] = [];
    const table = tableOf([FTL], {
      [`${I}.List`]: async function* () {
        for (let n = 0; n < 2; n++) {
          log.push(`yield ${String(n)}`);
          yield { size: n };
        }
      },
    });
    const done = dispatchCall(session, ev.id, ev.call, table, (bytes) => {
      log.push(`send ${JSON.stringify(messages(bytes)[0])}`);
      return new Promise((resolve) => releases.push(resolve));
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(log, ["yield 0", 'send {"parameters":{"size":0},"continues":true}']);
    releases.shift()?.();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(log.slice(2), ["yield 1", 'send {"parameters":{"size":1},"continues":true}']);
    releases.shift()?.();
    await new Promise((r) => setImmediate(r));
    releases.shift()?.();
    await done;
    assert.equal(log.at(-1), 'send {"parameters":{}}');
  });
});

describe("ctx.notify (rule 15)", () => {
  test("with more: continues replies, serialized, then the return value is final", async () => {
    const r = await run(
      {
        Plain: async (_p: unknown, ctx: CallContext) => {
          await ctx.notify({ n: 1 });
          void ctx.notify({ n: 2 });
          return { n: 3 };
        },
      },
      { method: `${I}.Plain`, more: true },
    );
    assert.deepEqual(r.replies, [
      { parameters: { n: 1 }, continues: true },
      { parameters: { n: 2 }, continues: true },
      { parameters: { n: 3 } },
    ]);
  });

  test("without more: the first notify is the single reply; later values dropped; a later throw only reported", async () => {
    const boom = new Error("after");
    const r = await run(
      {
        Plain: async (_p: unknown, ctx: CallContext) => {
          await ctx.notify({ n: 1 });
          await ctx.notify({ n: 2 });
          throw boom;
        },
      },
      { method: `${I}.Plain` },
    );
    assert.deepEqual(r.replies, [{ parameters: { n: 1 } }]);
    assert.deepEqual(r.reported, [{ reason: "handler-threw", error: boom, method: `${I}.Plain` }]);
    const s = await run(
      {
        Plain: async (_p: unknown, ctx: CallContext) => {
          await ctx.notify({ n: 1 });
          return { n: 9 };
        },
      },
      { method: `${I}.Plain` },
    );
    assert.deepEqual(s.replies, [{ parameters: { n: 1 } }]);
    assert.deepEqual(s.reported, []);
  });

  test("oneway: nothing is sent, resolves (also with an aborted signal); rejects once the session closed under it", async () => {
    let resolved = false;
    const r = await run(
      {
        Plain: async (_p: unknown, ctx: CallContext) => {
          await ctx.notify({ n: 1 });
          resolved = true;
        },
      },
      { method: `${I}.Plain`, oneway: true },
    );
    assert.equal(resolved, true);
    assert.deepEqual(r.replies, []);
    assert.equal(r.output.length, 0);

    // An aborted signal alone (graceful shutdown) is not gone.
    let outcome: unknown = "unset";
    const s = await run(
      {
        Plain: async (_p: unknown, ctx: CallContext) => {
          outcome = await ctx.notify({ n: 1 }).then(
            () => null,
            (e: unknown) => e,
          );
        },
      },
      { method: `${I}.Plain`, oneway: true },
      { signal: AbortSignal.abort("bye") },
    );
    assert.equal(outcome, null);
    assert.equal(s.output.length, 0);
    assert.deepEqual(s.reported, []);

    // The session closed while the oneway call is still active (gone is checked before the oneway shortcut).
    const session = new ServerSession();
    session.receive(msg({ method: `${I}.Plain`, oneway: true }));
    const ev = session.nextEvent();
    assert.ok(ev?.type === "call");
    let release: () => void = () => undefined;
    let rejection: unknown;
    const table = tableOf([FTL], {
      [`${I}.Plain`]: async (_p: unknown, ctx: CallContext) => {
        await new Promise<void>((res) => {
          release = res;
        });
        rejection = await ctx.notify({ n: 1 }).then(
          () => null,
          (e: unknown) => e,
        );
      },
    });
    const sent: Uint8Array[] = [];
    const done = dispatchCall(session, ev.id, ev.call, table, (b) => {
      sent.push(b);
      return Promise.resolve();
    });
    await Promise.resolve();
    session.close();
    release();
    await done;
    assert.ok(rejection instanceof ConnectionClosedError);
    assert.equal(sent.length, 0);
  });

  test("an aborted signal on a live session is not gone: a non-more notify-style reply is still sent", async () => {
    const r = await run(
      {
        Plain: async (_p: unknown, ctx: CallContext) => {
          await ctx.notify({ n: 1 });
        },
      },
      { method: `${I}.Plain` },
      { signal: AbortSignal.abort("shutdown") },
    );
    assert.deepEqual(r.replies, [{ parameters: { n: 1 } }]);
    assert.deepEqual(r.reported, []);
    const m = await run(
      {
        Plain: async (_p: unknown, ctx: CallContext) => {
          await ctx.notify({ n: 1 });
          return { n: 2 };
        },
      },
      { method: `${I}.Plain`, more: true },
      { signal: AbortSignal.abort("shutdown") },
    );
    assert.deepEqual(m.replies, [{ parameters: { n: 1 }, continues: true }, { parameters: { n: 2 } }]);
  });

  test("the driver closes the session without aborting its signal: ctx.signal aborts and notify rejects", async () => {
    const session = new ServerSession();
    session.receive(msg({ method: `${I}.Plain`, more: true }));
    const ev = session.nextEvent();
    assert.ok(ev?.type === "call");
    let release: () => void = () => undefined;
    const rejections: unknown[] = [];
    let signalAborted = false;
    const table = tableOf([FTL], {
      [`${I}.Plain`]: async (_p: unknown, ctx: CallContext) => {
        await new Promise<void>((res) => {
          release = res;
        });
        for (let i = 0; i < 3; i++) {
          await ctx.notify({ n: i }).catch((e: unknown) => {
            rejections.push(e);
          });
        }
        signalAborted = ctx.signal.aborted;
      },
    });
    const sent: Uint8Array[] = [];
    const done = dispatchCall(session, ev.id, ev.call, table, (b) => {
      sent.push(b);
      return Promise.resolve();
    });
    await Promise.resolve();
    session.close();
    release();
    await done;
    assert.equal(rejections.length, 3);
    for (const e of rejections) assert.ok(e instanceof ConnectionClosedError);
    assert.equal(signalAborted, true);
    assert.equal(sent.length, 0);
  });

  test("session.close() under an unanswered call aborts ctx.signal at once (no notify needed)", async () => {
    const session = new ServerSession();
    session.receive(msg({ method: `${I}.Monitor`, more: true }));
    const ev = session.nextEvent();
    assert.ok(ev?.type === "call");
    let saved: CallContext | undefined;
    let returned = false;
    const table = tableOf([FTL], {
      [`${I}.Monitor`]: async function* (_p: unknown, ctx: CallContext) {
        saved = ctx;
        try {
          // Parked until the signal aborts, like `for await (const c of changes({signal: ctx.signal}))`.
          await new Promise<void>((res) => {
            ctx.signal.addEventListener("abort", () => {
              res();
            });
          });
          yield { n: 1 }; // after the close: dropped, the generator is closed
          yield { n: 2 };
        } finally {
          returned = true;
        }
      },
    });
    const sent: Uint8Array[] = [];
    const done = dispatchCall(session, ev.id, ev.call, table, (b) => {
      sent.push(b);
      return Promise.resolve();
    });
    await Promise.resolve();
    assert.ok(saved !== undefined);
    assert.equal(saved.signal.aborted, false);
    session.close();
    assert.equal(saved.signal.aborted, true); // synchronously, via session.closedSignal
    assert.ok(saved.signal.reason instanceof ConnectionClosedError);
    await done;
    assert.equal(returned, true);
    assert.equal(sent.length, 0);
  });

  test("a generator yielding after session.close(): ctx.signal already aborted, the yield is dropped, return() runs", async () => {
    const session = new ServerSession();
    session.receive(msg({ method: `${I}.Monitor`, more: true }));
    const ev = session.nextEvent();
    assert.ok(ev?.type === "call");
    let release: () => void = () => undefined;
    let returned = false;
    let aborted = false;
    const table = tableOf([FTL], {
      [`${I}.Monitor`]: async function* (_p: unknown, ctx: CallContext) {
        try {
          await new Promise<void>((res) => {
            release = res;
          });
          aborted = ctx.signal.aborted;
          yield { n: 1 };
          yield { n: 2 };
        } finally {
          returned = true;
        }
      },
    });
    const sent: Uint8Array[] = [];
    const done = dispatchCall(session, ev.id, ev.call, table, (b) => {
      sent.push(b);
      return Promise.resolve();
    });
    await Promise.resolve();
    session.close();
    release();
    await done;
    assert.equal(aborted, true);
    assert.equal(returned, true);
    assert.equal(sent.length, 0);
  });

  test("oneway: a detached notify after the call ended and the session closed cleanly resolves", async () => {
    const session = new ServerSession();
    session.receive(msg({ method: `${I}.Plain`, oneway: true }));
    session.receiveEnd();
    const ev = session.nextEvent();
    assert.ok(ev?.type === "call");
    let saved: CallContext | undefined;
    const table = tableOf([FTL], {
      [`${I}.Plain`]: (_p: unknown, ctx: CallContext) => {
        saved = ctx;
      },
    });
    await dispatchCall(session, ev.id, ev.call, table, () => Promise.resolve());
    assert.deepEqual(session.nextEvent(), { type: "close" });
    assert.ok(saved !== undefined);
    await saved.notify({ n: 1 }); // resolves
    assert.equal(saved.signal.aborted, false);
  });

  test("after the final reply: resolves without sending, late-notify (also after a clean close or a later abort)", async () => {
    let saved: CallContext | undefined;
    const session = new ServerSession();
    const controller = new AbortController();
    const r = await run(
      {
        Plain: (_p: unknown, ctx: CallContext) => {
          saved = ctx;
          return { n: 1 };
        },
      },
      { method: `${I}.Plain`, more: true },
      { session, eof: false, signal: controller.signal },
    );
    assert.ok(saved !== undefined);
    await saved.notify({ n: 2 });
    assert.deepEqual(r.replies, [{ parameters: { n: 1 } }]);
    assert.deepEqual(reasons(r), ["late-notify"]);
    // A closed session alone (e.g. a clean peer EOF) is not gone: still resolves.
    session.close();
    await saved.notify({ n: 3 });
    assert.deepEqual(reasons(r), ["late-notify", "late-notify"]);
    // The driver's signal is no longer watched after the call ended, so ctx.signal stays as it was: resolves.
    controller.abort("gone");
    await saved.notify({ n: 4 });
    assert.equal(messages(r.output).length, 1);
  });

  test("without more, clean EOF drained while the first notify's send is pending: later notify resolves, cleanup runs", async () => {
    const session = new ServerSession();
    session.receive(msg({ method: `${I}.Plain` }));
    session.receiveEnd();
    const ev = session.nextEvent();
    assert.ok(ev?.type === "call");
    let release: () => void = () => undefined;
    const sent: Uint8Array[] = [];
    let cleanedUp = false;
    const table = tableOf([FTL], {
      [`${I}.Plain`]: async (_p: unknown, ctx: CallContext) => {
        await ctx.notify({ n: 1 });
        await ctx.notify({ n: 2 });
        cleanedUp = true;
        return { n: 3 };
      },
    });
    const reported: DispatchErrorReason[] = [];
    const done = dispatchCall(
      session,
      ev.id,
      ev.call,
      table,
      (bytes) => {
        sent.push(bytes);
        return new Promise<void>((r) => {
          release = r;
        });
      },
      { onError: (_e, info) => reported.push(info.reason) },
    );
    // The first notify produced the final reply; the driver drains the session: a clean EOF close.
    await Promise.resolve();
    assert.deepEqual(session.nextEvent(), { type: "close" });
    assert.equal(session.state, "closed");
    await Promise.resolve();
    assert.equal(sent.length, 1); // the first notify's send is pending
    release();
    await done;
    assert.equal(cleanedUp, true);
    assert.equal(sent.length, 1); // the second notify was dropped: no bytes
    assert.deepEqual(messages(concat(sent)), [{ parameters: { n: 1 } }]);
    assert.deepEqual(reported, []);
  });

  test("a send failure: notify rejects with ConnectionClosedError, so a notify loop ends", async () => {
    const session = new ServerSession();
    session.receive(msg({ method: `${I}.Plain`, more: true }));
    const ev = session.nextEvent();
    assert.ok(ev?.type === "call");
    const broken = new Error("EPIPE");
    let sends = 0;
    let iterations = 0;
    let rejection: unknown;
    const table = tableOf([FTL], {
      [`${I}.Plain`]: async (_p: unknown, ctx: CallContext) => {
        try {
          // Bounded only so that a regression fails instead of hanging the test run.
          for (; iterations < 10_000; iterations++) await ctx.notify({ n: iterations });
        } catch (e) {
          rejection = e;
        }
        return { n: -1 };
      },
    });
    const reported: DispatchErrorReason[] = [];
    await dispatchCall(
      session,
      ev.id,
      ev.call,
      table,
      () => (++sends <= 2 ? Promise.resolve() : Promise.reject(broken)),
      { onError: (_e, info) => reported.push(info.reason) },
    );
    assert.ok(rejection instanceof ConnectionClosedError);
    assert.equal(rejection.cause, broken);
    assert.equal(iterations, 2); // the third notify's own send failed
    assert.equal(sends, 3);
    assert.deepEqual(reported, ["send-failed"]);
    assert.deepEqual(session.nextEvent(), { type: "close" }); // the driver still gets its final event
  });

  test("a notify after the session was closed by the driver rejects; its cause is ctx.signal.reason", async () => {
    const session = new ServerSession();
    session.receive(msg({ method: `${I}.Plain`, more: true }));
    const ev = session.nextEvent();
    assert.ok(ev?.type === "call");
    const controller = new AbortController();
    let release: () => void = () => undefined;
    let rejection: unknown;
    const table = tableOf([FTL], {
      [`${I}.Plain`]: async (_p: unknown, ctx: CallContext) => {
        await new Promise<void>((r) => {
          release = r;
        });
        void ctx.notify({ n: 0 }); // fire and forget: never an unhandled rejection
        rejection = await ctx.notify({ n: 1 }).then(
          () => null,
          (e: unknown) => e,
        );
      },
    });
    const done = dispatchCall(session, ev.id, ev.call, table, () => Promise.resolve(), {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort("shutdown");
    session.close();
    release();
    await done;
    assert.ok(rejection instanceof ConnectionClosedError);
    assert.equal(rejection.cause, "shutdown");
  });

  test("a notify from a reply's toJSON (non-more call): rejected, exactly one final reply on the wire", async () => {
    let inner: unknown;
    const entry: MethodEntry = {
      handler: (_p: unknown, ctx: CallContext) => ({
        v: {
          toJSON() {
            inner = ctx.notify({ inner: true }).then(
              () => null,
              (e: unknown) => e,
            );
            return 1;
          },
        },
      }),
    };
    const r = await run({}, { method: `${I}.Hand` }, { extra: { [`${I}.Hand`]: entry }, eof: false });
    assert.deepEqual(r.replies, [{ parameters: { v: 1 } }]);
    assert.ok((await inner) instanceof TypeError);
    assert.deepEqual(reasons(r), ["invalid-reply"]);
  });

  test('validateReplies "throw": an invalid notify ends the call with InternalError and rejects', async () => {
    let rejection: unknown;
    const r = await run(
      {
        Plain: async (_p: unknown, ctx: CallContext) => {
          try {
            await ctx.notify({ n: "not an int" });
          } catch (e) {
            rejection = e;
          }
          await ctx.notify({ n: 2 });
          return { n: 3 };
        },
      },
      { method: `${I}.Plain`, more: true },
      { validateReplies: "throw" },
    );
    assert.ok(rejection instanceof ValidationError);
    assert.deepEqual(r.replies, [internal]);
    assert.deepEqual(reasons(r), ["invalid-reply"]);
  });

  test('a fire-and-forget notify failing in "throw" mode is never an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      for (const more of [true, false]) {
        const r = await run(
          {
            Plain: (_p: unknown, ctx: CallContext) => {
              void ctx.notify({ n: "not an int" });
              return { n: 1 };
            },
          },
          { method: `${I}.Plain`, more },
          { validateReplies: "throw" },
        );
        assert.deepEqual(r.replies, [internal]);
        assert.deepEqual(reasons(r), ["invalid-reply"]);
      }
      for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});

describe("thrown values (rule 9)", () => {
  test("VarlinkError of a known interface with valid parameters is sent", async () => {
    const r = await run(
      {
        Plain: () => {
          throw new VarlinkError(`${I}.Broken`, { reason: "x" });
        },
      },
      { method: `${I}.Plain` },
    );
    assert.deepEqual(r.replies, [{ error: `${I}.Broken`, parameters: { reason: "x" } }]);
    assert.deepEqual(r.reported, []);
  });

  test("org.varlink.service errors from handlers pass through the same path", async () => {
    const r = await run(
      {
        Plain: () => {
          throw new InvalidParameterError({ parameter: "x.y" });
        },
      },
      { method: `${I}.Plain` },
    );
    assert.deepEqual(r.replies, [{ error: "org.varlink.service.InvalidParameter", parameters: { parameter: "x.y" } }]);
  });

  test("error validator: undefined → sent unchecked; null → InternalError; invalid parameters → InternalError", async () => {
    const unknownIface = await run(
      {
        Plain: () => {
          throw new VarlinkError("com.other.Err", { anything: [1] });
        },
      },
      { method: `${I}.Plain` },
    );
    assert.deepEqual(unknownIface.replies, [{ error: "com.other.Err", parameters: { anything: [1] } }]);

    const undeclared = await run(
      {
        Plain: () => {
          throw new VarlinkError(`${I}.Undeclared`);
        },
      },
      { method: `${I}.Plain` },
    );
    assert.deepEqual(undeclared.replies, [internal]);
    assert.deepEqual(reasons(undeclared), ["invalid-error"]);

    const badParams = await run(
      {
        Plain: () => {
          throw new VarlinkError(`${I}.Broken`, { reason: 1 });
        },
      },
      { method: `${I}.Plain` },
    );
    assert.deepEqual(badParams.replies, [internal]);
    assert.deepEqual(reasons(badParams), ["invalid-error"]);
    assert.ok(badParams.reported[0]?.error instanceof VarlinkError);
  });

  test("an invalid error name → InternalError + invalid-error", async () => {
    for (const name of ["bad", "org.example.lower", ""]) {
      const r = await run(
        {
          Plain: () => {
            throw new VarlinkError(name);
          },
        },
        { method: `${I}.Plain` },
      );
      assert.deepEqual(r.replies, [internal], name);
      assert.deepEqual(reasons(r), ["invalid-error"]);
    }
  });

  test("anything else → InternalError, onError sees the original", async () => {
    const values: unknown[] = ["x", undefined, null, 42, new Error("secret"), new ValidationError(["a"], "type", "d")];
    for (const value of values) {
      const r = await run(
        {
          Plain: () => {
            throw value;
          },
        },
        { method: `${I}.Plain` },
      );
      assert.deepEqual(r.replies, [internal]);
      assert.equal(r.reported.length, 1);
      assert.equal(r.reported[0]?.reason, "handler-threw");
      assert.equal(r.reported[0].error, value);
      assert.ok(!new TextDecoder().decode(r.output).includes("secret"));
    }
  });
});

describe("validateReplies (rule 10)", () => {
  const invalid = { Plain: () => ({ n: "not an int" }) };

  test("off: sent unchanged, nothing reported", async () => {
    const r = await run(invalid, { method: `${I}.Plain` }, { validateReplies: "off" });
    assert.deepEqual(r.replies, [{ parameters: { n: "not an int" } }]);
    assert.deepEqual(r.reported, []);
  });

  test("warn (default): sent unchanged, invalid-reply reported", async () => {
    const r = await run(invalid, { method: `${I}.Plain` });
    assert.deepEqual(r.replies, [{ parameters: { n: "not an int" } }]);
    assert.deepEqual(reasons(r), ["invalid-reply"]);
    assert.ok(r.reported[0]?.error instanceof ValidationError);
  });

  test("warn: a valid value is sent as encoded (absent ≡ null omitted)", async () => {
    const r = await run({ Plain: () => ({ n: null }) }, { method: `${I}.Plain` });
    assert.deepEqual(r.replies, [{ parameters: {} }]);
  });

  test("throw: InternalError instead", async () => {
    const r = await run(invalid, { method: `${I}.Plain` }, { validateReplies: "throw" });
    assert.deepEqual(r.replies, [internal]);
    assert.deepEqual(reasons(r), ["invalid-reply"]);
  });

  test("throw: a generator is stopped with return() before the InternalError", async () => {
    const log: string[] = [];
    const r = await run(
      {
        List: async function* () {
          try {
            yield { name: "ok" };
            yield { name: 1 };
          } finally {
            log.push("finally");
          }
        },
      },
      { method: `${I}.List`, more: true },
      {
        validateReplies: "throw",
        onError: () => {
          log.push("onError");
        },
      },
    );
    assert.deepEqual(r.replies, [{ parameters: { name: "ok" }, continues: true }, internal]);
    assert.deepEqual(log, ["onError", "finally"]);
  });

  test("continues replies and the generator {} default are validated", async () => {
    const r = await run(
      {
        Ping: async function* () {
          yield { pong: 1 };
        },
      },
      { method: `${I}.Ping`, parameters: { ping: "x" }, more: true },
    );
    // Both the yielded value and the final {} (pong is required) are invalid.
    assert.deepEqual(reasons(r), ["invalid-reply", "invalid-reply"]);
  });
});

describe("encode failures (rule 11)", () => {
  test("a reply the codec cannot encode → invalid-reply + InternalError", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const r = await run({ Untyped: () => ({ o: cyclic }) }, { method: `${I}.Untyped`, parameters: { o: {} } });
    assert.deepEqual(r.replies, [internal]);
    assert.deepEqual(reasons(r), ["invalid-reply"]);
  });

  test("an error whose parameters cannot be encoded → InternalError + invalid-error", async () => {
    const r = await run(
      {
        Plain: () => {
          throw new VarlinkError("com.other.Err", { n: Number.NaN });
        },
      },
      { method: `${I}.Plain` },
    );
    assert.deepEqual(r.replies, [internal]);
    assert.deepEqual(reasons(r), ["invalid-error"]);
  });

  test("not even InternalError can be encoded: the session is closed, nothing written, the call ends", async () => {
    const broken = new Error("codec broken");
    const codec: Codec = {
      decode: (text) => jsonCodec.decode(text),
      encode: () => {
        throw broken;
      },
      losslessInts: jsonCodec.losslessInts,
    };
    const session = new ServerSession({ codec });
    let signal: AbortSignal | undefined;
    const r = await run(
      {
        Plain: (_p: unknown, ctx: CallContext) => {
          signal = ctx.signal;
          return { n: 1 };
        },
      },
      { method: `${I}.Plain` },
      { session, eof: false },
    );
    assert.deepEqual(r.replies, []);
    assert.deepEqual(reasons(r), ["invalid-reply", "invalid-reply"]);
    assert.ok(r.reported.every((x) => x.error === broken));
    assert.equal(session.state, "closed");
    assert.deepEqual(r.close, { type: "close" }); // the driver gets a final event instead of hanging
    assert.equal(session.wantsInput, false);
    assert.equal(signal?.aborted, true);
  });
});

describe("onError, send failures, aborts, upgrade, oneway", () => {
  test("an onError that throws never breaks dispatch", async () => {
    const table = tableOf([FTL], {
      [`${I}.Plain`]: () => {
        throw new Error("x");
      },
    });
    const r = await serve(msg({ method: `${I}.Plain` }), table, {
      onError: () => {
        throw new Error("onError bug");
      },
    });
    assert.deepEqual(r.replies, [internal]);
  });

  test("send rejects: ctx.signal aborts, the generator is stopped, send-failed, session closed", async () => {
    const session = new ServerSession();
    session.receive(msg({ method: `${I}.List`, more: true }));
    const ev = session.nextEvent();
    assert.ok(ev?.type === "call");
    let signal: AbortSignal | undefined;
    let finalized = false;
    const reported: DispatchErrorReason[] = [];
    const broken = new Error("EPIPE");
    const table = tableOf([FTL], {
      [`${I}.List`]: async function* (_p: unknown, ctx: CallContext) {
        signal = ctx.signal;
        try {
          for (;;) yield { name: "x" };
        } finally {
          finalized = true;
        }
      },
    });
    await dispatchCall(session, ev.id, ev.call, table, () => Promise.reject(broken), {
      onError: (_e, info) => reported.push(info.reason),
    });
    assert.equal(signal?.aborted, true);
    assert.equal(signal.reason, broken);
    assert.equal(finalized, true);
    assert.deepEqual(reported, ["send-failed"]);
    assert.equal(session.state, "closed");
  });

  test("options.signal abort aborts ctx.signal; replies after the session closed are dropped silently", async () => {
    const session = new ServerSession();
    session.receive(msg({ method: `${I}.Plain` }));
    const ev = session.nextEvent();
    assert.ok(ev?.type === "call");
    const controller = new AbortController();
    const written: Uint8Array[] = [];
    const reported: DispatchErrorReason[] = [];
    let release: () => void = () => undefined;
    const table = tableOf([FTL], {
      [`${I}.Plain`]: async (_p: unknown, ctx: CallContext) => {
        await new Promise<void>((r) => {
          release = r;
        });
        assert.equal(ctx.signal.aborted, true);
        assert.equal(ctx.signal.reason, "bye");
        return { n: 1 };
      },
    });
    const done = dispatchCall(
      session,
      ev.id,
      ev.call,
      table,
      (b) => {
        written.push(b);
        return Promise.resolve();
      },
      { signal: controller.signal, onError: (_e, info) => reported.push(info.reason) },
    );
    await Promise.resolve();
    controller.abort("bye");
    session.close(); // the driver closes the connection
    release();
    await done;
    assert.deepEqual(written, []);
    assert.deepEqual(reported, []);
  });

  test("an already aborted signal aborts ctx.signal before the handler runs; replies still go out", async () => {
    let aborted: boolean | undefined;
    const r = await run(
      {
        Plain: (_p: unknown, ctx: CallContext) => {
          aborted = ctx.signal.aborted;
          return { n: 1 };
        },
      },
      { method: `${I}.Plain` },
      { signal: AbortSignal.abort() },
    );
    assert.equal(aborted, true);
    assert.deepEqual(r.replies, [{ parameters: { n: 1 } }]);
  });

  test("upgrade: a successful reply upgrades the session and reports upgrade-unclaimed", async () => {
    const session = new ServerSession();
    const r = await run({ Up: () => ({ ok: true }) }, { method: `${I}.Up`, upgrade: true }, { session });
    assert.deepEqual(r.replies, [{ parameters: { ok: true } }]);
    assert.equal(session.state, "upgraded");
    assert.deepEqual(reasons(r), ["upgrade-unclaimed"]);
  });

  test("upgrade: an error reply leaves the session open, nothing reported", async () => {
    const session = new ServerSession();
    const r = await run(
      {
        Up: () => {
          throw new PermissionDeniedError();
        },
      },
      { method: `${I}.Up`, upgrade: true },
      { session, eof: false },
    );
    assert.deepEqual(r.replies, [{ error: "org.varlink.service.PermissionDenied", parameters: {} }]);
    assert.equal(session.state, "open");
    assert.deepEqual(r.reported, []);
  });

  test("upgrade: remainder lost to the size limit → no confirmation written, session closed, call finished", async () => {
    const session = new ServerSession({ maxMessageSize: 64 });
    const reported: DispatchErrorReason[] = [];
    let ran = false;
    const table = tableOf([FTL], {
      [`${I}.Up`]: () => {
        ran = true;
        return { ok: true };
      },
    });
    const r = await serve(
      [concat([msg({ method: `${I}.Up`, upgrade: true }), new Uint8Array(100).fill(0x78)]), new Uint8Array(8)],
      table,
      { session, eof: false, onError: (_e, info) => reported.push(info.reason) },
    );
    assert.equal(ran, true);
    assert.equal(r.output.length, 0); // the peer never sees "upgraded"
    assert.deepEqual(reported, []); // no InternalError attempt, no upgrade-unclaimed
    assert.equal(session.state, "closed");
    assert.ok(r.close?.type === "close" && r.close.error instanceof MessageTooLargeError);
  });

  test("upgrade: remainder lost, notify-style confirmation: notify rejects, ctx.signal aborted, nothing written", async () => {
    const session = new ServerSession({ maxMessageSize: 64 });
    let rejection: unknown;
    let aborted = false;
    const table = tableOf([FTL], {
      [`${I}.Up`]: async (_p: unknown, ctx: CallContext) => {
        rejection = await ctx.notify({ ok: true }).then(
          () => null,
          (e: unknown) => e,
        );
        aborted = ctx.signal.aborted;
      },
    });
    const r = await serve(
      [concat([msg({ method: `${I}.Up`, upgrade: true }), new Uint8Array(100).fill(0x78)]), new Uint8Array(8)],
      table,
      { session, eof: false },
    );
    assert.ok(rejection instanceof ConnectionClosedError);
    assert.equal(aborted, true);
    assert.equal(r.output.length, 0);
    assert.ok(r.close?.type === "close" && r.close.error instanceof MessageTooLargeError);
  });

  test("supports-upgrade method called without upgrade runs as a plain call", async () => {
    const r = await run({ Up: () => ({ ok: false }) }, { method: `${I}.Up` });
    assert.deepEqual(r.replies, [{ parameters: { ok: false } }]);
  });

  test("oneway: nothing is ever written; throws are reported; the call finishes", async () => {
    const boom = new Error("oneway bug");
    const table = tableOf([FTL], {
      [`${I}.Plain`]: () => {
        throw boom;
      },
      [`${I}.Ping`]: (p: { ping: string }) => ({ pong: p.ping }),
    });
    const reported: unknown[] = [];
    const r = await serve(
      concat([
        msg({ method: `${I}.Plain`, oneway: true }),
        msg({ method: "com.unknown.X.Y", oneway: true }),
        msg({ method: `${I}.Ping`, oneway: true, parameters: { bad: 1 } }),
        msg({ method: `${I}.Ping`, parameters: { ping: "real" } }),
      ]),
      table,
      { onError: (e) => reported.push(e) },
    );
    assert.deepEqual(r.replies, [{ parameters: { pong: "real" } }]);
    assert.deepEqual(reported, [boom]);
    assert.deepEqual(r.close, { type: "close" });
  });

  test("dispatchCall never rejects, even with a broken table", async () => {
    const table = {
      lookup: () => {
        throw new Error("table bug");
      },
      errorValidator: () => undefined,
    };
    const r = await serve(msg({ method: `${I}.Plain` }), table);
    assert.deepEqual(r.replies, [internal]);
  });
});

describe("streamOf", () => {
  async function drive<T>(
    g: AsyncGenerator<T, T | undefined, undefined>,
  ): Promise<{ yielded: T[]; returned: T | undefined }> {
    const yielded: T[] = [];
    for (;;) {
      const step = await g.next();
      if (step.done === true) return { yielded, returned: step.value };
      yielded.push(step.value);
    }
  }

  test("sync iterable: all but the last are yielded, the last is returned", async () => {
    assert.deepEqual(await drive(streamOf([1, 2, 3])), { yielded: [1, 2], returned: 3 });
    assert.deepEqual(await drive(streamOf([1])), { yielded: [], returned: 1 });
  });

  test("async iterable", async () => {
    async function* source(): AsyncGenerator<string> {
      yield "a";
      await Promise.resolve();
      yield "b";
    }
    assert.deepEqual(await drive(streamOf(source())), { yielded: ["a"], returned: "b" });
  });

  test("empty iterable returns undefined", async () => {
    assert.deepEqual(await drive(streamOf([])), { yielded: [], returned: undefined });
  });

  test("an early return() closes the source", async () => {
    let closed = false;
    function* source(): Generator<number> {
      try {
        for (let i = 0; ; i++) yield i;
      } finally {
        closed = true;
      }
    }
    const g = streamOf(source());
    assert.deepEqual(await g.next(), { done: false, value: 0 });
    await g.return(undefined);
    assert.equal(closed, true);
  });

  test("return yield* streamOf(x) in a handler sends the last item as the final reply", async () => {
    const r = await run(
      {
        List: async function* () {
          return yield* streamOf([{ name: "a" }, { name: "b" }]);
        },
      },
      { method: `${I}.List`, more: true },
    );
    assert.deepEqual(r.replies, [{ parameters: { name: "a" }, continues: true }, { parameters: { name: "b" } }]);
  });
});
