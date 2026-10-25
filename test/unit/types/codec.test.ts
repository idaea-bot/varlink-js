// JSON codec (DESIGN.md §4.3, §7.1): lossless integers with context.source, plain JSON.parse without it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ProtocolError } from "../../../src/core/errors/index.ts";
import { MAX_BIGINT_SOURCE_LENGTH, MAX_JSON_DEPTH } from "../../../src/core/types/codec.ts";
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

    test(`a non-string argument is a TypeError (losslessInts ${String(codec.losslessInts)})`, () => {
      for (const arg of [123, undefined, new Uint8Array([0x31])]) {
        assert.throws(() => codec.decode(arg as unknown as string), {
          name: "TypeError",
          message: "decode expects a string",
        });
      }
    });

    test(`deep nesting (losslessInts ${String(codec.losslessInts)})`, () => {
      const isProtocol = (e: unknown): boolean => e instanceof ProtocolError && e.constructor === ProtocolError;
      assert.throws(() => codec.decode("[".repeat(1_000_000)), isProtocol);
      // Valid but deep: refused before parsing, the same in both modes.
      assert.throws(() => codec.decode("[".repeat(200_000) + "]".repeat(200_000)), {
        name: "ProtocolError",
        message: `JSON nested deeper than ${String(MAX_JSON_DEPTH)} levels`,
      });
    });
  }
});

describe(`decode: at most ${String(MAX_JSON_DEPTH)} levels (sd-json DEPTH_MAX)`, () => {
  const arrays = (n: number, inner = ""): string => "[".repeat(n) + inner + "]".repeat(n);
  const objects = (n: number): string => '{"a":'.repeat(n - 1) + "{}" + "}".repeat(n - 1);
  /** [levels, innermost container] of a single-path nesting; iterative (assert.deepEqual overflows here). */
  const depthOf = (value: unknown): [number, unknown] => {
    let v = value;
    let n = 0;
    for (;;) {
      if (typeof v !== "object" || v === null) return [n, v];
      const children = Object.values(v);
      if (children.length === 0) return [n + 1, v];
      if (children.length > 1 || typeof children[0] !== "object") return [n + 1, children];
      n++;
      v = children[0];
    }
  };

  for (const codec of [withSource, noSource]) {
    const mode = `losslessInts ${String(codec.losslessInts)}`;
    test(`exactly ${String(MAX_JSON_DEPTH)} decodes, one more is ProtocolError (${mode})`, () => {
      assert.deepEqual(depthOf(codec.decode(arrays(MAX_JSON_DEPTH))), [MAX_JSON_DEPTH, []]);
      assert.deepEqual(depthOf(codec.decode(objects(MAX_JSON_DEPTH))), [MAX_JSON_DEPTH, {}]);
      // With a 16-digit number, so the source mode really runs its reviver.
      const big = codec.decode(arrays(MAX_JSON_DEPTH, "18446744073709551615"));
      assert.deepEqual(depthOf(big), [MAX_JSON_DEPTH, [codec.losslessInts ? 2n ** 64n - 1n : 2 ** 64]]);
      // (An unclosed "[" × 2049 is shorter than the scan threshold: plain invalid JSON, still a ProtocolError.)
      assert.throws(() => codec.decode("[".repeat(MAX_JSON_DEPTH + 1)), ProtocolError);
      for (const text of [arrays(MAX_JSON_DEPTH + 1), objects(MAX_JSON_DEPTH + 1), "[".repeat(3 * MAX_JSON_DEPTH)])
        assert.throws(() => codec.decode(text), { name: "ProtocolError", message: /nested deeper/ });
    });

    test(`brackets and escaped quotes inside strings do not count (${mode})`, () => {
      const tricky = JSON.stringify('"' + "[{".repeat(5000) + '\\"[\\');
      assert.equal(typeof codec.decode(tricky), "string");
      assert.ok(codec.decode(arrays(MAX_JSON_DEPTH, tricky)));
      assert.throws(() => codec.decode(arrays(MAX_JSON_DEPTH + 1, tricky)), ProtocolError);
      const list = codec.decode(`[${tricky},${tricky}]`) as unknown[];
      assert.equal(list.length, 2);
    });
  }
});

describe("decode: integer literal length limit", () => {
  test(`literals of at most ${String(MAX_BIGINT_SOURCE_LENGTH)} characters are exact`, () => {
    const longest = "1" + "0".repeat(MAX_BIGINT_SOURCE_LENGTH - 1);
    assert.equal(withSource.decode(longest), 10n ** BigInt(MAX_BIGINT_SOURCE_LENGTH - 1));
    const negative = "-" + "9".repeat(MAX_BIGINT_SOURCE_LENGTH - 1);
    assert.equal(withSource.decode(negative), -(10n ** BigInt(MAX_BIGINT_SOURCE_LENGTH - 1) - 1n));
    assert.equal(withSource.decode(longest + "0"), Infinity);
    assert.equal(withSource.decode("-" + "9".repeat(MAX_BIGINT_SOURCE_LENGTH)), -Infinity);
  });

  test("a 2000-digit literal decodes to Infinity, quickly", () => {
    assert.deepEqual(withSource.decode(`{"a":[1${"0".repeat(1999)}]}`), { a: [Infinity] });
    const start = performance.now();
    assert.equal(withSource.decode("1".repeat(1_000_000)), Infinity);
    assert.ok(performance.now() - start < 1000, "a 1M-digit literal is not handed to BigInt()");
  });
});

describe("decode: the reviver is skipped without a 16-digit run", () => {
  // Adding a field with a 16-digit run forces the reviver; the rest of the result must not change.
  const inputs = [
    "1",
    "-0",
    '"x"',
    "[1.5,1e3,-0,1e400,123456789012345]",
    '{"a":{"b":[9007199254740991,-9007199254740991]},"c":null,"d":true}',
    '{"__proto__":{"x":1},"s":"[{"}',
  ];
  for (const text of inputs) {
    test(text, () => {
      const plain = withSource.decode(text);
      const forced = withSource.decode(`[${text},"0000000000000000"]`) as unknown[];
      assert.deepEqual(forced, [plain, "0000000000000000"]);
      assert.deepEqual(plain, noSource.decode(text));
      if (typeof plain === "number") assert.ok(Object.is(plain, forced[0]));
    });
  }

  test("a 16-digit run anywhere enables it", () => {
    assert.equal(withSource.decode(String(P53)), P53);
    assert.deepEqual(withSource.decode(`{"s":"1234567890123456","n":${String(P53)}}`), {
      s: "1234567890123456",
      n: P53,
    });
  });
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
    assert.equal(jsonCodec.encode({ u: undefined }), "{}");
  });

  test("-0 is written as -0 (decode keeps it too)", () => {
    for (const codec of [withSource, noSource]) {
      assert.equal(codec.encode(-0), "-0");
      assert.equal(codec.encode({ f: [-0, 0] }), '{"f":[-0,0]}');
      const back = codec.decode(codec.encode({ f: -0 })) as { f: number };
      assert.ok(Object.is(back.f, -0));
    }
  });

  test("a BigInt.prototype.toJSON polyfill does not change the output", () => {
    const value = { a: 2n ** 64n - 1n, b: [-(2n ** 63n), 1n], c: 1 };
    const expected = '{"a":18446744073709551615,"b":[-9223372036854775808,1],"c":1}';
    const polyfills = [
      function (this: bigint): string {
        return this.toString();
      },
      function (this: bigint): number {
        return Number(this);
      },
    ];
    for (const toJSON of polyfills) {
      try {
        Object.defineProperty(BigInt.prototype, "toJSON", { value: toJSON, writable: true, configurable: true });
        assert.equal(jsonCodec.encode(value), expected);
        assert.equal(jsonCodec.encode(2n ** 64n - 1n), "18446744073709551615");
      } finally {
        delete (BigInt.prototype as { toJSON?: unknown }).toJSON;
      }
    }
    assert.equal(Object.hasOwn(BigInt.prototype, "toJSON"), false);
  });

  test("a value nested too deeply to encode throws TypeError", () => {
    let deep: unknown = [];
    for (let i = 0; i < 1_000_000; i++) deep = [deep];
    assert.throws(
      () => jsonCodec.encode(deep),
      (e: unknown) =>
        e instanceof TypeError &&
        e.cause instanceof RangeError &&
        e.message === `cannot encode value: ${e.cause.message}`,
    );
  });

  test(`at most ${String(MAX_JSON_DEPTH)} levels encode; one more is a TypeError (peers refuse it)`, () => {
    const nest = (n: number, wrap: (v: unknown) => unknown): unknown => {
      let v: unknown = 1;
      for (let i = 0; i < n; i++) v = wrap(v);
      return v;
    };
    const message = `value nested deeper than ${String(MAX_JSON_DEPTH)} levels cannot be sent (peers refuse it)`;
    for (const wrap of [(v: unknown) => ({ a: v }), (v: unknown) => [v]]) {
      for (const codec of [withSource, noSource]) {
        const text = codec.encode(nest(MAX_JSON_DEPTH, wrap));
        assert.equal(text, codec.encode(codec.decode(text)));
        assert.throws(() => codec.encode(nest(MAX_JSON_DEPTH + 1, wrap)), { name: "TypeError", message });
      }
    }
    // Brackets inside strings do not count.
    assert.ok(jsonCodec.encode({ s: "[{".repeat(5 * MAX_JSON_DEPTH) }));
  });

  test("U+007F is escaped (sd-json refuses it raw); the value round-trips", () => {
    for (const codec of [withSource, noSource]) {
      const value = { s: "a\x7fb", "k\x7f": ["\x7f"] };
      const text = codec.encode(value);
      assert.equal(text.includes("\x7f"), false);
      assert.equal(text, '{"s":"a\\u007fb","k\\u007f":["\\u007f"]}');
      assert.deepEqual(codec.decode(text), value);
    }
  });

  test("a getter runs once per encode; a getter returning a bigint encodes exactly", () => {
    let calls = 0;
    const value = {
      get n() {
        calls++;
        return 2n ** 64n - 1n;
      },
    };
    assert.equal(jsonCodec.encode(value), '{"n":18446744073709551615}');
    assert.equal(calls, 1);
    assert.equal(jsonCodec.encode([value, value]), '[{"n":18446744073709551615},{"n":18446744073709551615}]');
    assert.equal(calls, 3);
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
