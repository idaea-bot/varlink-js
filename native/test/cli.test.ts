// `varlink-js call --push-fd=` and `--exec` end to end (DESIGN.md §4.14, M11): the CLI as a child process (node
// src/cli/main.ts) with VARLINK_JS_NATIVE pointing at this package, against a varlink-js server in this process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { checkFdLeaks, kernelHasPassRights, native, readFd, SKIP, startServer, T, tempDir } from "./helpers.ts";

const root = resolve(import.meta.dirname, "../..");
const main = join(root, "src/cli/main.ts");
const addon = join(root, "native/index.js");

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the CLI with `args`; `fds` become its fds 3, 4, …; `env` adds to the environment. */
function cli(args: readonly string[], fds: readonly number[] = [], env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [main, ...args], {
      stdio: ["ignore", "pipe", "pipe", ...fds],
      env: { ...process.env, VARLINK_JS_NATIVE: addon, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.once("error", reject);
    child.once("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

describe("CLI --push-fd= and --exec", { skip: SKIP }, () => {
  checkFdLeaks();
  const dir = tempDir();

  test("--push-fd=3 (an fd the CLI inherited): the server writes through it", T, async () => {
    const fx = await startServer(dir(), "c1.sock");
    try {
      const [r, w] = native.pipe();
      const result = await cli(["call", "--push-fd=3", fx.address, "org.example.fd.Write", '{"text":"via cli"}'], [w]);
      native.close(w);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "{}\n");
      assert.equal(readFd(r), "via cli");
      native.close(r);
    } finally {
      await fx.close();
    }
  });

  test("--push-fd= repeated, a path opened read-only and an fd twice: all arrive", T, async () => {
    const fx = await startServer(dir(), "c2.sock");
    try {
      const [r, w] = native.pipe();
      const result = await cli(
        ["call", "--push-fd=/dev/null", "--push-fd=3", "--push-fd=3", fx.address, "org.example.fd.Count", "{}"],
        [w],
      );
      native.close(r);
      native.close(w);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, '{"n":3}\n');
    } finally {
      await fx.close();
    }
  });

  test("--push-fd= to a server without fd input (default): the call runs, the fd is dropped", T, async () => {
    const fx = await startServer(dir(), "c8a.sock", { allowFdPassingInput: false });
    try {
      const result = await cli(["call", "--push-fd=/dev/null", fx.address, "org.example.fd.Count", "{}"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, '{"n":0}\n');
    } finally {
      await fx.close();
    }
  });

  test(
    "--push-fd= to a strict server without fd input: ≥ 6.16 a clear failure (EPERM), else the call runs",
    T,
    async () => {
      const passRights = await kernelHasPassRights();
      const fx = await startServer(dir(), "c8.sock", { allowFdPassingInput: false }, true);
      try {
        const result = await cli(["call", "--push-fd=/dev/null", fx.address, "org.example.fd.Count", "{}"]);
        if (passRights) {
          assert.equal(result.code, 1);
          assert.match(
            result.stderr,
            /^Method call org\.example\.fd\.Count\(\) failed: .*does not accept file descriptors/,
          );
        } else {
          assert.equal(result.code, 0, result.stderr);
          assert.equal(result.stdout, '{"n":0}\n');
        }
      } finally {
        await fx.close();
      }
    },
  );

  test("--push-fd= errors use varlinkctl's messages", T, async () => {
    const fx = await startServer(dir(), "c3.sock");
    try {
      const bad = await cli(["call", "--push-fd=abc", fx.address, "org.example.fd.Count", "{}"]);
      assert.equal(bad.code, 1);
      assert.equal(bad.stderr, "Failed to parse --push-fd= parameter: abc\n");
      const closed = await cli(["call", "--push-fd=77", fx.address, "org.example.fd.Count", "{}"]);
      assert.equal(closed.code, 1);
      assert.match(closed.stderr, /^Failed to duplicate file descriptor 77: bad file descriptor\n$/i);
      const missing = await cli(["call", "--push-fd=./no/such/file", fx.address, "org.example.fd.Count", "{}"]);
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /^Failed to open '\.\/no\/such\/file': no such file or directory\n$/i);
      const noAddon = await cli(["call", "--push-fd=0", fx.address, "org.example.fd.Count", "{}"], [], {
        VARLINK_JS_NATIVE: join(dir(), "absent.js"),
      });
      assert.equal(noAddon.code, 1);
      assert.equal(noAddon.stderr, "--push-fd= requires the optional varlink-js-native addon (Linux)\n");
      const upgrade = await cli(["call", "--upgrade", "--push-fd=0", fx.address, "org.example.fd.Cat"]);
      assert.equal(upgrade.code, 1);
      assert.equal(
        upgrade.stderr,
        "--upgrade may not be combined with --collect/--more/--oneway/--push-fd=/--graceful.\nSee 'varlink-js --help'.\n",
      );
    } finally {
      await fx.close();
    }
  });

  test(
    "--exec: the reply on stdin, its fds as 3, 4, … with LISTEN_FDS and LISTEN_PID; exit status passed on",
    T,
    async () => {
      const fx = await startServer(dir(), "c4.sock");
      try {
        const script =
          'cat; cat <&3; echo " fds=$LISTEN_FDS"; [ "$LISTEN_PID" = "$$" ] && echo pid-ok; ' +
          '[ -z "$LISTEN_FDNAMES" ] && echo names-unset; exit 7';
        const result = await cli(
          [
            "call",
            "--exec",
            fx.address,
            "org.example.fd.Open",
            '{"text":"from the fd"}',
            "--",
            "/bin/sh",
            "-c",
            script,
          ],
          [],
          { LISTEN_FDNAMES: "stale" },
        );
        assert.equal(result.code, 7, result.stderr);
        assert.equal(result.stdout, "{}\nfrom the fd fds=1\npid-ok\nnames-unset\n");
      } finally {
        await fx.close();
      }
    },
  );

  test("--exec without fds in the reply: no LISTEN_FDS; --json=pretty is honoured; usage checks", T, async () => {
    const fx = await startServer(dir(), "c5.sock");
    try {
      const plain = await cli(
        [
          "call",
          "--exec",
          fx.address,
          "org.example.fd.Count",
          "{}",
          "--",
          "/bin/sh",
          "-c",
          'cat; echo "[${LISTEN_FDS-}]"',
        ],
        [],
        { LISTEN_FDS: "5", LISTEN_PID: "1" },
      );
      assert.equal(plain.code, 0, plain.stderr);
      assert.equal(plain.stdout, '{"n":0}\n[]\n');
      const pretty = await cli([
        "call",
        "--exec",
        "--json=pretty",
        fx.address,
        "org.example.fd.Count",
        "{}",
        "--",
        "cat",
      ]);
      assert.equal(pretty.stdout, '{\n\t"n" : 0\n}\n');
      const noCommand = await cli(["call", "--exec", fx.address, "org.example.fd.Count", "{}"]);
      assert.equal(noCommand.code, 1);
      assert.equal(noCommand.stderr, "Expected command line to execute.\nSee 'varlink-js --help'.\n");
      const more = await cli(["call", "--exec", "--more", fx.address, "org.example.fd.Count", "{}", "--", "cat"]);
      assert.equal(more.code, 1);
      assert.equal(
        more.stderr,
        "--exec and --collect/--more/--oneway may not be combined.\nSee 'varlink-js --help'.\n",
      );
      // An error reply: printed as usual, the command does not run.
      const failed = await cli(["call", "--exec", fx.address, "org.example.fd.Nope", "{}", "--", "echo", "ran"]);
      assert.equal(failed.code, 1);
      assert.doesNotMatch(failed.stdout, /ran/);
      assert.match(failed.stderr, /MethodNotFound/);
    } finally {
      await fx.close();
    }
  });

  test(
    "--exec --graceful: the error reply's parameters and fds go to the command (varlinkctl.c:1139-1155)",
    T,
    async () => {
      const fx = await startServer(dir(), "c6.sock");
      try {
        const result = await cli([
          "call",
          "--exec",
          "--graceful=org.example.fd.Nope",
          fx.address,
          "org.example.fd.FailWithFd",
          '{"text":"on the error"}',
          "--",
          "/bin/sh",
          "-c",
          'cat; cat <&3; echo " fds=$LISTEN_FDS"',
        ]);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout, "{}\non the error fds=1\n");
        assert.match(result.stderr, /returned expected error: org\.example\.fd\.Nope/);
        // Not graceful: the fds of the error reply are closed, nothing runs.
        const failed = await cli([
          "call",
          "--exec",
          fx.address,
          "org.example.fd.FailWithFd",
          '{"text":"x"}',
          "--",
          "cat",
        ]);
        assert.equal(failed.code, 1);
        assert.match(failed.stderr, /failed: org\.example\.fd\.Nope/);
      } finally {
        await fx.close();
      }
    },
  );

  test("--exec with fds: a command word starting with '-' never reaches the shell's exec as an option", T, async () => {
    const fx = await startServer(dir(), "c7.sock");
    try {
      const bare = await cli(["call", "--exec", fx.address, "org.example.fd.Open", '{"text":"x"}', "--", "-l"]);
      assert.equal(bare.code, 1);
      assert.match(bare.stderr, /Refusing to execute '-l': a command name may not start with '-'/);
    } finally {
      await fx.close();
    }
  });
});
