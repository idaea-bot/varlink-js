// `varlink-js certify` in-process (DESIGN.md §4.14), and the embedded certification IDL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { CERTIFICATION_IDL } from "../../../src/cli/certification-idl.ts";
import { readCertificationIdl } from "../../../src/cli/certification.ts";
import { rawServer, runCli, startFixture, waitFor, type CliResult, type Fixture } from "./helpers.ts";

test("the embedded IDL equals interfaces/org.varlink.certification.varlink byte for byte", async () => {
  const file = readFileSync(new URL("../../../interfaces/org.varlink.certification.varlink", import.meta.url));
  assert.deepEqual(new TextEncoder().encode(CERTIFICATION_IDL), new Uint8Array(file));
  assert.equal(await readCertificationIdl(), CERTIFICATION_IDL);
});

/** Starts `certify server` in-process; resolves with its address once it printed `Listening on …`. */
async function startServer(address: string): Promise<{ address: string; stop(): Promise<CliResult> }> {
  const controller = new AbortController();
  let out = "";
  const done = runCli(["certify", "server", address], { signal: controller.signal, onStdout: (t) => (out = t) });
  await waitFor(() => out.endsWith("\n"));
  const m = /^Listening on (.*)\n$/.exec(out);
  assert.ok(m?.[1] !== undefined, out);
  return {
    address: m[1],
    stop: () => {
      controller.abort("SIGTERM");
      return done;
    },
  };
}

describe("certify", () => {
  let fx: Fixture;
  before(async () => {
    fx = await startFixture();
  });
  after(async () => {
    await fx.close();
  });

  test("client against server over tcp: every step printed, `Certification passed`, server stops with 0", async () => {
    const server = await startServer("tcp:127.0.0.1:0");
    assert.match(server.address, /^tcp:127\.0\.0\.1:[1-9]\d*$/);
    const r = await runCli(["certify", "client", server.address]);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trimEnd().split("\n");
    assert.match(lines[0] ?? "", /^client_id: [0-9a-f]{32}$/);
    assert.ok(lines.some((l) => l.startsWith("Test10: ")));
    assert.ok(lines.includes("Test11: (oneway)"));
    assert.equal(lines.at(-1), "Certification passed");
    const q = await runCli(["certify", "client", "-q", server.address]);
    assert.equal(q.code, 0);
    assert.equal(q.stdout, "");
    const stopped = await server.stop();
    assert.equal(stopped.code, 0, stopped.stderr);
  });

  test("a server that is not a certification service: exit 1 with the reason", async () => {
    const r = await runCli(["certify", "client", fx.unix]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^Certification failed: org\.varlink\.service\.InterfaceNotFound/);
  });

  test("listen and connect failures", async () => {
    const server = await startServer("tcp:127.0.0.1:0");
    try {
      const busy = await runCli(["certify", "server", server.address]);
      assert.equal(busy.code, 1);
      assert.match(busy.stderr, /^Failed to listen on tcp:127\.0\.0\.1:\d+: .*EADDRINUSE/);
    } finally {
      await server.stop();
    }
    const refused = await runCli(["certify", "client", "unix:/nonexistent/x"]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^Failed to connect to unix:\/nonexistent\/x: /);
  });

  test("--timeout bounds the client run", async () => {
    // A peer that accepts and never answers: the client waits on Start until the deadline.
    const silent = await rawServer([]);
    try {
      const start = Date.now();
      const r = await runCli(["certify", "client", "--timeout=0.2", silent.address]);
      assert.equal(r.code, 1);
      assert.ok(Date.now() - start < 10_000);
      assert.equal(r.stderr, "Certification failed: timed out after 0.2s\n");
    } finally {
      await silent.close();
    }
  });
});
