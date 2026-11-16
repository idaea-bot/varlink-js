// Regressions that need real sockets (DESIGN.md §3, §7.2): F8 (listen() on an address in use rejects, nothing is
// thrown from an event listener) and F3 with Node's socket buffers really full in both directions.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ConnectionClosedError, type CallContext } from "../../src/index.ts";
import { connect, listen, type NodeListener } from "../../src/node/index.ts";
import { createServer } from "../../src/rpc/index.ts";
import { tcpTransport, unixTransport, waitFor } from "./harness.ts";

const IDL = `interface org.example.sockets

method Ping() -> ()

method Echo(text: string) -> (text: string)
`;
const I = "org.example.sockets";
const wire = (v: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(v)}\0`);

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "vj-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("F8 listen() on an address in use rejects with EADDRINUSE; the process is unaffected", () => {
  const uncaught: unknown[] = [];
  const record = (e: unknown): void => {
    uncaught.push(e);
  };
  before(() => {
    process.on("uncaughtException", record);
  });
  after(() => {
    process.off("uncaughtException", record);
  });

  for (const kind of ["tcp", "unix"] as const) {
    test(kind, async () => {
      const first: NodeListener = await listen(kind === "tcp" ? "tcp:127.0.0.1:0" : `unix:${join(dir, "f8")}`);
      try {
        await assert.rejects(listen(first.address), (e: unknown) => (e as { code?: unknown }).code === "EADDRINUSE");
        // The first listener still works.
        const server = createServer({ onError: () => undefined });
        server.addInterface(IDL, { Ping: () => ({}) });
        server.serve(first);
        const conn = await connect(first.address);
        assert.deepEqual(await conn.call(`${I}.Ping`), {});
        await conn.close();
        await server.shutdown();
      } finally {
        await first.close();
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(uncaught, []);
    });
  }
});

for (const transport of [unixTransport, tcpTransport]) {
  describe(`F3 over ${transport.name}: 4 MB each way while the peer is not reading`, () => {
    test("pipelined 4 MB echo + Ping written before reading anything", async () => {
      const server = createServer({ onError: () => undefined });
      server.addInterface(IDL, { Ping: () => ({}), Echo: (p: { text: string }) => ({ text: p.text }) });
      const ep = await transport.start(server);
      try {
        const raw = await ep.raw();
        const text = "y".repeat(4 * 1024 * 1024);
        // The whole request goes out before we read: the server's 4 MB reply fills both socket buffers and its
        // write waits (no `flush` event involved, F3), then completes once we read.
        await raw.write(wire({ method: `${I}.Echo`, parameters: { text } }));
        await raw.write(wire({ method: `${I}.Ping` }));
        await raw.end();
        for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
        const replies = await raw.readAll();
        assert.equal(replies.length, 2);
        assert.equal(
          (JSON.parse(replies[0] ?? "") as { parameters: { text: string } }).parameters.text.length,
          text.length,
        );
        assert.equal(replies[1], '{"parameters":{}}');
        await waitFor(() => server.connections === 0);
      } finally {
        await ep.close();
        await server.shutdown({ graceful: false });
      }
    });
  });
}

describe("accept errors are not fatal (EMFILE): the listener keeps serving", () => {
  test("an error emitted on the net.Server, then a connection: served", async () => {
    const errors: unknown[] = [];
    const reported: string[] = [];
    const listener = await listen("tcp:127.0.0.1:0", { onError: (e) => errors.push(e) });
    const server = createServer({ onError: (_e, info) => reported.push(info.reason) });
    server.addInterface(IDL, { Ping: () => ({}) });
    server.serve(listener);
    try {
      const emfile = Object.assign(new Error("accept EMFILE"), { code: "EMFILE", errno: -24, syscall: "accept" });
      listener.server.emit("error", emfile);
      await new Promise((resolve) => setImmediate(resolve));
      const conn = await connect(listener.address);
      assert.deepEqual(await conn.call(`${I}.Ping`), {});
      await conn.close();
      assert.deepEqual(errors, [emfile]);
      assert.deepEqual(reported, []);
      assert.ok(listener.server.listening);
    } finally {
      await server.shutdown();
    }
    assert.equal(listener.server.listening, false);
  });
});

describe("graceful shutdown over tcp delivers the active call's reply (no RST from unread input)", () => {
  test("pipelined calls behind a slow call: its 2 MB reply arrives, the rest reject ConnectionClosedError", async () => {
    const big = "z".repeat(2 * 1024 * 1024);
    let started: AbortSignal | undefined;
    const server = createServer({ onError: () => undefined });
    server.addInterface(IDL, {
      Ping: () => ({}),
      // "slow" waits for the shutdown signal, then answers with a big reply (longer than the socket buffers).
      Echo: (p: { text: string }, ctx: CallContext) => {
        if (p.text !== "slow") return { text: p.text };
        started = ctx.signal;
        return new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            resolve({ text: big });
          });
        });
      },
    });
    const ep = await tcpTransport.start(server);
    try {
      const conn = await ep.connect({ timeout: 0 });
      const slow = conn.call(`${I}.Echo`, { text: "slow" });
      await waitFor(() => started !== undefined);
      // Far more than the server buffers (64 queued calls, Node's read buffer): the rest stays unread in the kernel.
      const filler = "f".repeat(4096);
      const dropped = Array.from({ length: 200 }, () => conn.call(`${I}.Echo`, { text: filler }));
      const settled = Promise.allSettled(dropped);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await server.shutdown({ graceful: true });
      const reply = (await slow) as { text: string };
      assert.equal(reply.text.length, big.length);
      for (const r of await settled) {
        assert.equal(r.status, "rejected");
        assert.ok(r.reason instanceof ConnectionClosedError, String(r.reason));
      }
      await conn.close();
    } finally {
      await ep.close();
      await server.shutdown({ graceful: false });
    }
  });
});
