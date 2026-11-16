// `varlink-js bridge` in-process (DESIGN.md §4.14): stdin → socket, socket → stdout, half-close, EOF, backpressure
// both ways, errors.
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { after, before, describe, test } from "node:test";
import {
  controlledStdin,
  isPattern,
  pattern,
  rawServer,
  runCli,
  startFixture,
  waitFor,
  waitForStable,
  type Fixture,
} from "./helpers.ts";

/** A tcp:127.0.0.1:0 server running `onSocket` per connection. */
async function tcpServer(onSocket: (socket: Socket) => void): Promise<{ address: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    onSocket(socket);
  });
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no tcp address");
  return {
    address: `tcp:127.0.0.1:${String(addr.port)}`,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}

let fx: Fixture;
before(async () => {
  fx = await startFixture();
});
after(async () => {
  await fx.close();
});

const call = (method: string, parameters: object): string => `${JSON.stringify({ method, parameters })}\0`;

describe("bridge", () => {
  for (const transport of ["unix", "tcp"] as const)
    test(`a byte pipe over ${transport}: replies come out, stdin EOF half-closes, peer EOF ends it (exit 0)`, async () => {
      const stdin = controlledStdin();
      let out = "";
      const p = runCli(["bridge", transport === "unix" ? fx.unix : fx.tcp], {
        stdin,
        onStdout: (text) => (out = text),
      });
      stdin.push(call("org.example.cli.Echo", { value: 9223372036854775807n.toString() }));
      // Split one message across two chunks: bytes, not messages.
      const second = call("org.example.cli.Echo", { value: 2 });
      stdin.push(second.slice(0, 10));
      stdin.push(second.slice(10));
      await waitFor(() => out.split("\0").length === 3);
      stdin.end();
      const r = await p;
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, '{"parameters":{"value":"9223372036854775807"}}\0{"parameters":{"value":2}}\0');
      assert.equal(r.stderr, "");
    });

  test("the peer's EOF ends the bridge while stdin is still open", async () => {
    const raw = await rawServer(['{"parameters":{}}']);
    try {
      const stdin = controlledStdin();
      let out = "";
      const p = runCli(["bridge", raw.address], { stdin, onStdout: (text) => (out = text) });
      stdin.push(call("a.b.C", {}));
      await waitFor(() => out.includes("\0"));
      await raw.close();
      const r = await p;
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, '{"parameters":{}}\0');
    } finally {
      await raw.close();
    }
  });

  test("connect failure, unsupported kinds, arguments", async () => {
    const refused = await runCli(["bridge", "unix:/nonexistent/x"]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^Failed to connect to unix:\/nonexistent\/x: /);
    for (const address of ["ws://127.0.0.1:1/ws/services/a.b", "http://127.0.0.1:1/", "exec:/bin/true"]) {
      const r = await runCli(["bridge", address]);
      assert.equal(r.code, 1, address);
      assert.match(r.stderr, /addresses are not supported by bridge/, address);
    }
    const none = await runCli(["bridge"]);
    assert.equal(none.code, 1);
  });

  test("the peer's EOF first: stdin's iterator is returned (no pending read left behind)", async () => {
    const raw = await rawServer(['{"parameters":{}}']);
    try {
      let reads = 0;
      let returned = false;
      // An iterator object (not a generator), so return() is seen even while a next() is pending.
      const stdin: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            reads++ === 0
              ? Promise.resolve({ done: false, value: new TextEncoder().encode(call("a.b.C", {})) })
              : new Promise<IteratorResult<Uint8Array>>(() => undefined),
          return: () => {
            returned = true;
            return Promise.resolve({ done: true, value: undefined });
          },
        }),
      };
      let out = "";
      const p = runCli(["bridge", raw.address], { stdin, onStdout: (text) => (out = text) });
      await waitFor(() => out.includes("\0"));
      assert.equal(returned, false);
      await raw.close();
      const r = await p;
      assert.equal(r.code, 0, r.stderr);
      assert.equal(returned, true);
    } finally {
      await raw.close();
    }
  });

  test("backpressure socket → stdout: a blocked stdout stops the peer; all bytes arrive in order after", async () => {
    // Far more than the kernel's socket buffers on both ends (a few MiB): without backpressure the peer would send
    // all of it into the bridge's memory while stdout is blocked.
    const TOTAL = 32 * 1024 * 1024;
    const CHUNK = 64 * 1024;
    let flushed = 0;
    const server = await tcpServer((socket) => {
      void (async () => {
        for (let offset = 0; offset < TOTAL; offset += CHUNK) {
          // The callback fires once the kernel took the chunk: `flushed` is what really left the peer.
          await new Promise<void>((resolve, reject) => {
            socket.write(pattern(offset, CHUNK), (e) => {
              if (e) reject(e);
              else resolve();
            });
          });
          flushed += CHUNK;
        }
        socket.end();
      })().catch(() => undefined);
    });
    try {
      let writes = 0;
      let release: () => void = () => undefined;
      const blocked = new Promise<void>((resolve) => (release = resolve));
      const stdin = controlledStdin();
      const p = runCli(["bridge", server.address], {
        stdin,
        beforeStdoutWrite: async () => {
          writes++;
          await blocked;
        },
      });
      await waitFor(() => writes > 0, 20_000);
      // The peer stops: its writes no longer complete while the first stdout write is pending.
      const stalledAt = await waitForStable(() => flushed);
      assert.ok(stalledAt < TOTAL, `the peer sent everything (${String(stalledAt)} bytes) into a blocked stdout`);
      assert.equal(writes, 1, "one stdout write at a time");
      release();
      const r = await p;
      assert.equal(r.code, 0, r.stderr);
      assert.equal(flushed, TOTAL);
      assert.ok(isPattern(r.io.stdoutChunks, TOTAL), "stdout has exactly the peer's bytes");
    } finally {
      await server.close();
    }
  });

  test("backpressure stdin → socket: a peer that does not read stops the bridge pulling stdin", async () => {
    const TOTAL = 32 * 1024 * 1024;
    const CHUNK = 64 * 1024;
    let peer: Socket | undefined;
    const received: Uint8Array[] = [];
    const server = await tcpServer((socket) => {
      peer = socket;
      socket.pause();
      socket.on("data", (chunk: Uint8Array) => received.push(new Uint8Array(chunk)));
      // The bridge half-closed after stdin's EOF: end ours too, which ends the bridge.
      socket.on("end", () => socket.end());
    });
    try {
      let pulled = 0;
      const stdin: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (pulled * CHUNK >= TOTAL) return Promise.resolve({ done: true, value: undefined });
            const chunk = pattern(pulled * CHUNK, CHUNK);
            pulled++;
            return Promise.resolve({ done: false, value: chunk });
          },
        }),
      };
      const p = runCli(["bridge", server.address], { stdin });
      await waitFor(() => peer !== undefined && pulled > 0, 20_000);
      const stalledAt = await waitForStable(() => pulled);
      assert.ok(stalledAt * CHUNK < TOTAL, "the bridge read all of stdin while the peer was not reading");
      peer?.resume();
      const r = await p;
      assert.equal(r.code, 0, r.stderr);
      assert.ok(isPattern(received, TOTAL), "the peer got exactly stdin's bytes");
    } finally {
      await server.close();
    }
  });

  test("SIGINT: closed, 130; stdout EPIPE: 0", async () => {
    const controller = new AbortController();
    const stdin = controlledStdin();
    let out = "";
    const p = runCli(["bridge", fx.unix], { stdin, signal: controller.signal, onStdout: (text) => (out = text) });
    // Signal while piping (not during the connect): once a reply came through.
    stdin.push(call("org.example.cli.Echo", { value: 1 }));
    await waitFor(() => out.includes("\0"));
    controller.abort("SIGINT");
    assert.equal((await p).code, 130);

    const stdin2 = controlledStdin();
    const p2 = runCli(["bridge", fx.unix], { stdin: stdin2, stdoutBreaksAfter: 0 });
    stdin2.push(call("org.example.cli.Echo", { value: 1 }));
    const r2 = await p2;
    assert.equal(r2.code, 0);
    assert.equal(r2.stderr, "");
  });
});
