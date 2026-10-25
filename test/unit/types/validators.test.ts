// Compiled validators (DESIGN.md §4.3, §4.9, §7.1): tables per type, then the cross-cutting rules.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { IntegerRangeError, OperationNotSupportedError, ValidationError } from "../../../src/core/errors/index.ts";
import { IdlSyntaxError, parseInterface } from "../../../src/core/idl/index.ts";
import {
  compileInterface,
  compileInterfaceText,
  createJsonCodec,
  jsonCodec,
  MAX_VALUE_DEPTH,
  type CompileOptions,
  type IntsMode,
  type Validator,
} from "../../../src/core/types/index.ts";

const DEFS = `interface org.example.t
type Point (x: int, y: int)
type Color (red, green, blue)
type Node (value: int, children: []Node)
type Tree (name: string, kids: ?[string]Tree)
type Fields (toString: ?int, constructor: ?string, valueOf: int)
`;

const cache = new Map<string, Validator>();
/** Validator of `type W (v: <typeText>)`. */
function wrapper(typeText: string, options: CompileOptions = {}): Validator {
  const key = JSON.stringify([typeText, options.ints, options.lenientInts]);
  let v = cache.get(key);
  if (v === undefined) {
    const compiled = compileInterfaceText(`${DEFS}type W (v: ${typeText})\n`, options);
    v = compiled.types.get("W");
    assert.ok(v);
    cache.set(key, v);
  }
  return v;
}

type Dir = "reject" | "drop" | "encode";
const DIRS: readonly Dir[] = ["reject", "drop", "encode"];

function run(v: Validator, dir: Dir, value: unknown): unknown {
  return dir === "encode" ? v.encode(value) : v.decode(value, { unknownFields: dir });
}

/** The ValidationError `fn` throws. */
function validationError(fn: () => unknown): ValidationError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ValidationError, `expected ValidationError, got ${String(e)}`);
    assert.equal(e instanceof IntegerRangeError, e.reason === "int-range", "int-range ⇔ IntegerRangeError");
    return e;
  }
  assert.fail("expected a ValidationError");
}

const ABSENT = Symbol("absent");

/** A row's input for assertion labels. */
function show(value: unknown): string {
  try {
    return `${String(value)} (${typeof value})`;
  } catch {
    return typeof value;
  }
}
const OMITTED = Symbol("omitted");
type Outcome = { out: unknown } | { reason: ValidationError["reason"]; parameter?: string };

interface Row {
  type: string;
  /** Directions the row applies to; default all three. */
  dirs?: readonly Dir[];
  ints?: IntsMode;
  lenientInts?: boolean;
  /** The value of field `v` (ABSENT: no such key). */
  input: unknown;
  /** Expected value of `v` in the output (OMITTED: key absent), or the error (parameter default "v"). */
  expect: Outcome;
}

const ok = (out: unknown): Outcome => ({ out });
const err = (reason: ValidationError["reason"], parameter = "v"): Outcome => ({ reason, parameter });

function checkRows(rows: Row[]): void {
  for (const row of rows) {
    const opts: CompileOptions = {};
    if (row.ints) opts.ints = row.ints;
    if (row.lenientInts) opts.lenientInts = true;
    const v = wrapper(row.type, opts);
    for (const dir of row.dirs ?? DIRS) {
      const label = `${row.type} ${dir} ${row.ints ?? "number"} ${show(row.input)}`;
      const input = row.input === ABSENT ? {} : { v: row.input };
      if ("out" in row.expect) {
        const out = run(v, dir, input) as Record<string, unknown>;
        if (row.expect.out === OMITTED) assert.deepEqual(out, {}, label);
        else assert.deepEqual(out, { v: row.expect.out }, label);
      } else {
        const e = validationError(() => run(v, dir, input));
        assert.equal(e.reason, row.expect.reason, label);
        assert.equal(e.parameter, row.expect.parameter ?? "v", label);
      }
    }
  }
}

const DECODE: readonly Dir[] = ["reject", "drop"];
const ENCODE: readonly Dir[] = ["encode"];

describe("primitives", () => {
  test("bool", () => {
    checkRows([
      { type: "bool", input: true, expect: ok(true) },
      { type: "bool", input: false, expect: ok(false) },
      { type: "bool", input: 0, expect: err("type") },
      { type: "bool", input: "true", expect: err("type") },
      { type: "bool", input: null, expect: err("null") },
      { type: "bool", input: ABSENT, expect: err("missing") },
    ]);
  });

  test("string", () => {
    checkRows([
      { type: "string", input: "", expect: ok("") },
      { type: "string", input: "x\u0000y", expect: ok("x\u0000y") },
      { type: "string", input: 1, expect: err("type") },
      { type: "string", input: ["a"], expect: err("type") },
      { type: "string", input: null, expect: err("null") },
    ]);
  });

  test("int, number mode", () => {
    checkRows([
      { type: "int", input: 0, expect: ok(0) },
      { type: "int", input: -0, expect: ok(0) },
      { type: "int", input: 2 ** 53 - 1, expect: ok(2 ** 53 - 1) },
      { type: "int", input: -(2 ** 53 - 1), expect: ok(-(2 ** 53 - 1)) },
      { type: "int", input: 2 ** 53, expect: err("int-range") },
      { type: "int", input: 1e18, expect: err("int-range") },
      { type: "int", input: 1.5, expect: err("type") },
      { type: "int", input: NaN, expect: err("type") },
      // Non-finite: a literal too long to decode (or 1e400); int-range on every runtime.
      { type: "int", input: Infinity, expect: err("int-range") },
      { type: "int", input: -Infinity, expect: err("int-range") },
      { type: "int", ints: "bigint", input: Infinity, expect: err("int-range") },
      { type: "int", input: 5n, dirs: DECODE, expect: ok(5) },
      { type: "int", input: 5n, dirs: ENCODE, expect: ok(5n) },
      { type: "int", input: 2n ** 53n, dirs: DECODE, expect: err("int-range") },
      { type: "int", input: 2n ** 64n - 1n, dirs: ENCODE, expect: ok(2n ** 64n - 1n) },
      { type: "int", input: 2n ** 64n, expect: err("int-range") },
      { type: "int", input: -(2n ** 63n) - 1n, expect: err("int-range") },
      { type: "int", input: "1", expect: err("type") },
      { type: "int", input: true, expect: err("type") },
      { type: "int", input: null, expect: err("null") },
    ]);
  });

  test("int, bigint mode", () => {
    checkRows([
      { type: "int", ints: "bigint", input: 1, dirs: DECODE, expect: ok(1n) },
      { type: "int", ints: "bigint", input: 1, dirs: ENCODE, expect: ok(1) },
      { type: "int", ints: "bigint", input: -0, dirs: DECODE, expect: ok(0n) },
      { type: "int", ints: "bigint", input: 2n ** 64n - 1n, expect: ok(2n ** 64n - 1n) },
      { type: "int", ints: "bigint", input: -(2n ** 63n), expect: ok(-(2n ** 63n)) },
      { type: "int", ints: "bigint", input: 2n ** 64n, expect: err("int-range") },
      { type: "int", ints: "bigint", input: 2 ** 53, expect: err("int-range") },
      { type: "int", ints: "bigint", input: 0.5, expect: err("type") },
    ]);
  });

  test("int, lenientInts", () => {
    const L = { type: "int", lenientInts: true } as const;
    checkRows([
      { ...L, input: "42", dirs: DECODE, expect: ok(42) },
      { ...L, input: "-0", dirs: DECODE, expect: ok(0) },
      { ...L, input: "0", dirs: DECODE, expect: ok(0) },
      { ...L, input: "-9007199254740991", dirs: DECODE, expect: ok(-(2 ** 53 - 1)) },
      { ...L, input: "9007199254740992", dirs: DECODE, expect: err("int-range") },
      { ...L, ints: "bigint", input: "18446744073709551615", dirs: DECODE, expect: ok(2n ** 64n - 1n) },
      { ...L, ints: "bigint", input: "18446744073709551616", dirs: DECODE, expect: err("int-range") },
      { ...L, ints: "bigint", input: "1" + "0".repeat(1000), dirs: DECODE, expect: err("int-range") },
      { ...L, input: "42", dirs: ENCODE, expect: err("type") },
      ...["007", "1.0", " 1", "1 ", "+1", "", "-", "1e3", "0x10", "١"].map((input): Row => ({
        ...L,
        input,
        dirs: DECODE,
        expect: err("type"),
      })),
    ]);
  });

  test("float", () => {
    checkRows([
      { type: "float", input: 1.5, expect: ok(1.5) },
      { type: "float", input: 1, expect: ok(1) },
      { type: "float", input: 1e300, expect: ok(1e300) },
      { type: "float", input: 2n ** 64n, dirs: DECODE, expect: ok(2 ** 64) },
      { type: "float", input: 2n ** 64n, dirs: ENCODE, expect: ok(2n ** 64n) },
      { type: "float", input: 10n ** 400n, dirs: DECODE, expect: err("type") },
      { type: "float", input: Infinity, expect: err("type") },
      { type: "float", input: -Infinity, expect: err("type") },
      { type: "float", input: NaN, expect: err("type") },
      { type: "float", input: "1.5", expect: err("type") },
      { type: "float", input: null, expect: err("null") },
    ]);
  });

  test("float -0 round-trips through the codec; int -0 becomes 0", () => {
    const f = wrapper("float");
    const text = jsonCodec.encode(f.encode({ v: -0 }));
    assert.equal(text, '{"v":-0}');
    const out = f.decode(jsonCodec.decode(text)) as { v: number };
    assert.ok(Object.is(out.v, -0));
    assert.equal(jsonCodec.encode(wrapper("int").encode({ v: -0 })), '{"v":0}');
  });

  test("object", () => {
    const plain = { a: [1, { b: 2n }] };
    const bare = Object.create(null) as object;
    checkRows([
      { type: "object", input: plain, expect: ok(plain) },
      { type: "object", input: {}, expect: ok({}) },
      { type: "object", input: bare, expect: ok(bare) },
      { type: "object", input: [], expect: err("type") },
      { type: "object", input: new Date(0), expect: err("type") },
      { type: "object", input: new Map(), expect: err("type") },
      {
        type: "object",
        input: new (class Foo {
          x = 1;
        })(),
        expect: err("type"),
      },
      { type: "object", input: "{}", expect: err("type") },
      { type: "object", input: null, expect: err("null") },
    ]);
    // Returned by reference.
    const out = wrapper("object").decode({ v: plain }) as { v: unknown };
    assert.equal(out.v, plain);
  });

  test("JSON.rawJSON objects are not plain objects", () => {
    const raw = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON("1");
    assert.equal(Object.getPrototypeOf(raw), null);
    for (const type of ["object", "any", "()", "(a: ?int)", "[string]int"])
      checkRows([{ type, input: raw, expect: err("type") }]);
    checkRows([{ type: "[]any", input: [1, raw], expect: err("type", "v.1") }]);
  });

  test("any", () => {
    const arr = [1, null, "x"];
    checkRows([
      ...[true, 0, 1.5, 2n ** 64n, "s", arr, { a: null }].map((input): Row => ({
        type: "any",
        input,
        expect: ok(input),
      })),
      { type: "any", input: null, expect: err("null") },
      { type: "any", input: NaN, dirs: ENCODE, expect: err("type") },
      { type: "any", input: Infinity, dirs: ENCODE, expect: err("type") },
      { type: "any", input: () => 0, dirs: ENCODE, expect: err("type") },
      { type: "any", input: Symbol("s"), dirs: ENCODE, expect: err("type") },
      { type: "any", input: new Date(0), dirs: ENCODE, expect: err("type") },
      { type: "any", input: ABSENT, expect: err("missing") },
      { type: "?any", input: null, expect: ok(OMITTED) },
    ]);
    const out = wrapper("any").decode({ v: arr }) as { v: unknown };
    assert.equal(out.v, arr);
    // undefined at the top level is a type error; in a decoded map it is null, as in arrays.
    assert.equal(validationError(() => wrapper("any").decode(undefined)).reason, "type");
    assert.equal(validationError(() => wrapper("[string]any").decode({ v: { k: undefined } })).reason, "null");
  });
});

describe("enums", () => {
  test("inline and named", () => {
    for (const type of ["(red, green, blue)", "Color"]) {
      checkRows([
        { type, input: "green", expect: ok("green") },
        { type, input: "Green", expect: err("enum") },
        { type, input: "", expect: err("enum") },
        { type, input: 1, expect: err("type") },
        { type, input: null, expect: err("null") },
      ]);
    }
  });

  test("a top-level enum type validator", () => {
    const color = compileInterfaceText(DEFS).types.get("Color");
    assert.ok(color);
    assert.equal(color.decode("red"), "red");
    const e = validationError(() => color.encode("pink"));
    assert.equal(e.parameter, "");
    assert.equal(e.message, 'invalid parameter "": expected one of red, green, blue');
  });
});

describe("structs", () => {
  test("inline struct: absent vs null vs undefined", () => {
    const type = "(a: int, b: ?string)";
    checkRows([
      { type, input: { a: 1, b: "x" }, expect: ok({ a: 1, b: "x" }) },
      { type, input: { a: 1 }, expect: ok({ a: 1 }) },
      { type, input: { a: 1, b: null }, expect: ok({ a: 1 }) },
      { type, input: { a: 1, b: undefined }, expect: ok({ a: 1 }) },
      { type, input: { b: "x" }, expect: err("missing", "v.a") },
      { type, input: { a: null }, expect: err("null", "v.a") },
      { type, input: { a: undefined }, expect: err("missing", "v.a") },
      { type, input: { a: 1, c: 2 }, dirs: ["reject", "encode"], expect: err("unknown-field", "v.c") },
      { type, input: { a: 1, c: 2 }, dirs: ["drop"], expect: ok({ a: 1 }) },
      { type, input: { a: 1, c: undefined }, dirs: ENCODE, expect: ok({ a: 1 }) },
      { type, input: [], expect: err("type") },
      { type, input: new Date(0), expect: err("type") },
      { type, input: new Map([["a", 1]]), expect: err("type") },
      { type, input: Object.assign(Object.create({ a: 1 }) as object, { b: "x" }), expect: err("type") },
    ]);
  });

  test("output keys follow IDL order, never input order", () => {
    const out = wrapper("(a: int, b: int)").decode({ v: { b: 2, a: 1 } }) as { v: object };
    assert.deepEqual(Object.keys(out.v), ["a", "b"]);
  });

  test("the empty struct", () => {
    checkRows([
      { type: "()", input: {}, expect: ok({}) },
      { type: "()", input: { x: 1 }, dirs: ["reject"], expect: err("unknown-field", "v.x") },
      { type: "()", input: { x: 1 }, dirs: ["drop"], expect: ok({}) },
    ]);
  });

  test("fields named like Object.prototype members never read inherited values", () => {
    const fields = compileInterfaceText(DEFS).types.get("Fields");
    assert.ok(fields);
    assert.deepEqual(fields.decode({ valueOf: 1 }), { valueOf: 1 });
    assert.deepEqual(fields.encode({ valueOf: 1, toString: 2, constructor: "c" }), {
      toString: 2,
      constructor: "c",
      valueOf: 1,
    });
    const missing = validationError(() => fields.decode({}));
    assert.equal(missing.parameter, "valueOf");
    assert.equal(missing.reason, "missing");
    assert.equal(validationError(() => fields.decode({ valueOf: 1, constructor: 5 })).parameter, "constructor");

    // Non-nullable: Object.prototype.toString / .constructor never satisfy the field.
    const required = wrapper("(toString: int, constructor: string)");
    for (const dir of DIRS) {
      const e = validationError(() => run(required, dir, { v: {} }));
      assert.equal(e.reason, "missing", dir);
      assert.equal(e.parameter, "v.toString", dir);
      const input = JSON.parse('{"v": {"toString": 5, "constructor": "x"}}') as unknown;
      assert.deepEqual(run(required, dir, input), { v: { toString: 5, constructor: "x" } }, dir);
    }
  });

  test("non-enumerable own fields count as absent", () => {
    const value = Object.defineProperty({}, "a", { value: 1, enumerable: false });
    assert.equal(validationError(() => wrapper("(a: int)").encode({ v: value })).reason, "missing");
  });

  test('JSON {"__proto__": 1} as an unknown field', () => {
    const v = wrapper("(a: ?int)");
    const input = jsonCodec.decode('{"v":{"__proto__":1}}');
    const e = validationError(() => v.decode(input));
    assert.equal(e.reason, "unknown-field");
    assert.equal(e.parameter, "v.__proto__");
    const out = v.decode(input, { unknownFields: "drop" }) as { v: object };
    assert.equal(Object.hasOwn(out.v, "__proto__"), false);
    assert.equal(Object.getPrototypeOf(out.v), Object.prototype);
    assert.deepEqual(out, { v: {} });
  });

  test("named struct", () => {
    checkRows([
      { type: "Point", input: { x: 1, y: 2 }, expect: ok({ x: 1, y: 2 }) },
      { type: "Point", input: { x: 1 }, expect: err("missing", "v.y") },
      { type: "Point", input: { x: 1, y: "2" }, expect: err("type", "v.y") },
    ]);
  });
});

describe("arrays", () => {
  test("[]T", () => {
    checkRows([
      { type: "[]int", input: [], expect: ok([]) },
      { type: "[]int", input: [1, 2], expect: ok([1, 2]) },
      { type: "[]int", input: [1, "2"], expect: err("type", "v.1") },
      { type: "[]int", input: [1, null], expect: err("null", "v.1") },
      { type: "[]int", input: { 0: 1, length: 1 }, expect: err("type") },
      { type: "[]?int", input: [1, null], expect: ok([1, null]) },
      { type: "[]?int", input: [undefined], dirs: ENCODE, expect: ok([null]) },
      { type: "?[]int", input: [], expect: ok([]) },
      { type: "?[]int", input: null, expect: ok(OMITTED) },
      { type: "?[]int", input: ABSENT, expect: ok(OMITTED) },
    ]);
  });

  test("sparse arrays on encode", () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3];
    assert.deepEqual(wrapper("[]?int").encode({ v: sparse }), { v: [1, null, 3] });
    const e = validationError(() => wrapper("[]int").encode({ v: sparse }));
    assert.equal(e.reason, "null");
    assert.equal(e.parameter, "v.1");
  });
});

describe("maps", () => {
  test("[string]T", () => {
    checkRows([
      { type: "[string]int", input: {}, expect: ok({}) },
      { type: "[string]int", input: { a: 1, "b.c": 2 }, expect: ok({ a: 1, "b.c": 2 }) },
      { type: "[string]int", input: { a: 1, b: "x" }, expect: err("type", "v.b") },
      { type: "[string]int", input: { a: null }, expect: err("null", "v.a") },
      { type: "[string]int", input: { a: undefined, b: 1 }, dirs: ENCODE, expect: ok({ b: 1 }) },
      // Decode (hand-made input): an undefined value is null, as for array elements.
      { type: "[string]int", input: { a: undefined, b: 1 }, dirs: DECODE, expect: err("null", "v.a") },
      { type: "[string]?int", input: { a: undefined, b: 1 }, dirs: DECODE, expect: ok({ a: null, b: 1 }) },
      { type: "[string]int", input: new Map(), expect: err("type") },
      { type: "[string]int", input: [], expect: err("type") },
      { type: "[string]?int", input: { a: null, b: 1 }, expect: ok({ a: null, b: 1 }) },
      { type: "?[string]int", input: {}, expect: ok({}) },
      { type: "?[string]int", input: null, expect: ok(OMITTED) },
      { type: "[string]()", input: { a: {}, b: {} }, expect: ok({ a: {}, b: {} }) },
    ]);
  });

  test("a __proto__ key is an own data property of the output", () => {
    const input = jsonCodec.decode('{"v":{"__proto__":1,"x":2}}');
    for (const dir of DIRS) {
      const out = run(wrapper("[string]int"), dir, input) as { v: Record<string, unknown> };
      assert.equal(Object.getPrototypeOf(out.v), Object.prototype);
      assert.deepEqual(Object.getOwnPropertyDescriptor(out.v, "__proto__"), {
        value: 1,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      assert.deepEqual(Object.keys(out.v), ["__proto__", "x"]);
    }
  });
});

describe("recursive types and depth", () => {
  test("recursive named types", () => {
    checkRows([
      {
        type: "Node",
        input: { value: 1, children: [{ value: 2, children: [] }] },
        expect: ok({ value: 1, children: [{ value: 2, children: [] }] }),
      },
      {
        type: "Node",
        input: { value: 1, children: [{ value: 2, children: [{ value: "x", children: [] }] }] },
        expect: err("type", "v.children.0.children.0.value"),
      },
      {
        type: "Tree",
        input: { name: "r", kids: { a: { name: "a" } } },
        expect: ok({ name: "r", kids: { a: { name: "a" } } }),
      },
      { type: "Tree", input: { name: "r", kids: { a: { kids: null } } }, expect: err("missing", "v.kids.a.name") },
    ]);
  });

  function chain(levels: number): unknown {
    let node: unknown = { value: 0, children: [] };
    for (let i = 0; i < levels; i++) node = { value: i, children: [node] };
    return node;
  }

  test(`at most ${String(MAX_VALUE_DEPTH)} levels`, () => {
    const node = compileInterfaceText(DEFS).types.get("Node");
    assert.ok(node);
    // Each node is a struct plus its children array: 512 nodes = 1024 levels.
    node.decode(chain(511));
    node.encode(chain(511));
    const tooDeep = validationError(() => node.decode(chain(512)));
    assert.equal(tooDeep.reason, "too-deep");
    assert.equal(tooDeep.path.length, MAX_VALUE_DEPTH);
  });

  test("a very deep value gives too-deep, not RangeError", () => {
    const node = compileInterfaceText(DEFS).types.get("Node");
    assert.ok(node);
    for (const dir of DIRS) assert.equal(validationError(() => run(node, dir, chain(100_000))).reason, "too-deep");
  });

  test("a cyclic value on encode gives too-deep", () => {
    const node = compileInterfaceText(DEFS).types.get("Node");
    assert.ok(node);
    const cyclic: { value: number; children: unknown[] } = { value: 1, children: [] };
    cyclic.children.push(cyclic);
    assert.equal(validationError(() => node.encode(cyclic)).reason, "too-deep");
    const tree: Record<string, unknown> = { name: "t" };
    tree.kids = { k: tree };
    assert.equal(validationError(() => wrapper("Tree").encode({ v: tree })).reason, "too-deep");
  });
});

describe("cross-cutting", () => {
  test("dotted paths through struct → array → map → struct", () => {
    const v = wrapper("(a: [](m: [string](b: int)))");
    const input = { v: { a: [{ m: {} }, { m: {} }, { m: { key: { b: "x" } } }] } };
    const e = validationError(() => v.decode(input));
    assert.equal(e.parameter, "v.a.2.m.key.b");
    assert.deepEqual(e.path, ["v", "a", 2, "m", "key", "b"]);
    assert.equal(e.message, 'invalid parameter "v.a.2.m.key.b": expected int, got string');
  });

  test("messages name types, never contents", () => {
    const secret = "hunter2-secret";
    const e = validationError(() => wrapper("int").decode({ v: secret }));
    assert.ok(!e.message.includes(secret), e.message);
    const e2 = validationError(() => wrapper("Color").decode({ v: secret }));
    assert.ok(!e2.message.includes(secret), e2.message);
    const e3 = validationError(() => wrapper("()").decode({ v: { [secret]: 1 } }));
    assert.equal(e3.parameter, `v.${secret}`); // the path names the field; the value is never shown
  });

  test("first error: IDL field order, then unknown fields in key order", () => {
    const v = wrapper("(a: int, b: int)");
    assert.equal(validationError(() => v.decode({ v: { z: 1, b: "x", a: "x" } })).parameter, "v.a");
    assert.equal(validationError(() => v.decode({ v: { z: 1, b: "x", a: 1 } })).parameter, "v.b");
    assert.equal(validationError(() => v.decode({ v: { z: 1, y: 1, b: 1, a: 1 } })).parameter, "v.z");
    assert.equal(validationError(() => wrapper("[]int").decode({ v: [1, "x", null] })).parameter, "v.1");
    assert.equal(validationError(() => wrapper("[string]int").decode({ v: { b: "x", a: null } })).parameter, "v.b");
  });

  test("inputs are never mutated and outputs are fresh", () => {
    const freeze = <T>(x: T): T => {
      if (typeof x === "object" && x !== null) {
        for (const value of Object.values(x)) freeze(value);
        Object.freeze(x);
      }
      return x;
    };
    const type = "(a: []?(b: ?int, c: [string]int), d: ?string, e: int)";
    const input = freeze({ v: { a: [{ b: null, c: { x: 1 } }, null], d: null, e: -0, extra: 1 } });
    const snapshot = structuredClone(input);
    for (const dir of DIRS) {
      try {
        const out = run(wrapper(type), dir, input) as { v: { a: unknown[] } };
        assert.notEqual(out, input);
        assert.notEqual(out.v.a, input.v.a);
        assert.deepEqual(out, { v: { a: [{ c: { x: 1 } }, null], e: 0 } });
      } catch (e) {
        assert.ok(e instanceof ValidationError && dir !== "drop");
      }
      assert.deepEqual(input, snapshot);
    }
  });
});

describe("compileInterface", () => {
  test("methods, errors and types maps", () => {
    const c = compileInterfaceText(`${DEFS}method Get(id: int) -> (point: Point)\nerror NotFound (id: int)\n`);
    assert.equal(c.name, "org.example.t");
    assert.equal(c.ints, "number");
    assert.deepEqual([...c.types.keys()], ["Point", "Color", "Node", "Tree", "Fields"]);
    assert.deepEqual([...c.errors.keys()], ["NotFound"]);
    const get = c.methods.get("Get");
    assert.ok(get);
    assert.equal(get.name, "Get");
    assert.equal(get.method, "org.example.t.Get");
    assert.equal(get.member.kind, "method");
    assert.deepEqual(get.input.decode({ id: 1 }), { id: 1 });
    assert.deepEqual(get.output.decode({ point: { x: 1, y: 2 }, more: 1 }, { unknownFields: "drop" }), {
      point: { x: 1, y: 2 },
    });
    assert.equal(validationError(() => c.errors.get("NotFound")?.decode({})).parameter, "id");
  });

  test("an invalid AST throws its first IdlSyntaxError", () => {
    const iface = parseInterface("interface a.b\nmethod M(x: T) -> ()\n", { validate: false });
    assert.throws(
      () => compileInterface(iface),
      (e: unknown) => e instanceof IdlSyntaxError && e.code === "unresolved-type",
    );
  });

  test("ints option checks", () => {
    assert.equal(compileInterfaceText(DEFS, { ints: "bigint" }).ints, "bigint");
    assert.throws(
      () => compileInterfaceText(DEFS, { ints: "bigint", codec: createJsonCodec({ sourceText: false }) }),
      OperationNotSupportedError,
    );
    assert.equal(compileInterfaceText(DEFS, { codec: createJsonCodec({ sourceText: false }) }).ints, "number");
    assert.throws(() => compileInterfaceText(DEFS, { ints: "float" as IntsMode }), TypeError);
  });
});

describe("§7.1 integers end to end (codec + validator)", () => {
  const P53 = 2n ** 53n;
  /** [JSON literal, number-mode result, bigint-mode result]; a string is the expected reason. */
  const TABLE: [string, number | string, bigint | string][] = [
    [String(P53 - 1n), Number(P53 - 1n), P53 - 1n],
    [String(-(P53 - 1n)), -Number(P53 - 1n), -(P53 - 1n)],
    [String(P53), "int-range", P53],
    [String(-P53), "int-range", -P53],
    [String(2n ** 63n - 1n), "int-range", 2n ** 63n - 1n],
    [String(-(2n ** 63n)), "int-range", -(2n ** 63n)],
    [String(2n ** 64n - 1n), "int-range", 2n ** 64n - 1n],
    [String(2n ** 64n), "int-range", "int-range"],
    [String(-(2n ** 63n) - 1n), "int-range", "int-range"],
    ["1.0", 1, 1n],
    ["1e3", 1000, 1000n],
    ["1.5", "type", "type"],
    ["1e18", "int-range", "int-range"],
    ["1e400", "int-range", "int-range"],
    // Exact bigint, out of range.
    ["1" + "0".repeat(399), "int-range", "int-range"],
    // Longer than MAX_BIGINT_SOURCE_LENGTH: stays Infinity, still int-range.
    ["1" + "0".repeat(1999), "int-range", "int-range"],
  ];
  for (const [literal, asNumber, asBigint] of TABLE) {
    test(literal.length > 30 ? `${String(literal.length)}-digit integer` : literal, () => {
      for (const [ints, expected] of [
        ["number", asNumber],
        ["bigint", asBigint],
      ] as const) {
        const value = jsonCodec.decode(`{"v":${literal}}`);
        const v = wrapper("int", { ints });
        if (typeof expected === "string") {
          const e = validationError(() => v.decode(value));
          assert.equal(e.reason, expected, ints);
          assert.equal(e.parameter, "v");
        } else {
          const out = v.decode(value) as { v: unknown };
          assert.deepEqual(out, { v: expected }, ints);
          // encode → codec → decode round trip
          assert.deepEqual(v.decode(jsonCodec.decode(jsonCodec.encode(v.encode(out)))), out);
        }
      }
    });
  }

  test("without context.source: unsafe ints are rejected, bigint mode refused", () => {
    const codec = createJsonCodec({ sourceText: false });
    const value = codec.decode(`{"v":${String(P53 + 1n)}}`);
    assert.equal(validationError(() => wrapper("int").decode(value)).reason, "int-range");
    assert.deepEqual(wrapper("float").decode(value), { v: 2 ** 53 });
    // A 400-digit literal is Infinity here (exact bigint with source): int-range either way.
    const huge = codec.decode(`{"v":1${"0".repeat(399)}}`);
    assert.equal(validationError(() => wrapper("int").decode(huge)).reason, "int-range");
    assert.throws(() => compileInterfaceText(DEFS, { ints: "bigint", codec }), OperationNotSupportedError);
  });
});
