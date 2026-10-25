#!/usr/bin/env node
// Packs varlink-js (or takes --tarball), installs it into a temp dir outside the repo and runs the
// consumer checks. Plain JS on purpose: it also runs on the Node 22.12.0 floor (no type stripping).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const { values } = parseArgs({
  options: { tarball: { type: "string" }, "no-tsc": { type: "boolean", default: false }, keep: { type: "boolean" } },
});

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(" ")}  (in ${cwd})`);
  const r = spawnSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  if (r.error) throw r.error;
  process.stdout.write(r.stdout);
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")} exited with ${r.status}`);
  return r.stdout;
}

const tmp = mkdtempSync(join(tmpdir(), "varlink-js-consumer-"));
try {
  let tarball = values.tarball === undefined ? undefined : resolve(values.tarball);
  if (tarball === undefined) {
    run("npm", ["pack", "--pack-destination", tmp], repo);
    const packed = readdirSync(tmp).filter((f) => f.endsWith(".tgz"));
    assert.equal(packed.length, 1, `expected one tarball, got ${packed.join(", ")}`);
    tarball = join(tmp, packed[0]);
  }
  assert.ok(existsSync(tarball), tarball);

  const app = join(tmp, "app");
  cpSync(here, app, { recursive: true, filter: (src) => !src.endsWith("run.js") && !src.includes("node_modules") });
  run("npm", ["install", "--no-save", "--no-audit", "--no-fund", "--ignore-scripts", tarball], app);

  // Tarball contents.
  const installed = join(app, "node_modules", "varlink-js");
  for (const stem of [
    "index",
    "node/index",
    "websocket/index",
    "http/index",
    "idl/index",
    "codegen/index",
    "testing/index",
  ]) {
    for (const ext of [".js", ".d.ts", ".js.map", ".d.ts.map"]) {
      assert.ok(existsSync(join(installed, "dist", stem + ext)), `missing dist/${stem}${ext}`);
    }
    assert.ok(existsSync(join(installed, "src", stem + ".ts")), `missing src/${stem}.ts (source maps)`);
  }
  assert.ok(existsSync(join(installed, "dist", "cli", "main.js")), "missing dist/cli/main.js");
  const tests = readdirSync(installed, { recursive: true }).filter((f) =>
    /(^|[\\/])(test|tests)([\\/]|$)|\.test\./.test(f),
  );
  assert.deepEqual(tests, [], "tests must not be published");
  const top = readdirSync(installed).sort();
  assert.deepEqual(top, ["LICENSE", "README.md", "dist", "package.json", "src"], "unexpected files in the tarball");

  run(process.execPath, ["esm.js"], app);
  run(process.execPath, ["cjs.cjs"], app);

  const version = run(join(app, "node_modules", ".bin", "varlink-js"), ["--version"], app).trim();
  const { version: expected } = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(version, expected, "bin --version");

  if (!values["no-tsc"]) {
    const tsc = join(repo, "node_modules", "typescript", "bin", "tsc");
    // Web subpaths first, while the app has no @types/node at all: a `/// <reference types="node" />`
    // that tsc emits into a public .d.ts would otherwise resolve quietly despite `types: []`.
    assert.ok(!existsSync(join(app, "node_modules", "@types", "node")), "@types/node must not be installed yet");
    run(process.execPath, [tsc, "-p", join(app, "tsconfig.web.json")], app);
    console.log("tsc nodenext (web subpaths, no @types/node installed): ok");
    // Same @types/node as the repo's lockfile, so the check is reproducible.
    const typesNode = JSON.parse(readFileSync(join(repo, "node_modules", "@types", "node", "package.json"), "utf8"));
    run(
      "npm",
      [
        "install",
        "--no-save",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        `@types/node@${typesNode.version}`,
        tarball,
      ],
      app,
    );
    run(process.execPath, [tsc, "-p", join(app, "tsconfig.node.json")], app);
    console.log("tsc nodenext (node subpaths, ESM + CJS): ok");
  }
  console.log(`consumer fixture: ok (${tarball})`);
} finally {
  if (values.keep) console.log(`kept ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}
