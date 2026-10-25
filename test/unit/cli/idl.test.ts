// `validate-idl`, `format` and `codegen` in-process (DESIGN.md §4.14).
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { generate } from "../../../src/codegen/index.ts";
import { formatInterface, parseInterface } from "../../../src/idl/index.ts";
import { IDL, runCli, startFixture, tempDir, type Fixture } from "./helpers.ts";

const CANONICAL = formatInterface(parseInterface(IDL));
const MESSY = "interface   org.example.messy\nmethod  F( a :int )->( )\n";
const MESSY_CANONICAL = "interface org.example.messy\n\nmethod F(a: int) -> ()\n";

let dir: { path: string; remove(): Promise<void> };
let fx: Fixture;
before(async () => {
  dir = await tempDir();
  fx = await startFixture();
});
after(async () => {
  await fx.close();
  await dir.remove();
});

const file = async (name: string, text: string): Promise<string> => {
  const path = join(dir.path, name);
  await writeFile(path, text);
  return path;
};

describe("validate-idl", () => {
  test("valid: the canonical formatting, exit 0; -q prints nothing", async () => {
    const path = await file("ok.varlink", MESSY);
    const r = await runCli(["validate-idl", path]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, MESSY_CANONICAL);
    const q = await runCli(["validate-idl", "-q", path]);
    assert.equal(q.code, 0);
    assert.equal(q.stdout, "");
  });

  test("stdin when absent or '-'", async () => {
    for (const argv of [["validate-idl"], ["validate-idl", "-"]]) {
      const r = await runCli(argv, { stdin: MESSY });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, MESSY_CANONICAL);
    }
  });

  test("errors: FILE:LINE:COL: message (stdin: <stdin>)", async () => {
    const path = await file("bad.varlink", "interface org.example.bad\n\nmethod F(x: Missing) -> ()\n");
    const r = await runCli(["validate-idl", path]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`^${path.replace(/[\\.]/g, "\\$&")}:3:13: .*Missing.*\n$`));
    assert.equal(r.stdout, "");
    const s = await runCli(["validate-idl"], {
      stdin: "interface org.example.bad\nmethod F() -> ()\nmethod F() -> ()\n",
    });
    assert.equal(s.code, 1);
    assert.match(s.stderr, /^<stdin>:3:8: /);
    const syntax = await runCli(["validate-idl"], { stdin: "interface x\n" });
    assert.match(syntax.stderr, /^<stdin>:1:11: /);
  });

  test("unreadable file, invalid UTF-8, too many arguments", async () => {
    const missing = await runCli(["validate-idl", join(dir.path, "nope.varlink")]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /^Failed to read interface description file '.*nope\.varlink': .*ENOENT/);
    const bytes = await runCli(["validate-idl"], { stdin: new Uint8Array([0x69, 0xff]) });
    assert.equal(bytes.stderr, "<stdin>: not valid UTF-8\n");
    const many = await runCli(["validate-idl", "a", "b"]);
    assert.equal(many.stderr, "Too many arguments.\nSee 'varlink-js --help'.\n");
  });
});

describe("format", () => {
  test("prints the canonical formatting of files (blank line between) or stdin", async () => {
    const a = await file("a.varlink", MESSY);
    const b = await file("b.varlink", IDL);
    const r = await runCli(["format", a, b]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `${MESSY_CANONICAL}\n${CANONICAL}`);
    const s = await runCli(["format"], { stdin: MESSY });
    assert.equal(s.stdout, MESSY_CANONICAL);
  });

  test("--check: prints nothing, names the files that are not canonical, exit 1", async () => {
    const good = await file("good.varlink", CANONICAL);
    const bad = await file("bad-format.varlink", MESSY);
    const ok = await runCli(["format", "--check", good]);
    assert.equal(ok.code, 0);
    assert.equal(ok.stdout + ok.stderr, "");
    const r = await runCli(["format", "--check", good, bad]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, `${bad}: not canonically formatted\n`);
    const s = await runCli(["format", "--check", "-"], { stdin: MESSY });
    assert.equal(s.stderr, "<stdin>: not canonically formatted\n");
  });

  test("--in-place / -i rewrites only what differs; not stdin", async () => {
    const path = await file("inplace.varlink", MESSY);
    const r = await runCli(["format", "-i", path]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "");
    assert.equal(await readFile(path, "utf8"), MESSY_CANONICAL);
    const again = await runCli(["format", "--in-place", path]);
    assert.equal(again.code, 0);
    const stdin = await runCli(["format", "-i"], { stdin: MESSY });
    assert.equal(stdin.code, 1);
    assert.match(stdin.stderr, /^--in-place cannot rewrite standard input\.\n/);
  });

  test("invalid input: like validate-idl, the other files still processed", async () => {
    const bad = await file("broken.varlink", "interface x\n");
    const good = await file("fine.varlink", MESSY);
    const r = await runCli(["format", bad, good]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /broken\.varlink:1:11: /);
    assert.equal(r.stdout, MESSY_CANONICAL);
  });
});

describe("codegen", () => {
  test("one file to stdout, generate()'s defaults", async () => {
    const path = await file("cli.varlink", IDL);
    const r = await runCli(["codegen", path]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, generate(IDL).code);
  });

  test("-o DIR: <DIR>/<interface>.ts per file, paths on stderr unless -q; --ints, --import-path", async () => {
    const a = await file("gen-a.varlink", IDL);
    const b = await file("gen-b.varlink", MESSY);
    const out = join(dir.path, "out", "nested");
    const r = await runCli(["codegen", a, b, "-o", out, "--ints=bigint", "--import-path", "../runtime.ts"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "");
    const pa = join(out, "org.example.cli.ts");
    const pb = join(out, "org.example.messy.ts");
    assert.equal(r.stderr, `${pa}\n${pb}\n`);
    const options = { ints: "bigint", importPath: "../runtime.ts" } as const;
    assert.equal(await readFile(pa, "utf8"), generate(IDL, options).code);
    assert.equal(await readFile(pb, "utf8"), generate(MESSY, options).code);
    const q = await runCli(["codegen", "-q", a, "--output", out]);
    assert.equal(q.code, 0);
    assert.equal(q.stderr, "");
  });

  test("stdin ('-'), several inputs need -o, the same interface twice, bad input, bad import path", async () => {
    const s = await runCli(["codegen", "-"], { stdin: MESSY });
    assert.equal(s.stdout, generate(MESSY).code);
    const a = await file("dup-a.varlink", MESSY);
    const two = await runCli(["codegen", a, a]);
    assert.equal(two.code, 1);
    assert.match(two.stderr, /^Without -o DIR, codegen takes one input/);
    const dup = await runCli(["codegen", a, a, "-o", join(dir.path, "dup")]);
    assert.equal(dup.code, 1);
    assert.match(dup.stderr, /interface org\.example\.messy is given more than once/);
    const bad = await runCli(["codegen", "-"], { stdin: "interface x\n" });
    assert.match(bad.stderr, /^<stdin>:1:11: /);
    const path = await runCli(["codegen", a, "--import-path", 'x"y']);
    assert.equal(path.code, 1);
    assert.match(path.stderr, /^codegen: /);
    const none = await runCli(["codegen"]);
    assert.equal(none.stderr, "Too few arguments.\nSee 'varlink-js --help'.\n");
  });

  test("--address: generateFromService against a running service", async () => {
    const r = await runCli(["codegen", "--address", fx.unix, "org.example.cli"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, generate(IDL).code);
    const out = join(dir.path, "live");
    const two = await runCli(["codegen", "--address", fx.tcp, "org.example.cli", "org.example.preview", "-o", out]);
    assert.equal(two.code, 0, two.stderr);
    assert.equal(await readFile(join(out, "org.example.cli.ts"), "utf8"), generate(IDL).code);
    const missing = await runCli(["codegen", "--address", fx.unix, "org.example.missing"]);
    assert.equal(missing.code, 1);
    assert.equal(
      missing.stderr,
      "Method call org.varlink.service.GetInterfaceDescription() failed: org.varlink.service.InterfaceNotFound\n",
    );
    const invalid = await runCli(["codegen", "--address", "unix:/nonexistent/x", "nope"]);
    assert.equal(invalid.stderr, "Not a valid Varlink interface name: 'nope'\n");
  });
});
