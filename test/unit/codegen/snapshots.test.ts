// Golden outputs of generate() (DESIGN.md §4.13), compared byte for byte. `UPDATE_SNAPSHOTS=1 npm test` rewrites
// them. Stored as *.ts.snap so tsc, ESLint and prettier leave them alone.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { generate, type GenerateOptions } from "../../../src/codegen/index.ts";
import { UPDATE } from "./committed.ts";
import { firstDiff, readText } from "./helpers.ts";

const DIR = "test/unit/codegen/snapshots";

const SNAPSHOTS: [snapshot: string, source: string, options: GenerateOptions][] = [
  ["org.example.ftl.ts.snap", "test/corpus/uapi/org.example.ftl.varlink", {}],
  ["org.example.ftl.bigint.ts.snap", "test/corpus/uapi/org.example.ftl.varlink", { ints: "bigint" }],
  ["org.example.complex.ts.snap", "test/corpus/rust-varlink/varlink_generator__tests__org.example.complex.varlink", {}],
  ["org.varlink.certification.ts.snap", "test/corpus/python-varlink/org.varlink.certification.varlink", {}],
  ["io.systemd.Resolve.ts.snap", "test/corpus/systemd-255/io.systemd.Resolve.varlink", {}],
  ["org.varlink.service.ts.snap", "test/corpus/uapi/org.varlink.service.varlink", {}],
];

for (const [snapshot, source, options] of SNAPSHOTS) {
  test(`${snapshot} (${source})`, () => {
    const code = generate(readText(source), options).code;
    const path = join(DIR, snapshot);
    if (UPDATE) {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(path, code);
    }
    const expected = readFileSync(path, "utf8");
    assert.ok(
      code === expected,
      `${path} differs (UPDATE_SNAPSHOTS=1 npm test rewrites it): ${firstDiff(code, expected)}`,
    );
  });
}
