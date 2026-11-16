// Generated modules committed to the repo (built-ins and typed-e2e fixtures) and how each is produced. The
// up-to-date test compares them with generate(); `UPDATE_SNAPSHOTS=1 npm test` rewrites them.
import { join } from "node:path";
import { generate } from "../../../src/codegen/index.ts";
import { BUILTIN_INTERFACES, generateBuiltin, outputPath } from "../../../scripts/gen-interfaces.ts";
import { TEST_IDL } from "./fixtures.ts";
import { readText } from "./helpers.ts";

/** A committed generated file: its path (repo-relative) and the code it must contain. */
export interface Committed {
  readonly path: string;
  code(): string;
}

const GENERATED = "test/unit/codegen/generated";
/** From test/unit/codegen/generated/ (and one level deeper for bigint/) to src/index.ts. */
const RUNTIME = "../../../../src/index.ts";

export const COMMITTED: readonly Committed[] = [
  ...BUILTIN_INTERFACES.map((name) => ({ path: outputPath(name), code: () => generateBuiltin(name).code })),
  {
    path: join(GENERATED, "org.example.ftl.ts"),
    code: () => generate(readText("test/corpus/uapi/org.example.ftl.varlink"), { importPath: RUNTIME }).code,
  },
  {
    path: join(GENERATED, "org.varlink.certification.ts"),
    code: () =>
      generate(readText("test/corpus/python-varlink/org.varlink.certification.varlink"), { importPath: RUNTIME }).code,
  },
  { path: join(GENERATED, "org.example.typed.ts"), code: () => generate(TEST_IDL, { importPath: RUNTIME }).code },
  {
    path: join(GENERATED, "bigint", "org.example.typed.ts"),
    code: () => generate(TEST_IDL, { ints: "bigint", importPath: `../${RUNTIME}` }).code,
  },
];

/** Whether the tests should rewrite committed files and snapshots instead of comparing. */
export const UPDATE: boolean = process.env.UPDATE_SNAPSHOTS === "1";
