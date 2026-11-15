// Runs the examples end to end as child processes (README.md quick start, docs/MIGRATION.md, examples/codegen,
// examples/reference-server.ts), so every documented example works as shown.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { generate } from "../../src/codegen/index.ts";
import {
  ExpectedMoreError,
  InterfaceNotFoundError,
  isVarlinkError,
  MethodNotFoundError,
  type Connection,
} from "../../src/index.ts";
import { connect } from "../../src/node/index.ts";
import { readRepoFile, runExample, runExampleOk, startServer, type RunningServer } from "./helpers.ts";

const TIMEOUT = { timeout: 30_000 };
const UNIX_SKIP = process.platform === "win32" ? "unix sockets: not on Windows" : false;

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "vjdocs-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Runs `body` against a started server and checks that SIGTERM then ends it with exit code 0. */
async function withServer(
  file: string,
  args: readonly string[],
  body: (server: RunningServer) => Promise<void>,
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  const server = await startServer(file, args, cwd);
  let failed = true;
  try {
    await body(server);
    failed = false;
  } finally {
    const r = await server.stop("SIGTERM");
    if (!failed) assert.equal(r.code, 0, `${file} exit code after SIGTERM; stderr:\n${r.stderr}`);
  }
  return server.output();
}

async function withConnection(address: string, body: (conn: Connection) => Promise<void>): Promise<void> {
  const conn = await connect(address);
  try {
    await body(conn);
  } finally {
    await conn.close();
  }
}

async function rejectsWith(p: Promise<unknown>, check: (e: unknown) => boolean, what: string): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    assert.ok(check(e), `${what}: got ${String(e)}`);
    return e;
  }
  assert.fail(`${what}: did not reject`);
}

/** What examples/reference-server.ts must do on any address. */
async function checkReferenceServer(address: string): Promise<void> {
  const out = await runExampleOk("examples/client.ts", [address]);
  assert.match(out, /^varlink-js reference-server 1 \(https:\/\/github\.com\/pzmarzly\/varlink-js\)$/m);
  assert.match(out, /^ {2}org\.varlink\.service$/m);
  assert.match(out, /^ {2}org\.example\.reference$/m);

  await withConnection(address, async (conn) => {
    // F9: descriptions come from the registered interfaces only, never from the file system.
    for (const name of ["../../etc/hosts#", "/etc/passwd", "../examples/reference-server.ts", "org.example.nope"]) {
      const e = await rejectsWith(
        conn.call("org.varlink.service.GetInterfaceDescription", { interface: name }),
        (x) => InterfaceNotFoundError.is(x),
        `GetInterfaceDescription(${name})`,
      );
      assert.equal((e as InterfaceNotFoundError).error, "org.varlink.service.InterfaceNotFound");
    }
    const description = await conn.getInterfaceDescription("org.example.reference");
    assert.match(
      description,
      /^# The varlink-js reference server's demo interface\.\ninterface org\.example\.reference\n/,
    );
    assert.ok(readRepoFile("examples/reference-server.ts").includes(description), "served verbatim from the source");

    assert.deepEqual(await conn.call("org.example.reference.Ping", { ping: "x" }), { pong: "x" });
    assert.deepEqual(await conn.call("org.example.reference.Lookup", { word: "oneway" }), {
      meaning: "a call that gets no reply",
    });
    const notFound = await rejectsWith(
      conn.call("org.example.reference.Lookup", { word: "xyzzy" }),
      (x) => isVarlinkError(x, "org.example.reference.NotFound"),
      "Lookup(xyzzy)",
    );
    assert.deepEqual((notFound as { parameters: unknown }).parameters, { word: "xyzzy" });

    const replies: unknown[] = [];
    for await (const r of conn.stream("org.example.reference.Count", { n: 3 })) replies.push(r);
    assert.deepEqual(replies, [{ i: 1 }, { i: 2 }, { i: 3 }]);
    await rejectsWith(
      conn.collect("org.example.reference.Count", { n: 0 }),
      (x) => isVarlinkError(x, "org.example.reference.OutOfRange"),
      "Count(0)",
    );
    await rejectsWith(conn.call("org.example.reference.Count", { n: 2 }), (x) => ExpectedMoreError.is(x), "no more");

    // Oneway: no reply is written, so the next call gets its own reply (F5), and the message was recorded.
    await conn.oneway("org.example.reference.Log", { message: "hello" });
    await conn.oneway("org.example.reference.Ping", { ping: "unanswered" });
    assert.deepEqual(await conn.call("org.example.reference.Messages"), { messages: ["hello"] });
  });
}

describe("examples/reference-server.ts", () => {
  test(
    "unix socket: mode 0644, GetInfo client, demo interface, path traversal, SIGTERM",
    { ...TIMEOUT, skip: UNIX_SKIP },
    async () => {
      const path = join(dir, "ref.sock");
      await withServer("examples/reference-server.ts", [`--varlink=unix:${path}`], async (server) => {
        assert.equal(server.address, `unix:${path}`);
        const st = await stat(path);
        assert.ok(st.isSocket());
        assert.equal(st.mode & 0o777, 0o644);
        await checkReferenceServer(server.address);
      });
      assert.equal(existsSync(path), false, "the socket is removed at shutdown");
    },
  );

  test(
    "default address: unix:./org.example.reference.sock with mode 0644",
    { ...TIMEOUT, skip: UNIX_SKIP },
    async () => {
      const cwd = await mkdtemp(join(dir, "default-"));
      await withServer(
        "examples/reference-server.ts",
        [],
        async (server) => {
          assert.equal(server.address, "unix:./org.example.reference.sock");
          const st = await stat(join(cwd, "org.example.reference.sock"));
          assert.equal(st.mode & 0o777, 0o644);
        },
        cwd,
      );
    },
  );

  test("tcp:127.0.0.1:0: the real port is printed; SIGINT also shuts down with 0", TIMEOUT, async () => {
    const server = await startServer("examples/reference-server.ts", ["--varlink=tcp:127.0.0.1:0"]);
    try {
      assert.match(server.address, /^tcp:127\.0\.0\.1:[1-9]\d*$/);
      await checkReferenceServer(server.address);
    } finally {
      const r = await server.stop("SIGINT");
      assert.equal(r.code, 0, r.stderr);
    }
  });

  test("refuses non-loopback TCP hosts and non-listenable kinds (exit 2, nothing bound)", TIMEOUT, async () => {
    for (const address of ["tcp:0.0.0.0:0", "tcp:[::]:0", "tcp:192.0.2.1:0", "exec:/bin/true"]) {
      const r = await runExample("examples/reference-server.ts", [`--varlink=${address}`]);
      assert.equal(r.code, 2, `${address}: ${r.stderr}`);
      assert.equal(r.stdout, "", address);
      assert.match(r.stderr, /^reference-server: (refusing to listen on|cannot listen on)/, address);
    }
  });
});

describe("README quick start: examples/server.ts and examples/demo-client.ts", () => {
  test("tcp:127.0.0.1:0 (the default)", TIMEOUT, async () => {
    await withServer("examples/server.ts", [], async (server) => {
      assert.match(server.address, /^tcp:127\.0\.0\.1:[1-9]\d*$/);
      const out = await runExampleOk("examples/demo-client.ts", [server.address]);
      assert.equal(out, "Hello, world!\n1\n2\n3\norg.example.demo.OutOfRange: max is 100\n");
    });
  });

  test("unix socket", { ...TIMEOUT, skip: UNIX_SKIP }, async () => {
    const path = join(dir, "demo.sock");
    await withServer("examples/server.ts", [`unix:${path}`], async (server) => {
      assert.equal((await stat(path)).mode & 0o777, 0o644);
      const out = await runExampleOk("examples/demo-client.ts", [server.address]);
      assert.match(out, /^Hello, world!\n/);
      const info = await runExampleOk("examples/client.ts", [server.address]);
      assert.equal(
        info,
        "Example demo 1.0 (https://example.org)\n  org.varlink.service\n  org.example.demo\n  io.github.pzmarzly.varlinkjs\n",
      );
    });
  });
});

describe("examples/codegen", () => {
  test("the committed generated module is up to date", TIMEOUT, async () => {
    const expected = generate(readRepoFile("examples/codegen/org.example.notes.varlink"), {
      importPath: "../../src/index.ts",
    });
    assert.equal(expected.fileName, "org.example.notes.ts");
    assert.equal(expected.constName, "OrgExampleNotes");
    assert.equal(
      readRepoFile("examples/codegen/org.example.notes.ts"),
      expected.code,
      "examples/codegen/org.example.notes.ts is stale: run node examples/codegen/generate.ts",
    );
    const out = await runExampleOk("examples/codegen/generate.ts", ["--check"]);
    assert.equal(out, "org.example.notes.ts (OrgExampleNotes) is up to date\n");
  });

  test("typed server and client", TIMEOUT, async () => {
    await withServer("examples/codegen/server.ts", [], async (server) => {
      const out = await runExampleOk("examples/codegen/client.ts", [server.address]);
      assert.equal(out, "note 1: buy milk [shopping]\nlisted: buy milk\nno note 999\n");
      // A second run sees both notes, the last one as the final reply.
      const again = await runExampleOk("examples/codegen/client.ts", [server.address]);
      assert.equal(again, "note 2: buy milk [shopping]\nlisted: buy milk\nlisted: buy milk\nno note 999\n");
    });
  });
});

describe("docs/MIGRATION.md samples (examples/migration)", () => {
  test("server.ts: built-in GetInfo, Echo, oneway Log, streaming Ticks; binds 127.0.0.1", TIMEOUT, async () => {
    const output = await withServer("examples/migration/server.ts", ["tcp:127.0.0.1:0"], async (server) => {
      assert.match(server.address, /^tcp:127\.0\.0\.1:[1-9]\d*$/);
      await withConnection(server.address, async (conn) => {
        const info = await conn.getInfo();
        assert.deepEqual(info, {
          vendor: "varlink-js",
          product: "varlink-js",
          version: "0.0.1",
          url: "https://example.com",
          interfaces: ["org.varlink.service", "org.example.migration", "io.github.pzmarzly.varlinkjs"],
        });
        assert.deepEqual(await conn.call("org.example.migration.Echo", { text: "hi" }), { text: "hi" });
        await conn.oneway("org.example.migration.Log", { message: "logged oneway" });
        assert.deepEqual(await conn.collect("org.example.migration.Ticks", { count: 3 }), [
          { tick: 1 },
          { tick: 2 },
          { tick: 3 },
        ]);
        await rejectsWith(
          conn.call("org.example.migration.Nope"),
          (x) => MethodNotFoundError.is(x),
          "unknown method → MethodNotFound",
        );
      });
    });
    assert.match(output.stderr, /^log: logged oneway$/m);
  });

  test("client.ts, errors.ts, streaming.ts, pool.ts against the reference server", TIMEOUT, async () => {
    await withServer("examples/reference-server.ts", ["--varlink=tcp:127.0.0.1:0"], async (server) => {
      const a = [server.address];
      assert.equal(await runExampleOk("examples/migration/client.ts", a), "string\ntrue\n");
      assert.equal(
        await runExampleOk("examples/migration/errors.ts", a),
        [
          'org.example.reference.NotFound {"word":"xyzzy"}',
          'org.varlink.service.MethodNotFound {"method":"org.example.reference.NoSuchMethod"}',
          "org.example.reference.NotFound",
          "local error: ConnectionClosedError",
          "",
        ].join("\n"),
      );
      assert.equal(
        await runExampleOk("examples/migration/streaming.ts", a),
        "reply 1\nreply 2\nreply 3\nstream failed: org.example.reference.OutOfRange\ncollected 3 replies\n",
      );
      const pool = await runExampleOk("examples/migration/pool.ts", a);
      const m = /^a b c d e f\nopen connections: (\d+)\n$/.exec(pool);
      assert.ok(m !== null, pool);
      const size = Number(m[1]);
      assert.ok(size >= 1 && size <= 4, `pool size ${String(size)}`);
    });
  });
});
