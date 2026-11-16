// Golden tests on the vendored corpus (test/corpus/SOURCES.md): every file parses, formatting keeps the
// AST and is a fixpoint, and the files already in canonical (libvarlink) style come out byte-identical.
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatInterface, parseInterface } from "../../../src/core/idl/index.ts";
import { corpusFiles, stripSpans } from "./helpers.ts";

const files = corpusFiles();

/**
 * Files that `formatInterface(parseInterface(x))` reproduces byte for byte. The others are hand-laid-out
 * (e.g. rust's org.example.complex puts a 37-character struct on three lines, the certification
 * interfaces keep a 49-character parameter list on one line, `error Name(` without a space) or use
 * systemd's style (tabs, `type Name(`).
 */
const CANONICAL = [
  "libvarlink/org.varlink.service.varlink",
  "python-varlink/org.example.encoding.varlink",
  "python-varlink/org.example.more.varlink",
  "python-varlink/org.varlink.service.varlink",
  "rust-varlink/examples__async_more__org.example.more.varlink",
  "rust-varlink/examples__more__org.example.more.varlink",
  "rust-varlink/varlink_stdinterfaces__org.varlink.resolver.varlink",
  "rust-varlink/varlink_stdinterfaces__org.varlink.service.varlink",
  "uapi/org.example.ftl.varlink",
  "uapi/org.varlink.service.varlink",
];

test("corpus is found", () => {
  assert.ok(files.length >= 27, `found only ${String(files.length)} corpus files`);
});

for (const { name, text } of files) {
  test(`corpus: ${name}`, () => {
    const ast = parseInterface(text);
    const formatted = formatInterface(ast);
    const reparsed = parseInterface(formatted);
    assert.deepEqual(stripSpans(reparsed), stripSpans(ast));
    assert.equal(formatInterface(reparsed), formatted, "formatting is not a fixpoint");
    if (CANONICAL.includes(name)) assert.equal(formatted, text, "canonical file changed");
  });
}

test("canonical list names existing files", () => {
  for (const name of CANONICAL)
    assert.ok(
      files.some((f) => f.name === name),
      name,
    );
});
