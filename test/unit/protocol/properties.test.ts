// Property-based protocol tests (DESIGN.md §7.3): random chunk boundaries and interleavings of pipelined calls,
// more streams, oneway calls and error replies give the same events as unsplit delivery; random framer chunking
// gives the same messages as one push. Seed and run count: VARLINK_FC_SEED / VARLINK_FC_RUNS override.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { Framer } from "../../../src/core/protocol/index.ts";
import { concat, frame, runScript, type Schedule, type Step } from "./helpers.ts";

const SEED = Number(process.env.VARLINK_FC_SEED ?? 20261025);
const RUNS = Number(process.env.VARLINK_FC_RUNS ?? 200);
const params = (numRuns: number): fc.Parameters<unknown> => ({ seed: SEED, numRuns });

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.constant<Step>({ kind: "single" }),
  fc.integer({ min: 0, max: 4 }).map((n): Step => ({ kind: "more", n })),
  fc.constant<Step>({ kind: "oneway" }),
  fc.constant<Step>({ kind: "error" }),
);
const scheduleArb: fc.Arbitrary<Schedule> = fc.array(
  fc.record({ toServer: fc.boolean(), size: fc.integer({ min: 1, max: 48 }) }),
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

describe("protocol properties", () => {
  test("client/server sessions: split and interleaved delivery = unsplit delivery", () => {
    fc.assert(
      fc.property(
        fc.array(stepArb, { maxLength: 12 }),
        scheduleArb,
        fc.integer({ min: 1, max: 4 }),
        (steps, schedule, maxQueuedCalls) => {
          const reference = runScript(steps);
          const split = runScript(steps, schedule, maxQueuedCalls);
          assert.deepEqual(split.clientEvents, reference.clientEvents);
          assert.deepEqual(split.serverEvents, reference.serverEvents);
          // Sanity: every non-oneway call got exactly one final event, then the session closed cleanly.
          const finals = reference.clientEvents.filter(
            (e) => e.type === "error" || (e.type === "reply" && !e.continues),
          );
          assert.equal(finals.length, steps.filter((s) => s.kind !== "oneway").length);
          assert.deepEqual(reference.clientEvents.at(-1), { type: "closed" });
          assert.deepEqual(reference.serverEvents.at(-1), { type: "close" });
        },
      ),
      params(RUNS),
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
