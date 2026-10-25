// Shared helpers for the codegen tests: the corpus file list and prettier with the repo's config.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as prettier from "prettier";

/** Repository root (tests run from it). */
export const ROOT: string = resolve(".");

/** `importPath` that makes generated code load the repo's runtime from any directory. */
export const RUNTIME_URL: string = pathToFileURL(join(ROOT, "src/index.ts")).href;

/** A fresh temp directory (an ESM package), removed by the returned cleanup. */
export function tempPackage(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "vjs-codegen-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Writes generated `code` (made with `importPath: RUNTIME_URL`) to a temp module and imports it. */
export async function importGenerated(code: string): Promise<Record<string, unknown>> {
  const { dir, cleanup } = tempPackage();
  try {
    const file = join(dir, "generated.ts");
    writeFileSync(file, code);
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } finally {
    cleanup();
  }
}

/** Every `.varlink` file under test/corpus, sorted, as repo-relative paths. */
export function corpusFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".varlink")) out.push(p);
    }
  };
  walk("test/corpus");
  return out.sort();
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

/** `code` formatted by prettier with the repository's options, as for a `.ts` file. */
export async function prettierFormat(code: string): Promise<string> {
  const config = (await prettier.resolveConfig(join(ROOT, "src/x.ts"))) ?? {};
  return prettier.format(code, { ...config, parser: "typescript" });
}

/** The first differing line of two texts, for assertion messages. */
export function firstDiff(a: string, b: string): string {
  const x = a.split("\n");
  const y = b.split("\n");
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if (x[i] !== y[i])
      return `line ${String(i + 1)}:\n  got:      ${JSON.stringify(x[i])}\n  expected: ${JSON.stringify(y[i])}`;
  return "(equal)";
}
