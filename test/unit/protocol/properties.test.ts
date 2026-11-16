// Property-based protocol tests (DESIGN.md §7.3): random chunk boundaries and interleavings of pipelined calls,
// more streams, oneway calls, error replies and a trailing upgrade give the same events as unsplit delivery, with
// backpressure (wantsInput) honoured and responses deferred; dispatchCall with generator handlers gives the same
// replies under random chunking; random framer chunking gives the same messages as one push. Seed and run count:
// VARLINK_FC_SEED / VARLINK_FC_RUNS override.
/* eslint-disable @typescript-eslint/require-await -- streaming handlers are async generators without awaits */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { VarlinkError } from "../../../src/core/errors/index.ts";
import {
  dispatchCall,
  encodeCall,
  Framer,
  ServerSession,
  type CallContext,
  type DispatchTable,
} from "../../../src/core/protocol/index.ts";
import { compileInterfaceText, jsonCodec } from "../../../src/core/types/index.ts";
import { concat, frame, messages, runScript, tableOf, type Schedule, type Step } from "./helpers.ts";

const SEED = Number(process.env.VARLINK_FC_SEED ?? 20261025);
const RUNS = Number(process.env.VARLINK_FC_RUNS ?? 200);
const params = (numRuns: number): fc.Parameters<unknown> => ({ seed: SEED, numRuns });

/** The server's maxMessageSize in the split script runs. */
const SCRIPT_MAX_MESSAGE_SIZE = 512;
/** Some calls carry a padding parameter of random size, so a few calls reach the byte bound. */
const padded = (arb: fc.Arbitrary<Step>): fc.Arbitrary<Step> =>
  fc
    .tuple(arb, fc.option(fc.integer({ min: 0, max: 200 })))
    .map(([step, pad]): Step => (pad === null ? step : { ...step, pad: "p".repeat(pad) }));
const stepArb: fc.Arbitrary<Step> = padded(
  fc.oneof(
    fc.constant<Step>({ kind: "single" }),
    fc.integer({ min: 0, max: 4 }).map((n): Step => ({ kind: "more", n })),
    fc.constant<Step>({ kind: "oneway" }),
    fc.constant<Step>({ kind: "error" }),
  ),
);
/** Random raw bytes (NULs and invalid UTF-8 included): they must never reach the decoder. */
const upgradeArb: fc.Arbitrary<Step> = padded(
  fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 40 }).map((rest): Step => ({ kind: "upgrade", rest })),
);
/** Steps, optionally ending with an upgrade (only the last call can be one: the client refuses calls after it). */
const stepsArb: fc.Arbitrary<Step[]> = fc
  .tuple(fc.array(stepArb, { maxLength: 12 }), fc.option(upgradeArb))
  .map(([steps, upgrade]) => (upgrade === null ? steps : [...steps, upgrade]));
const scheduleArb: fc.Arbitrary<Schedule> = fc.array(
  fc.record({ toServer: fc.boolean(), size: fc.integer({ min: 1, max: 48 }), defer: fc.integer({ min: 0, max: 3 }) }),
  { minLength: 1, maxLength: 64 },
);

/** Cuts `bytes` at the given offsets (sorted, deduplicated, clamped). */
function cut(bytes: Uint8Array, offsets: readonly number[]): Uint8Array[] {
  const cuts = [...new Set(offsets.map((o) => o % (bytes.length + 1)))].sort((a, b) => a - b);
  const out: Uint8Array[] = [];
  let start = 0;
  for (const c of cuts) {
    out.push(bytes.subarray(start, c));
    start = c;
  }
  out.push(bytes.subarray(start));
  return out;
}

const PROP_IDL = `interface org.example.prop

# [Supports 'more' flag]
method Count(n: int, step: int) -> (i: ?int, step: int)

method Fail(step: int) -> ()

error Failed (step: int)
`;
const PROP = compileInterfaceText(PROP_IDL);

/** Count streams n values from a generator (the step as the final reply); Fail throws Failed. */
const propTable: DispatchTable = tableOf([PROP], {
  "org.example.prop.Count": async function* (p: { n: number; step: number }, ctx: CallContext) {
    for (let i = 0; i < p.n; i++) {
      if (ctx.signal.aborted) return;
      yield { i, step: p.step };
    }
    return { step: p.step };
  },
  "org.example.prop.Fail": (p: { step: number }) => {
    throw new VarlinkError("org.example.prop.Failed", { step: p.step });
  },
});

type PropCall = { kind: "count"; n: number; flag: "none" | "more" | "oneway" } | { kind: "fail" };

const propCallArb: fc.Arbitrary<PropCall> = fc.oneof(
  fc.record({
    kind: fc.constant("count" as const),
    n: fc.integer({ min: 0, max: 3 }),
    flag: fc.constantFrom("none" as const, "more" as const, "oneway" as const),
  }),
  fc.constant<PropCall>({ kind: "fail" }),
);

/**
 * A driver: reads chunks while the session wants input, takes calls one at a time and awaits dispatchCall for
 * each; `sendDelays` (cycled) is how many macrotasks each send takes. Returns the parsed replies.
 */
async function drive(
  chunks: readonly Uint8Array[],
  maxQueuedCalls: number,
  sendDelays: readonly number[],
): Promise<unknown[]> {
  const session = new ServerSession({ maxQueuedCalls });
  const out: Uint8Array[] = [];
  let next = 0;
  let sends = 0;
  for (let guard = 0; ; guard++) {
    if (guard > 10_000) throw new Error("drive: no progress");
    while (next < chunks.length && session.wantsInput) session.receive(chunks[next++] ?? new Uint8Array(0));
    if (next === chunks.length) session.receiveEnd();
    const ev = session.nextEvent();
    if (ev === null) {
      if (next < chunks.length && session.wantsInput) continue;
      throw new Error("drive: the session neither wants input nor has an event");
    }
    if (ev.type === "close") {
      assert.equal(ev.error, undefined);
      break;
    }
    await dispatchCall(session, ev.id, ev.call, propTable, async (bytes) => {
      const delay = sendDelays.length === 0 ? 0 : (sendDelays[sends++ % sendDelays.length] ?? 0);
      for (let i = 0; i < delay; i++) await new Promise((r) => setImmediate(r));
      out.push(bytes);
    });
  }
  return messages(concat(out));
}

describe("protocol properties", () => {
  test("client/server sessions: split, interleaved, backpressured and deferred delivery = unsplit delivery", () => {
    fc.assert(
      fc.property(stepsArb, scheduleArb, fc.integer({ min: 1, max: 4 }), (steps, schedule, maxQueuedCalls) => {
        const reference = runScript(steps);
        // A small maxMessageSize (every call fits: ≤ ~470 bytes) exercises wantsInput's byte bound.
        const split = runScript(steps, schedule, { maxQueuedCalls, maxMessageSize: SCRIPT_MAX_MESSAGE_SIZE });
        assert.deepEqual(split.clientEvents, reference.clientEvents);
        assert.deepEqual(split.serverEvents, reference.serverEvents);
        const last = steps.at(-1);
        if (last?.kind === "upgrade") {
          // The bytes the client sent after the upgrade call are exactly what the server hands over, and the
          // server's raw bytes after its confirmation are exactly what the client hands over.
          const rest = Uint8Array.from(last.rest);
          const reversed = Uint8Array.from(last.rest.toReversed());
          for (const run of [reference, split]) {
            assert.deepEqual(run.serverRemainder, rest);
            assert.deepEqual(run.clientRemainder, reversed);
          }
          assert.equal(reference.clientEvents.at(-1)?.type, "upgraded");
        } else {
          assert.equal(reference.serverRemainder, null);
          assert.equal(reference.clientRemainder, null);
          assert.deepEqual(reference.clientEvents.at(-1), { type: "closed" });
          assert.deepEqual(reference.serverEvents.at(-1), { type: "close" });
        }
        // Sanity: every non-oneway call got exactly one final event.
        const finals = reference.clientEvents.filter(
          (e) => e.type === "error" || e.type === "upgraded" || (e.type === "reply" && !e.continues),
        );
        assert.equal(finals.length, steps.filter((s) => s.kind !== "oneway").length);
      }),
      params(RUNS),
    );
  });

  test("dispatchCall with a table and generator handlers: random chunking and slow sends = unsplit", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(propCallArb, { maxLength: 8 }),
        fc.array(fc.nat(), { maxLength: 12 }),
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.integer({ min: 0, max: 2 }), { maxLength: 4 }),
        async (calls, offsets, maxQueuedCalls, sendDelays) => {
          const stream = concat(
            calls.map((c, step) =>
              frame(
                encodeCall(
                  c.kind === "fail"
                    ? { method: "org.example.prop.Fail", parameters: { step } }
                    : {
                        method: "org.example.prop.Count",
                        parameters: { n: c.n, step },
                        more: c.flag === "more",
                        oneway: c.flag === "oneway",
                      },
                  jsonCodec,
                ),
              ),
            ),
          );
          const reference = await drive([stream], 64, []);
          const split = await drive(cut(stream, offsets), maxQueuedCalls, sendDelays);
          assert.deepEqual(split, reference);
          // The replies the streaming contract (§5.4) prescribes, in call order.
          const expected: unknown[] = [];
          calls.forEach((c, step) => {
            if (c.kind === "fail") {
              expected.push({ error: "org.example.prop.Failed", parameters: { step } });
            } else if (c.flag === "more") {
              for (let i = 0; i < c.n; i++) expected.push({ parameters: { i, step }, continues: true });
              expected.push({ parameters: { step } });
            } else if (c.flag === "none") {
              expected.push({ parameters: c.n > 0 ? { i: 0, step } : { step } });
            }
          });
          assert.deepEqual(reference, expected);
        },
      ),
      params(Math.max(1, Math.floor(RUNS / 4))),
    );
  });

  test("framer: random chunking = one push", () => {
    const textArb = fc.string({ unit: "grapheme", maxLength: 20 }).filter((s) => !s.includes("\0"));
    fc.assert(
      fc.property(fc.array(textArb, { maxLength: 10 }), fc.array(fc.nat(), { maxLength: 20 }), (texts, offsets) => {
        const stream = concat(texts.map(frame));
        const whole = new Framer();
        whole.push(stream);
        const expected: string[] = [];
        for (let m = whole.next(); m !== null; m = whole.next()) expected.push(m);
        assert.deepEqual(expected, texts);
        const framer = new Framer();
        const got: string[] = [];
        for (const piece of cut(stream, offsets)) {
          framer.push(piece);
          for (let m = framer.next(); m !== null; m = framer.next()) got.push(m);
        }
        assert.deepEqual(got, texts);
        assert.equal(framer.buffered, 0);
      }),
      params(RUNS * 2),
    );
  });
});
