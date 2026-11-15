// fromNodeSocket (DESIGN.md §4.11): read/write/end/close/closed semantics over real tcp sockets.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ConnectionClosedError } from "../../../src/core/errors/index.ts";
import { fromNodeSocket } from "../../../src/node/index.ts";
import { tcpPair, tempDir, turns, unixPair } from "./helpers.ts";

const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const dir = tempDir();
const isPeerGoneError = (e: unknown): boolean =>
  ["EPIPE", "ECONNRESET", "ECONNABORTED", "ENOTCONN"].includes(String((e as { code?: unknown } | undefined)?.code));
/**
 * Bun's own node:net closes the socket natively when a write fails (unix: the write rejects with ECANCELED) and the
 * peer's last bytes are gone with it; fromNodeSocket's guard cannot reach below that (Node and Deno: kept).
 */
const BUN_DROPS_ON_WRITE_ERROR =
  process.versions.bun !== undefined ? "Bun: its net.Socket drops received bytes once a write fails" : false;

describe("fromNodeSocket", () => {
  test("reads chunks as plain Uint8Arrays, then null after the peer's FIN; closed after both ends", async () => {
    const p = await tcpPair();
    try {
      const a = fromNodeSocket(p.client);
      const b = fromNodeSocket(p.server);
      await a.write(bytes("hello"));
      const chunk = await b.read();
      assert.ok(chunk !== null);
      assert.equal(Object.getPrototypeOf(chunk.bytes), Uint8Array.prototype);
      assert.equal(Buffer.isBuffer(chunk.bytes), false);
      assert.equal(text(chunk.bytes), "hello");
      await a.end();
      assert.equal(await b.read(), null);
      assert.equal(await b.read(), null);
      // Half-close: b can still write to a.
      await b.write(bytes("back"));
      assert.equal(text((await a.read())?.bytes ?? new Uint8Array()), "back");
      await b.end();
      assert.equal(await a.read(), null);
      await Promise.all([a.closed, b.closed]);
      assert.deepEqual(a.capabilities, {});
    } finally {
      await p.close();
    }
  });

  test("the socket is paused: nothing is read until read() is called", async () => {
    const p = await tcpPair();
    try {
      const b = fromNodeSocket(p.server);
      const a = fromNodeSocket(p.client);
      await a.write(bytes("x"));
      await turns(20);
      assert.equal(p.server.isPaused(), true);
      assert.equal(text((await b.read())?.bytes ?? new Uint8Array()), "x");
      assert.equal(p.server.isPaused(), true);
    } finally {
      await p.close();
    }
  });

  test("concurrent read() is a TypeError", async () => {
    const p = await tcpPair();
    try {
      const b = fromNodeSocket(p.server);
      const first = b.read();
      await assert.rejects(b.read(), TypeError);
      b.close();
      assert.equal(await first, null);
    } finally {
      await p.close();
    }
  });

  test("an error listener is always attached; a socket error rejects one read, later reads give null", async () => {
    const p = await tcpPair();
    try {
      const b = fromNodeSocket(p.server);
      assert.ok(p.server.listenerCount("error") >= 1);
      const boom = new Error("boom");
      const pending = b.read();
      p.server.destroy(boom);
      await assert.rejects(pending, (e: unknown) => e === boom);
      assert.equal(await b.read(), null);
      await b.closed;
      await assert.rejects(b.write(bytes("x")), ConnectionClosedError);
    } finally {
      await p.close();
    }
  });

  test("an error with no read pending rejects the next read", async () => {
    const p = await tcpPair();
    try {
      const b = fromNodeSocket(p.server);
      const boom = new Error("boom");
      p.server.destroy(boom);
      await b.closed;
      await assert.rejects(b.read(), (e: unknown) => e === boom);
      assert.equal(await b.read(), null);
    } finally {
      await p.close();
    }
  });

  test("write after end() or close() rejects at once with ConnectionClosedError", async () => {
    const p = await tcpPair();
    try {
      const a = fromNodeSocket(p.client);
      await a.end();
      await assert.rejects(a.write(bytes("x")), ConnectionClosedError);
      const b = fromNodeSocket(p.server);
      b.close();
      await assert.rejects(b.write(bytes("x")), ConnectionClosedError);
    } finally {
      await p.close();
    }
  });

  test("close(): idempotent, a pending read resolves null, buffered data is dropped, closed resolves", async () => {
    const p = await tcpPair();
    try {
      const a = fromNodeSocket(p.client);
      const b = fromNodeSocket(p.server);
      const pending = b.read();
      b.close();
      b.close("again");
      assert.equal(await pending, null);
      assert.equal(await b.read(), null);
      await b.closed;
      assert.equal(p.server.destroyed, true);
      // The peer sees EOF.
      assert.equal(await a.read(), null);
    } finally {
      await p.close();
    }
  });

  test("a write blocked on a full socket rejects (never hangs) when the peer resets", async () => {
    const p = await tcpPair();
    try {
      const a = fromNodeSocket(p.client);
      fromNodeSocket(p.server); // paused and never read: the client's write cannot complete
      const big = new Uint8Array(64 * 1024 * 1024);
      const write = a.write(big);
      let settled = false;
      write.then(
        () => (settled = true),
        () => (settled = true),
      );
      await turns(20);
      assert.equal(settled, false, "the write waits for the peer");
      p.server.resetAndDestroy();
      await assert.rejects(write);
      await a.closed;
    } finally {
      await p.close();
    }
  });

  // M9 VM interop (`yes | call --upgrade` against a `head -n1`-like service): Node destroys a socket on a write error,
  // which used to drop the reply the peer had sent before it closed (still queued in the kernel).
  for (const transport of ["unix", "tcp"] as const)
    test(
      `over ${transport}: a write failing because the peer went keeps what the peer sent before`,
      { skip: BUN_DROPS_ON_WRITE_ERROR },
      async () => {
        const p = transport === "tcp" ? await tcpPair() : await unixPair(join(dir(), "pair"));
        try {
          const a = fromNodeSocket(p.client);
          // The peer reads one chunk, replies, and goes with our later bytes unread (over TCP: an RST).
          p.server.on("error", () => undefined);
          p.server.once("data", () => {
            p.server.pause();
            p.server.write("y\n", () => p.server.destroy());
          });
          p.server.resume();
          let failure: unknown;
          for (let i = 0; i < 10_000 && failure === undefined; i++)
            await a.write(new Uint8Array(65536).fill(0x79)).catch((e: unknown) => (failure = e));
          assert.ok(isPeerGoneError(failure), `a peer-gone write error, not ${String(failure)}`);
          // Later writes reject with the same error, at once.
          await assert.rejects(a.write(bytes("x")), (e: unknown) => e === failure);
          let got = "";
          try {
            for (let c = await a.read(); c !== null; c = await a.read()) got += text(c.bytes);
          } catch (e) {
            // Over TCP the peer's reset follows its data: an error after the bytes is fine.
            assert.ok(isPeerGoneError(e), String(e));
          }
          assert.equal(got, "y\n");
          await a.closed;
        } finally {
          await p.close();
        }
      },
    );

  test(
    "after a peer-gone write error the socket reads ahead and closes on its own, even if nobody reads",
    { skip: BUN_DROPS_ON_WRITE_ERROR },
    async () => {
      const p = await unixPair(join(dir(), "drain"));
      try {
        const a = fromNodeSocket(p.client);
        p.server.on("error", () => undefined);
        p.server.once("data", () => {
          p.server.pause();
          p.server.write("bye\n", () => p.server.destroy());
        });
        p.server.resume();
        let failure: unknown;
        for (let i = 0; i < 10_000 && failure === undefined; i++)
          await a.write(new Uint8Array(65536)).catch((e: unknown) => (failure = e));
        assert.ok(isPeerGoneError(failure), String(failure));
        await a.closed;
        // Received before the close: still there for a late read.
        assert.equal(text((await a.read())?.bytes ?? new Uint8Array()), "bye\n");
        // Then the peer's EOF, or (Linux: it closed with our bytes unread) its reset, reported once.
        const after = await a.read().catch((e: unknown) => e);
        assert.ok(after === null || isPeerGoneError(after), String(after));
        assert.equal(await a.read(), null);
      } finally {
        await p.close();
      }
    },
  );

  // Node reads into a paused socket's buffer (up to its highWaterMark) and drops that buffer when a read error
  // destroys the socket: a reply the peer sent just before its reset was lost if nobody was reading at that moment.
  test("over unix: a reply followed by the peer's reset is read before the error, even if read late", async () => {
    const p = await unixPair(join(dir(), "reset"));
    try {
      const a = fromNodeSocket(p.client);
      p.server.on("error", () => undefined);
      // The server never reads (pauseOnConnect): closing with our bytes unread resets the connection (Linux).
      p.server.write("hello\n");
      assert.equal(text((await a.read())?.bytes ?? new Uint8Array()), "hello\n");
      await a.write(bytes("never read by the peer"));
      p.server.write("reply\n", () => p.server.destroy());
      await new Promise((resolve) => p.server.once("close", resolve));
      // Not reading until the reset has closed our socket (where the peer's close arrives as an EOF instead, the
      // half-open socket stays open: read after a while).
      for (let i = 0; i < 200 && !p.client.destroyed; i++) await turns(1);
      let got = "";
      try {
        for (let c = await a.read(); c !== null; c = await a.read()) got += text(c.bytes);
      } catch (e) {
        assert.ok(isPeerGoneError(e), String(e));
      }
      assert.equal(got, "reply\n");
      assert.equal(await a.read(), null);
    } finally {
      await p.close();
    }
  });

  test("a pending write rejects with ConnectionClosedError on a local close()", async () => {
    const p = await tcpPair();
    try {
      const a = fromNodeSocket(p.client);
      fromNodeSocket(p.server);
      const write = a.write(new Uint8Array(64 * 1024 * 1024));
      await turns(5);
      a.close();
      await assert.rejects(write, ConnectionClosedError);
      await a.closed;
    } finally {
      await p.close();
    }
  });
});
