// The DESIGN.md §4 rule "the runtime-agnostic layers must not touch Node built-ins or runtime globals"
// is enforced by eslint.config.js. This checks the rule really fires (and does not fire elsewhere).
// Dev-only: needs ESLint, so it is not part of the compiled Node 22.12 floor run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ESLint } from "eslint";

// The probe files do not exist on disk, so let the project service type-check them in the default project.
const eslint = new ESLint({
  overrideConfig: {
    files: ["src/*/lint-probe.ts", "src/index.ts"],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["src/*/lint-probe.ts"], defaultProject: "tsconfig.json" },
      },
    },
  },
});

async function restrictedRules(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  assert.ok(result);
  const fatal = result.messages.filter((m) => m.fatal === true);
  assert.deepEqual(fatal, [], `parse errors in ${filePath}`);
  return result.messages
    .map((m) => m.ruleId ?? "")
    .filter(
      (id) =>
        id.startsWith("no-restricted-") ||
        id.startsWith("local/") ||
        id === "no-eval" ||
        id === "@typescript-eslint/triple-slash-reference",
    )
    .sort();
}

const L = "local/layer-boundaries";
const G = "no-restricted-globals";
const P = "no-restricted-properties";
const S = "no-restricted-syntax";

// [code, rule expected in src/core, rule expected in src/rpc] (null = must be clean).
const cases: [string, string | null, string | null][] = [
  ['import { readFile } from "node:fs";\nexport const x: unknown = readFile;\n', L, L],
  ['import { Socket } from "net";\nexport const x: unknown = Socket;\n', L, L],
  ['import { promises } from "fs/promises";\nexport const x: unknown = promises;\n', L, L],
  ['import type { Socket } from "node:net";\nexport type X = Socket;\n', L, L],
  ['export type X = import("node:net").Socket;\n', L, L],
  ['export * from "node:fs";\n', L, L],
  ['export type { Socket } from "node:net";\n', L, L],
  ['export type * from "node:fs";\n', L, L],
  ['export type F = typeof import("node:fs");\n', L, L],
  ["export const f = (x: string): Promise<unknown> => import(`node:${x}`);\n", L, L],
  [
    '/// <reference types="node" />\nexport const x = 1;\n',
    "@typescript-eslint/triple-slash-reference",
    "@typescript-eslint/triple-slash-reference",
  ],
  ['export const x: unknown = eval("process");\n', "no-eval", "no-eval"],
  ["export const x: unknown = self;\n", G, G],
  ["export const x: unknown = navigator;\n", G, G],
  ['import WebSocket from "ws";\nexport const x: unknown = WebSocket;\n', L, L],
  ['import * as http from "varlink-js/http";\nexport const x: unknown = http;\n', L, L],
  ['import { x } from "../node/index.ts";\nexport const y: unknown = x;\n', L, L],
  ['import { x } from "../cli/main.ts";\nexport const y: unknown = x;\n', L, L],
  ['export const x: Promise<unknown> = import("node:fs");\n', L, L],
  ["export const f = (s: string): Promise<unknown> => import(s);\n", L, L],
  ['import { x } from "../rpc/conn.ts";\nexport const y: unknown = x;\n', L, null],
  ['import { x } from "../core/idl/index.ts";\nexport const y: unknown = x;\n', null, null],
  ['import { x } from "./idl/node/member.ts";\nexport const y: unknown = x;\n', null, null],
  ["export const x: unknown = process.env;\n", G, G],
  ["export const x: unknown = Buffer.from([]);\n", G, G],
  ["export const x: unknown = document;\n", G, G],
  ["export const x: unknown = globalThis.process;\n", P, P],
  ["const g = globalThis;\nexport const x: unknown = g;\n", S, S],
  ['export const x: unknown = globalThis["process"];\n', S, S],
  ["export const x: unknown = import.meta.url;\n", S, S],
  ["export const x: unknown = [new TextDecoder(), new Uint8Array(1), globalThis.queueMicrotask];\n", null, null],
  // Ambient declarations would make runtime globals local bindings (or smuggle modules in).
  ['declare const Deno: { env: { get(k: string): string } };\nexport const x: unknown = Deno.env.get("X");\n', S, S],
  ["declare function require(id: string): unknown;\nexport const x: unknown = require;\n", S, S],
  ["declare global {\n  var process: unknown;\n}\nexport {};\n", S, S],
  ['declare module "node:fs" {\n  export const x: number;\n}\nexport {};\n', L, L],
  ["export const x: unknown = (globalThis.globalThis as unknown as { process: unknown }).process;\n", P, P],
  // Overload signatures are TSDeclareFunction nodes too; they must stay legal.
  [
    "export function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: unknown): unknown {\n  return a;\n}\n",
    null,
    null,
  ],
  // core/rpc do no I/O of their own (DESIGN.md §4.1).
  ['export const x: unknown = fetch("http://x");\n', G, G],
  ['export const x: unknown = new WebSocket("ws://x");\n', G, G],
  ["export const x: unknown = globalThis.fetch;\n", P, P],
];

for (const [index, dir] of ["src/core", "src/rpc"].entries()) {
  for (const testCase of cases) {
    const [code] = testCase;
    const rule = testCase[index + 1] ?? null;
    const label = JSON.stringify(code.split("\n")[0]);
    test(`${dir}: ${rule === null ? "allows" : `${rule} rejects`} ${label}`, async () => {
      const rules = await restrictedRules(`${dir}/lint-probe.ts`, code);
      if (rule === null) assert.deepEqual(rules, []);
      else assert.ok(rules.includes(rule), `expected ${rule}, got ${JSON.stringify(rules)}`);
    });
  }
}

// Browser-facing subpaths (DESIGN.md §4, §8): runtime-agnostic too, but the transports may do I/O.
for (const file of ["src/index.ts", "src/idl/lint-probe.ts", "src/websocket/lint-probe.ts", "src/http/lint-probe.ts"]) {
  const transport = file.startsWith("src/websocket/") || file.startsWith("src/http/");
  const webCases: [string, string | null][] = [
    ['import { readFile } from "node:fs";\nexport const x: unknown = readFile;\n', L],
    // From src/index.ts "./node" is the Node adapter; from src/<layer>/ "../node" is.
    [
      `import { x } from "${file === "src/index.ts" ? "./node/index.ts" : "../node/index.ts"}";\nexport const y: unknown = x;\n`,
      L,
    ],
    [
      `import { x } from "${file === "src/index.ts" ? "./cli/main.ts" : "../cli/main.ts"}";\nexport const y: unknown = x;\n`,
      L,
    ],
    ['import WebSocket from "ws";\nexport const x: unknown = WebSocket;\n', L],
    ["export const x: unknown = process.env;\n", G],
    ["export const x: unknown = globalThis.Buffer;\n", P],
    ["declare const Bun: unknown;\nexport const x: unknown = Bun;\n", S],
    ['/// <reference types="node" />\nexport const x = 1;\n', "@typescript-eslint/triple-slash-reference"],
    ["export const x: unknown = [fetch, WebSocket];\n", transport ? null : G],
  ];
  for (const [code, rule] of webCases) {
    const label = JSON.stringify(code.split("\n")[0]);
    test(`${file}: ${rule === null ? "allows" : `${rule} rejects`} ${label}`, async () => {
      const rules = await restrictedRules(file, code);
      if (rule === null) assert.deepEqual(rules, []);
      else assert.ok(rules.includes(rule), `expected ${rule}, got ${JSON.stringify(rules)}`);
    });
  }
}

test("adapters (src/node) may use Node built-ins and globals", async () => {
  const rules = await restrictedRules(
    "src/node/lint-probe.ts",
    'import { readFile } from "node:fs";\nexport const x: unknown = [readFile, process.env, import.meta.url];\n',
  );
  assert.deepEqual(rules, []);
});
