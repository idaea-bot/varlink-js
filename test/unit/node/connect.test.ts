// connect() and createPool(address) (DESIGN.md §4.11, §5.1, §5.2).
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, mock, test } from "node:test";
import { CallTimeoutError, OperationNotSupportedError } from "../../../src/core/errors/index.ts";
import { connect, createPool, listen, type NodeListener } from "../../../src/node/index.ts";
import { createServer, type Server } from "../../../src/rpc/index.ts";
import { tempDir } from "./helpers.ts";

const IDL = `interface org.example.node

method Ping() -> ()
`;
const dir = tempDir();

async function serve(address: string): Promise<{ server: Server; listener: NodeListener; stop(): Promise<void> }> {
  const server = createServer({ onError: () => undefined });
  server.addInterface(IDL, { Ping: () => ({}) });
  const listener = await listen(address);
  server.serve(listener);
  return {
    server,
    listener,
    stop: () => server.shutdown({ graceful: false }),
  };
}

const codeOf = (e: unknown): unknown => (e as { code?: unknown }).code;

describe("connect", () => {
  test("unix (prefixed and bare path) and tcp", async () => {
    const path = join(dir(), "c1");
    for (const [listenOn, dialed] of [
      [`unix:${path}`, (a: string) => [a, a.slice("unix:".length), { kind: "unix", path } as const]],
      ["tcp:127.0.0.1:0", (a: string) => [a]],
    ] as const) {
      const s = await serve(listenOn);
      try {
        for (const address of dialed(s.listener.address)) {
          const conn = await connect(address);
          assert.deepEqual(await conn.call("org.example.node.Ping"), {});
          await conn.close();
        }
      } finally {
        await s.stop();
      }
    }
  });

  test("abstract sockets need Linux", { skip: process.platform === "linux" }, async () => {
    await assert.rejects(connect("unix:@varlink-js-test"), OperationNotSupportedError);
  });

  test("unsupported kinds reject with OperationNotSupportedError naming the kind", async () => {
    for (const [address, kind] of [
      ["exec:/bin/true", "exec"],
      ["ssh-unix:host:/run/x", "ssh-unix"],
      ["ssh-exec:host:cmd", "ssh-exec"],
      ["ws://localhost/x", "websocket"],
      ["http://localhost/x", "http"],
    ] as const)
      await assert.rejects(
        connect(address),
        (e: unknown) => e instanceof OperationNotSupportedError && e.message.includes(kind),
      );
  });

  test("an invalid address rejects with TypeError", async () => {
    await assert.rejects(connect("nonsense"), TypeError);
  });

  test("connection errors reject with the Node error (ENOENT, ECONNREFUSED)", async () => {
    await assert.rejects(connect(`unix:${join(dir(), "missing")}`), (e: unknown) => codeOf(e) === "ENOENT");
    // A port that was just free: nothing listens there.
    const s = await serve("tcp:127.0.0.1:0");
    const address = s.listener.address;
    await s.stop();
    await assert.rejects(connect(address), (e: unknown) => codeOf(e) === "ECONNREFUSED");
  });

  test("signal: already aborted rejects with its reason; aborted during connect too", async () => {
    const s = await serve("tcp:127.0.0.1:0");
    try {
      const reason = new Error("stop");
      await assert.rejects(connect(s.listener.address, { signal: AbortSignal.abort(reason) }), (e) => e === reason);
      const ac = new AbortController();
      const pending = connect(s.listener.address, { signal: ac.signal });
      ac.abort(reason); // before the socket's async `connect` event
      await assert.rejects(pending, (e) => e === reason);
    } finally {
      await s.stop();
    }
  });

  test("the connect phase times out with CallTimeoutError (mocked clock)", async () => {
    const s = await serve("tcp:127.0.0.1:0");
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pending = connect(s.listener.address, { timeout: 1000 });
      mock.timers.tick(1000); // before the socket's async `connect` event
      await assert.rejects(
        pending,
        (e: unknown) => e instanceof CallTimeoutError && /connect timed out/.test(e.message),
      );
    } finally {
      mock.timers.reset();
      await s.stop();
    }
  });

  test("timeout: 0 means no connect timeout; invalid timeouts are RangeErrors", async () => {
    const s = await serve("tcp:127.0.0.1:0");
    try {
      const conn = await connect(s.listener.address, { timeout: 0 });
      assert.deepEqual(await conn.call("org.example.node.Ping"), {});
      await conn.close();
      await assert.rejects(connect(s.listener.address, { timeout: -1 }), RangeError);
    } finally {
      await s.stop();
    }
  });
});

describe("createPool(address)", () => {
  test("leases connections to the address; close() closes them", async () => {
    const s = await serve("tcp:127.0.0.1:0");
    try {
      const pool = createPool(s.listener.address, { max: 2, idleTimeout: 0, timeout: 1000 });
      const results = await Promise.all([1, 2, 3].map(() => pool.call("org.example.node.Ping")));
      assert.deepEqual(results, [{}, {}, {}]);
      assert.ok(pool.size >= 1 && pool.size <= 2);
      await pool.close();
      await assert.rejects(pool.call("org.example.node.Ping"));
    } finally {
      await s.stop();
    }
  });

  test("a failing connect rejects that operation only", async () => {
    const pool = createPool(`unix:${join(dir(), "nobody")}`);
    await assert.rejects(pool.call("org.example.node.Ping"), (e: unknown) => codeOf(e) === "ENOENT");
    assert.equal(pool.size, 0);
    await pool.close();
  });
});
