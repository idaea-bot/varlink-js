// fds in the framer (M11, DESIGN.md §4.1): bound to the message their chunk starts, handed out with it, closed when
// unclaimed; fds while a message is incomplete are a protocol error (json-stream.c:1345-1350). Driven chunk by chunk,
// so it is deterministic (the end-to-end tests cannot choose where the kernel splits reads).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ProtocolError, type FdHandle } from "../../../src/index.ts";
import { Framer } from "../../../src/core/protocol/framer.ts";

const enc = new TextEncoder();

function fds(...names: string[]): { handles: FdHandle[]; closed: string[] } {
  const closed: string[] = [];
  const handles = names.map((name, i) => ({
    fd: 100 + i,
    close: () => {
      closed.push(name);
    },
  }));
  return { handles, closed };
}

describe("Framer and fds", () => {
  test("fds go with the message their chunk starts; the next one has none", () => {
    const f = new Framer();
    const { handles, closed } = fds("a");
    f.push(enc.encode('{"m":1}\0{"m":2}\0'), handles);
    assert.equal(f.next(), '{"m":1}');
    assert.deepEqual(
      f.takeFds().map((h) => h.fd),
      [100],
    );
    assert.equal(f.next(), '{"m":2}');
    assert.deepEqual(f.takeFds(), []);
    assert.deepEqual(closed, []);
  });

  test("fds with a chunk that starts a message after complete ones belong to that later message", () => {
    const f = new Framer();
    f.push(enc.encode('{"m":1}\0'));
    const { handles } = fds("b");
    f.push(enc.encode('{"m":2}\0'), handles);
    assert.equal(f.next(), '{"m":1}');
    assert.deepEqual(f.takeFds(), []);
    assert.equal(f.next(), '{"m":2}');
    assert.equal(f.takeFds().length, 1);
  });

  test("fds while a message is incomplete: closed, a ProtocolError after the complete messages before", () => {
    const f = new Framer();
    f.push(enc.encode('{"m":1}\0{"m":'));
    const { handles, closed } = fds("mid");
    f.push(enc.encode("2}\0"), handles);
    assert.deepEqual(closed, ["mid"]);
    assert.equal(f.next(), '{"m":1}');
    assert.throws(
      () => f.next(),
      (e: unknown) => e instanceof ProtocolError && /middle of a message/.test(e.message),
    );
  });

  test("unclaimed fds are closed by the next next(), and by discardFds()", () => {
    const f = new Framer();
    const one = fds("one");
    const two = fds("two");
    f.push(enc.encode('{"m":1}\0'), one.handles);
    f.push(enc.encode('{"m":2}\0'), two.handles);
    assert.equal(f.next(), '{"m":1}');
    assert.equal(f.next(), '{"m":2}');
    assert.deepEqual(one.closed, ["one"]);
    f.discardFds();
    assert.deepEqual(two.closed, ["two"]);
  });
});
