// listen() (DESIGN.md §4.11): unix stale/live/non-socket paths, mode, unlink on close, tcp addresses, errors and
// the iterator.
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { createServer as createNetServer, connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import { describe, test } from "node:test";
import { OperationNotSupportedError } from "../../../src/core/errors/index.ts";
import type { ByteChannel } from "../../../src/core/protocol/index.ts";
import { listen } from "../../../src/node/index.ts";
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

  test("a server error after listening is thrown by the iterator, not from a listener", async () => {
    const l = await listen("tcp:127.0.0.1:0");
    const it = l[Symbol.asyncIterator]();
    const pending = it.next();
    const boom = new Error("accept failed");
    l.server.emit("error", boom);
    await assert.rejects(pending, (e) => e === boom);
    await l.close();
  });
});
