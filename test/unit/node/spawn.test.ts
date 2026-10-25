// Spawned transports (DESIGN.md §4.6, §5.8): exec: (connected and listening), bridge argv, ssh-unix:/ssh-exec: with
// a fake ssh, the ssh-exec word splitter.
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import diagnostics from "node:diagnostics_channel";
import { chmod, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { CallTimeoutError } from "../../../src/core/errors/index.ts";
import { connect, connectBridge, connectExec, listen } from "../../../src/node/index.ts";
import { openBridge, openSpawned, splitCommandLine } from "../../../src/node/spawn.ts";
import { createServer, type Connection } from "../../../src/rpc/index.ts";
import { tempDir } from "./helpers.ts";

const dir = tempDir();
const CHILD = resolve(import.meta.dirname, "activation-child.ts");

interface PingReply {
  pid: number;
  before: Record<string, string>;
  after: Record<string, string>;
  address: string;
  argv: string[];
}

const ping = async (conn: Connection): Promise<PingReply> =>
  (await conn.call("org.example.child.Ping")) as unknown as PingReply;

/** An executable `#!/bin/sh` wrapper that runs the child fixture with node (exec: needs one executable path). */
async function wrapper(): Promise<string> {
  const path = join(dir(), "child.sh");
  if (!existsSync(path)) {
    await writeFile(path, `#!/bin/sh\nexec "${process.execPath}" "${CHILD}" "$@"\n`);
    await chmod(path, 0o755);
  }
  return path;
}

const gone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as { code?: unknown }).code === "ESRCH";
  }
};

const never = new AbortController().signal;
const exitOf = (child: { once(ev: "exit", cb: (code: number | null, signal: string | null) => void): unknown }) =>
  new Promise<{ code: number | null; signal: string | null }>((r) => {
    child.once("exit", (code, signal) => {
      r({ code, signal });
    });
  });

describe("exec:", () => {
  // The child runs listenAuto() with the default accept: "auto" everywhere (off Linux the hint says "connected").
  test("connected (default): LISTEN_* for the child, unset by listenAuto; the child is gone after close", async () => {
    const cmd = await wrapper();
    const conn = await connectExec(cmd, {
      argv: ["ignored-argv0", "--some-arg"],
      // Ours must not leak: an inherited LISTEN_PIDFDID would make a systemd child ignore its fds.
      env: {
        ...process.env,
        LISTEN_PIDFDID: "12345",
        SYSTEMD_VARLINK_LISTEN: "/nonexistent/x",
        LISTEN_FDS: "7",
        VARLINK_ADDRESS: "unix:/nonexistent/y",
      },
    });
    const reply = await ping(conn);
    assert.deepEqual(reply.before, {
      LISTEN_PID: String(reply.pid),
      LISTEN_FDS: "1",
      LISTEN_FDNAMES: "varlink",
      // Set by the shell with LISTEN_PID: the same pid.
      VARLINK_JS_ACTIVATION: `connected:${String(reply.pid)}`,
    });
    assert.deepEqual(reply.after, {});
    // A socketpair end has no bound path, not even in /proc.
    assert.equal(reply.address, "fd:3");
    assert.deepEqual(reply.argv.slice(1), ["--some-arg"]);
    await conn.close();
    await conn.closed;
    assert.ok(gone(reply.pid), "the child was reaped when closed resolved");
  });

  test("via connect('exec:…', { spawn })", async () => {
    const cmd = await wrapper();
    const conn = await connect(`exec:${cmd}`);
    assert.equal(typeof (await ping(conn)).pid, "number");
    await conn.close();
    await conn.closed;
  });

  test("half-close: after our FIN the child still answers, then exits on its own (exit-on-idle)", async () => {
    const cmd = await wrapper();
    const ch = await openSpawned({ kind: "exec", path: cmd }, undefined, never);
    const exited = exitOf(ch.child);
    await ch.write(new TextEncoder().encode('{"method":"org.example.child.Ping"}\0'));
    await ch.end();
    let text = "";
    for (;;) {
      const chunk = await ch.read();
      if (chunk === null) break;
      text += new TextDecoder().decode(chunk.bytes);
    }
    assert.match(text, /"pid":\d+/);
    assert.deepEqual(await exited, { code: 0, signal: null });
    ch.close();
    await ch.closed;
  });

  test("the child's FIN does not end our write side", async () => {
    // A child that closes its side right away: our end() and write() must not throw synchronously.
    const sh = join(dir(), "fin.sh");
    await writeFile(sh, "#!/bin/sh\nexec 3>&-\nsleep 1\n");
    await chmod(sh, 0o755);
    const ch = await openSpawned({ kind: "exec", path: sh }, undefined, never);
    assert.equal(await ch.read(), null);
    // The write goes out (or fails with EPIPE): either way a settled promise, not a crash.
    await ch.write(new Uint8Array([1])).catch(() => undefined);
    ch.close();
    await ch.closed;
  });

  test("a child that ignores SIGTERM is SIGKILLed after killTimeout", async () => {
    const cmd = await wrapper();
    const ch = await openSpawned({ kind: "exec", path: cmd }, { argv: [cmd, "--linger"], killTimeout: 100 }, never);
    const exited = exitOf(ch.child);
    // Wait until it serves (its SIGTERM handler is installed by then).
    await ch.write(new TextEncoder().encode('{"method":"org.example.child.Ping"}\0'));
    assert.notEqual(await ch.read(), null);
    ch.close();
    await ch.closed;
    assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
  });

  test("listening: VARLINK_ADDRESS names the socket; its private directory is removed on close", async () => {
    const cmd = await wrapper();
    // The default accept: "auto" too (no hint: listening). An inherited hint or address must not leak.
    const conn = await connectExec(cmd, {
      socket: "listening",
      env: { ...process.env, VARLINK_JS_ACTIVATION: "connected", VARLINK_ADDRESS: "unix:/nonexistent/y" },
    });
    const reply = await ping(conn);
    const address = reply.before.VARLINK_ADDRESS ?? "";
    assert.equal(reply.before.VARLINK_JS_ACTIVATION, undefined);
    assert.match(address, /^unix:\/.+\/socket$/);
    assert.equal(reply.before.LISTEN_FDS, "1");
    assert.equal(reply.before.LISTEN_PID, String(reply.pid));
    const path = address.slice("unix:".length);
    assert.ok(existsSync(path), "the socket stays at its path while connected");
    await conn.close();
    await conn.closed;
    assert.equal(existsSync(dirname(path)), false);
    assert.ok(gone(reply.pid));
  });

  test("bad commands", async () => {
    for (const bad of ["relative/x", "/a/../b", "/a//b", "/a/", "./x"])
      await assert.rejects(connectExec(bad), TypeError, bad);
    await assert.rejects(connectExec("/nonexistent/varlink-js-test"), { code: "ENOENT" });
    const plain = join(dir(), "not-executable");
    await writeFile(plain, "");
    await chmod(plain, 0o644);
    await assert.rejects(connectExec(plain), { code: "EACCES" });
  });

  test("options are checked", async () => {
    const cmd = await wrapper();
    await assert.rejects(connectExec(cmd, { argv: [] }), TypeError);
    await assert.rejects(connectExec(cmd, { socket: "nope" as "listening" }), TypeError);
    await assert.rejects(connectExec(cmd, { stderr: "pipe" as "ignore" }), TypeError);
    await assert.rejects(connectExec(cmd, { killTimeout: -1 }), RangeError);
  });

  test("an aborted signal rejects with its reason", async () => {
    const cmd = await wrapper();
    const reason = new Error("stop");
    await assert.rejects(connectExec(cmd, { signal: AbortSignal.abort(reason) }), (e) => e === reason);
  });

  for (const socket of ["connected", "listening"] as const)
    test(`${socket}: an abort while the child is being spawned kills it (and removes the private directory)`, async () => {
      const cmd = await wrapper();
      const ac = new AbortController();
      const reason = new Error("stop");
      const result = await withSpawnHook(
        () => {
          ac.abort(reason);
        },
        () => connectExec(cmd, { socket, signal: ac.signal }),
      );
      assert.equal(result.error, reason);
      assert.notEqual((await result.exit).signal, null, "killed, not exited on its own");
      assert.deepEqual(result.tmp, [], "no private directory left");
    });

  test("listening: the timeout expiring during the connect phase kills the child", async () => {
    const cmd = await wrapper();
    const result = await withSpawnHook(
      () => {
        // Overrun the 50 ms timeout synchronously, right at the spawn: the timer fires before the connect completes.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
      },
      () => connectExec(cmd, { socket: "listening", timeout: 50 }),
    );
    assert.ok(result.error instanceof CallTimeoutError, String(result.error));
    assert.notEqual((await result.exit).signal, null);
    assert.deepEqual(result.tmp, []);
  });
});

/**
 * Runs `connectAttempt` with `hook` called synchronously when it spawns the child (the `child_process`
 * diagnostics channel), and TMPDIR pointing at a fresh directory (so the listening mode's private one shows up there).
 * Expects the attempt to reject: the error, the child's exit, and what is left in that TMPDIR.
 */
async function withSpawnHook(
  hook: () => void,
  connectAttempt: () => Promise<Connection>,
): Promise<{ error: unknown; exit: Promise<{ code: number | null; signal: string | null }>; tmp: string[] }> {
  const tmp = await mkdtemp(join(dir(), "tmp-"));
  const savedTmp = process.env.TMPDIR;
  let child: ChildProcess | undefined;
  const onSpawn = (message: unknown): void => {
    if (child !== undefined) return;
    child = (message as { process: ChildProcess }).process;
    hook();
  };
  diagnostics.subscribe("child_process", onSpawn);
  process.env.TMPDIR = tmp;
  try {
    const conn = await connectAttempt().then(
      (c) => c,
      (e: unknown) => ({ error: e }),
    );
    assert.ok("error" in conn, "the connect rejected");
    assert.ok(child !== undefined, "a child was spawned");
    const spawned = child;
    const exit =
      spawned.exitCode !== null || spawned.signalCode !== null
        ? Promise.resolve({ code: spawned.exitCode, signal: spawned.signalCode })
        : exitOf(spawned);
    return { error: conn.error, exit, tmp: await readdir(tmp) };
  } finally {
    diagnostics.unsubscribe("child_process", onSpawn);
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  }
}

describe("bridge", () => {
  test("varlink over the child's stdio (SYSTEMD_VARLINK_LISTEN=- via env(1))", async () => {
    const conn = await connectBridge(["/usr/bin/env", "SYSTEMD_VARLINK_LISTEN=-", process.execPath, CHILD], {
      env: { ...process.env, SYSTEMD_VARLINK_LISTEN: "/nonexistent/x", LISTEN_PID: "1" },
    });
    const reply = await ping(conn);
    assert.deepEqual(reply.before, { SYSTEMD_VARLINK_LISTEN: "-" });
    assert.equal(reply.address, "stdio:");
    await conn.close();
    await conn.closed;
    assert.ok(gone(reply.pid));
  });

  test("the child exits on its own after our end() (exit-on-idle over stdio)", async () => {
    const ch = await openBridge(["/usr/bin/env", "SYSTEMD_VARLINK_LISTEN=-", process.execPath, CHILD], {}, never);
    const exited = exitOf(ch.child);
    await ch.write(new TextEncoder().encode('{"method":"org.example.child.Ping"}\0'));
    await ch.end();
    let n = 0;
    while ((await ch.read()) !== null) n++;
    assert.ok(n > 0);
    assert.deepEqual(await exited, { code: 0, signal: null });
    ch.close();
    await ch.closed;
  });

  test("a stdio server closing its connection sends EOF while the process still runs", async () => {
    // --hold: the child stays alive after its server closed, so EOF can only come from closing the channel.
    const ch = await openBridge(
      ["/usr/bin/env", "SYSTEMD_VARLINK_LISTEN=-", process.execPath, CHILD, "--hold"],
      { killTimeout: 0 },
      never,
    );
    await ch.write(new TextEncoder().encode('{"method":"org.example.child.Ping"}\0'));
    await ch.end();
    let eof = false;
    const read = (async () => {
      while ((await ch.read()) !== null);
      eof = true;
    })();
    const deadline = new Promise((r) => setTimeout(r, 5000).unref());
    await Promise.race([read, deadline]);
    assert.ok(eof, "EOF before the child exited");
    assert.equal(ch.child.exitCode, null, "the child is still running");
    ch.close();
    await ch.closed;
  });

  test("errors", async () => {
    await assert.rejects(connectBridge([]), TypeError);
    await assert.rejects(connectBridge(["/nonexistent/varlink-js-test"]), { code: "ENOENT" });
  });
});

describe("ssh (fake ssh binary)", () => {
  /** A fake ssh: logs its argv as a JSON line, then `-W path host` → pipes stdio to the unix socket, else runs the
   *  words after the host. */
  async function fakeSsh(): Promise<{ ssh: string; log: string; env: Record<string, string | undefined> }> {
    const ssh = join(dir(), "fake-ssh.mjs");
    const log = join(dir(), "ssh.log");
    await writeFile(
      ssh,
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { connect } from "node:net";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "-W") {
  const s = connect({ path: args[1], allowHalfOpen: true });
  s.on("error", () => process.exit(255));
  process.stdin.pipe(s);
  s.pipe(process.stdout);
} else {
  const words = args.slice(args.indexOf("-T") + 2);
  const c = spawn(words[0], words.slice(1), { stdio: "inherit" });
  c.on("exit", (code) => process.exit(code ?? 1));
}
`,
    );
    await chmod(ssh, 0o755);
    await writeFile(log, "");
    return { ssh, log, env: { ...process.env, FAKE_SSH_LOG: log } };
  }

  const lastArgv = async (log: string): Promise<string[]> =>
    JSON.parse((await readFile(log, "utf8")).trim().split("\n").at(-1) ?? "null") as string[];

  test("ssh-unix: (and ssh:) run `ssh -W <path> <host>`", async () => {
    const fake = await fakeSsh();
    const path = join(dir(), "remote.sock");
    const server = createServer({ onError: () => undefined });
    server.addInterface("interface org.example.remote\n\nmethod Hi() -> (pid: int)\n", {
      Hi: () => ({ pid: process.pid }),
    });
    server.serve(await listen(`unix:${path}`));
    try {
      for (const scheme of ["ssh-unix", "ssh"]) {
        const conn = await connect(`${scheme}:my.host:${path}`, { spawn: { ssh: fake.ssh, env: fake.env } });
        assert.deepEqual(await conn.call("org.example.remote.Hi"), { pid: process.pid });
        assert.deepEqual(await lastArgv(fake.log), ["-W", path, "my.host"]);
        await conn.close();
        await conn.closed;
      }
    } finally {
      await server.shutdown({ graceful: false });
    }
  });

  test("ssh-exec: runs `ssh -e none -T <host> env SYSTEMD_VARLINK_LISTEN=- <words…>`", async () => {
    const fake = await fakeSsh();
    const conn = await connect(`ssh-exec:user@host:'${process.execPath}' "${CHILD}" --name=x\\tz`, {
      spawn: { ssh: fake.ssh, env: fake.env },
    });
    const reply = await ping(conn);
    assert.deepEqual(reply.before, { SYSTEMD_VARLINK_LISTEN: "-" });
    assert.deepEqual(await lastArgv(fake.log), [
      "-e",
      "none",
      "-T",
      "user@host",
      "env",
      "SYSTEMD_VARLINK_LISTEN=-",
      process.execPath,
      CHILD,
      "--name=x\tz",
    ]);
    await conn.close();
    await conn.closed;
  });

  test("$SYSTEMD_SSH is the default binary", async () => {
    const fake = await fakeSsh();
    const saved = process.env.SYSTEMD_SSH;
    process.env.SYSTEMD_SSH = fake.ssh;
    try {
      const conn = await connect(`ssh-exec:h:${process.execPath} ${CHILD}`, { spawn: { env: fake.env } });
      assert.equal(typeof (await ping(conn)).pid, "number");
      await conn.close();
      await conn.closed;
    } finally {
      if (saved === undefined) delete process.env.SYSTEMD_SSH;
      else process.env.SYSTEMD_SSH = saved;
    }
  });

  test("hosts and paths are checked before anything is spawned", async () => {
    const fake = await fakeSsh();
    const spawn = { ssh: fake.ssh, env: fake.env };
    for (const address of [
      "ssh-unix:-oProxyCommand=evil:/run/x",
      "ssh-exec:-oProxyCommand=evil:cmd",
      "ssh-unix:a b:/run/x",
      "ssh-unix:a\tb:/run/x",
      "ssh-exec:a\u0001b:cmd",
      "ssh-unix:h:/run/../x",
      "ssh-unix:h:/run/x/",
      "ssh-exec:h:   ",
      "ssh-exec:h:'unterminated",
    ])
      await assert.rejects(connect(address, { spawn }), TypeError, address);
    assert.equal(await readFile(fake.log, "utf8"), "", "ssh never ran");
  });
});

describe("splitCommandLine (sd-varlink strv_split_full UNQUOTE|CUNESCAPE)", () => {
  test("words", () => {
    const table: [string, string[]][] = [
      ["a b  c", ["a", "b", "c"]],
      ["  lead\ttab\nnl\rcr  ", ["lead", "tab", "nl", "cr"]],
      ["", []],
      [" \t ", []],
      ["'a b' \"c d\"", ["a b", "c d"]],
      ["a'b c'd", ["ab cd"]],
      ["''", [""]],
      ["'' x", ["", "x"]],
      ['"it\'s"', ["it's"]],
      ["'say \"hi\"'", ['say "hi"']],
      ["'\\n'", ["\n"]], // escapes are decoded inside single quotes too (sd extract-word.c)
      ['"\\n"', ["\n"]],
      ["a\\sb", ["a b"]],
      ["\\t\\\\\\\"\\'", ["\t\\\"'"]],
      ["\\a\\b\\f\\r\\v\\s", ["\x07\b\f\r\v "]],
      ["\\x41\\102", ["AB"]],
      ["\\xc3\\xa9", ["é"]],
      ["\\u00e9\\U0001F600", ["é😀"]],
      ["日本 語", ["日本", "語"]],
    ];
    for (const [input, words] of table) assert.deepEqual(splitCommandLine(input), words, JSON.stringify(input));
  });

  test("errors", () => {
    for (const bad of [
      "'open",
      '"open',
      "trailing\\",
      "\\q",
      "a\\ b", // no escaped separators (EXTRACT_UNESCAPE_SEPARATORS is not set): use \s
      "\\x4",
      "\\x00",
      "\\000",
      "\\12",
      "\\400",
      "\\xff",
      "\\uD800",
      "'\\q'",
      "\\U00110000",
    ])
      assert.throws(() => splitCommandLine(bad), TypeError, JSON.stringify(bad));
  });
});
