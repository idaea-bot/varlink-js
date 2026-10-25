// listen() (DESIGN.md §4.11): unix stale/live/non-socket paths, mode, unlink on close, tcp addresses, errors and
// the iterator.
import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createServer as createNetServer, connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import { describe, test } from "node:test";
import { OperationNotSupportedError } from "../../../src/core/errors/index.ts";
import type { ByteChannel } from "../../../src/core/protocol/index.ts";
import { createServer } from "../../../src/index.ts";
import { connect, listen } from "../../../src/node/index.ts";
import { listenUnixWithHooks } from "../../../src/node/listen.ts";
import { closeServer, listening, tempDir, turns } from "./helpers.ts";

const dir = tempDir();
const codeOf = (e: unknown): unknown => (e as { code?: unknown }).code;
const inUse = (e: unknown): boolean => codeOf(e) === "EADDRINUSE";

function dial(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = netConnect({ path });
    s.once("connect", () => {
      resolve(s);
    });
    s.once("error", reject);
  });
}

/** A socket file nobody listens on (bind elsewhere, move it into place, close: libuv unlinks the old name). */
async function staleSocket(path: string): Promise<void> {
  const s = createNetServer();
  await listening(s, { path: `${path}.tmp` });
  await rename(`${path}.tmp`, path);
  await closeServer(s);
}

describe("listen unix", () => {
  test("canonical address; close() unlinks the path", async () => {
    const path = join(dir(), "a");
    const l = await listen(path);
    assert.equal(l.address, `unix:${path}`);
    assert.ok(lstatSync(path).isSocket());
    assert.ok(l.server.listening);
    await l.close();
    await l.close();
    assert.equal(existsSync(path), false);
  });

  test("a stale socket is replaced", async () => {
    const path = join(dir(), "stale");
    await staleSocket(path);
    assert.ok(lstatSync(path).isSocket());
    const l = await listen(`unix:${path}`);
    const s = await dial(path);
    s.destroy();
    await l.close();
  });

  test("a live socket is not stolen: EADDRINUSE, the first listener keeps working", async () => {
    const path = join(dir(), "live");
    const first = await listen(`unix:${path}`);
    try {
      await assert.rejects(listen(`unix:${path}`), inUse);
      const accepted = (async () => {
        for await (const ch of first) return ch;
        return undefined;
      })();
      const s = await dial(path);
      const ch = await accepted;
      assert.ok(ch !== undefined);
      ch.close();
      s.destroy();
    } finally {
      await first.close();
    }
  });

  test("a non-socket path is never unlinked", async () => {
    const path = join(dir(), "file");
    await writeFile(path, "keep me");
    await assert.rejects(listen(`unix:${path}`), inUse);
    assert.equal(readFileSync(path, "utf8"), "keep me");
  });

  test("two concurrent listen() calls on one path: exactly one wins, the other rejects EADDRINUSE", async () => {
    const sub = join(dir(), "race");
    await mkdir(sub);
    const path = join(sub, "s");
    const results = await Promise.allSettled([listen(`unix:${path}`), listen(`unix:${path}`)]);
    const won = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const lost = results.filter((r) => r.status === "rejected").map((r) => r.reason as unknown);
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    assert.ok(inUse(lost[0]), String(lost[0]));
    const winner = won[0];
    assert.ok(winner !== undefined);
    try {
      // The winner still owns the path and serves on it.
      const accepted = (async () => {
        for await (const ch of winner) return ch;
        return undefined;
      })();
      const s = await dial(path);
      const ch = await accepted;
      assert.ok(ch !== undefined);
      ch.close();
      s.destroy();
      assert.deepEqual(readdirSync(sub), ["s"]);
    } finally {
      await winner.close();
    }
    assert.deepEqual(readdirSync(sub), []);
  });

  test("concurrent listen() calls over a stale socket: exactly one wins, the winner serves", async () => {
    const sub = join(dir(), "stale-race");
    await mkdir(sub);
    const path = join(sub, "s");
    // Several rounds of 8 (2 rarely interleave inside the probe → replace window on an idle machine).
    for (let round = 0; round < 3; round++) {
      await staleSocket(path);
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => listen(`unix:${path}`)));
      const won = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
      const lost = results.filter((r) => r.status === "rejected").map((r) => r.reason as unknown);
      try {
        assert.equal(won.length, 1);
        assert.equal(lost.length, 7);
        for (const e of lost) assert.ok(inUse(e), String(e));
        const winner = won[0];
        assert.ok(winner !== undefined);
        const accepted = (async () => {
          for await (const ch of winner) return ch;
          return undefined;
        })();
        const s = await dial(path);
        const ch = await accepted;
        assert.ok(ch !== undefined);
        ch.close();
        s.destroy();
        assert.deepEqual(readdirSync(sub), ["s"]);
      } finally {
        await Promise.all(won.map((l) => l.close()));
      }
      assert.deepEqual(readdirSync(sub), []);
    }
  });

  test("a live socket published between the stale probe and the replace is put back, EADDRINUSE", async () => {
    const sub = join(dir(), "replace-race");
    await mkdir(sub);
    const path = join(sub, "s");
    await staleSocket(path);
    // Another process's listener takes the path (atomically, over the stale socket) after our probe.
    const other = createNetServer();
    const err = await listenUnixWithHooks(
      path,
      {},
      {
        beforeReplace: async () => {
          await listening(other, { path: join(sub, "other") });
          await rename(join(sub, "other"), path);
        },
      },
    ).then(
      async (l) => {
        await l.close();
        return new Error("listen() resolved");
      },
      (e: unknown) => e,
    );
    try {
      assert.ok(inUse(err), String(err));
      assert.deepEqual(readdirSync(sub), ["s"]);
      const accepted = new Promise((resolve) => other.once("connection", resolve));
      const s = await dial(path);
      await accepted;
      s.destroy();
    } finally {
      await closeServer(other);
    }
  });

  test("restore never overwrites: a third socket at the path keeps it, the moved one stays in the private dir", async () => {
    const sub = join(dir(), "restore-race");
    await mkdir(sub);
    const path = join(sub, "s");
    await staleSocket(path);
    const other = createNetServer();
    const third = createNetServer();
    const err = await listenUnixWithHooks(
      path,
      {},
      {
        beforeReplace: async () => {
          await listening(other, { path: join(sub, "other") });
          await rename(join(sub, "other"), path);
        },
        beforeRestore: async () => {
          await listening(third, { path: join(sub, "third") });
          await rename(join(sub, "third"), path);
        },
      },
    ).then(
      async (l) => {
        await l.close();
        return new Error("listen() resolved");
      },
      (e: unknown) => e,
    );
    try {
      assert.ok(inUse(err), String(err));
      const kept = readdirSync(sub).filter((n) => n.startsWith(".vjs-"));
      assert.equal(kept.length, 1);
      const tomb = join(sub, kept[0] ?? "", "old");
      assert.match(String(err), /something else now occupies the path/);
      assert.ok(String(err).includes(tomb));
      // The third listener owns the path; the moved one is still reachable through its only name.
      const acceptedThird = new Promise((resolve) => third.once("connection", resolve));
      const s1 = await dial(path);
      await acceptedThird;
      s1.destroy();
      const acceptedOther = new Promise((resolve) => other.once("connection", resolve));
      const s2 = await dial(tomb);
      await acceptedOther;
      s2.destroy();
      assert.deepEqual(readdirSync(join(sub, kept[0] ?? "")), ["old"]);
    } finally {
      await closeServer(other);
      await closeServer(third);
    }
  });

  test("no hard links (link fails with EPERM): falls back to binding at the path", async () => {
    const sub = join(dir(), "nolink");
    await mkdir(sub);
    const path = join(sub, "s");
    const l = await listenUnixWithHooks(
      path,
      { mode: 0o600 },
      {
        link: () => Promise.reject(Object.assign(new Error("operation not permitted"), { code: "EPERM" })),
      },
    );
    try {
      assert.equal(l.server.address(), path);
      assert.equal(lstatSync(path).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(sub), ["s"]);
      const accepted = (async () => {
        for await (const ch of l) return ch;
        return undefined;
      })();
      const s = await dial(path);
      const ch = await accepted;
      assert.ok(ch !== undefined);
      ch.close();
      s.destroy();
    } finally {
      await l.close();
    }
    assert.deepEqual(readdirSync(sub), []);
  });

  test("a path longer than sun_path rejects with ENAMETOOLONG and creates nothing", async () => {
    const sub = join(dir(), "toolong");
    await mkdir(sub);
    const path = join(sub, "n".repeat(120));
    await assert.rejects(listen(`unix:${path}`), (e: unknown) => codeOf(e) === "ENAMETOOLONG");
    assert.deepEqual(readdirSync(sub), []);
  });

  test("a second Server serving the same listener throws; the first keeps serving", async () => {
    const path = join(dir(), "twoservers");
    const l = await listen(path);
    const a = createServer({ onError: () => undefined });
    const b = createServer({ onError: () => undefined });
    try {
      a.serve(l);
      assert.throws(() => {
        b.serve(l);
      }, TypeError);
      const c = await connect(path);
      assert.equal((await c.getInfo()).interfaces[0], "org.varlink.service");
      await c.close();
    } finally {
      await a.shutdown();
      await b.shutdown();
      await l.close();
    }
  });

  test("mode applies before publication: only a 0700 private directory ever holds the socket", async () => {
    const sub = join(dir(), "private");
    await mkdir(sub);
    const path = join(sub, "s");
    // With umask 0 a freshly bound socket is 0777: any exposure would be world-connectable.
    const umask = process.umask(0);
    const seen: string[] = [];
    const watcher = { on: true };
    const watch = (async () => {
      while (watcher.on) {
        for (const name of readdirSync(sub)) {
          const full = join(sub, name);
          let st;
          try {
            st = lstatSync(full);
          } catch {
            continue;
          }
          if (name === "s") seen.push(`s ${(st.mode & 0o777).toString(8)}`);
          else if (st.isDirectory() && name.startsWith(".vjs-")) seen.push(`dir ${(st.mode & 0o777).toString(8)}`);
          else seen.push(`unexpected ${name}`);
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    let l;
    try {
      l = await listen(`unix:${path}`, { mode: 0o600 });
      assert.equal(lstatSync(path).mode & 0o777, 0o600);
    } finally {
      process.umask(umask);
      watcher.on = false;
      await watch;
    }
    await l.close();
    assert.ok(seen.length > 0);
    for (const entry of seen) assert.ok(entry === "s 600" || entry === "dir 700", entry);
  });

  test("fallback: a private socket path too long for sun_path binds directly at the path", async (t) => {
    const limit = process.platform === "linux" ? 107 : 103;
    // dirname + "/s" fits, dirname + "/.vjs-XXXXXX/s" does not.
    const want = limit - 8;
    const base = dir();
    if (base.length + 2 > want) {
      t.skip(`temp dir too long (${String(base.length)})`);
      return;
    }
    const sub = join(base, "d".repeat(want - base.length - 1));
    assert.equal(sub.length, want);
    await mkdir(sub);
    const path = join(sub, "s");
    await staleSocket(path);
    const l = await listen(`unix:${path}`, { mode: 0o600 });
    try {
      // Bound at the path itself (not in a private directory).
      assert.equal(l.server.address(), path);
      assert.equal(lstatSync(path).mode & 0o777, 0o600);
      await assert.rejects(listen(`unix:${path}`), inUse);
      const accepted = (async () => {
        for await (const ch of l) return ch;
        return undefined;
      })();
      const s = await dial(path);
      const ch = await accepted;
      assert.ok(ch !== undefined);
      ch.close();
      s.destroy();
      assert.deepEqual(readdirSync(sub), ["s"]);
    } finally {
      await l.close();
    }
    assert.deepEqual(readdirSync(sub), []);
  });

  test("no temporary names are left behind, after success or failure", async () => {
    const sub = join(dir(), "leftovers");
    await mkdir(sub);
    const l = await listen(`unix:${join(sub, "ok")}`, { mode: 0o600 });
    try {
      assert.deepEqual(readdirSync(sub), ["ok"]);
      await assert.rejects(listen(`unix:${join(sub, "ok")}`), inUse);
      await writeFile(join(sub, "file"), "keep me");
      await assert.rejects(listen(`unix:${join(sub, "file")}`), inUse);
      // A missing directory: bind fails (ENOENT on Linux, EACCES on macOS).
      await assert.rejects(listen(`unix:${join(sub, "nodir", "x")}`));
      assert.deepEqual(readdirSync(sub).sort(), ["file", "ok"]);
    } finally {
      await l.close();
    }
    assert.deepEqual(readdirSync(sub), ["file"]);
  });

  test("mode is applied", async () => {
    const path = join(dir(), "mode");
    const l = await listen(`unix:${path}`, { mode: 0o600 });
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    await l.close();
  });

  test("close() leaves a path that was replaced in the meantime", async () => {
    const path = join(dir(), "replaced");
    const l = await listen(`unix:${path}`);
    await writeFile(`${path}.new`, "other");
    await rename(`${path}.new`, path);
    await l.close();
    assert.equal(readFileSync(path, "utf8"), "other");
  });

  test("abstract sockets: Linux only", { skip: process.platform === "linux" }, async () => {
    await assert.rejects(listen("unix:@varlink-js-test"), OperationNotSupportedError);
  });
});

describe("listen tcp", () => {
  test("port 0: the address carries the real port", async () => {
    const l = await listen("tcp:127.0.0.1:0");
    const m = /^tcp:127\.0\.0\.1:(\d+)$/.exec(l.address);
    assert.ok(m !== null, l.address);
    assert.notEqual(Number(m[1]), 0);
    await l.close();
  });

  test("IPv6 loopback", async (t) => {
    let l;
    try {
      l = await listen("tcp:[::1]:0");
    } catch (e) {
      t.skip(`no IPv6 loopback here (${String(codeOf(e))})`);
      return;
    }
    assert.match(l.address, /^tcp:\[::1\]:\d+$/);
    await l.close();
  });

  test("EADDRINUSE rejects", async () => {
    const l = await listen("tcp:127.0.0.1:0");
    try {
      await assert.rejects(listen(l.address), inUse);
    } finally {
      await l.close();
    }
  });

  test("other kinds reject with OperationNotSupportedError; invalid fds with TypeError", async () => {
    await assert.rejects(listen("exec:/bin/true"), OperationNotSupportedError);
    await assert.rejects(listen("ws://localhost/x"), OperationNotSupportedError);
    await assert.rejects(listen({ fd: -1 }), TypeError);
    await assert.rejects(listen("bogus"), TypeError);
  });
});

describe("the listener iterator", () => {
  test("hands out accepted connections; close() ends it and destroys connections nobody took", async () => {
    const l = await listen("tcp:127.0.0.1:0");
    const port = Number(l.address.split(":").at(-1));
    const it = l[Symbol.asyncIterator]();
    const c1 = netConnect({ host: "127.0.0.1", port });
    const first = await it.next();
    assert.equal(first.done, false);
    const ch: ByteChannel = first.value;
    // A second connection is queued but never taken.
    const c2 = netConnect({ host: "127.0.0.1", port });
    const c2Closed = new Promise((resolve) => c2.once("close", resolve));
    c2.on("error", () => undefined);
    c2.resume();
    await new Promise((resolve) => c2.once("connect", resolve));
    await turns(20);
    await l.close();
    await c2Closed;
    assert.deepEqual(await it.next(), { value: undefined, done: true });
    ch.close();
    c1.destroy();
  });

  test("a pending next() resolves done on close()", async () => {
    const l = await listen("tcp:127.0.0.1:0");
    const it = l[Symbol.asyncIterator]();
    const pending = it.next();
    await l.close();
    assert.deepEqual(await pending, { value: undefined, done: true });
  });

  test("iterating twice concurrently is a TypeError; after return() it may iterate again", async () => {
    const l = await listen("tcp:127.0.0.1:0");
    const it = l[Symbol.asyncIterator]();
    assert.throws(() => l[Symbol.asyncIterator](), TypeError);
    await it.return?.();
    const again = l[Symbol.asyncIterator]();
    await l.close();
    assert.equal((await again.next()).done, true);
  });

  test("accept errors (EMFILE) are not fatal: onError gets them, later connections are still handed out", async () => {
    const errors: unknown[] = [];
    const l = await listen("tcp:127.0.0.1:0", {
      onError: (e) => {
        errors.push(e);
        throw new Error("onError throws: swallowed");
      },
    });
    const port = Number(l.address.split(":").at(-1));
    const it = l[Symbol.asyncIterator]();
    const pending = it.next();
    const emfile = Object.assign(new Error("accept EMFILE"), { code: "EMFILE", errno: -24, syscall: "accept" });
    l.server.emit("error", emfile);
    assert.deepEqual(errors, [emfile]);
    const c = netConnect({ host: "127.0.0.1", port });
    c.on("error", () => undefined);
    const r = await pending;
    assert.equal(r.done, false);
    r.value.close();
    c.destroy();
    // Without onError they are ignored.
    const l2 = await listen("tcp:127.0.0.1:0");
    l2.server.emit("error", emfile);
    assert.ok(l2.server.listening);
    await l2.close();
    await l.close();
    assert.equal((await it.next()).done, true);
  });

  test("the server closed behind our back ends the iterator", async () => {
    const l = await listen("tcp:127.0.0.1:0");
    const it = l[Symbol.asyncIterator]();
    const pending = it.next();
    l.server.close();
    assert.deepEqual(await pending, { value: undefined, done: true });
    await l.close();
  });
});
