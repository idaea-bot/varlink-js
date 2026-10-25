// JSON codec (DESIGN.md §4.3, §7.1): lossless integers with context.source, plain JSON.parse without it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ProtocolError } from "../../../src/core/errors/index.ts";
import { createJsonCodec, jsonCodec, type Codec } from "../../../src/core/types/index.ts";

const P53 = 2n ** 53n;
const withSource = createJsonCodec({ sourceText: true });
const noSource = createJsonCodec({ sourceText: false });

/** [literal, decoded with context.source, decoded without]. */
const INTS: [string, unknown, unknown][] = [
  [String(P53 - 1n), Number(P53 - 1n), Number(P53 - 1n)],
  [String(-(P53 - 1n)), -Number(P53 - 1n), -Number(P53 - 1n)],
  [String(P53), P53, 2 ** 53],
  [String(-P53), -P53, -(2 ** 53)],
  [String(P53 + 1n), P53 + 1n, 2 ** 53],
  ["9223372036854775807", 2n ** 63n - 1n, 2 ** 63],
  ["18446744073709551615", 2n ** 64n - 1n, 2 ** 64],
  ["-9223372036854775808", -(2n ** 63n), -(2 ** 63)],
  ["18446744073709551616", 2n ** 64n, 2 ** 64],
  ["1.0", 1, 1],
  ["1e3", 1000, 1000],
  ["-0", -0, -0],
  ["1.5", 1.5, 1.5],
  ["1e300", 1e300, 1e300],
  ["1e400", Infinity, Infinity],
  ["1" + "0".repeat(399), 10n ** 399n, Infinity],
];

describe("codec feature detection", () => {
  test("Node has context.source and JSON.rawJSON", () => {
    assert.equal(jsonCodec.losslessInts, true);
    assert.equal(withSource.losslessInts, true);
    assert.equal(noSource.losslessInts, false);
  });
});

describe("decode: §7.1 integer table", () => {
  for (const [literal, exact, rounded] of INTS) {
    test(literal.length > 30 ? "400-digit integer" : literal, () => {
      assert.deepEqual(withSource.decode(literal), exact);
      assert.deepEqual(jsonCodec.decode(literal), exact);
      assert.deepEqual(noSource.decode(literal), rounded);
      assert.ok(Object.is(withSource.decode(literal), exact) || typeof exact === "bigint");
    });
  }

  test("nested in arrays and objects", () => {
    const text = `{"a":[1,${String(P53 + 1n)},{"b":18446744073709551615}],"c":1e3,"s":"18446744073709551615"}`;
    assert.deepEqual(withSource.decode(text), {
      a: [1, P53 + 1n, { b: 2n ** 64n - 1n }],
      c: 1000,
      s: "18446744073709551615",
    });
    assert.deepEqual(noSource.decode(text), { a: [1, 2 ** 53, { b: 2 ** 64 }], c: 1000, s: "18446744073709551615" });
  });

  test("__proto__ keys stay own data properties", () => {
    for (const codec of [withSource, noSource]) {
      const v = codec.decode('{"__proto__":{"x":1}}') as Record<string, unknown>;
      assert.equal(Object.getPrototypeOf(v), Object.prototype);
      assert.deepEqual(Object.keys(v), ["__proto__"]);
    }
  });
});

describe("decode errors are ProtocolError", () => {
  const bad = ["", "not json", "{", '{"a":1,}', "[1,]", "NaN", "undefined", "'x'", '"\\x"', "1 2"];
  for (const codec of [withSource, noSource]) {
    test(`invalid JSON (losslessInts ${String(codec.losslessInts)})`, () => {
      for (const text of bad) {
        assert.throws(
          () => codec.decode(text),
          (e: unknown) => e instanceof ProtocolError && e.cause instanceof SyntaxError,
          text,
        );
      }
    });

    test(`deep nesting (losslessInts ${String(codec.losslessInts)})`, () => {
      const isProtocol = (e: unknown): boolean => e instanceof ProtocolError && e.constructor === ProtocolError;
      assert.throws(() => codec.decode("[".repeat(1_000_000)), isProtocol);
      // Valid but deep: the reviver (with source) recurses; either way only ProtocolError may escape.
      try {
        codec.decode("[".repeat(1_000_000) + "]".repeat(1_000_000));
      } catch (e) {
        assert.ok(isProtocol(e), String(e));
      }
    });
  }
});

describe("encode", () => {
  test("bigint round-trips exactly", () => {
    for (const [, exact] of INTS) {
      if (typeof exact !== "bigint") continue;
      const text = jsonCodec.encode({ v: [exact] });
      assert.equal(text, `{"v":[${exact.toString()}]}`);
      assert.deepEqual(jsonCodec.decode(text), { v: [exact] });
    }
  });

  test("numbers, strings and nesting", () => {
    assert.equal(jsonCodec.encode({ a: 1, b: [true, null, "x"], c: 1.5 }), '{"a":1,"b":[true,null,"x"],"c":1.5}');
    assert.equal(jsonCodec.encode(-0), "0");
    assert.equal(jsonCodec.encode({ u: undefined }), "{}");
  });

  test("NaN and ±Infinity throw TypeError, also nested", () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      for (const value of [v, [v], { a: { b: [1, v] } }, Object(v) as unknown]) {
        assert.throws(() => jsonCodec.encode(value), TypeError);
        assert.throws(() => noSource.encode(value), TypeError);
      }
    }
  });

  test("a top-level value JSON cannot represent throws TypeError", () => {
    for (const v of [undefined, () => 0, Symbol("x")]) assert.throws(() => jsonCodec.encode(v), TypeError);
  });

  test("cycles throw JSON.stringify's TypeError", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    assert.throws(() => jsonCodec.encode(a), TypeError);
  });
});

describe("runtimes without the features", () => {
  test("sourceText: true without context.source throws; without JSON.rawJSON bigint encode throws", () => {
    const parse = JSON.parse.bind(JSON);
    const rawJSON = (JSON as { rawJSON?: unknown }).rawJSON;
    let codec: Codec;
    try {
      // Simulate an older engine: a reviver that never receives a context, and no JSON.rawJSON.
      JSON.parse = (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown =>
        reviver ? parse(text, (key, value: unknown) => reviver.call(undefined, key, value)) : parse(text);
      delete (JSON as { rawJSON?: unknown }).rawJSON;
      assert.throws(() => createJsonCodec({ sourceText: true }), { name: "OperationNotSupportedError" });
      codec = createJsonCodec();
    } finally {
      JSON.parse = parse;
      Object.defineProperty(JSON, "rawJSON", { value: rawJSON, writable: true, configurable: true });
    }
    assert.equal(codec.losslessInts, false);
    assert.equal(codec.decode("18446744073709551615"), 2 ** 64);
    assert.throws(() => codec.encode(1n), TypeError);
    assert.equal(codec.encode(1), "1");
  });
});
