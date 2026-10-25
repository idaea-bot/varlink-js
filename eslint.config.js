// @ts-check
import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";
import { layerBoundaries } from "./eslint-rules/layer-boundaries.js";

/**
 * Runtime-agnostic layers (DESIGN.md §4) and the directories each may import from. core/rpc are the
 * protocol layers; the root entry, idl, websocket and http are the subpaths a browser loads (§4, §8).
 */
const LAYERS = {
  "src/core": ["src/core"],
  "src/rpc": ["src/core", "src/rpc"],
  "src/index.ts": ["src/core", "src/rpc"],
  "src/idl": ["src/core", "src/idl"],
  "src/websocket": ["src/core", "src/rpc", "src/websocket"],
  "src/http": ["src/core", "src/rpc", "src/http"],
};
const agnosticFiles = Object.keys(LAYERS).map((l) => (l.endsWith(".ts") ? l : `${l}/**`));

const globalMessage = "This layer must stay runtime-agnostic (DESIGN.md §4): no runtime-specific globals.";
const runtimeGlobals = [
  "process",
  "Buffer",
  "Bun",
  "Deno",
  "require",
  "module",
  "exports",
  "__dirname",
  "__filename",
  "global",
  "setImmediate",
  "clearImmediate",
  // Browser-only (and not defined on Node), even though lib "dom" types them for the core typecheck.
  "window",
  "self",
  "document",
  "location",
  "navigator",
  "localStorage",
  "sessionStorage",
  "XMLHttpRequest",
  "requestAnimationFrame",
  "alert",
  "top",
  "parent",
  "frames",
  "name",
];
// core does no I/O and rpc does I/O only through ByteChannel (DESIGN.md §4.1); the transports
// (websocket, http) are the only agnostic layers that may open connections.
const ioMessage = "Only the transports (src/websocket, src/http) open connections (DESIGN.md §4.1): use a ByteChannel.";
const ioGlobals = [
  "fetch",
  "WebSocket",
  "WebSocketStream",
  "EventSource",
  "Worker",
  "SharedWorker",
  "BroadcastChannel",
  "indexedDB",
  "caches",
];

/** @param {{ name: string, message: string }[]} banned */
const globalRules = (banned) => ({
  "no-restricted-globals": ["error", ...banned],
  "no-restricted-properties": [
    "error",
    // `globalThis.globalThis.x` would dodge the per-name ban.
    { object: "globalThis", property: "globalThis", message: globalMessage },
    ...banned.map(({ name, message }) => ({ object: "globalThis", property: name, message })),
  ],
});
const runtimeBans = runtimeGlobals.map((name) => ({ name, message: globalMessage }));
const ioBans = ioGlobals.map((name) => ({ name, message: ioMessage }));

export default defineConfig(
  globalIgnores(["dist/", "build/", "pkg/", "coverage/", "test/fixtures/consumer/"]),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // node:test's test()/describe() return promises the runner tracks itself.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["test", "it", "describe", "suite", "before", "after"] },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: agnosticFiles,
    plugins: { local: { rules: { "layer-boundaries": layerBoundaries } } },
    rules: {
      "local/layer-boundaries": ["error", { root: import.meta.dirname, layers: LAYERS }],
      // `/// <reference types="node" />` would pull @types/node into the core typecheck.
      "@typescript-eslint/triple-slash-reference": ["error", { lib: "never", path: "never", types: "never" }],
      "no-eval": "error",
      ...globalRules(runtimeBans),
      "no-restricted-syntax": [
        "error",
        {
          selector: "MetaProperty[meta.name='import']",
          message: "import.meta is runtime-specific (DESIGN.md §4).",
        },
        {
          selector: "Identifier[name='globalThis']:not(MemberExpression[computed=false] > Identifier.object)",
          message:
            "Only plain property access on globalThis (globalThis.x) is allowed, so the global rules can see it.",
        },
        {
          // `declare const Deno: …` makes a local binding that both the global ban and the typecheck accept;
          // `declare global` / `declare module "node:fs"` smuggle runtime types or modules in the same way.
          selector:
            "VariableDeclaration[declare=true], TSDeclareFunction[declare=true], ClassDeclaration[declare=true], TSModuleDeclaration",
          message: "No ambient declarations in runtime-agnostic layers (DESIGN.md §4): they bypass the global rules.",
        },
      ],
    },
  },
  {
    files: agnosticFiles.filter((f) => !f.startsWith("src/websocket/") && !f.startsWith("src/http/")),
    rules: globalRules([...runtimeBans, ...ioBans]),
  },
  prettier,
);
