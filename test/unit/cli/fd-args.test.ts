// `call --push-fd=` and `--exec` parsing (M11, DESIGN.md §4.14): varlinkctl's combinations and messages, and the
// clear failures without the optional varlink-js-native addon (the fake CliIo has none). Runs on every runtime.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseCommandLine } from "../../../src/cli/args.ts";
import { run, type CliIo } from "../../../src/cli/run.ts";

function io(): { io: CliIo; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      stdin: { isTTY: false, [Symbol.asyncIterator]: async function* () {} },
      stdout: {
        isTTY: false,
        write: (d) => {
          out += String(d);
          return Promise.resolve();
        },
      },
      stderr: {
        isTTY: false,
        write: (d) => {
          err += String(d);
          return Promise.resolve();
        },
      },
      env: {},
    },
    out: () => out,
    err: () => err,
  };
}

describe("call --push-fd= / --exec parsing", () => {
  test("--push-fd= is repeatable and kept in order; --exec is a flag", () => {
    const cli = parseCommandLine(["call", "--push-fd=3", "--push-fd", "/etc/hosts", "--exec", "a", "b.C", "{}", "x"]);
    assert.deepEqual(cli.pushFds, ["3", "/etc/hosts"]);
    assert.equal(cli.exec, true);
    assert.deepEqual(cli.args, ["a", "b.C", "{}", "x"]);
    assert.deepEqual(parseCommandLine(["call", "a", "b.C"]).pushFds, []);
  });

  test("--upgrade with --push-fd= and --exec with --more/--collect/--oneway: varlinkctl's messages", () => {
    assert.throws(() => parseCommandLine(["call", "--upgrade", "--push-fd=3", "a", "b.C"]), {
      message: "--upgrade may not be combined with --collect/--more/--oneway/--push-fd=/--graceful.",
    });
    for (const flag of ["--more", "-E", "--collect", "--oneway"])
      assert.throws(() => parseCommandLine(["call", "--exec", flag, "a", "b.C", "{}", "x"]), {
        message: "--exec and --collect/--more/--oneway may not be combined.",
      });
  });

  test("without the addon: --push-fd= fails clearly before connecting", async () => {
    const t = io();
    const code = await run(["call", "--push-fd=0", "unix:/nonexistent/x", "org.example.Ping", "{}"], t.io);
    assert.equal(code, 1);
    assert.equal(t.err(), "--push-fd= requires the optional varlink-js-native addon (Linux)\n");
  });

  test("--exec needs a command line after PARAMETERS", async () => {
    const t = io();
    assert.equal(await run(["call", "--exec", "unix:/nonexistent/x", "org.example.Ping", "{}"], t.io), 1);
    assert.equal(t.err(), "Expected command line to execute.\nSee 'varlink-js --help'.\n");
  });
});
