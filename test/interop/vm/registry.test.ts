// The registry with systemd's tools (DESIGN.md §4.6, §5.4): varlinkctl calls through the entry a varlink-js server
// published; resolveInterface finds it. The filesystem-only parts are in test/unit/node/registry.test.ts. Linux only.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { listen, resolveInterface } from "../../../src/node/index.ts";
import { createServer } from "../../../src/rpc/index.ts";
import { needs, run } from "./helpers.ts";

describe("registry + varlinkctl", { skip: needs("varlinkctl") }, () => {
  let dir = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "vj-reg-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("varlinkctl call unix:<registry>/<iface>; entries gone after shutdown", async () => {
    const reg = join(dir, "registry");
    const server = createServer({ onError: () => undefined });
    server.addInterface("interface org.example.bound\n\nmethod Hello(name: string) -> (greeting: string)\n", {
      Hello: (p: { name: string }) => ({ greeting: `hi ${p.name}` }),
    });
    await server.serve(await listen(join(dir, "bound.sock")), { registry: { directory: reg } });
    try {
      const address = await resolveInterface("org.example.bound", { directory: reg, resolver: false });
      assert.equal(address, `unix:${join(reg, "org.example.bound")}`);
      const { stdout } = await run("varlinkctl", ["call", address, "org.example.bound.Hello", '{"name":"vm"}']);
      assert.deepEqual(JSON.parse(stdout), { greeting: "hi vm" });
    } finally {
      await server.shutdown();
    }
    assert.deepEqual(readdirSync(reg), []);
  });
});
