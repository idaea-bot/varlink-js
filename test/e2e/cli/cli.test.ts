// End-to-end tests of the real `varlink-js` bin (DESIGN.md §4.14): `node src/cli/main.ts` as a child process against
// a server in this process, and `certify server` ↔ `certify client` as two children. Node only (spawns
// process.execPath with the .ts file, which Node ≥ 22.18 runs by stripping types). Every test waits for the child to
// exit by itself, so a dangling handle fails it (by timeout).
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { RS, startFixture, waitFor, type Fixture } from "../../unit/cli/helpers.ts";

const MAIN = fileURLToPath(new URL("../../../src/cli/main.ts", import.meta.url));
const VERSION = (
  JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }
).version;
const BIG = '{"max":9223372036854775807,"min":-9223372036854775808,"u":18446744073709551615}';
const TIMEOUT = { timeout: 30_000 };

interface Child {
  readonly child: ChildProcessWithoutNullStreams;
  /** stdout so far. */
  stdout(): string;
  stderr(): string;
  /** Resolves with the exit code and signal once the child exited and its streams closed. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function start(args: readonly string[], env: Record<string, string> = {}): Child {
  const child = spawn(process.execPath, [MAIN, ...args], {
    env: { ...process.env, ...env, VARLINK_JS_DEBUG: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (b: Buffer) => out.push(b));
  child.stderr.on("data", (b: Buffer) => err.push(b));
  child.stdin.on("error", () => undefined);
  child.stdout.on("error", () => undefined);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  return {
    child,
    stdout: () => Buffer.concat(out).toString("utf8"),
    stderr: () => Buffer.concat(err).toString("utf8"),
    exited,
  };
}

/** Runs the bin to completion; `stdin` is written and closed (default: closed at once). */
async function runBin(
  args: readonly string[],
  stdin = "",
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const c = start(args);
  c.child.stdin.end(stdin);
  const { code, signal } = await c.exited;
  return { code, signal, stdout: c.stdout(), stderr: c.stderr() };
}

let fx: Fixture;
before(async () => {
  fx = await startFixture();
});
after(async () => {
  await fx.close();
});

describe("varlink-js (real process)", () => {
  test("--version", TIMEOUT, async () => {
    const r = await runBin(["--version"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, `${VERSION}\n`);
  });

  test("info", TIMEOUT, async () => {
    const r = await runBin(["info", fx.unix]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^ {4}Vendor: varlink-js tests\n/);
    assert.match(r.stdout, /\nInterfaces: io\.github\.pzmarzly\.varlinkjs\n {12}org\.example\.cli\n/);
  });

  test("call, and exit codes of an error reply and a usage error", TIMEOUT, async () => {
    const r = await runBin(["call", fx.tcp, "org.example.cli.Echo", '{"value":[1,"two"]}']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '{"value":[1,"two"]}\n');
    const failed = await runBin(["call", fx.unix, "org.example.cli.Fail", '{"error":"org.example.other.No"}']);
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr, "Method call org.example.cli.Fail() failed: org.example.other.No\n");
    const usage = await runBin(["call", "--frobnicate"]);
    assert.equal(usage.code, 1);
    assert.match(usage.stderr, /--frobnicate.*\nSee 'varlink-js --help'\.\n$/);
  });

  test("an expected failure prints one line, no stack", TIMEOUT, async () => {
    const r = await runBin(["call", "unix:/nonexistent/sock", "a.b.C", "{}"]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr.split("\n").length, 2, r.stderr);
    assert.match(r.stderr, /^Failed to connect to unix:\/nonexistent\/sock: /);
  });

  test("call --more: JSON-SEQ bytes", TIMEOUT, async () => {
    const r = await runBin(["call", "--more", fx.unix, "org.example.cli.Count", '{"n":3}']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(Buffer.from(r.stdout), Buffer.from(`${RS}{"i":0}\n${RS}{"i":1}\n${RS}{"i":2}\n`));
  });

  test("int precision through a real process: call, --more, --collect", TIMEOUT, async () => {
    const single = await runBin(["call", fx.unix, "org.example.cli.Echo", `{"value":${BIG}}`]);
    assert.equal(single.stdout, `{"value":${BIG}}\n`);
    const more = await runBin(["call", "--more", fx.unix, "org.example.cli.Count", `{"n":1,"value":${BIG}}`]);
    assert.equal(more.stdout, `${RS}{"i":0,"value":${BIG}}\n`);
    const collect = await runBin(["call", "--collect", fx.unix, "org.example.cli.Count", `{"n":1,"value":${BIG}}`]);
    assert.equal(collect.stdout, `[{"i":0,"value":${BIG}}]\n`);
  });

  test("--graceful: exit 0, parameters printed, the notice on stderr", TIMEOUT, async () => {
    const r = await runBin([
      "call",
      "--graceful=org.example.other.Fine",
      fx.unix,
      "org.example.cli.Fail",
      '{"error":"org.example.other.Fine","parameters":{"x":1}}',
    ]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '{"x":1}\n');
    assert.equal(r.stderr, "Method call org.example.cli.Fail() returned expected error: org.example.other.Fine\n");
  });

  test("--oneway", TIMEOUT, async () => {
    const r = await runBin(["call", "--oneway", fx.unix, "org.example.cli.Log", '{"text":"from-e2e"}']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "");
    await waitFor(() => fx.logged.includes("from-e2e"));
  });

  test("parameters piped into stdin", TIMEOUT, async () => {
    const r = await runBin(["call", fx.unix, "org.example.cli.Echo"], `{"value":${BIG}}\n`);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `{"value":${BIG}}\n`);
    const empty = await runBin(["call", fx.unix, "org.example.cli.Preview", "-"], "");
    assert.equal(empty.code, 0, empty.stderr);
    assert.equal(empty.stdout, "{}\n");
  });

  test("stdout closed early while -E streams (`| head -1`): exit 0, no stack", TIMEOUT, async () => {
    const ended = fx.monitorsEnded;
    const c = start(["call", "-E", fx.unix, "org.example.cli.Monitor", "{}"]);
    c.child.stdin.end();
    await waitFor(() => c.stdout().length > 0, 20_000);
    c.child.stdout.destroy();
    const { code, signal } = await c.exited;
    assert.equal(signal, null);
    assert.equal(code, 0, c.stderr());
    assert.equal(c.stderr(), "");
    await waitFor(() => fx.monitorsEnded > ended);
  });

  test("SIGINT during -E: exit code 130, the connection closed", TIMEOUT, async () => {
    const ended = fx.monitorsEnded;
    const c = start(["call", "-E", fx.unix, "org.example.cli.Monitor", "{}"]);
    c.child.stdin.end();
    await waitFor(() => c.stdout().split(RS).length > 2, 20_000);
    c.child.kill("SIGINT");
    const { code, signal } = await c.exited;
    assert.equal(signal, null);
    assert.equal(code, 130, c.stderr());
    assert.equal(c.stderr(), "");
    await waitFor(() => fx.monitorsEnded > ended);
  });

  test("SIGTERM during a call: exit code 143", TIMEOUT, async () => {
    const c = start(["call", fx.unix, "org.example.cli.Hang", "{}"]);
    const hangs = fx.hangs;
    c.child.stdin.end();
    // Wait until the call is in flight (a fixed delay raced the child's startup on CI: killed before main.ts ran).
    await waitFor(() => fx.hangs > hangs, 20_000);
    c.child.kill("SIGTERM");
    const { code } = await c.exited;
    assert.equal(code, 143, c.stderr());
  });

  test("bridge as a byte pipe: a call on stdin, the reply on stdout, stdin EOF ends it", TIMEOUT, async () => {
    const c = start(["bridge", fx.unix]);
    c.child.stdin.write(`${JSON.stringify({ method: "org.example.cli.Echo", parameters: { value: "piped" } })}\0`);
    await waitFor(() => c.stdout().includes("\0"), 20_000);
    c.child.stdin.end();
    const { code } = await c.exited;
    assert.equal(code, 0, c.stderr());
    assert.equal(c.stdout(), '{"parameters":{"value":"piped"}}\0');
  });

  test("certify client ↔ certify server, both as children", TIMEOUT, async () => {
    const server = start(["certify", "server", "tcp:127.0.0.1:0"]);
    server.child.stdin.end();
    try {
      await waitFor(() => server.stdout().includes("\n"), 20_000);
      const m = /^Listening on (tcp:127\.0\.0\.1:\d+)\n$/.exec(server.stdout());
      assert.ok(m?.[1] !== undefined, server.stdout() + server.stderr());
      const client = await runBin(["certify", "client", m[1]]);
      assert.equal(client.code, 0, client.stderr);
      assert.match(client.stdout, /\nCertification passed\n$/);
    } finally {
      server.child.kill("SIGTERM");
    }
    const { code } = await server.exited;
    assert.equal(code, 0, server.stderr());
  });
});
