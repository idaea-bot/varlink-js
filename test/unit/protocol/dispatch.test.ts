// dispatchCall (DESIGN.md §5.4, §4.10): the dispatch table, the streaming handler contract, notify, error
// mapping, reply validation, send failures and aborts.
/* eslint-disable @typescript-eslint/require-await -- streaming handlers are async generators without awaits */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  InvalidParameterError,
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
import { compileInterfaceText, jsonCodec } from "../../../src/core/types/index.ts";
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

  test("oneway: a no-op", async () => {
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
  });

  test("after the final reply: resolves without sending, late-notify", async () => {
    let saved: CallContext | undefined;
    const r = await run(
      {
        Plain: (_p: unknown, ctx: CallContext) => {
          saved = ctx;
          return { n: 1 };
        },
      },
      { method: `${I}.Plain`, more: true },
    );
    assert.ok(saved !== undefined);
    await saved.notify({ n: 2 });
    assert.deepEqual(r.replies, [{ parameters: { n: 1 } }]);
    assert.deepEqual(reasons(r), ["late-notify"]);
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

  test("an error whose parameters cannot be encoded → InternalError", async () => {
    const r = await run(
      {
        Plain: () => {
          throw new VarlinkError("com.other.Err", { n: Number.NaN });
        },
      },
      { method: `${I}.Plain` },
    );
    assert.deepEqual(r.replies, [internal]);
    assert.deepEqual(reasons(r), ["invalid-reply"]);
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
