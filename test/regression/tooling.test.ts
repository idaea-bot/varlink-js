// Packaging and tooling regressions (DESIGN.md §3, §8): F10 (exports map, ESM only), F11 (one VarlinkError across
// module copies), F12 (lockfile, pinned prettier), F13 (Node 22/24/26 CI and the 22.12.0 floor), F14 (a regression
// test per finding), F16 (no `publish` script; prepack builds; `files`).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";

interface PackageJson {
  type?: string;
  main?: unknown;
  module?: unknown;
  exports: Record<string, unknown>;
  scripts: Record<string, string>;
  files?: string[];
  devDependencies: Record<string, string>;
}

// npm scripts and CI run tests from the repository root.
const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as PackageJson;
const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");

/** Every condition name used anywhere in an exports value. */
function conditions(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => [k, ...conditions(v)]);
}

describe("F10 package.json exports every subpath, ESM only", () => {
  test("the exports map", () => {
    assert.deepEqual(Object.keys(pkg.exports), [
      ".",
      "./node",
      "./websocket",
      "./http",
      "./idl",
      "./codegen",
      "./testing",
      "./package.json",
    ]);
    assert.equal(pkg.type, "module");
    assert.equal(pkg.main, undefined);
    assert.equal(pkg.module, undefined);
    const used = new Set(Object.values(pkg.exports).flatMap(conditions));
    for (const cjs of ["require", "node-addons", "module-sync"]) assert.equal(used.has(cjs), false, cjs);
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (subpath === "./package.json") continue;
      const t = target as { default: string };
      assert.match(t.default, /\.js$/, subpath);
    }
  });

  test("CI runs the consumer fixture (ESM import, require(esm), tsc nodenext) against the packed tarball", () => {
    assert.ok(existsSync(resolve("test/fixtures/consumer/run.js")));
    assert.match(ci, /run: node test\/fixtures\/consumer\/run\.js --tarball /);
  });
});

describe("F11 isVarlinkError works across separate module instances", () => {
  test("an error from one copy is recognised by another", async () => {
    type Mod = typeof import("../../src/core/errors/varlink-error.ts");
    const url = pathToFileURL(resolve("src/core/errors/varlink-error.ts")).href;
    const a = (await import(`${url}?copy=1`)) as Mod;
    const b = (await import(`${url}?copy=2`)) as Mod;
    assert.notEqual(a.VarlinkError, b.VarlinkError, "two module instances");
    const error = new a.VarlinkError("org.example.Failed", { why: "x" });
    assert.equal(error instanceof b.VarlinkError, false);
    assert.equal(b.isVarlinkError(error), true);
    assert.equal(b.isVarlinkError(new Error("plain")), false);
  });
});

describe("F12 the toolchain is pinned", () => {
  test("package-lock.json is committed; prettier is pinned exact", () => {
    const lock = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8")) as { lockfileVersion: number };
    assert.ok(lock.lockfileVersion >= 3);
    assert.match(pkg.devDependencies.prettier ?? "", /^\d+\.\d+\.\d+$/);
  });
});

describe("F13 CI tests the supported Node lines and the engines floor", () => {
  test("matrix 22/24/26 and a 22.12.0 job", () => {
    const matrix = /matrix:\s*\n\s*node:\s*\[([^\]]*)\]/.exec(ci);
    assert.ok(matrix !== null, "test matrix");
    assert.deepEqual(
      matrix[1]?.split(",").map((s) => s.trim()),
      ["22", "24", "26"],
    );
    assert.match(ci, /node-version:\s*22\.12\.0\b/);
  });
});

describe("F14 every finding has a regression test", () => {
  test("a describe(`F<n> …`) for F1–F17 under test/regression/", () => {
    const dir = resolve("test/regression");
    const text = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
    const found = new Set([...text.matchAll(/describe\(\s*["'`]F(\d+)\b/g)].map((m) => Number(m[1])));
    const missing = Array.from({ length: 17 }, (_, i) => i + 1).filter((n) => !found.has(n));
    assert.deepEqual(missing, []);
  });
});

describe("F16 releases are built by prepack, never published by a script", () => {
  test("no publish script; prepack builds; files is set", () => {
    for (const name of Object.keys(pkg.scripts))
      assert.equal(/^(pre|post)?publish$/.test(name), false, `script ${name}`);
    assert.match(pkg.scripts.prepack ?? "", /npm run build/);
    assert.ok(Array.isArray(pkg.files) && pkg.files.includes("dist"));
  });
});
