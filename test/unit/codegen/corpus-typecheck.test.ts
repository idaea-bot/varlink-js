// Generated code for every corpus file (both ints modes) plus the hand-written interfaces typechecks under the repo's
// strict compiler options (isolatedDeclarations, exactOptionalPropertyTypes, …) with a usage file exercising the
// client and Handlers types (one tsc run), and every generated descriptor passes compileDescriptor at runtime.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { generate } from "../../../src/codegen/index.ts";
import { compileDescriptor, type InterfaceDescriptor } from "../../../src/index.ts";
import { COLLISIONS_IDL, LAYOUT_IDL, TEST_IDL } from "./fixtures.ts";
import { corpusFiles, importGenerated, readText, ROOT, RUNTIME_URL, tempPackage } from "./helpers.ts";

const INTS = ["number", "bigint"] as const;

const inputs: [label: string, idl: string][] = [
  ...corpusFiles().map((f): [string, string] => [f, readText(f)]),
  ["collisions", COLLISIONS_IDL],
  ["layout", LAYOUT_IDL],
  ["typed", TEST_IDL],
];

test("generated code for the whole corpus typechecks with the repo's strict options", () => {
  const { dir, cleanup } = tempPackage();
  try {
    const repo = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")) as {
      compilerOptions: Record<string, unknown>;
    };
    const strict = { ...repo.compilerOptions };
    delete strict.rootDir;
    delete strict.outDir;
    const tsconfig = {
      compilerOptions: {
        ...strict,
        // Like tsconfig.core.json: the runtime-agnostic entry, no @types/node.
        lib: ["es2024", "dom"],
        types: [],
        noEmit: true,
        allowImportingTsExtensions: true,
        paths: { "varlink-js": [join(ROOT, "src/index.ts")] },
      },
      include: ["**/*.ts"],
    };
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
    inputs.forEach(([label, idl], i) => {
      for (const ints of INTS) {
        // One directory per input: several corpus files share an interface name.
        const sub = join(dir, `${String(i)}-${ints}`);
        mkdirSync(sub);
        const file = generate(idl, { ints });
        writeFileSync(join(sub, file.fileName), file.code);
        const C = file.constName;
        writeFileSync(
          join(sub, "usage.ts"),
          [
            `import { createServer, type Connection, type Pool } from "varlink-js";`,
            `import { ${C}, type ${C}_Client, type ${C}_Handlers } from ${JSON.stringify(`./${file.fileName}`)};`,
            ``,
            `export function use(conn: Connection, pool: Pool): ${C}_Client[] {`,
            `  const handlers: ${C}_Handlers = {};`,
            `  createServer({ ints: ${JSON.stringify(ints)} }).implement(${C}, handlers);`,
            `  const fromConn: ${C}_Client = ${C}.client(conn);`,
            `  return [fromConn, ${C}.client(pool)];`,
            `}`,
            ``,
            // What decoding `{}` gives for fields named like Object.prototype members: an own `undefined` each.
            ...(label === "collisions"
              ? [
                  `import type { Inherited } from "./vjs.collide.ts";`,
                  `export const decoded: Inherited = {`,
                  ...[
                    "constructor",
                    "toString",
                    "valueOf",
                    "hasOwnProperty",
                    "isPrototypeOf",
                    "propertyIsEnumerable",
                    "toLocaleString",
                  ].map((n) => `  ${n}: undefined,`),
                  `};`,
                  ``,
                ]
              : []),
          ].join("\n"),
        );
      }
    });
    const tsc = spawnSync(
      process.execPath,
      [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", dir, "--pretty", "false", "--listFiles"],
      { encoding: "utf8" },
    );
    assert.equal(tsc.status, 0, `tsc failed:\n${tsc.stdout}${tsc.stderr}`);
    // The program really contained every generated module, its usage file and the runtime through `paths`.
    const listed = tsc.stdout.split("\n").filter((l) => l.startsWith(dir) || l.startsWith(join(ROOT, "src")));
    assert.equal(listed.filter((l) => l.startsWith(dir)).length, inputs.length * INTS.length * 2);
    assert.ok(listed.includes(join(ROOT, "src/index.ts")), "src/index.ts not in the program");
  } finally {
    cleanup();
  }
});

test("every generated descriptor passes compileDescriptor at runtime (both ints modes)", async () => {
  for (const [label, idl] of inputs)
    for (const ints of INTS) {
      const file = generate(idl, { ints, importPath: RUNTIME_URL });
      const mod = await importGenerated(file.code);
      const desc = mod[file.constName] as InterfaceDescriptor;
      assert.equal(desc.ints, ints, label);
      assert.equal(desc.idl, idl, label);
      const compiled = compileDescriptor(desc);
      assert.equal(compiled.name, file.interfaceName, label);
    }
});
