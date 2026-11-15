// `validate-idl`, `format` and `codegen` in-process (DESIGN.md §4.14).
import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { parseCommandLine } from "../../../src/cli/args.ts";
import { createContext, type Context } from "../../../src/cli/context.ts";
import { codegen, format, validateIdl } from "../../../src/cli/idl.ts";
import { signalExitCode } from "../../../src/cli/io.ts";
import { generate } from "../../../src/codegen/index.ts";
import { formatInterface, parseInterface } from "../../../src/idl/index.ts";
import { fakeIo, IDL, runCli, startFixture, tempDir, waitFor, type Fixture } from "./helpers.ts";

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

  test("stdin above 16 MiB: `too large`, exit 1", async () => {
    const r = await runCli(["validate-idl"], { stdin: new Uint8Array(16 * 1024 * 1024 + 1).fill(0x20) });
    assert.equal(r.code, 1);
    assert.equal(r.stderr, "Failed to read interface description from stdin: too large (more than 16777216 bytes)\n");
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

  test("-i replaces the file atomically: same mode, no temp file left, through a symlink", async () => {
    const sub = join(dir.path, "atomic");
    await mkdir(sub);
    const path = join(sub, "mode.varlink");
    await writeFile(path, MESSY);
    await chmod(path, 0o640);
    const link = join(sub, "link.varlink");
    await symlink(path, link);
    const r = await runCli(["format", "-i", link]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await readFile(path, "utf8"), MESSY_CANONICAL);
    assert.equal((await stat(path)).mode & 0o777, 0o640);
    assert.ok((await lstat(link)).isSymbolicLink(), "the symlink stays a symlink");
    assert.deepEqual((await readdir(sub)).sort(), ["link.varlink", "mode.varlink"]);
  });

  test("-i in a read-only directory: a writable file is written in place (no temp file possible)", async (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root ignores directory permissions");
      return;
    }
    const sub = join(dir.path, "readonly");
    await mkdir(sub);
    const path = join(sub, "x.varlink");
    await writeFile(path, MESSY);
    await chmod(sub, 0o555);
    try {
      const r = await runCli(["format", "-i", path]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, "");
      assert.equal(await readFile(path, "utf8"), MESSY_CANONICAL);
      assert.deepEqual(await readdir(sub), ["x.varlink"]);
    } finally {
      await chmod(sub, 0o755);
    }
  });

  test("-i failing to write: the original is untouched, no temp file left", async (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root ignores file permissions");
      return;
    }
    // A read-only file in a read-only directory: neither the temp file nor the in-place write can happen.
    const sub = join(dir.path, "readonly-file");
    await mkdir(sub);
    const path = join(sub, "x.varlink");
    await writeFile(path, MESSY);
    await chmod(path, 0o444);
    await chmod(sub, 0o555);
    try {
      const r = await runCli(["format", "-i", path]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /^Failed to write '.*x\.varlink': .*EACCES/);
      assert.equal(await readFile(path, "utf8"), MESSY);
      assert.deepEqual(await readdir(sub), ["x.varlink"]);
    } finally {
      await chmod(sub, 0o755);
    }
  });

  test("-i on a file with hard links: written in place, every link sees the new text", async () => {
    const sub = join(dir.path, "hardlink");
    await mkdir(sub);
    const path = join(sub, "a.varlink");
    const other = join(sub, "b.varlink");
    await writeFile(path, MESSY);
    await link(path, other);
    const r = await runCli(["format", "-i", path]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await readFile(path, "utf8"), MESSY_CANONICAL);
    assert.equal(await readFile(other, "utf8"), MESSY_CANONICAL);
    assert.equal((await stat(path)).ino, (await stat(other)).ino);
    assert.deepEqual((await readdir(sub)).sort(), ["a.varlink", "b.varlink"]);
  });

  test("-i on a long but valid file name (255 bytes): the short temp name fits", async () => {
    const sub = join(dir.path, "longname");
    await mkdir(sub);
    const path = join(sub, `${"n".repeat(255 - ".varlink".length)}.varlink`);
    await writeFile(path, MESSY);
    const r = await runCli(["format", "-i", path]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await readFile(path, "utf8"), MESSY_CANONICAL);
    assert.equal((await readdir(sub)).length, 1);
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

describe("signals during the local commands", () => {
  // stdout never takes the write (a stuck reader), so only the signal can end the command: the first one does.
  for (const [argv, signal, code] of [
    [["format", "FILE"], "SIGINT", 130],
    [["validate-idl", "FILE"], "SIGTERM", 143],
    [["codegen", "FILE"], "SIGINT", 130],
    [["help"], "SIGTERM", 143],
    [["--version"], "SIGINT", 130],
  ] as const)
    test(`${argv.join(" ")}: ${signal} → ${String(code)}`, async () => {
      const path = await file("signal.varlink", MESSY);
      const controller = new AbortController();
      let writing = false;
      const p = runCli(
        argv.map((a) => (a === "FILE" ? path : a)),
        {
          signal: controller.signal,
          beforeStdoutWrite: () => {
            writing = true;
            return new Promise(() => undefined);
          },
        },
      );
      await waitFor(() => writing);
      controller.abort(signal);
      const r = await p;
      assert.equal(r.code, code);
      assert.equal(r.stderr, "");
    });

  // run() returns 130 at the first signal; the command itself must not go on with the next file. Called directly, so
  // the test sees when it stopped.
  const runCommand = async (
    command: (ctx: Context) => Promise<number>,
    argv: string[],
    onStderr: (text: string, controller: AbortController) => void,
  ): Promise<unknown> => {
    const controller = new AbortController();
    const io = fakeIo({
      signal: controller.signal,
      onStderr: (text) => {
        onStderr(text, controller);
      },
    });
    try {
      await command(createContext(io, parseCommandLine(argv)));
      return undefined;
    } catch (e) {
      return e;
    }
  };

  test("codegen -o: a signal after the first file is written stops before the second", async () => {
    const a = await file("sig-a.varlink", IDL);
    const b = await file("sig-b.varlink", MESSY);
    const out = join(dir.path, "sig-out");
    const reason = await runCommand(codegen, ["codegen", "-o", out, a, b], (_text, controller) => {
      controller.abort("SIGINT");
    });
    assert.equal(reason, "SIGINT");
    assert.equal(signalExitCode(reason), 130);
    assert.deepEqual(await readdir(out), ["org.example.cli.ts"]);
  });

  test("format -i: a signal after the first file is written leaves the next ones untouched", async () => {
    const first = await file("sig-1.varlink", MESSY);
    // Fails to parse: its message on stderr is where the signal comes.
    const broken = await file("sig-2.varlink", "interface x\n");
    const third = await file("sig-3.varlink", MESSY);
    const reason = await runCommand(format, ["format", "-i", first, broken, third], (_text, controller) => {
      controller.abort("SIGTERM");
    });
    assert.equal(reason, "SIGTERM");
    assert.equal(await readFile(first, "utf8"), MESSY_CANONICAL);
    assert.equal(await readFile(third, "utf8"), MESSY);
  });

  test("validate-idl: an already-aborted signal reads nothing", async () => {
    const controller = new AbortController();
    controller.abort("SIGINT");
    const io = fakeIo({ signal: controller.signal, stdin: MESSY });
    await assert.rejects(
      validateIdl(createContext(io, parseCommandLine(["validate-idl", "-"]))),
      (e) => e === "SIGINT",
    );
    assert.equal(io.stdoutText(), "");
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
    // Names differing only in case are one file on a case-insensitive file system: refused before any write.
    const upper = await file("case-a.varlink", "interface org.example.Messy\nmethod F() -> ()\n");
    const caseOut = join(dir.path, "case");
    const clash = await runCli(["codegen", a, upper, "-o", caseOut]);
    assert.equal(clash.code, 1);
    assert.equal(
      clash.stderr,
      "codegen: interfaces org.example.messy and org.example.Messy would write the same file (case-insensitively).\n",
    );
    await assert.rejects(readdir(caseOut), /ENOENT/);
    const bad = await runCli(["codegen", "-"], { stdin: "interface x\n" });
    assert.match(bad.stderr, /^<stdin>:1:11: /);
    const path = await runCli(["codegen", a, "--import-path", 'x"y']);
    assert.equal(path.code, 1);
    assert.match(path.stderr, /^codegen: /);
    const none = await runCli(["codegen"]);
    assert.equal(none.stderr, "Too few arguments.\nSee 'varlink-js --help'.\n");
  });

  test("--address: two names that clash case-insensitively are refused before writing", async () => {
    const out = join(dir.path, "live-case");
    const r = await runCli(["codegen", "--address", fx.unix, "org.example.cli", "org.example.cli", "-o", out]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /interface org\.example\.cli is given more than once/);
    await assert.rejects(readdir(out), /ENOENT/);
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
