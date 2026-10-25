// Server exitOnIdle and Server.closed (DESIGN.md §5.4 limits, §5.8).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createConnection, createServer, type Server } from "../../../src/rpc/index.ts";
import { pair } from "../../../src/testing/index.ts";
import { isPending, MemoryListener, settle, sleep } from "./helpers.ts";

const IDL = "interface org.example.idle\n\nmethod Ping() -> ()\n";

function server(exitOnIdle?: number): Server {
  const s = createServer({ onError: () => undefined, ...(exitOnIdle === undefined ? {} : { exitOnIdle }) });
  s.addInterface(IDL, { Ping: () => ({}) });
  return s;
}

describe("exitOnIdle", () => {
  test("invalid values are RangeErrors", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "10"])
      assert.throws(() => createServer({ exitOnIdle: bad as number }), RangeError, String(bad));
  });

  test("off by default: an idle server keeps running", async () => {
    const s = server();
    s.serve(new MemoryListener());
    await sleep(60);
    assert.equal(await isPending(s.closed), true);
    await s.shutdown();
    await s.closed;
  });

  test("no timer before serving starts", async () => {
    const s = server(0);
    await sleep(40);
    assert.equal(await isPending(s.closed), true);
    await s.shutdown();
  });

  test("starts at the first serve(): nobody connects → shut down", async () => {
    const s = server(20);
    const listener = new MemoryListener();
    s.serve(listener);
    await s.closed;
    assert.equal(listener.closeCalls, 1);
  });

  test("0: shut down as soon as the last connection closed", async () => {
    const s = server(0);
    const listener = new MemoryListener();
    s.serve(listener);
    // Dialed before the first timer turn: the startup check sees it.
    const a = createConnection(listener.dial());
    const b = createConnection(listener.dial());
    assert.deepEqual(await a.call("org.example.idle.Ping"), {});
    assert.deepEqual(await b.call("org.example.idle.Ping"), {});
    await a.close();
    await settle(5);
    assert.equal(await isPending(s.closed), true, "one connection is still open");
    assert.equal(s.connections, 1);
    await b.close();
    await s.closed;
    assert.equal(s.connections, 0);
  });

  test("a new connection cancels the timer; it re-arms when that one closes", async () => {
    const s = server(50);
    const listener = new MemoryListener();
    s.serve(listener);
    await sleep(10);
    const conn = createConnection(listener.dial());
    assert.deepEqual(await conn.call("org.example.idle.Ping"), {});
    // Well past the first deadline: the open connection keeps the server up.
    await sleep(150);
    assert.equal(await isPending(s.closed), true);
    const started = Date.now();
    await conn.close();
    await s.closed;
    assert.ok(Date.now() - started >= 40, "waited for exitOnIdle after the last close");
  });

  test("handle() starts it too", async () => {
    const s = server(0);
    const [client, end] = pair();
    const handled = s.handle(end);
    const conn = createConnection(client);
    assert.deepEqual(await conn.call("org.example.idle.Ping"), {});
    await conn.close();
    await handled;
    await s.closed;
  });

  test(
    "no timers once shut down (shutdown before expiry)",
    // process.getActiveResourcesInfo() is Node's; Bun and Deno do not report Timeouts through it.
    {
      skip: process.versions.bun !== undefined || "Deno" in globalThis ? "needs Node's getActiveResourcesInfo" : false,
    },
    async () => {
      const timeouts = (): number => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
      const baseline = timeouts();
      // Long enough that only clearing it (not its expiry) can make it go away within the test.
      const s = server(60_000);
      s.serve(new MemoryListener());
      assert.equal(timeouts(), baseline + 1, "the idle timer is armed");
      await s.shutdown();
      await s.closed;
      assert.equal(timeouts(), baseline, "and cleared by the shutdown");
    },
  );
});

describe("Server.closed", () => {
  test("resolves on a manual shutdown, not before", async () => {
    const s = server();
    const listener = new MemoryListener();
    s.serve(listener);
    const conn = createConnection(listener.dial());
    assert.deepEqual(await conn.call("org.example.idle.Ping"), {});
    assert.equal(await isPending(s.closed), true);
    await s.shutdown({ graceful: false });
    await s.closed;
    await conn.closed;
  });

  test("a server that never served resolves on shutdown", async () => {
    const s = server();
    await s.shutdown();
    await s.closed;
  });
});
