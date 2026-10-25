// systemd's varlinkctl against our server, and our IDL formatter against `varlinkctl validate-idl`; our client
// against the userdb Multiplexer (DESIGN.md §7.4). Linux with systemd >= 255 only: runs when VARLINK_VARLINKCTL=1
// (the Interop workflow's varlinkctl job), skipped otherwise. Every command goes through execFile (no shell).
/* eslint-disable @typescript-eslint/require-await -- streaming handlers are async generators without awaits */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { after, before, describe, test, type TestContext } from "node:test";
import { formatInterface, parseInterface } from "../../src/idl/index.ts";
import { VarlinkError } from "../../src/index.ts";
import { connect, listen } from "../../src/node/index.ts";
import { createServer, type Server } from "../../src/rpc/index.ts";
import { createCertificationServer, readCertificationIdl } from "../../examples/certification/certification.ts";
import { gate, REQUIRE_INTEROP, ROOT, tempDir } from "./helpers.ts";

const ENABLED = process.env["VARLINK_VARLINKCTL"] === "1";
const I = "org.example.interop";
const IDL_URL = new URL("org.example.interop.varlink", import.meta.url);
const MULTIPLEXER = "/run/systemd/userdb/io.systemd.Multiplexer";
const REQUIRE_MULTIPLEXER = process.env["VARLINK_REQUIRE_MULTIPLEXER"] === "1";
const GET_USER_RECORD = "io.systemd.UserDatabase.GetUserRecord";
/**
 * systemd 255 rejects these (`[string]()`), ours and the originals alike (test/corpus/VARLINKCTL.md); a newer
 * systemd may accept them, and then the re-prints are compared like the rest.
 */
const SYSTEMD_255_REJECTS = new Set([
  "python-varlink/org.varlink.certification.varlink",
  "rust-varlink/varlink-certification__org.varlink.certification.varlink",
  "rust-varlink/varlink_generator__tests__org.example.complex.varlink",
]);

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command (no shell, 30 s timeout); a non-zero exit is a result, a spawn failure or timeout rejects. */
function run(command: string, args: readonly string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30_000, maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
      if (error === null) resolve({ code: 0, stdout, stderr });
      else if (typeof error.code === "number") resolve({ code: error.code, stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")}: ${error.message}\n${stdout}\n${stderr}`));
    });
  });
}

function record(t: TestContext, args: readonly string[], r: Run): void {
  t.diagnostic(
    `$ varlinkctl ${args.join(" ")}\nexit ${String(r.code)}\n--- stdout ---\n${r.stdout}--- stderr ---\n${r.stderr}`,
  );
}

/** `varlinkctl args…`, recorded in the test's diagnostics. */
async function varlinkctl(t: TestContext, ...args: string[]): Promise<Run> {
  const r = await run("varlinkctl", args);
  record(t, args, r);
  return r;
}

/** `varlinkctl …` that must succeed. */
async function ok(t: TestContext, ...args: string[]): Promise<string> {
  const r = await varlinkctl(t, ...args);
  assert.equal(r.code, 0, `varlinkctl ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** JSON values printed one per line (`--json=short`), with or without JSON-SEQ record separators. */
function jsonLines(stdout: string): unknown[] {
  return stdout
    .replaceAll("\u001e", "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as unknown);
}

test("varlinkctl suite enabled when required", (t) => {
  // Under VARLINK_REQUIRE_INTEROP the suite must not be skipped silently for want of VARLINK_VARLINKCTL.
  if (REQUIRE_INTEROP) assert.ok(ENABLED, "VARLINK_REQUIRE_INTEROP=1 needs VARLINK_VARLINKCTL=1 for this file");
  else if (!ENABLED) t.skip("set VARLINK_VARLINKCTL=1 (Linux, systemd >= 255)");
});

describe("varlinkctl", { skip: ENABLED ? false : "set VARLINK_VARLINKCTL=1 (Linux, systemd >= 255)" }, () => {
  let missing: string | null = "not checked";
  let server: Server | undefined;
  let socketPath = "";
  let interopIdl = "";
  let cleanup: (() => Promise<void>) | undefined;
  const notified: string[] = [];

  before(async () => {
    try {
      await run("varlinkctl", ["--version"]);
      missing = null;
    } catch (e) {
      missing = `varlinkctl is not available: ${String(e)}`;
      return;
    }
    interopIdl = await readFile(IDL_URL, "utf8");
    const tmp = await tempDir();
    cleanup = tmp.remove;
    socketPath = join(tmp.dir, "interop.sock");
    server = createServer({
      vendor: "varlink-js",
      product: "interop",
      version: "1",
      url: "https://github.com/pzmarzly/varlink-js",
      validateReplies: "throw",
      onError: (error, info) => {
        console.error(`interop server: ${info.reason}`, error);
      },
    });
    server.addInterface(interopIdl, {
      Echo: (p) => p,
      Count: async function* ({ n }: { n: number }) {
        for (let i = 1; i < n; i++) yield { i };
        return { i: n };
      },
      Notify: ({ message }: { message: string }) => {
        notified.push(message);
      },
      LastNotified: () => ({ message: notified.at(-1) ?? null }),
      Fail: ({ reason }: { reason: string }) => {
        throw new VarlinkError(`${I}.Failed`, { reason, code: 42 });
      },
    });
    server.serve(await listen(`unix:${socketPath}`));
  });

  after(async () => {
    await server?.shutdown({ graceful: false });
    await cleanup?.();
  });

  test("versions", async (t) => {
    if (gate(t, missing) !== null) return;
    const v = await ok(t, "--version");
    t.diagnostic(`varlinkctl: ${v.split("\n")[0] ?? ""}`);
    const s = await run("systemctl", ["--version"]).catch((e: unknown) => ({
      code: -1,
      stdout: String(e),
      stderr: "",
    }));
    t.diagnostic(`systemctl: ${s.stdout.split("\n")[0] ?? ""}`);
  });

  test("info", async (t) => {
    if (gate(t, missing) !== null) return;
    const text = await ok(t, "info", socketPath);
    assert.match(text, /varlink-js/);
    assert.match(text, /interop/);
    assert.match(text, /org\.example\.interop/);
    const [info] = jsonLines(await ok(t, "--json=short", "info", socketPath));
    assert.deepEqual(info, {
      vendor: "varlink-js",
      product: "interop",
      version: "1",
      url: "https://github.com/pzmarzly/varlink-js",
      interfaces: ["org.varlink.service", I, "io.github.pzmarzly.varlinkjs"],
    });
  });

  test("list-interfaces", async (t) => {
    if (gate(t, missing) !== null) return;
    const names = (await ok(t, "list-interfaces", socketPath)).split("\n").filter((l) => l !== "");
    assert.deepEqual(names.toSorted(), ["io.github.pzmarzly.varlinkjs", I, "org.varlink.service"].toSorted());
  });

  /** systemd's re-print of IDL text (validate-idl on a temp file). */
  const reprint = async (t: TestContext, text: string, name: string): Promise<Run> => {
    const tmp = await tempDir();
    try {
      const file = join(tmp.dir, name);
      await writeFile(file, text);
      return await varlinkctl(t, "validate-idl", file);
    } finally {
      await tmp.remove();
    }
  };

  for (const name of [I, "org.varlink.service"]) {
    test(`introspect ${name} equals validate-idl of the registered text`, async (t) => {
      if (gate(t, missing) !== null) return;
      const introspected = await ok(t, "introspect", socketPath, name);
      const conn = await connect(`unix:${socketPath}`);
      const registered = await conn.getInterfaceDescription(name).finally(() => conn.close());
      if (name === I) assert.equal(registered, interopIdl);
      const r = await reprint(t, registered, `${name}.varlink`);
      assert.equal(r.code, 0);
      assert.equal(introspected, r.stdout);
    });
  }

  test("call: parameters round-trip", async (t) => {
    if (gate(t, missing) !== null) return;
    const params = {
      int: -7,
      float: 2.5,
      string: 'héllo "varlink"',
      bool: true,
      nullable: "here",
      array: [1, 2, 3],
      map: { a: "A", b: "B" },
      color: "green",
      shape: {
        name: "tri",
        color: "blue",
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 2 },
        ],
        tags: { k: "v" },
        label: "L",
      },
    };
    const [reply] = jsonLines(await ok(t, "--json=short", "call", socketPath, `${I}.Echo`, JSON.stringify(params)));
    assert.deepEqual(reply, params);
  });

  test("call --more: every reply, the stream ends", async (t) => {
    if (gate(t, missing) !== null) return;
    // varlinkctl prints parameters only; it exits 0 only after a reply without `continues`, so a clean exit with
    // exactly n replies means the last one was final and none before it was.
    const replies = jsonLines(await ok(t, "--more", "--json=short", "call", socketPath, `${I}.Count`, '{"n":5}'));
    assert.deepEqual(replies, [{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }]);
  });

  test("call --oneway: the handler runs", async (t) => {
    if (gate(t, missing) !== null) return;
    const message = `oneway ${String(process.pid)}`;
    const out = await ok(t, "--oneway", "call", socketPath, `${I}.Notify`, JSON.stringify({ message }));
    assert.equal(out.trim(), "");
    const deadline = Date.now() + 10_000;
    while (!notified.includes(message)) {
      assert.ok(Date.now() < deadline, "the oneway call never reached the handler");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const [last] = jsonLines(await ok(t, "--json=short", "call", socketPath, `${I}.LastNotified`, "{}"));
    assert.deepEqual(last, { message });
  });

  test("call: error reply", async (t) => {
    if (gate(t, missing) !== null) return;
    const r = await varlinkctl(t, "--json=short", "call", socketPath, `${I}.Fail`, '{"reason":"because"}');
    assert.notEqual(r.code, 0);
    assert.match(r.stdout + r.stderr, /org\.example\.interop\.Failed/);
  });

  test("call: unknown method → MethodNotFound", async (t) => {
    if (gate(t, missing) !== null) return;
    const r = await varlinkctl(t, "call", socketPath, `${I}.Nope`, "{}");
    assert.notEqual(r.code, 0);
    // systemd 255 prints the error name; newer varlinkctl (259 on ubuntu-latest) maps the well-known
    // org.varlink.service errors to an errno (MethodNotFound → ENXIO) and prints the parameters on stdout.
    if (!/org\.varlink\.service\.MethodNotFound/.test(r.stdout + r.stderr)) {
      assert.match(r.stderr, /No such device or address/);
      assert.deepEqual(jsonLines(r.stdout), [{ method: `${I}.Nope` }]);
    }
  });

  describe("validate-idl: systemd's re-print of the original equals that of formatInterface(parseInterface(x))", () => {
    const corpus = join(ROOT, "test/corpus");
    const files = async (): Promise<string[]> =>
      (await readdir(corpus, { recursive: true }))
        .filter((f) => f.endsWith(".varlink"))
        .map((f) => join(corpus, f))
        .toSorted();

    test("corpus and the interop interface", async (t) => {
      if (gate(t, missing) !== null) return;
      const all = [...(await files()), new URL(IDL_URL).pathname];
      assert.ok(all.length >= 27, `expected the corpus, found ${String(all.length)} files`);
      for (const file of all) {
        await t.test(relative(ROOT, file), async (st) => {
          const text = await readFile(file, "utf8");
          const original = await varlinkctl(st, "validate-idl", file);
          const ours = await reprint(st, formatInterface(parseInterface(text)), "formatted.varlink");
          if (original.code !== 0) {
            // Only the files systemd 255 rejects (`[string]()`) may be rejected, and then ours must be too.
            assert.ok(SYSTEMD_255_REJECTS.has(relative(corpus, file)), "systemd accepts the original");
            assert.notEqual(ours.code, 0, "systemd rejects our formatting like the original");
            st.diagnostic("rejected by this systemd, original and ours alike (test/corpus/VARLINKCTL.md)");
            return;
          }
          assert.equal(ours.code, 0, "systemd accepts our formatting");
          assert.equal(ours.stdout, original.stdout);
        });
      }
    });
  });

  test("introspect and call our certification server", async (t) => {
    if (gate(t, missing) !== null) return;
    const { server: cert } = await createCertificationServer({ onError: () => undefined });
    const tmp = await tempDir();
    try {
      const path = join(tmp.dir, "cert.sock");
      cert.serve(await listen(`unix:${path}`));
      const validated = await varlinkctl(t, "validate-idl", join(ROOT, "interfaces/org.varlink.certification.varlink"));
      const r = await varlinkctl(t, "introspect", path, "org.varlink.certification");
      assert.equal(r.code, 0);
      if (validated.code === 0) assert.equal(r.stdout, validated.stdout);
      else {
        // systemd 255 and 259 cannot parse `[string]()`; introspect then prints the description verbatim.
        assert.equal(r.stdout.trimEnd(), (await readCertificationIdl()).trimEnd());
        t.diagnostic("this systemd rejects the certification IDL ([string]()); introspect printed it verbatim");
      }
      const [started] = jsonLines(await ok(t, "--json=short", "call", path, "org.varlink.certification.Start", "{}"));
      assert.match(String((started as Record<string, unknown>)["client_id"]), /^[0-9a-f]{32}$/);
    } finally {
      await cert.shutdown({ graceful: false });
      await tmp.remove();
    }
  });

  describe("userdb Multiplexer", () => {
    let socketMissing: string | null = null;
    before(async () => {
      try {
        await access(MULTIPLEXER);
      } catch {
        socketMissing = `${MULTIPLEXER} does not exist (systemd-userdbd not running)`;
      }
    });

    test("GetUserRecord with more: all records, root among them", async (t) => {
      if (gate(t, missing) !== null) return;
      if (socketMissing !== null) {
        // The CI job starts systemd-userdbd and sets VARLINK_REQUIRE_MULTIPLEXER: a missing socket fails there.
        assert.ok(!REQUIRE_MULTIPLEXER, socketMissing);
        t.skip(socketMissing);
        return;
      }
      const conn = await connect(`unix:${MULTIPLEXER}`);
      const records: Record<string, unknown>[] = [];
      try {
        for await (const reply of conn.stream(GET_USER_RECORD, { service: "io.systemd.Multiplexer" }))
          records.push(reply["record"] as Record<string, unknown>);
      } finally {
        await conn.close();
      }
      t.diagnostic(`our client: ${String(records.length)} records`);
      assert.ok(
        records.some((r) => r["userName"] === "root" && r["uid"] === 0),
        "a record with userName root and uid 0",
      );
      const args = [
        "--more",
        "--json=short",
        "call",
        MULTIPLEXER,
        GET_USER_RECORD,
        '{"service":"io.systemd.Multiplexer"}',
      ];
      const first = jsonLines(await ok(t, ...args)).length;
      const second = jsonLines(await ok(t, ...args)).length;
      t.diagnostic(`varlinkctl: ${String(first)} and ${String(second)} records`);
      // The user database may change between runs; compare only when varlinkctl itself saw a stable count.
      if (first === second) assert.equal(records.length, first);
    });

    test("GetUserRecord root without more", async (t) => {
      if (gate(t, missing) !== null) return;
      if (socketMissing !== null) {
        // The CI job starts systemd-userdbd and sets VARLINK_REQUIRE_MULTIPLEXER: a missing socket fails there.
        assert.ok(!REQUIRE_MULTIPLEXER, socketMissing);
        t.skip(socketMissing);
        return;
      }
      const conn = await connect(`unix:${MULTIPLEXER}`);
      try {
        const reply = await conn.call(GET_USER_RECORD, { userName: "root", service: "io.systemd.Multiplexer" });
        const rec = reply["record"] as Record<string, unknown>;
        t.diagnostic(JSON.stringify(reply));
        assert.equal(rec["userName"], "root");
        assert.equal(rec["uid"], 0);
      } finally {
        await conn.close();
      }
    });
  });
});
