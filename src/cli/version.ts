// The package version, read from package.json at startup. createRequire resolves the same relative path from
// src/cli/ (type stripping) and from dist/cli/ (the published build), and works on Node, Bun and Deno.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** package.json's `version`. */
export const VERSION: string = (require("../../package.json") as { version: string }).version;
