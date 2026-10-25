// Regressions that need real sockets (DESIGN.md §3, §7.2): F8 (listen() on an address in use rejects, nothing is
// thrown from an event listener) and F3 with Node's socket buffers really full in both directions.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
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
