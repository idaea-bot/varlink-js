// fromWebSocket (DESIGN.md §4.12) against a scripted WebSocket: message types, ordering of data and close, the
// receive buffer cap, write backpressure, end/close/closed and the 5 s guard.
import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import { ConnectionClosedError, OperationNotSupportedError } from "../../../src/index.ts";
import { fromWebSocket } from "../../../src/websocket/index.ts";
import { trackTimers } from "../rpc/helpers.ts";
import { dec, enc, FakeWebSocket } from "./fake.ts";

/** Lets pending promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function isPending(p: Promise<unknown>): Promise<boolean> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  await flush();
  return !settled;
}

async function readText(ch: ReturnType<typeof fromWebSocket>): Promise<string | null> {
  const chunk = await ch.read();
  return chunk === null ? null : dec(chunk.bytes);
}

describe("fromWebSocket: setup", () => {
  test("sets binaryType to arraybuffer; capabilities are empty", () => {
    const ws = new FakeWebSocket();
    const ch = fromWebSocket(ws);
    assert.equal(ws.binaryType, "arraybuffer");
    assert.deepEqual(ch.capabilities, {});
    ch.close();
  });

  test("a socket that is not OPEN (or not a socket) is a TypeError", () => {
    for (const state of [0, 2, 3]) {
      const ws = new FakeWebSocket();
      ws.readyState = state;
      assert.throws(() => fromWebSocket(ws), TypeError);
    }
    assert.throws(() => fromWebSocket(null as unknown as FakeWebSocket), TypeError);
  });

  test("invalid options are RangeErrors", () => {
    const ws = new FakeWebSocket();
    for (const options of [{ maxBufferedBytes: 0 }, { maxBufferedBytes: 1.5 }, { writeHighWaterMark: -1 }])
      assert.throws(() => fromWebSocket(ws, options), RangeError);
  });
});

describe("fromWebSocket: reading", () => {
  test("binary (ArrayBuffer and views) and text messages become byte chunks in order", async () => {
    const ws = new FakeWebSocket();
    const ch = fromWebSocket(ws);
    ws.message(enc("ab").buffer);
    ws.message("cé\0");
    ws.message(new Uint8Array([0x78, 0x79, 0x7a]).subarray(1));
    ws.message(new ArrayBuffer(0)); // empty: skipped
    assert.equal(await readText(ch), "ab");
    assert.equal(await readText(ch), "cé\0");
    assert.equal(await readText(ch), "yz");
    ws.closed(1000);
    assert.equal(await ch.read(), null);
    await ch.closed;
  });

  test("a read waits for the next message", async () => {
    const ws = new FakeWebSocket();
    const ch = fromWebSocket(ws);
    const p = readText(ch);
    assert.equal(await isPending(p), true);
    ws.message("x");
    assert.equal(await p, "x");
    ch.close();
  });

  test("a Blob (binaryType ignored) is read in order: later messages wait behind it", async () => {
    const ws = new FakeWebSocket();
    const ch = fromWebSocket(ws);
    ws.message(new Blob([enc("first")]));
    ws.message("second");
    ws.closed(1000);
    assert.equal(await readText(ch), "first");
    assert.equal(await readText(ch), "second");
    assert.equal(await ch.read(), null);
    await ch.closed;
  });

  test("a Blob that cannot be read fails the stream at its position", async () => {
    const ws = new FakeWebSocket();
    const ch = fromWebSocket(ws);
    ws.message("before");
    const boom = new Error("unreadable");
    ws.message({ size: 3, arrayBuffer: () => Promise.reject(boom) });
    ws.message("after");
    assert.equal(await readText(ch), "before");
    await assert.rejects(ch.read(), (e: unknown) => e instanceof ConnectionClosedError && e.cause === boom);
    assert.equal(await ch.read(), null);
    assert.deepEqual(ws.closes, [{ code: 1011, reason: "unreadable message" }]);
  });

  test("an unreadable Blob also rejects a write waiting for the buffer, even if the close is clean", async () => {
    const ws = new FakeWebSocket();
    ws.holdClose = true;
    const ch = fromWebSocket(ws, { writeHighWaterMark: 0 });
    ws.bufferedAmount = 1;
    const w = ch.write(enc("x"));
    const boom = new Error("unreadable");
    ws.message({ size: 3, arrayBuffer: () => Promise.reject(boom) });
    await assert.rejects(ch.read(), (e: unknown) => e instanceof ConnectionClosedError && e.cause === boom);
    ws.closed(1000);
    await assert.rejects(w, ConnectionClosedError);
    await assert.rejects(ch.write(enc("y")), ConnectionClosedError);
    ch.close();
    await ch.closed;
  });

  test("an unsupported message type fails the next read and closes the socket", async () => {
    const ws = new FakeWebSocket();
    ws.strictCodes = true;
    const ch = fromWebSocket(ws);
    ws.message(42);
    await assert.rejects(
      ch.read(),
      (e: unknown) => e instanceof ConnectionClosedError && /unsupported/.test(e.message),
    );
    assert.deepEqual(ws.closes, [{ code: 1000, reason: undefined }]); // 1003 refused by the WHATWG API
  });

  test("clean close (1000, 1005) after the data is EOF", async () => {
    for (const code of [1000, 1005]) {
      const ws = new FakeWebSocket();
      const ch = fromWebSocket(ws);
      ws.message("a");
      ws.message("b");
      ws.closed(code);
      assert.equal(await readText(ch), "a");
      assert.equal(await readText(ch), "b");
      assert.equal(await ch.read(), null);
      assert.equal(await ch.read(), null);
      await ch.closed;
      assert.equal(ws.listenerCount(), 0, "listeners removed once closed");
    }
  });

  test("an unclean close rejects one read after the data, then null; the reason is quoted", async () => {
    for (const [code, wasClean, reason, message] of [
      [1011, true, "bye", 'websocket closed: code 1011 "bye"'],
      [1000, false, "", "websocket closed: code 1000"],
      [1006, false, "", "websocket closed: code 1006"],
      [4001, true, `x${String.fromCharCode(0x202e)}\n`, 'websocket closed: code 4001 "x\\u202e\\u000a"'],
    ] as const) {
      const ws = new FakeWebSocket();
      const ch = fromWebSocket(ws);
      ws.message("data");
      ws.closed(code, reason, wasClean);
      assert.equal(await readText(ch), "data");
      await assert.rejects(ch.read(), (e: unknown) => {
        assert.ok(e instanceof ConnectionClosedError);
        assert.equal(e.message, message);
        return true;
      });
      assert.equal(await ch.read(), null);
      await ch.closed;
    }
  });

  test("a long peer reason is cut to 256 code units", async () => {
    const ws = new FakeWebSocket();
    const ch = fromWebSocket(ws);
    ws.closed(4000, "r".repeat(1000));
    await assert.rejects(ch.read(), (e: unknown) => e instanceof Error && e.message.length < 300);
  });

  test("an error event: the following close's code is reported (error event as cause)", async () => {
    const ws = new FakeWebSocket();
    const ch = fromWebSocket(ws);
    ws.message("data");
    ws.error();
    ws.closed(1006, "", false);
    assert.equal(await readText(ch), "data");
    await assert.rejects(ch.read(), (e: unknown) => {
      assert.ok(e instanceof ConnectionClosedError);
      assert.equal(e.message, "websocket closed: code 1006");
      assert.ok(e.cause instanceof ConnectionClosedError && e.cause.message === "websocket error");
      return true;
    });
    assert.equal(await ch.read(), null);
  });

  test("an error event alone fails the next read", async () => {
    const ws = new FakeWebSocket();
    const ch = fromWebSocket(ws);
    ws.error();
    await assert.rejects(
      ch.read(),
      (e: unknown) => e instanceof ConnectionClosedError && e.message === "websocket error",
    );
    await assert.rejects(ch.write(enc("x")), ConnectionClosedError);
    ch.close();
  });

  test("concurrent read() is a TypeError", async () => {
    const ws = new FakeWebSocket();
    const ch = fromWebSocket(ws);
    const first = ch.read();
    await assert.rejects(ch.read(), TypeError);
    ch.close();
    assert.equal(await first, null);
  });

  test("the receive buffer cap: queue dropped, socket closed with 1009, next read rejects, then null", async () => {
    const ws = new FakeWebSocket();
    ws.holdClose = true;
    const ch = fromWebSocket(ws, { maxBufferedBytes: 10 });
    ws.message("123456");
    ws.message("7890"); // exactly 10: fine
    assert.deepEqual(ws.closes, []);
    ws.message("x");
    assert.deepEqual(ws.closes, [{ code: 1009, reason: "receive buffer limit exceeded" }]);
    ws.message("ignored");
    await assert.rejects(
      ch.read(),
      (e: unknown) => e instanceof ConnectionClosedError && /receive buffer limit/.test(e.message),
    );
    assert.equal(await ch.read(), null);
    ws.closed(1009, "", true);
    await ch.closed;
  });

  test("the cap counts only unread bytes; a WHATWG socket refusing 1009 is closed with 1000", async () => {
    const ws = new FakeWebSocket();
    ws.strictCodes = true;
    const ch = fromWebSocket(ws, { maxBufferedBytes: 4 });
    for (let i = 0; i < 10; i++) {
      ws.message("abcd");
      assert.equal(await readText(ch), "abcd");
    }
    ws.message("abcde");
    assert.deepEqual(ws.closes, [{ code: 1000, reason: "receive buffer limit exceeded" }]);
    await assert.rejects(ch.read(), ConnectionClosedError);
  });

  test("a Blob counts against the cap by its size", async () => {
    const ws = new FakeWebSocket();
    const ch = fromWebSocket(ws, { maxBufferedBytes: 4 });
    ws.message(new Blob([enc("12345")]));
    await assert.rejects(ch.read(), /receive buffer limit/);
  });
});

describe("fromWebSocket: writing", () => {
  test("write sends the bytes and resolves while bufferedAmount is under the high-water mark", async () => {
    const ws = new FakeWebSocket();
    const ch = fromWebSocket(ws);
    await ch.write(enc("hello\0"));
    await ch.write(enc("x"), []); // an empty fd list is fine
    assert.deepEqual(ws.sent.map(dec), ["hello\0", "x"]);
    ch.close();
  });

  test("backpressure: resolves once bufferedAmount drops to writeHighWaterMark (polled, mocked clock)", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const ws = new FakeWebSocket();
      const ch = fromWebSocket(ws, { writeHighWaterMark: 100 });
      ws.bufferedAmount = 101;
      const p = ch.write(enc("x"));
      assert.equal(await isPending(p), true);
      for (let i = 0; i < 20; i++) {
        mock.timers.tick(50);
        await flush();
      }
      assert.equal(await isPending(p), true);
      ws.bufferedAmount = 100;
      mock.timers.tick(50);
      await flush();
      assert.equal(await isPending(p), false);
      await p;
      ch.close();
    } finally {
      mock.timers.reset();
    }
  });

  test("a waiting write: rejects on an unclean close or a peer-started clean close, resolves after our end()", async () => {
    // Unclean, and clean but started by the peer (RFC 6455 lets it discard frames that arrive after its Close).
    for (const [code, clean] of [
      [1006, false],
      [1000, true],
    ] as const) {
      const ws = new FakeWebSocket();
      const ch = fromWebSocket(ws, { writeHighWaterMark: 0 });
      ws.bufferedAmount = 1;
      const p = ch.write(enc("x"));
      ws.closed(code, "", clean);
      await assert.rejects(p, ConnectionClosedError);
      ch.close();
      await ch.closed;
    }
    // The peer's Close arrived first (CLOSING) and then we call end(): still the peer's close, the write rejects.
    {
      const ws = new FakeWebSocket();
      ws.holdClose = true;
      const ch = fromWebSocket(ws, { writeHighWaterMark: 0 });
      ws.bufferedAmount = 1;
      const p = ch.write(enc("x"));
      ws.readyState = 2;
      const ended = ch.end();
      ws.closed(1000);
      await assert.rejects(p, ConnectionClosedError);
      await ended;
      ch.close();
      await ch.closed;
    }
    // Our end(): the clean close completes the handshake after everything queued was sent.
    const ws = new FakeWebSocket();
    ws.holdClose = true;
    const ch = fromWebSocket(ws, { writeHighWaterMark: 0 });
    ws.bufferedAmount = 1;
    const p = ch.write(enc("x"));
    const ended = ch.end();
    ws.closed(1000);
    await p;
    await ended;
    ch.close();
    await ch.closed;
  });

  test("write rejects unless OPEN, after end()/close(), when send throws, and with fds", async () => {
    const fd = { fd: 3, close: () => undefined };
    const ws = new FakeWebSocket();
    const ch = fromWebSocket(ws);
    await assert.rejects(ch.write(enc("x"), [fd]), OperationNotSupportedError);
    const boom = new Error("send failed");
    ws.sendThrows = boom;
    await assert.rejects(ch.write(enc("x")), (e: unknown) => e instanceof ConnectionClosedError && e.cause === boom);
    ws.sendThrows = undefined;
    ws.readyState = 2;
    await assert.rejects(ch.write(enc("x")), ConnectionClosedError);
    ws.readyState = 1;
    ch.close();
    await assert.rejects(ch.write(enc("x")), ConnectionClosedError);
    const ws2 = new FakeWebSocket();
    const ch2 = fromWebSocket(ws2);
    void ch2.end();
    await assert.rejects(ch2.write(enc("x")), ConnectionClosedError);
    ws2.closed(1000);
  });

  test("close() rejects a write waiting for the buffer", async () => {
    const ws = new FakeWebSocket();
    const ch = fromWebSocket(ws, { writeHighWaterMark: 0 });
    ws.bufferedAmount = 5;
    const p = ch.write(enc("x"));
    ch.close();
    await assert.rejects(p, ConnectionClosedError);
  });
});

describe("fromWebSocket: end, close, closed", () => {
  test("end() closes with 1000 and resolves on the close event; data before it is still read", async () => {
    const ws = new FakeWebSocket();
    ws.holdClose = true;
    const ch = fromWebSocket(ws);
    const ended = ch.end();
    assert.deepEqual(ws.closes, [{ code: 1000, reason: undefined }]);
    assert.equal(await isPending(ended), true);
    ws.message("late reply");
    ws.closed(1000);
    await ended;
    assert.equal(await readText(ch), "late reply");
    assert.equal(await ch.read(), null);
    await ch.closed;
    assert.equal(ws.listenerCount(), 0);
    await ch.end(); // after the close: at once
  });

  test("close() is idempotent: a pending read gives null, the socket is closed once, closed settles on the close event", async () => {
    const ws = new FakeWebSocket();
    ws.holdClose = true;
    const ch = fromWebSocket(ws);
    ws.message("dropped");
    const r = ch.read();
    assert.equal(await readText({ read: () => r } as ReturnType<typeof fromWebSocket>), "dropped");
    ws.message("dropped too");
    ch.close();
    ch.close("again");
    assert.equal(await ch.read(), null);
    assert.deepEqual(ws.closes, [{ code: 1000, reason: undefined }]);
    assert.equal(await isPending(ch.closed), true);
    ws.closed(1000);
    await ch.closed;
    assert.equal(ws.listenerCount(), 0);
  });

  test("closed waits until the end of the stream was read, so queued data is never cut off", async () => {
    const ws = new FakeWebSocket();
    const ch = fromWebSocket(ws);
    ws.message("reply");
    ws.closed(1000);
    assert.equal(await isPending(ch.closed), true);
    assert.equal(await readText(ch), "reply");
    assert.equal(await isPending(ch.closed), true);
    assert.equal(await ch.read(), null);
    await ch.closed;
  });

  test("the 5 s guard: closed (and end()) settle even if the peer never answers the close (mocked clock)", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const ws = new FakeWebSocket();
      ws.holdClose = true;
      const ch = fromWebSocket(ws);
      ch.close();
      mock.timers.tick(4999);
      assert.equal(await isPending(ch.closed), true);
      mock.timers.tick(1);
      await ch.closed;

      const ws2 = new FakeWebSocket();
      ws2.holdClose = true;
      const ch2 = fromWebSocket(ws2, { writeHighWaterMark: 0 });
      ws2.bufferedAmount = 1;
      const w = ch2.write(enc("x"));
      const ended = ch2.end();
      mock.timers.tick(5000);
      await ended;
      await assert.rejects(w, ConnectionClosedError);
      ch2.close();
      await ch2.closed;
      await ch2.end();
    } finally {
      mock.timers.reset();
    }
  });

  test("a read that settles at once with the end of the stream runs its awaiter before closed's listeners", async () => {
    for (const code of [1000, 1011]) {
      const ws = new FakeWebSocket();
      const ch = fromWebSocket(ws);
      const order: string[] = [];
      void ch.closed.then(() => order.push("closed"));
      ws.closed(code, "", true); // nobody is reading yet
      try {
        await ch.read();
        order.push("read");
      } catch {
        order.push("read");
      }
      await ch.closed;
      assert.deepEqual(order, ["read", "closed"], String(code));
    }
  });

  test("end(), then the close event without a reader: no guard timer is left; closed waits for the reader", async () => {
    const timers = trackTimers();
    try {
      const ws = new FakeWebSocket();
      ws.holdClose = true;
      const ch = fromWebSocket(ws);
      const ended = ch.end();
      assert.equal(timers.live(), 1, "the guard");
      ws.closed(1000);
      await ended;
      assert.equal(timers.live(), 0);
      assert.equal(await isPending(ch.closed), true);
      assert.equal(await ch.read(), null);
      await ch.closed;
    } finally {
      timers.restore();
    }
  });

  test("the guard timer is cleared when the close event arrives (no handle left)", async () => {
    const timers = trackTimers();
    try {
      const ws = new FakeWebSocket();
      ws.holdClose = true;
      const ch = fromWebSocket(ws);
      ch.close();
      assert.equal(timers.live(), 1, "the guard");
      ws.closed(1000);
      await ch.closed;
      assert.equal(timers.live(), 0, "the close event cleared the guard");
      assert.equal(ws.listenerCount(), 0);
    } finally {
      timers.restore();
    }
  });

  test(
    "end() unanswered: the guard also ends a pending read and removes the listeners (mocked clock)",
    { timeout: 5000 },
    async () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        const ws = new FakeWebSocket();
        ws.holdClose = true;
        const ch = fromWebSocket(ws);
        const ended = ch.end();
        const read = ch.read();
        mock.timers.tick(5000);
        await ended;
        await assert.rejects(
          read,
          (e: unknown) => e instanceof ConnectionClosedError && /did not close in time/.test(e.message),
        );
        assert.equal(await ch.read(), null);
        await ch.closed;
        assert.equal(ws.listenerCount(), 0);
      } finally {
        mock.timers.reset();
      }
    },
  );
});
