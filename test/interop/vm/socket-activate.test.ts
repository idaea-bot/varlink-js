// systemd-socket-activate → our listenAuto() (DESIGN.md §5.8): a listening fd (named and unnamed), an accepted
// connection (Accept=yes style, detected via /proc), and a registry bound on an inherited fd (kept at exit). Linux
// only.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { connect, listRegistry } from "../../../src/node/index.ts";
import { FIXTURE, needs, start, waitForPath, which, within } from "./helpers.ts";

const skip = needs("systemd-socket-activate");

interface PingReply {
  pid: number;
  address: string;
}

describe("systemd-socket-activate", { skip }, () => {
  let dir = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "vj-sa-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const tool = (): string => which("systemd-socket-activate") ?? "systemd-socket-activate";

  for (const named of [true, false])
    test(`a listening fd (${named ? "--fdname=varlink" : "no LISTEN_FDNAMES"}): Ping, address from /proc`, async () => {
      const path = join(dir, named ? "named" : "unnamed");
      const child = start(tool(), [
        "-l",
        path,
        ...(named ? ["--fdname=varlink"] : []),
        "--",
        process.execPath,
        FIXTURE,
      ]);
      try {
        await waitForPath(path);
        const conn = await connect(`unix:${path}`, { timeout: 10_000 });
        const reply = (await conn.call("org.example.vm.Ping")) as unknown as PingReply;
        assert.equal(reply.address, `unix:${path}`);
        assert.equal(typeof reply.pid, "number");
        await conn.close();
        // exitOnIdle 0: the service exits once the only connection closed.
        assert.equal(await within(child.exited, "the service to exit on idle"), 0, child.stderr());
      } finally {
        await child.stop();
      }
    });

  test("--accept: a connected fd per connection (detected via /proc); the child exits after the call", async () => {
    const path = join(dir, "accept");
    const child = start(tool(), ["--accept", "-l", path, "--fdname=varlink", "--", process.execPath, FIXTURE]);
    try {
      await waitForPath(path);
      const pids = new Set<number>();
      for (let i = 0; i < 2; i++) {
        const conn = await connect(`unix:${path}`, { timeout: 10_000 });
        const reply = (await conn.call("org.example.vm.Ping")) as unknown as PingReply;
        // An accepted unix socket carries the listener's bound path in /proc/net/unix.
        assert.equal(reply.address, `unix:${path}`);
        pids.add(reply.pid);
        await conn.close();
        await within(conn.closed, "the connection to close");
      }
      assert.equal(pids.size, 2, "one service instance per connection");
    } finally {
      await child.stop();
    }
  });

  test("the registry on an inherited listening fd: bound while serving, kept at exit (the socket is not ours)", async () => {
    const path = join(dir, "registered");
    const reg = join(dir, "registry");
    const child = start(tool(), [
      "-l",
      path,
      "--fdname=varlink",
      "--",
      process.execPath,
      FIXTURE,
      `--registry=${reg}`,
      "--idle=200",
    ]);
    try {
      await waitForPath(path);
      const conn = await connect(`unix:${path}`, { timeout: 10_000 });
      await conn.call("org.example.vm.Ping");
      // serve() resolved before the call was answered? Not necessarily: wait for the entry.
      await waitForPath(join(reg, "org.example.vm"));
      assert.deepEqual(
        (await listRegistry({ directory: reg })).map((e) => [e.interface, e.target]),
        [["org.example.vm", path]],
      );
      const viaRegistry = await connect(`unix:${join(reg, "org.example.vm")}`, { timeout: 10_000 });
      assert.equal(((await viaRegistry.call("org.example.vm.Ping")) as unknown as PingReply).address, `unix:${path}`);
      await viaRegistry.close();
      await conn.close();
      assert.equal(await within(child.exited, "the service to exit on idle"), 0, child.stderr());
      // The service manager owns the socket (a connect would activate the service again): the entry stays.
      assert.deepEqual(readdirSync(reg), ["org.example.vm"], "kept at shutdown");
      assert.equal(readlinkSync(join(reg, "org.example.vm")), path);
      assert.equal(existsSync(path), true, "the activated socket is not ours to unlink");
    } finally {
      await child.stop();
    }
  });
});
