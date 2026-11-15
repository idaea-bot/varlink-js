// Every TypeScript block in README.md and docs/*.md (except DESIGN.md) is a verbatim copy of an example file, or of a
// `// #region NAME` … `// #endregion NAME` part of one, named by a `<!-- snippet: PATH[#NAME] -->` line right before
// the block. The only substitution: relative imports of the package's entry points (`../src/index.ts`,
// `../../src/node/index.ts`, …) are shown as the package specifiers users write (`varlink-js`, `varlink-js/node`, …).
// Blocks marked `<!-- snippet: none (0.1.x, not compiled) -->` (old API samples in MIGRATION.md) are exempt.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, test } from "node:test";
import { fences, readRepoFile, ROOT } from "./helpers.ts";

/** The public entry points, by source file. */
const ENTRY_POINTS: Readonly<Record<string, string>> = {
  "src/index.ts": "varlink-js",
  "src/node/index.ts": "varlink-js/node",
  "src/websocket/index.ts": "varlink-js/websocket",
  "src/http/index.ts": "varlink-js/http",
  "src/idl/index.ts": "varlink-js/idl",
  "src/codegen/index.ts": "varlink-js/codegen",
  "src/testing/index.ts": "varlink-js/testing",
};

const EXEMPT = "none (0.1.x, not compiled)";
const CODE_LANGS = new Set(["ts", "typescript", "js", "javascript", "mjs", "tsx"]);

/** The markdown files whose code blocks are checked. */
const DOCS: readonly string[] = [
  "README.md",
  ...readdirSync(join(ROOT, "docs"))
    .filter((f) => f.endsWith(".md") && f !== "DESIGN.md")
    .map((f) => `docs/${f}`),
];

/** `code` of `file` as the docs show it: entry-point imports as package specifiers; deep `src/` imports fail. */
function asShown(file: string, code: string): string {
  return code.replace(/(\bfrom |\bimport\(|^import )"(\.\.?\/[^"]*)"/gm, (whole, keyword: string, spec: string) => {
    const target = relative(ROOT, resolve(dirname(join(ROOT, file)), spec))
      .split("\\")
      .join("/");
    const name = ENTRY_POINTS[target];
    if (name !== undefined) return `${keyword}"${name}"`;
    if (target.startsWith("src/"))
      throw new Error(`${file} imports ${spec}: examples shown in the docs may import only the public entry points`);
    return whole;
  });
}

/** The lines of a region (or the whole file), without region markers, common indentation removed. */
function extract(file: string, region: string | undefined): string {
  const lines = readRepoFile(file).replace(/\n$/, "").split("\n");
  let body = lines;
  if (region !== undefined) {
    const start = lines.findIndex((l) => l.trim() === `// #region ${region}`);
    const end = lines.findIndex((l) => l.trim() === `// #endregion ${region}`);
    if (start < 0 || end < start) throw new Error(`${file}: no region ${region}`);
    body = lines.slice(start + 1, end);
  }
  body = body.filter((l) => !/^\s*\/\/ #(end)?region\b/.test(l));
  const indent = Math.min(...body.filter((l) => l.trim() !== "").map((l) => /^ */.exec(l)?.[0].length ?? 0));
  return body.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
}

for (const doc of DOCS) {
  describe(doc, () => {
    const text = readRepoFile(doc);
    const blocks = fences(text);

    test("every snippet marker is followed by a code block", () => {
      const markers = text.split("\n").filter((l) => l.trim().startsWith("<!-- snippet:")).length;
      assert.equal(blocks.filter((b) => b.snippet !== undefined).length, markers);
      for (const b of blocks)
        if (b.snippet !== undefined)
          assert.ok(CODE_LANGS.has(b.lang), `${doc}:${String(b.line)}: snippet marker on a ${b.lang} block`);
    });

    test("no block shows a relative import of the library's source", () => {
      for (const b of blocks)
        assert.ok(!/["'](\.\.?\/)+src\//.test(b.code), `${doc}:${String(b.line)} shows a ../src import`);
    });

    for (const b of blocks.filter((x) => CODE_LANGS.has(x.lang))) {
      test(`line ${String(b.line)}: ${b.snippet ?? "(no marker)"}`, () => {
        assert.ok(
          b.snippet !== undefined,
          `${doc}:${String(b.line)}: a ${b.lang} block needs a <!-- snippet: examples/FILE[#region] --> line before it`,
        );
        if (b.snippet === EXEMPT) {
          assert.equal(doc, "docs/MIGRATION.md", "only MIGRATION.md may show 0.1.x code");
          return;
        }
        const [file = "", region] = b.snippet.split("#");
        assert.ok(
          file.startsWith("examples/") && existsSync(join(ROOT, file)),
          `${file} does not exist under examples/`,
        );
        const expected = asShown(file, extract(file, region));
        assert.equal(b.code, expected, `${doc}:${String(b.line)} differs from ${b.snippet} (left: the doc)`);
      });
    }
  });
}

describe("docs coverage", () => {
  test("README.md and docs/MIGRATION.md exist and have checked blocks", () => {
    for (const doc of ["README.md", "docs/MIGRATION.md"]) {
      assert.ok(DOCS.includes(doc));
      const checked = fences(readRepoFile(doc)).filter((b) => b.snippet !== undefined && b.snippet !== EXEMPT);
      assert.ok(checked.length >= 5, `${doc}: ${String(checked.length)} checked blocks`);
    }
  });

  test("every MIGRATION.md after-sample file is shown", () => {
    const shown = new Set(fences(readRepoFile("docs/MIGRATION.md")).map((b) => b.snippet?.split("#")[0]));
    for (const f of readdirSync(join(ROOT, "examples/migration")))
      assert.ok(shown.has(`examples/migration/${f}`), `examples/migration/${f} is not shown in docs/MIGRATION.md`);
  });
});

describe("paths named in the docs exist", () => {
  /** Repo-relative paths in a markdown text: in backticks, link targets or plain text. */
  function paths(text: string): string[] {
    const found = new Set<string>();
    const re = /(?:^|[\s`([])((?:test|examples|docs|src|interfaces|scripts|\.github)\/[\w./@-]*[\w/])/gm;
    for (const m of text.matchAll(re)) if (m[1] !== undefined) found.add(m[1]);
    return [...found];
  }

  for (const doc of DOCS) {
    test(doc, () => {
      const text = readRepoFile(doc);
      const missing = paths(text).filter((p) => !existsSync(join(ROOT, p)));
      assert.deepEqual(missing, [], `${doc} names paths that do not exist`);
    });
  }

  test('README "What is tested where" names existing test files and CI workflows', () => {
    const text = readRepoFile("README.md");
    const start = text.indexOf("\n## What is tested where\n");
    assert.ok(start >= 0, "section missing");
    const end = text.indexOf("\n## ", start + 1);
    const section = text.slice(start, end < 0 ? undefined : end);
    const named = paths(section);
    assert.ok(named.length >= 30, `only ${String(named.length)} paths`);
    for (const p of named) assert.ok(existsSync(join(ROOT, p)), `${p} does not exist`);
    for (const workflow of ["ci.yml", "interop.yml", "runtimes.yml"]) {
      assert.ok(section.includes(`\`${workflow}\``), `${workflow} not mentioned`);
      assert.ok(existsSync(join(ROOT, ".github/workflows", workflow)), `${workflow} does not exist`);
    }
    // Every job the table names exists in its workflow.
    const jobs: Record<string, readonly string[]> = {
      "ci.yml": ["test:", "floor:"],
      "interop.yml": ["python:", "rust:", "varlinkctl:"],
      "runtimes.yml": ["bun:", "deno:"],
    };
    for (const [file, names] of Object.entries(jobs)) {
      const workflow = readRepoFile(`.github/workflows/${file}`);
      for (const n of names) assert.ok(workflow.includes(`\n  ${n}\n`), `${file} has no job ${n}`);
    }
  });
});
