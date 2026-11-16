// Regenerates org.example.notes.ts from org.example.notes.varlink with the codegen API:
// `node examples/codegen/generate.ts` (`--check`: exit 1 if the committed file is out of date, write nothing).
// The CLI equivalent is `varlink-js codegen org.example.notes.varlink -o .`.
import { readFileSync, writeFileSync } from "node:fs";
import { generate, type GenerateOptions } from "../../src/codegen/index.ts";

// This repository's examples import the library by relative path; generated code imports "varlink-js" by default.
const options: GenerateOptions = { importPath: "../../src/index.ts" };

// #region generate
const idl = readFileSync(new URL("org.example.notes.varlink", import.meta.url), "utf8");
const { fileName, code, constName } = generate(idl, options); // options: { ints?: "number" | "bigint", importPath? }
// fileName: "org.example.notes.ts", constName: "OrgExampleNotes"
// #endregion generate

const target = new URL(fileName, import.meta.url);
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== code) {
    console.error(`${fileName} is out of date: run node examples/codegen/generate.ts`);
    process.exit(1);
  }
  console.log(`${fileName} (${constName}) is up to date`);
} else {
  writeFileSync(target, code);
  console.log(`wrote ${fileName} (${constName})`);
}
