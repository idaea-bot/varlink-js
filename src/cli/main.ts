#!/usr/bin/env node
// The `varlink-js` bin (DESIGN.md §4.14). It only wires the process; everything else is run() in run.ts.
import { nodeIo } from "./node-io.ts";
import { run } from "./run.ts";

const io = nodeIo();
try {
  process.exitCode = await run(process.argv.slice(2), io);
} finally {
  io.dispose();
}
