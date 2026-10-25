// Regenerates the built-in interfaces (DESIGN.md §4.13, §5.7): interfaces/<name>.varlink → src/interfaces/<name>.ts.
// Run with `npm run gen:interfaces`; test/unit/codegen/builtins.test.ts fails while the committed files are stale.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INTERNAL_ERROR_INTERFACE, ORG_VARLINK_SERVICE } from "../src/core/errors/standard.ts";
import { generate, type GeneratedFile } from "../src/codegen/index.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The built-in interfaces: GetInfo order (org.varlink.service first, the internal-error interface last). */
export const BUILTIN_INTERFACES: readonly string[] = [ORG_VARLINK_SERVICE, INTERNAL_ERROR_INTERFACE];

/** Path of a built-in's `.varlink` source, relative to the repository root. */
export function sourcePath(name: string): string {
  return join("interfaces", `${name}.varlink`);
}

/** Path of a built-in's generated module, relative to the repository root. */
export function outputPath(name: string): string {
  return join("src", "interfaces", `${name}.ts`);
}

/** What the generated module of a built-in must contain (it imports the runtime from ./runtime.ts). */
export function generateBuiltin(name: string, root: string = ROOT): GeneratedFile {
  return generate(readFileSync(join(root, sourcePath(name)), "utf8"), { importPath: "./runtime.ts" });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const name of BUILTIN_INTERFACES) {
    writeFileSync(join(ROOT, outputPath(name)), generateBuiltin(name).code);
    console.log(`wrote ${outputPath(name)}`);
  }
}
