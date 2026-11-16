// Framer (DESIGN.md §4.2, §4.10): splitting at every offset, size limit and bounded memory, strict UTF-8.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MessageTooLargeError, ProtocolError } from "../../../src/core/errors/index.ts";
import { DEFAULT_MAX_MESSAGE_SIZE, Framer, frameMessage } from "../../../src/core/protocol/index.ts";
import { concat, frame, utf8 } from "./helpers.ts";

const MESSAGES = ['{"method":"a.b.C"}', '{"text":"zażółć € 😀 𝄞"}', "{}", '{"x":[1,2,{"y":null}]}'];
const STREAM = concat(MESSAGES.map(frame));

/** Pushes the chunks, calling next() after each push; returns every message. */
function drain(framer: Framer, chunks: readonly Uint8Array[]): string[] {
  const out: string[] = [];
  for (const c of chunks) {
    framer.push(c);
    for (let m = framer.next(); m !== null; m = framer.next()) out.push(m);
  }
  return out;
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail("expected a throw");
}

describe("Framer splitting", () => {
  test("the whole stream in one chunk", () => {
    assert.deepEqual(drain(new Framer(), [STREAM]), MESSAGES);
  });

  test("split at every single offset gives the same messages", () => {
    for (let cut = 1; cut < STREAM.length; cut++) {
      const got = drain(new Framer(), [STREAM.subarray(0, cut), STREAM.subarray(cut)]);
      assert.deepEqual(got, MESSAGES, `cut at ${String(cut)}`);
    }
  });

  test("1-byte pushes", () => {
    const chunks = Array.from(STREAM, (b) => new Uint8Array([b]));
    assert.deepEqual(drain(new Framer(), chunks), MESSAGES);
  });

  test("many messages in one chunk, counted by completeMessages", () => {
    const many = Array.from({ length: 1000 }, (_, i) => `{"i":${String(i)}}`);
    const framer = new Framer();
    framer.push(concat(many.map(frame)));
    assert.equal(framer.completeMessages, 1000);
    assert.equal(framer.next(), many[0]);
    assert.equal(framer.completeMessages, 999);
    const rest: string[] = [];
    for (let m = framer.next(); m !== null; m = framer.next()) rest.push(m);
    assert.deepEqual(rest, many.slice(1));
    assert.equal(framer.completeMessages, 0);
    assert.equal(framer.buffered, 0);
  });

  test("an incomplete message is not returned and is buffered", () => {
    const framer = new Framer();
    framer.push(utf8('{"a":1}\0{"b"'));
    assert.equal(framer.next(), '{"a":1}');
    assert.equal(framer.next(), null);
    assert.equal(framer.buffered, 4);
    assert.equal(framer.completeMessages, 0);
    framer.push(utf8(":2}\0"));
    assert.equal(framer.next(), '{"b":2}');
  });

  test("an empty message is the empty string", () => {
    const framer = new Framer();
    framer.push(new Uint8Array([0, 0]));
    assert.equal(framer.next(), "");
    assert.equal(framer.next(), "");
    assert.equal(framer.next(), null);
  });

  test("push copies its input", () => {
    const framer = new Framer();
    const chunk = utf8("ab\0");
    framer.push(chunk);
    chunk[0] = 0x7a;
    assert.equal(framer.next(), "ab");
  });

  test("growth and compaction: a 1 MiB message in 1-byte pushes, then more messages", () => {
    const framer = new Framer();
    const size = 1024 * 1024;
    const one = new Uint8Array([0x61]);
    for (let i = 0; i < size; i++) {
      framer.push(one);
      if (i % 65536 === 0) assert.equal(framer.buffered, i + 1);
    }
    assert.equal(framer.next(), null);
    framer.push(new Uint8Array([0]));
    const text = framer.next();
    assert.equal(text?.length, size);
    assert.equal(framer.buffered, 0);
    // Interleaved pushes and reads keep exact accounting across compactions.
    let expected = 0;
    const queue: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const text = `{"i":${String(i)}}`;
      framer.push(frame(text));
      queue.push(text);
      expected += text.length + 1;
      if (i % 3 === 0) {
        const want = queue.shift();
        assert.equal(framer.next(), want);
        expected -= (want ?? "").length + 1;
      }
      assert.equal(framer.buffered, expected);
      assert.equal(framer.completeMessages, queue.length);
    }
  });

  test("the buffer shrinks back once a 16 MiB message was consumed", () => {
    const framer = new Framer();
    const mib = new Uint8Array(1024 * 1024).fill(0x20);
    for (let i = 0; i < 15; i++) framer.push(mib);
    framer.push(mib.subarray(2));
    framer.push(utf8("{}\0")); // exactly DEFAULT_MAX_MESSAGE_SIZE bytes before the NUL
    assert.ok(framer.capacity >= DEFAULT_MAX_MESSAGE_SIZE);
    assert.equal(framer.next()?.length, DEFAULT_MAX_MESSAGE_SIZE);
    assert.equal(framer.buffered, 0);
    assert.ok(framer.capacity <= 4096, `capacity ${String(framer.capacity)}`);
    framer.push(frame("{}"));
    assert.equal(framer.capacity, 4096);
    assert.equal(framer.next(), "{}");
    assert.equal(framer.capacity, 4096); // small buffers are kept (no churn)
  });

  test("a large buffer is kept while at least a quarter of it is still buffered", () => {
    const framer = new Framer();
    framer.push(concat([frame("x".repeat(100_000)), utf8("y".repeat(40_000))]));
    const capacity = framer.capacity;
    assert.equal(framer.next()?.length, 100_000);
    assert.equal(framer.capacity, capacity);
    assert.equal(framer.buffered, 40_000);
    framer.push(new Uint8Array([0]));
    assert.equal(framer.next(), "y".repeat(40_000));
  });

  test("a 16 MiB call followed by one byte of the next one: the buffer shrinks once the big one is consumed", () => {
    const framer = new Framer();
    const mib = new Uint8Array(1024 * 1024).fill(0x20);
    for (let i = 0; i < 15; i++) framer.push(mib);
    framer.push(mib.subarray(2));
    framer.push(utf8("{}\0{")); // the big call, then the first byte of the next call
    assert.ok(framer.capacity >= DEFAULT_MAX_MESSAGE_SIZE);
    assert.equal(framer.next()?.length, DEFAULT_MAX_MESSAGE_SIZE);
    assert.equal(framer.buffered, 1);
    assert.equal(framer.capacity, 4096); // an idle client does not pin 16+ MiB
    framer.push(utf8("}\0"));
    assert.equal(framer.next(), "{}");
  });

  test("shrinking keeps the unconsumed bytes and the scan state (partial and complete messages)", () => {
    const framer = new Framer();
    framer.push(concat([frame("x".repeat(200_000)), frame("next"), utf8("part")]));
    assert.equal(framer.next()?.length, 200_000);
    assert.equal(framer.capacity, 4096);
    assert.equal(framer.completeMessages, 1);
    assert.equal(framer.buffered, 9);
    framer.push(utf8("ial\0"));
    assert.equal(framer.next(), "next");
    assert.equal(framer.next(), "partial");
    assert.equal(framer.buffered, 0);
  });

  test("pipelined ~1 MiB messages read with the server's byte bound: capacity stays ≤ 4 MiB + one chunk", () => {
    // Mirrors ServerSession.wantsInput: push while no complete message is buffered or buffered < max; otherwise
    // the consumer takes one message.
    const max = 1024 * 1024;
    const chunk = 64 * 1024;
    const framer = new Framer({ maxMessageSize: max });
    const one = frame(`{"x":"${"x".repeat(max - 100)}"}`);
    const count = 64;
    const stream = concat(Array.from({ length: count }, () => one));
    let sent = 0;
    let taken = 0;
    let maxCapacity = 0;
    while (taken < count) {
      if ((framer.completeMessages === 0 || framer.buffered < max) && sent < stream.length) {
        framer.push(stream.subarray(sent, sent + chunk));
        sent = Math.min(stream.length, sent + chunk);
      } else {
        assert.equal(framer.next()?.length, one.length - 1);
        taken++;
      }
      maxCapacity = Math.max(maxCapacity, framer.capacity);
      assert.ok(framer.capacity <= 4 * max + chunk, `capacity ${String(framer.capacity)} after ${String(sent)} bytes`);
    }
    assert.ok(maxCapacity > max); // the buffer did hold more than one message
  });

  test("needing room with less than a quarter consumed grows instead of compacting", () => {
    const framer = new Framer();
    framer.push(concat([frame("a"), utf8("x".repeat(4094))]));
    assert.equal(framer.capacity, 4096);
    assert.equal(framer.next(), "a"); // 2 bytes consumed: < 1/4 of the buffer
    framer.push(utf8("x"));
    assert.equal(framer.capacity, 8192); // compacting here would move ~4 KiB for 2 freed bytes
    assert.equal(framer.buffered, 4095);
    framer.push(new Uint8Array([0]));
    assert.equal(framer.next(), "x".repeat(4095));
  });

  test("needing room with at least a quarter consumed compacts in place", () => {
    const framer = new Framer();
    const first = "a".repeat(1100);
    framer.push(concat([frame(first), utf8("x".repeat(4096 - 1101))]));
    assert.equal(framer.capacity, 4096);
    assert.equal(framer.next(), first); // 1101 bytes consumed: ≥ 1/4, < 1/2 (no compaction in next())
    framer.push(utf8("yz"));
    assert.equal(framer.capacity, 4096);
    framer.push(new Uint8Array([0]));
    assert.equal(framer.next(), `${"x".repeat(4096 - 1101)}yz`);
  });
});

describe("Framer size limit", () => {
  test("exactly maxMessageSize is fine, one more byte is an error", () => {
    const framer = new Framer({ maxMessageSize: 10 });
    framer.push(frame("0123456789"));
    assert.equal(framer.next(), "0123456789");
    framer.push(frame("0123456789A"));
    assert.ok(thrown(() => framer.next()) instanceof MessageTooLargeError);
  });

  test("complete messages before a too large partial one are delivered first", () => {
    const framer = new Framer({ maxMessageSize: 8 });
    framer.push(concat([frame("one"), frame("two"), utf8("123456789")]));
    assert.equal(framer.completeMessages, 2);
    assert.equal(framer.accepting, false);
    assert.equal(framer.next(), "one");
    assert.equal(framer.next(), "two");
    const e = thrown(() => framer.next());
    assert.ok(e instanceof MessageTooLargeError);
    assert.ok(e instanceof ProtocolError);
    // Failed: the same error object forever, push is a no-op.
    assert.equal(
      thrown(() => framer.next()),
      e,
    );
    framer.push(frame("ok"));
    assert.equal(
      thrown(() => framer.next()),
      e,
    );
  });

  test("the limit counts bytes, not characters", () => {
    const framer = new Framer({ maxMessageSize: 4 });
    framer.push(frame("😀")); // 4 bytes
    assert.equal(framer.next(), "😀");
    framer.push(frame("€€")); // 6 bytes
    assert.ok(thrown(() => framer.next()) instanceof MessageTooLargeError);
  });

  test("64 MiB without NUL in 64 KiB chunks: bounded memory, MessageTooLargeError", () => {
    const framer = new Framer();
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const bound = DEFAULT_MAX_MESSAGE_SIZE + chunk.length;
    for (let sent = 0; sent < 64 * 1024 * 1024; sent += chunk.length) {
      framer.push(chunk);
      assert.ok(framer.buffered <= bound, `buffered ${String(framer.buffered)} after ${String(sent)}`);
    }
    assert.ok(thrown(() => framer.next()) instanceof MessageTooLargeError);
  });

  test("maxMessageSize must be a positive safe integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 53, "1"]) {
      assert.throws(() => new Framer({ maxMessageSize: bad as number }), RangeError, String(bad));
    }
    assert.equal(DEFAULT_MAX_MESSAGE_SIZE, 16 * 1024 * 1024);
  });
});

describe("Framer UTF-8", () => {
  const invalid: [string, number[]][] = [
    ["overlong", [0xc0, 0xaf]],
    ["lone continuation", [0x80]],
    ["CESU-8 surrogate", [0xed, 0xa0, 0x80]],
    ["truncated sequence", [0xe2, 0x82]],
    ["invalid byte", [0xff]],
  ];
  for (const [name, bytes] of invalid) {
    test(`${name} is a ProtocolError when reached`, () => {
      const framer = new Framer();
      framer.push(concat([frame("good"), new Uint8Array([0x7b, ...bytes, 0x7d, 0])]));
      assert.equal(framer.next(), "good");
      const e = thrown(() => framer.next());
      assert.ok(e instanceof ProtocolError);
      assert.ok(!(e instanceof MessageTooLargeError));
      assert.ok(e.cause instanceof TypeError);
      assert.equal(
        thrown(() => framer.next()),
        e,
      );
    });
  }

  test("a leading BOM stays in the text", () => {
    const framer = new Framer();
    framer.push(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0]));
    assert.equal(framer.next(), "﻿{}");
  });
});

describe("Framer.takeRemainder", () => {
  test("returns a copy of the unconsumed bytes and finishes the framer", () => {
    const framer = new Framer();
    framer.push(utf8("a\0bc\0de"));
    assert.equal(framer.next(), "a");
    const rest = framer.takeRemainder();
    assert.deepEqual(rest, utf8("bc\0de"));
    assert.equal(framer.buffered, 0);
    assert.equal(framer.accepting, false);
    assert.throws(() => {
      framer.push(utf8("x"));
    }, TypeError);
    assert.throws(() => framer.next(), TypeError);
    assert.throws(() => framer.takeRemainder(), TypeError);
  });

  test("throws the pending MessageTooLargeError if bytes were dropped", () => {
    const framer = new Framer({ maxMessageSize: 4 });
    framer.push(utf8("a\x00123456"));
    assert.equal(framer.next(), "a");
    framer.push(utf8("more"));
    assert.ok(thrown(() => framer.takeRemainder()) instanceof MessageTooLargeError);
  });

  test("keeps the bytes of the push that hit the limit", () => {
    const framer = new Framer({ maxMessageSize: 4 });
    framer.push(utf8("a\x00123456"));
    assert.equal(framer.next(), "a");
    assert.deepEqual(framer.takeRemainder(), utf8("123456"));
  });
});

describe("frameMessage", () => {
  test("UTF-8 plus NUL", () => {
    assert.deepEqual(frameMessage("{}"), new Uint8Array([0x7b, 0x7d, 0]));
    assert.deepEqual(frameMessage("€"), new Uint8Array([0xe2, 0x82, 0xac, 0]));
    assert.deepEqual(frameMessage(""), new Uint8Array([0]));
  });

  test("rejects NUL and lone surrogates", () => {
    assert.throws(() => frameMessage('{"a":"\0"}'), TypeError);
    assert.throws(() => frameMessage("\uD800"), TypeError);
    assert.throws(() => frameMessage("x\uDC00"), TypeError);
    assert.throws(() => frameMessage(1 as unknown as string), TypeError);
  });
});
