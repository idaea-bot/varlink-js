#!/usr/bin/env node
// `varlink-js` CLI. Placeholder until M7 (DESIGN.md §10): only `--version` works.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
  console.log(version);
} else {
  console.error("varlink-js: the CLI is not implemented yet (rewrite milestone M7).");
  process.exitCode = 2;
}
