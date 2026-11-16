// varlinkctl against our services (DESIGN.md §5.8): `exec:` (varlinkctl passes a connected socketpair as fd 3 with
// LISTEN_FDNAMES=varlink) and `info unix:` on a registry-bound server. Linux only.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { listen } from "../../../src/node/index.ts";
import { createServer } from "../../../src/rpc/index.ts";
import { fixtureWrapper, needs, run, systemdVersion } from "./helpers.ts";

const skip = needs("varlinkctl");
/** varlinkctl has `exec:` addresses in systemd 255 (verified: `varlinkctl info exec:/usr/lib/systemd/systemd-pcrextend` on Ubuntu 24.04, 255.4). */
const EXEC_SINCE = 255;

describe("varlinkctl", { skip }, () => {
  let dir = "";
  let version = 0;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "vj-vc-"));
    version = await systemdVersion("varlinkctl");
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("call exec:<fixture> org.example.vm.Ping", async (t) => {
    if (version < EXEC_SINCE) {
      t.skip(`varlinkctl ${String(version)} has no exec: (needs ${String(EXEC_SINCE)})`);
      return;
    }
    const wrapper = await fixtureWrapper(dir);
    const { stdout } = await run("varlinkctl", ["call", `exec:${wrapper}`, "org.example.vm.Ping", "{}"]);
    const reply = JSON.parse(stdout) as { pid: number; address: string };
    assert.equal(typeof reply.pid, "number");
    // A socketpair has no name: the connected-fd placeholder.
    assert.equal(reply.address, "fd:3");
  });

  test("info exec:<fixture>", async (t) => {
    if (version < EXEC_SINCE) {
      t.skip(`varlinkctl ${String(version)} has no exec: (needs ${String(EXEC_SINCE)})`);
      return;
    }
    const wrapper = await fixtureWrapper(dir);
    const { stdout } = await run("varlinkctl", ["info", `exec:${wrapper}`]);
    assert.match(stdout, /varlink-js fixture/);
    assert.match(stdout, /org\.example\.vm/);
    assert.match(stdout, /org\.varlink\.service/);
  });

  test("info unix:<path> of a registry-bound server", async () => {
    const path = join(dir, "bound.sock");
    const server = createServer({ product: "varlink-js registry", onError: () => undefined });
    server.addInterface("interface org.example.bound\n\nmethod Ping() -> ()\n", { Ping: () => ({}) });
    await server.serve(await listen(path), { registry: { directory: join(dir, "registry") } });
    try {
      const { stdout } = await run("varlinkctl", ["info", `unix:${path}`]);
      assert.match(stdout, /varlink-js registry/);
      assert.match(stdout, /org\.example\.bound/);
    } finally {
      await server.shutdown();
    }
  });
});
