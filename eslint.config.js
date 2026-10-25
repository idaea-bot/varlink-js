// @ts-check
import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";
import { layerBoundaries } from "./eslint-rules/layer-boundaries.js";

/** Runtime-agnostic layers (DESIGN.md §4) and the directories each may import from. */
const LAYERS = { "src/core": ["src/core"], "src/rpc": ["src/core", "src/rpc"] };

const globalMessage = "src/core and src/rpc must stay runtime-agnostic (DESIGN.md §4): no runtime-specific globals.";
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
    files: ["src/core/**", "src/rpc/**"],
    plugins: { local: { rules: { "layer-boundaries": layerBoundaries } } },
    rules: {
      "local/layer-boundaries": ["error", { root: import.meta.dirname, layers: LAYERS }],
      // `/// <reference types="node" />` would pull @types/node into the core typecheck.
      "@typescript-eslint/triple-slash-reference": ["error", { lib: "never", path: "never", types: "never" }],
      "no-eval": "error",
      "no-restricted-globals": ["error", ...runtimeGlobals.map((name) => ({ name, message: globalMessage }))],
      "no-restricted-properties": [
        "error",
        ...["globalThis"].flatMap((object) =>
          runtimeGlobals.map((property) => ({ object, property, message: globalMessage })),
        ),
      ],
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
      ],
    },
  },
  prettier,
);
