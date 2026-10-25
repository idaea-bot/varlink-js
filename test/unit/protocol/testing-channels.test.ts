// varlink-js/testing (DESIGN.md §4.1, §4.10): pair() semantics and faulty() fault injection.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ConnectionClosedError } from "../../../src/core/errors/index.ts";
import type { ByteChannel } from "../../../src/core/protocol/index.ts";
import { faulty, pair } from "../../../src/testing/index.ts";
import { concat, utf8 } from "./helpers.ts";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Settled state of a promise after the queued microtasks and one macrotask ran. */
async function state(p: Promise<unknown>): Promise<"pending" | "resolved" | "rejected"> {
  let s: "pending" | "resolved" | "rejected" = "pending";
  p.then(
    () => (s = "resolved"),
    () => (s = "rejected"),
  );
  await tick();
  return s;
}

/** Reads until EOF; returns the chunks as strings. */
async function readAll(ch: ByteChannel): Promise<string[]> {
  const out: string[] = [];
  for (let c = await ch.read(); c !== null; c = await ch.read()) out.push(new TextDecoder().decode(c.bytes));
  return out;
}

describe("pair()", () => {
  test("bytes arrive in order, chunk by chunk, copied", async () => {
    const [a, b] = pair();
    const pending = b.read();
    await a.write(utf8("zero")); // handed straight to the waiting read
    assert.equal(new TextDecoder().decode((await pending)?.bytes), "zero");
    const chunk = utf8("one");
    await a.write(chunk);
    chunk[0] = 0x78;
    await a.write(utf8("two"));
    await a.end();
    assert.deepEqual(await readAll(b), ["one", "two"]);
  });

  test("works in both directions; capabilities is {}", async () => {
    const [a, b] = pair();
    await b.write(utf8("back"));
    assert.equal(new TextDecoder().decode((await a.read())?.bytes), "back");
    assert.deepEqual(a.capabilities, {});
  });

  test("backpressure: write() waits until the peer reads below highWaterMark", async () => {
    const [a, b] = pair({ highWaterMark: 4 });
    assert.equal(await state(a.write(utf8("1234"))), "resolved");
    const w = a.write(utf8("5"));
    assert.equal(await state(w), "pending");
    await b.read();
    assert.equal(await state(w), "resolved");
  });

  test("highWaterMark 0: every write waits for its read", async () => {
    const [a, b] = pair({ highWaterMark: 0 });
    const w = a.write(utf8("x"));
    assert.equal(await state(w), "pending");
    await b.read();
    assert.equal(await state(w), "resolved");
  });

  test("end(): peer reads queued bytes then null; later writes reject; closed after both ends", async () => {
    const [a, b] = pair();
    await a.write(utf8("last"));
    await a.end();
    await assert.rejects(a.write(utf8("x")), ConnectionClosedError);
    assert.deepEqual(await readAll(b), ["last"]);
    assert.equal(await b.read(), null);
    assert.equal(await state(a.closed), "pending"); // a has ended but not read EOF
    await b.write(utf8("reply")); // half-closed: b can still write
    await b.end();
    assert.deepEqual(await readAll(a), ["reply"]);
    assert.equal(await state(a.closed), "resolved");
    assert.equal(await state(b.closed), "resolved");
  });

  test("close(): own pending read → null, pending writes reject, peer drains then null, peer writes reject", async () => {
    const [a, b] = pair({ highWaterMark: 0 });
    const read = a.read();
    const blocked = b.write(utf8("to a"));
    // b's write was handed to a's pending read directly.
    assert.equal(new TextDecoder().decode((await read)?.bytes), "to a");
    assert.equal(await state(blocked), "resolved");
    const queued = a.write(utf8("queued for b"));
    const pendingRead = a.read();
    const reason = new Error("bye");
    a.close(reason);
    assert.equal(await pendingRead, null);
    const rejected = await queued.then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(rejected instanceof ConnectionClosedError);
    assert.equal(rejected.cause, reason);
    assert.equal(await a.read(), null);
    await assert.rejects(a.write(utf8("x")), ConnectionClosedError);
    assert.deepEqual(await readAll(b), ["queued for b"]);
    await assert.rejects(b.write(utf8("x")), ConnectionClosedError);
    assert.equal(await state(a.closed), "resolved");
    assert.equal(await state(b.closed), "pending");
    b.close();
    b.close(); // idempotent
    assert.equal(await state(b.closed), "resolved");
  });

  test("the peer's pending write rejects when this side closes", async () => {
    const [a, b] = pair({ highWaterMark: 0 });
    const w = b.write(utf8("never read"));
    a.close();
    await assert.rejects(w, ConnectionClosedError);
  });

  test("concurrent read() is a TypeError", async () => {
    const [a] = pair();
    void a.read();
    await assert.rejects(a.read(), TypeError);
    a.close();
  });

  test("highWaterMark must be a non-negative integer", () => {
    assert.throws(() => pair({ highWaterMark: -1 }), RangeError);
  });
});

describe("faulty()", () => {
  async function received(plan: Parameters<typeof faulty>[1], chunks: string[]): Promise<number[][]> {
    const [a, b] = pair();
    const fb = faulty(b, plan);
    for (const c of chunks) await a.write(utf8(c));
    await a.end();
    const out: number[][] = [];
    for (let c = await fb.read(); c !== null; c = await fb.read()) out.push([...c.bytes]);
    return out;
  }

  test("splitReads every-byte, max size, function", async () => {
    assert.deepEqual(await received({ splitReads: "every-byte" }, ["abc"]), [[97], [98], [99]]);
    assert.deepEqual(await received({ splitReads: 2 }, ["abcde"]), [[97, 98], [99, 100], [101]]);
    assert.deepEqual(await received({ splitReads: () => [3, 1, 1, 99, 0] }, ["abcde"]), [[97], [98, 99], [100, 101]]);
  });

  test("splitWrites splits what this side sends", async () => {
    const [a, b] = pair();
    const fa = faulty(a, { splitWrites: "every-byte" });
    await fa.write(utf8("xyz"));
    await fa.end();
    assert.deepEqual(await readAll(b), ["x", "y", "z"]);
  });

  test("resetAfterReadBytes: delivers up to the limit, then rejects and closes the inner channel", async () => {
    const [a, b] = pair();
    const fb = faulty(b, { resetAfterReadBytes: 5 });
    await a.write(utf8("abc"));
    await a.write(utf8("defgh"));
    assert.equal(new TextDecoder().decode((await fb.read())?.bytes), "abc");
    assert.equal(new TextDecoder().decode((await fb.read())?.bytes), "de");
    await assert.rejects(
      fb.read(),
      (e: unknown) => e instanceof ConnectionClosedError && e.message === "connection reset (faulty)",
    );
    await fb.closed;
    await assert.rejects(a.write(utf8("x")), ConnectionClosedError); // the peer sees the close
  });

  test("resetAfterWriteBytes: bytes beyond the limit are not written", async () => {
    const [a, b] = pair();
    const fa = faulty(a, { resetAfterWriteBytes: 4 });
    await fa.write(utf8("ab"));
    await assert.rejects(fa.write(utf8("cdef")), ConnectionClosedError);
    assert.deepEqual(await readAll(b), ["ab", "cd"]);
  });

  test("delay is awaited before every read and write", async () => {
    const [a, b] = pair();
    let calls = 0;
    const delay = (): Promise<void> => {
      calls++;
      return new Promise((r) => setTimeout(r, 1));
    };
    const fa = faulty(a, { delay });
    const fb = faulty(b, { delay });
    await fa.write(utf8("hi"));
    await fb.read();
    assert.equal(calls, 2);
  });

  test("closed, end, close and capabilities delegate", async () => {
    const [a, b] = pair();
    const fa = faulty(a, {});
    assert.equal(fa.capabilities, a.capabilities);
    fa.close();
    await fa.closed;
    await assert.rejects(b.write(utf8("x")), ConnectionClosedError);
  });

  test("bad plans are RangeErrors", () => {
    const [a] = pair();
    assert.throws(() => faulty(a, { splitReads: 0 }), RangeError);
    assert.throws(() => faulty(a, { splitWrites: 1.5 }), RangeError);
    assert.throws(() => faulty(a, { resetAfterReadBytes: -1 }), RangeError);
  });

  test("a message split at every byte still frames correctly end to end", async () => {
    const [a, b] = pair();
    const fb = faulty(b, { splitReads: "every-byte" });
    await a.write(concat([utf8('{"a":1}'), new Uint8Array([0])]));
    await a.end();
    const bytes: number[] = [];
    for (let c = await fb.read(); c !== null; c = await fb.read()) bytes.push(...c.bytes);
    assert.equal(bytes.length, 8);
  });
});
