// fromNodeSocket (DESIGN.md §4.11): read/write/end/close/closed semantics over real tcp sockets.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ConnectionClosedError } from "../../../src/core/errors/index.ts";
import { fromNodeSocket } from "../../../src/node/index.ts";
import { tcpPair, turns } from "./helpers.ts";

const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

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
