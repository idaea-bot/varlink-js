// Peer credentials, pidfd, the per-UID connection limit and the user.varlink xattr with varlink-js-native
// (DESIGN.md §4.15, §5.4).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fstatSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { ConnectionClosedError } from "../../src/index.ts";
import { checkFdLeaks, LINUX, native, openFds, SKIP, startServer, T, tempDir, until } from "./helpers.ts";

const run = promisify(execFile);
const child = join(import.meta.dirname, "peer-child.ts");

/** The running Linux kernel as major + minor/1000 (0 elsewhere). */
function kernel(): number {
  if (!LINUX) return 0;
  const m = /^(\d+)\.(\d+)/.exec(release());
  return m === null ? 0 : Number(m[1]) + Number(m[2]) / 1000;
}

describe("peer credentials and limits", { skip: SKIP }, () => {
  checkFdLeaks();
  const dir = tempDir();

  test("ctx.peer is the client process's uid, gid and pid (a child process as the client)", T, async () => {
    const fx = await startServer(dir(), "p.sock");
    try {
      for (const mode of ["native", "plain"]) {
        const { stdout } = await run(process.execPath, [child, fx.address, mode]);
        const { self, peer } = JSON.parse(stdout) as {
          self: { pid: number; uid: number; gid: number };
          peer: { pid: number; uid: number; gid: number; pidfd: boolean };
        };
        assert.notEqual(self.pid, process.pid);
        assert.equal(peer.pid, self.pid, mode);
        assert.equal(peer.uid, self.uid, mode);
        assert.equal(peer.gid, self.gid, mode);
      }
    } finally {
      await fx.close();
    }
  });

  test("a native client knows its server's credentials too (capabilities.peer)", T, async () => {
    const fx = await startServer(dir(), "q.sock");
    try {
      const conn = await fx.connect();
      const { channel } = await conn.upgrade("org.example.fd.Cat", {});
      const peer = channel.capabilities.peer?.();
      assert.equal(peer?.pid, process.pid);
      assert.equal(peer.uid, process.getuid?.());
      channel.close();
    } finally {
      await fx.close();
    }
  });

  test(
    "pidfd: present on Linux ≥ 6.5, owned by the connection (closed with it)",
    { ...T, skip: kernel() < 6.005 ? `needs Linux ≥ 6.5 (SO_PEERPIDFD), not ${process.platform}` : false },
    async () => {
      const fx = await startServer(dir(), "r.sock");
      try {
        const before = openFds();
        const conn = await fx.connect();
        const peer = await conn.call("org.example.fd.Peer", {});
        assert.equal(peer.pidfd, true);
        await conn.close();
        await until(() => fx.server.connections === 0);
        await until(() => openFds() <= before);
      } finally {
        await fx.close();
      }
    },
  );

  test(
    "pidfd: fetched on first access, a view whose close() is a no-op and whose fd is -1 once the connection closed",
    { ...T, skip: kernel() < 6.005 ? `needs Linux ≥ 6.5 (SO_PEERPIDFD), not ${process.platform}` : false },
    async () => {
      const fx = await startServer(dir(), "r2.sock");
      try {
        const conn = await fx.connect();
        await conn.call("org.example.fd.Keep", { claim: false });
        const before = openFds();
        // Not fetched during the call (nobody asked): the first access opens it, the connection still being open.
        const view = fx.seen.kept[0]?.peer?.pidfd;
        assert.ok(view !== undefined && view.fd >= 0);
        assert.equal(openFds(), before + 1);
        view.close(); // no-op: the connection owns it
        assert.doesNotThrow(() => fstatSync(view.fd), "still open after the view's close()");
        assert.equal(openFds(), before + 1);
        await conn.close();
        await until(() => fx.server.connections === 0);
        assert.equal(view.fd, -1, "a stale pidfd number is never handed out");
        await until(() => openFds() <= before);
      } finally {
        await fx.close();
      }
    },
  );

  // The per-UID default (off, more than sd-varlink's 128 connections) is tested in test/unit/rpc/server-peer.test.ts.

  test("maxConnectionsPerUid: the third connection of the UID is refused; a freed slot is reusable", T, async () => {
    const fx = await startServer(dir(), "s.sock", { maxConnectionsPerUid: 2 });
    try {
      const one = await fx.connect();
      const two = await fx.connect();
      await one.call("org.example.fd.Ping", {});
      await two.call("org.example.fd.Ping", {});
      const three = await fx.connect();
      await assert.rejects(three.call("org.example.fd.Ping", {}), ConnectionClosedError);
      assert.ok(fx.errors.some((e) => e.reason === "connection-limit" && /per-UID/.test(String(e.error))));
      // The server reads the credentials (its listener has the addon): a client without the addon counts too.
      const plain = await fx.connect({ native: false });
      await assert.rejects(plain.call("org.example.fd.Ping", {}), ConnectionClosedError);
      await one.close();
      // Refused connections never counted: `two` is the only one left.
      await until(() => fx.server.connections === 1);
      const four = await fx.connect();
      assert.deepEqual(await four.call("org.example.fd.Ping", {}), {});
    } finally {
      await fx.close();
    }
  });

  test("user.varlink xattr: best effort, never throws (what the kernel says is recorded)", T, async (t) => {
    const fx = await startServer(dir(), "x.sock");
    try {
      const conn = await fx.connect();
      assert.deepEqual(await conn.call("org.example.fd.Ping", {}), {});
      // Probe directly what the library swallowed, on a connected socket of our own.
      const sock = native.connect(Buffer.from(fx.address.slice("unix:".length)));
      let outcome = "ok";
      try {
        native.setXattr(sock.getFd(), "client");
        native.removeXattr(sock.getFd());
      } catch (e) {
        outcome = (e as { code?: string }).code ?? String(e);
      }
      t.diagnostic(`fsetxattr(user.varlink) on a unix socket (${process.platform}): ${outcome}`);
      sock.close();
    } finally {
      await fx.close();
    }
  });
});
