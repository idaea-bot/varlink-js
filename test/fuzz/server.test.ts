// Server fuzzing over pair() (DESIGN.md §7.5): random bytes and valid-but-hostile messages. Invariants: no
// unhandled rejection or uncaught exception, every connection replies or closes (per-case deadline), and a fresh
// connection is still answered. Seeded; VARLINK_FC_SEED and VARLINK_FUZZ_RUNS override (default 200 runs).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import fc from "fast-check";
import { caseArb, fuzzServer, runCase, stillAnswers } from "./generators.ts";

const SEED = Number(process.env.VARLINK_FC_SEED ?? 20261025);
const RUNS = Number(process.env.VARLINK_FUZZ_RUNS ?? 200);

describe("fuzz: server over pair()", () => {
  const problems: unknown[] = [];
  const onProblem = (e: unknown): void => {
    problems.push(e);
  };
  before(() => {
    process.on("unhandledRejection", onProblem);
    process.on("uncaughtException", onProblem);
  });
  after(() => {
    process.off("unhandledRejection", onProblem);
    process.off("uncaughtException", onProblem);
  });

  test("hostile input never crashes, hangs or wedges the server", async () => {
    const { server } = fuzzServer();
    await fc.assert(
      fc.asyncProperty(caseArb, async (c) => {
        await runCase(server, c, 2000);
        assert.equal(server.connections, 0);
      }),
      { seed: SEED, numRuns: RUNS },
    );
    // Let late rejections surface before checking.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(problems, []);
    assert.equal(await stillAnswers(server), true);
    await server.shutdown();
  });
});
