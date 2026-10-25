// generate() lays code out the way prettier (repo config) would, so generated files can be committed as is.
import assert from "node:assert/strict";
import { test } from "node:test";
import { generate } from "../../../src/codegen/index.ts";
import { COLLISIONS_IDL, LAYOUT_IDL } from "./fixtures.ts";
import { corpusFiles, firstDiff, prettierFormat, readText } from "./helpers.ts";

const inputs: [string, string][] = [
  ...corpusFiles().map((f): [string, string] => [f, readText(f)]),
  ["collisions", COLLISIONS_IDL],
  ["layout", LAYOUT_IDL],
];

for (const [label, idl] of inputs) {
  test(`prettier leaves the generated code of ${label} unchanged (both ints modes)`, async () => {
    for (const ints of ["number", "bigint"] as const) {
      const { code } = generate(idl, { ints });
      const formatted = await prettierFormat(code);
      assert.equal(code, formatted, `${label} (${ints}) ${firstDiff(code, formatted)}`);
    }
  });
}
