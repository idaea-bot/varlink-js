// Soak run of the server fuzzer (DESIGN.md §7.5, §4.11): `node test/fuzz/soak.ts` runs the fuzz generator against
// one server for VARLINK_SOAK_SECONDS (default 600), printing RSS every 10 s, and exits non-zero on an unhandled
// rejection, an uncaught exception, a hung connection or a server that stops answering. Not part of `npm test`.
import fc from "fast-check";
import { caseArb, fuzzServer, runCase, stillAnswers } from "./generators.ts";

const seconds = Number(process.env.VARLINK_SOAK_SECONDS ?? 600);
const seed = Number(process.env.VARLINK_FC_SEED ?? Date.now());
const problems: unknown[] = [];
process.on("unhandledRejection", (e) => problems.push(e));
process.on("uncaughtException", (e) => problems.push(e));

const mib = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MiB`;
const { server } = fuzzServer();
const start = Date.now();
let lastReport = start;
let cases = 0;
let batch = 0;
console.log(`soak: ${String(seconds)} s, seed ${String(seed)}, rss ${mib(process.memoryUsage().rss)}`);
while (Date.now() - start < seconds * 1000 && problems.length === 0) {
  for (const c of fc.sample(caseArb, { seed: seed + batch, numRuns: 50 })) {
    await runCase(server, c, 5000);
    cases++;
  }
  batch++;
  if (!(await stillAnswers(server))) problems.push(new Error("the server stopped answering Ping"));
  if (Date.now() - lastReport >= 10_000) {
    lastReport = Date.now();
    const s = Math.round((lastReport - start) / 1000);
    console.log(`soak: ${String(s)} s, ${String(cases)} cases, rss ${mib(process.memoryUsage().rss)}`);
  }
}
await server.shutdown();
if (problems.length > 0) {
  console.error("soak: FAILED", problems);
  process.exitCode = 1;
} else {
  console.log(`soak: OK, ${String(cases)} cases, rss ${mib(process.memoryUsage().rss)}`);
}
