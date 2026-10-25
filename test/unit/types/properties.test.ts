// Property-based tests for the validators (DESIGN.md §7.3): values generated from random types validate and
// round-trip through the codec in both ints modes, and a single mutation is rejected at exactly its path.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { IntegerRangeError, ValidationError, type ValidationReason } from "../../../src/core/errors/index.ts";
import type {
  EnumType,
  Field,
  Interface,
  PrimitiveType,
  StructType,
  Type,
  TypeMember,
} from "../../../src/core/idl/index.ts";
import {
  compileInterface,
  createJsonCodec,
  jsonCodec,
  type IntsMode,
  type Validator,
} from "../../../src/core/types/index.ts";

const SEED = 20261025;
const RUNS = 300;
const params = (numRuns: number): fc.Parameters<unknown> => ({ seed: SEED, numRuns });

// --- arbitrary interfaces -------------------------------------------------------------------------------

const PRIMITIVES: PrimitiveType["kind"][] = ["bool", "int", "float", "string", "object", "any"];
const fieldName = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,3}(_[A-Za-z0-9]{1,3}){0,2}$/);
/** Never a valid field or enum value name, so never declared. */
const UNKNOWN_KEY = "x-unknown";
const NOT_A_VALUE = "not-a-value";

/** A recursive named type, always present. */
const REC: TypeMember = {
  kind: "type",
  name: "Rec",
  experimental: false,
  type: {
    kind: "struct",
    fields: [
      { name: "value", type: { kind: "int" }, experimental: false },
      {
        name: "kids",
        type: { kind: "nullable", element: { kind: "array", element: { kind: "named", name: "Rec" } } },
        experimental: false,
      },
      {
        name: "attrs",
        type: { kind: "map", element: { kind: "nullable", element: { kind: "named", name: "Rec" } } },
        experimental: false,
      },
    ],
  },
};

const enumType: fc.Arbitrary<EnumType> = fc
  .uniqueArray(fieldName, { minLength: 1, maxLength: 4 })
  .map((names) => ({ kind: "enum", values: names.map((name) => ({ name, experimental: false })) }));

function structType(refs: readonly string[], depth: number): fc.Arbitrary<StructType> {
  return fc
    .uniqueArray(fc.tuple(fieldName, typeArb(refs, depth)), { maxLength: 4, selector: ([n]) => n })
    .map((fields) => ({
      kind: "struct",
      fields: fields.map(([name, type]): Field => ({ name, type, experimental: false })),
    }));
}

function typeArb(refs: readonly string[], depth: number): fc.Arbitrary<Type> {
  const leaf = fc.oneof(
    fc.constantFrom(...PRIMITIVES).map((kind): Type => ({ kind })),
    fc.constantFrom(...refs).map((name): Type => ({ kind: "named", name })),
  );
  if (depth <= 0) return leaf;
  const inner = typeArb(refs, depth - 1);
  return fc.oneof(
    { weight: 4, arbitrary: leaf },
    { weight: 1, arbitrary: structType(refs, depth - 1) },
    { weight: 1, arbitrary: enumType },
    { weight: 1, arbitrary: inner.map((element): Type => ({ kind: "array", element })) },
    { weight: 1, arbitrary: inner.map((element): Type => ({ kind: "map", element })) },
    {
      weight: 2,
      arbitrary: inner.filter((t) => t.kind !== "nullable").map((element): Type => ({ kind: "nullable", element })),
    },
  );
}

/** Rec, then up to three named structs/enums (each may use the earlier ones), then `method M(…) -> ()`. */
const interfaceArb: fc.Arbitrary<Interface> = fc.integer({ min: 0, max: 3 }).chain((count) => {
  const names = Array.from({ length: count }, (_, i) => `N${String(i)}`);
  const members = names.map((name, i) =>
    fc
      .oneof(structType(["Rec", ...names.slice(0, i)], 2), enumType)
      .map((type): TypeMember => ({ kind: "type", name, experimental: false, type })),
  );
  return fc.tuple(fc.tuple(...members), structType(["Rec", ...names], 3)).map(([types, input]): Interface => ({
    kind: "interface",
    name: "org.example.prop",
    experimental: false,
    members: [
      REC,
      ...types,
      { kind: "method", name: "M", experimental: false, input, output: { kind: "struct", fields: [] } },
    ],
  }));
});

// --- arbitrary conforming values --------------------------------------------------------------------------

/** A value to feed a validator and the normalized value it must return. */
interface Sample {
  input: unknown;
  expected: unknown;
}
const same = (v: unknown): Sample => ({ input: v, expected: v });

/** Sets `obj[key] = value` as an own data property (a "__proto__" key must not change the prototype). */
function put(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Integer-valued doubles beyond ±(2^53-1) that JSON.stringify writes as plain digits (below 1e21). */
const unsafeIntegerDouble = fc.oneof(
  fc.constantFrom(2 ** 53, 2 ** 60, -(2 ** 60), 1e20, -1e20),
  fc
    .double({ min: -1e21, max: 1e21, noNaN: true })
    .filter((n) => Number.isInteger(n) && !Number.isSafeInteger(n) && Math.abs(n) < 1e21),
);
const jsonLeaf = fc.oneof(
  fc.boolean(),
  fc.integer(),
  fc.string(),
  fc.bigInt({ min: 2n ** 60n, max: 2n ** 64n }),
  unsafeIntegerDouble,
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.constant(-0),
);
const anyValue = fc.oneof(
  jsonLeaf,
  fc.array(fc.oneof(jsonLeaf, fc.constant(null)), { maxLength: 3 }),
  fc.dictionary(fc.string(), fc.oneof(jsonLeaf, fc.constant(null)), { maxKeys: 3, noNullPrototype: true }),
);

class Gen {
  readonly named: ReadonlyMap<string, TypeMember>;
  readonly ints: IntsMode;

  constructor(iface: Interface, ints: IntsMode) {
    const named = new Map<string, TypeMember>();
    for (const m of iface.members) if (m.kind === "type") named.set(m.name, m);
    this.named = named;
    this.ints = ints;
  }

  resolve(type: Type): Type {
    if (type.kind !== "named") return type;
    const member = this.named.get(type.name);
    assert.ok(member);
    return member.type;
  }

  /** `depth` bounds recursion through Rec: at 0, arrays/maps are empty and nullables null. */
  value(type: Type, depth: number): fc.Arbitrary<Sample> {
    switch (type.kind) {
      case "bool":
        return fc.boolean().map(same);
      case "string":
        return fc.string({ unit: "binary", maxLength: 6 }).map(same);
      case "int":
        return this.ints === "number"
          ? fc.maxSafeInteger().map((n) => same(n === 0 ? 0 : n))
          : fc.bigInt({ min: -(2n ** 63n), max: 2n ** 64n - 1n }).map(same);
      case "float":
        return fc.double({ noNaN: true, noDefaultInfinity: true }).map((n) => same(n === 0 ? 0 : n));
      case "object":
        // Null-prototype objects are valid `object`s but come back from JSON with Object.prototype.
        return fc.dictionary(fc.string({ maxLength: 4 }), anyValue, { maxKeys: 3, noNullPrototype: true }).map(same);
      case "any":
        return anyValue.map(same);
      case "enum":
        return fc.constantFrom(...type.values.map((v) => v.name)).map(same);
      case "named":
        return this.value(this.resolve(type), depth - 1);
      case "nullable":
        if (depth <= 0) return fc.constant(same(null));
        return fc.oneof(fc.constant(same(null)), this.value(type.element, depth));
      case "array":
        if (depth <= 0) return fc.constant({ input: [], expected: [] });
        return fc.array(this.value(type.element, depth), { maxLength: 3 }).map((items) => ({
          input: items.map((s) => s.input),
          expected: items.map((s) => s.expected),
        }));
      case "map":
        if (depth <= 0) return fc.constant({ input: {}, expected: {} });
        return fc
          .uniqueArray(fc.tuple(fc.string({ maxLength: 4 }), this.value(type.element, depth)), {
            maxLength: 3,
            selector: ([k]) => k,
          })
          .map((entries) => {
            const input: Record<string, unknown> = {};
            const expected: Record<string, unknown> = {};
            for (const [k, s] of entries) {
              put(input, k, s.input);
              put(expected, k, s.expected);
            }
            return { input, expected };
          });
      case "struct": {
        const fields = type.fields.map((f) => {
          if (f.type.kind !== "nullable") return this.value(f.type, depth).map((s) => ({ ...s, omit: false }));
          // ?T field: absent, null (both omitted from the output) or a value.
          return fc.oneof(
            fc.constant({ input: ABSENT, expected: undefined, omit: true }),
            fc.constant({ input: null, expected: undefined, omit: true }),
            this.value(f.type.element, depth).map((s) => ({ ...s, omit: false })),
          );
        });
        return fc.tuple(...fields).map((samples) => {
          const input: Record<string, unknown> = {};
          const expected: Record<string, unknown> = {};
          type.fields.forEach((f, i) => {
            const s = samples[i];
            assert.ok(s);
            if (s.input !== ABSENT) put(input, f.name, s.input);
            if (!s.omit) put(expected, f.name, s.expected);
          });
          return { input, expected };
        });
      }
    }
  }
}

const ABSENT = Symbol("absent");

interface Case {
  iface: Interface;
  ints: IntsMode;
  sample: Sample;
}

const caseArb: fc.Arbitrary<Case> = fc
  .tuple(interfaceArb, fc.constantFrom<IntsMode>("number", "bigint"))
  .chain(([iface, ints]) =>
    new Gen(iface, ints).value(methodInput(iface), 4).map((sample): Case => ({ iface, ints, sample })),
  );
const numberCaseArb: fc.Arbitrary<Case> = interfaceArb.chain((iface) =>
  new Gen(iface, "number").value(methodInput(iface), 4).map((sample): Case => ({ iface, ints: "number", sample })),
);

const HAS_RAW_JSON = typeof (JSON as { rawJSON?: unknown }).rawJSON === "function";

/**
 * Untyped JSON content (object/any) as a codec decodes it after jsonCodec-style encoding (DESIGN.md §4.3):
 * - with `context.source`: an integer-valued unsafe number below 1e21 is written as plain digits and comes back
 *   as the bigint of that literal (`BigInt(String(n))`, e.g. 2^60 → 1152921504606847000n);
 * - without: every bigint comes back as `Number(bigint)`;
 * - -0 survives only where JSON.rawJSON exists (JSON.stringify writes 0).
 */
function untypedRoundTrip(value: unknown, source: boolean): unknown {
  if (typeof value === "bigint") return source ? value : Number(value);
  if (typeof value === "number") {
    if (Object.is(value, -0)) return HAS_RAW_JSON ? -0 : 0;
    if (source && Number.isInteger(value) && !Number.isSafeInteger(value) && Math.abs(value) < 1e21)
      return BigInt(String(value));
    return value;
  }
  if (Array.isArray(value)) return value.map((x) => untypedRoundTrip(x, source));
  if (typeof value !== "object" || value === null) return value;
  const copy: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(value)) put(copy, k, untypedRoundTrip(x, source));
  return copy;
}

/**
 * The normalized value `expected` (of type `type`) after encode → codec → decode: typed slots come back as they
 * were (int rejects unsafe numbers, float converts bigints back), untyped content per {@link untypedRoundTrip}.
 */
function roundTripped(gen: Gen, type: Type, expected: unknown, source: boolean): unknown {
  const t = gen.resolve(type);
  if (expected === null || expected === undefined) return expected;
  switch (t.kind) {
    case "object":
    case "any":
      return untypedRoundTrip(expected, source);
    case "nullable":
      return roundTripped(gen, t.element, expected, source);
    case "array":
      return (expected as unknown[]).map((x) => roundTripped(gen, t.element, x, source));
    case "map":
    case "struct": {
      const fields = t.kind === "struct" ? new Map(t.fields.map((f) => [f.name, f.type])) : undefined;
      const copy: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(expected)) {
        const element = t.kind === "map" ? t.element : fields?.get(k);
        assert.ok(element);
        put(copy, k, roundTripped(gen, element, x, source));
      }
      return copy;
    }
    default:
      return expected;
  }
}

function inputValidator(c: Case): Validator {
  const method = compileInterface(c.iface, { ints: c.ints }).methods.get("M");
  assert.ok(method);
  return method.input;
}

// --- mutations --------------------------------------------------------------------------------------------

type Path = (string | number)[];

interface Mutation {
  /** Where the value is replaced (`set`) or deleted (`delete`); also the expected error path. */
  path: Path;
  op: { set: unknown } | "delete";
  reason: ValidationReason;
  /** The mutation adds an unknown field (dropped instead in drop mode). */
  unknown?: boolean;
}

/** Values the slot's type definitely rejects, with the expected reason. */
function wrongValues(gen: Gen, type: Type): [unknown, ValidationReason][] {
  const t = gen.resolve(type);
  switch (t.kind) {
    case "bool":
      return [["true", "type"]];
    case "int":
      return [
        ["1", "type"],
        [1.5, "type"],
        [2n ** 64n, "int-range"],
        [2 ** 53, "int-range"],
      ];
    case "float":
      return [["1", "type"]];
    case "string":
      return [[1, "type"]];
    case "object":
      return [[[], "type"]];
    case "any":
      return []; // only null/undefined are wrong for any
    case "enum":
      return [
        [1, "type"],
        [NOT_A_VALUE, "enum"],
      ];
    case "struct":
    case "map":
      return [["x", "type"]];
    case "array":
      return [[{}, "type"]];
    case "nullable":
      return wrongValues(gen, t.element);
    case "named":
      assert.fail("resolve() returns the named type's definition");
  }
}

/** Every single-step mutation of `value` (of type `type`, at `path`). */
function mutations(gen: Gen, type: Type, value: unknown, path: Path): Mutation[] {
  const out: Mutation[] = [];
  /** Mutations replacing the value in a slot of type `slot` at `key` of the current container. */
  const slot = (slotType: Type, key: string | number, nullable: boolean): void => {
    const at = [...path, key];
    for (const [wrong, reason] of wrongValues(gen, slotType)) out.push({ path: at, op: { set: wrong }, reason });
    if (!nullable) out.push({ path: at, op: { set: null }, reason: "null" });
  };
  const t = gen.resolve(type);
  if (t.kind === "nullable") return value === null ? [] : mutations(gen, t.element, value, path);
  if (t.kind === "struct" && typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const f of t.fields) {
      const nullable = f.type.kind === "nullable";
      slot(f.type, f.name, nullable);
      if (!nullable) out.push({ path: [...path, f.name], op: "delete", reason: "missing" });
      if (Object.hasOwn(obj, f.name)) out.push(...mutations(gen, f.type, obj[f.name], [...path, f.name]));
    }
    out.push({ path: [...path, UNKNOWN_KEY], op: { set: 1 }, reason: "unknown-field", unknown: true });
  } else if (t.kind === "array" && Array.isArray(value)) {
    value.forEach((item: unknown, i) => {
      slot(t.element, i, t.element.kind === "nullable");
      out.push(...mutations(gen, t.element, item, [...path, i]));
    });
  } else if (t.kind === "map" && typeof value === "object" && value !== null) {
    for (const [k, item] of Object.entries(value)) {
      slot(t.element, k, t.element.kind === "nullable");
      out.push(...mutations(gen, t.element, item, [...path, k]));
    }
  }
  return out;
}

function methodInput(iface: Interface): StructType {
  const method = iface.members.at(-1);
  assert.ok(method?.kind === "method");
  return method.input;
}

/** A copy of `root` with `m` applied at its path (containers along the path are copied, never mutated). */
function applyMutation(value: unknown, m: Mutation, depth = 0): unknown {
  const key = m.path[depth];
  if (key === undefined) {
    assert.ok(m.op !== "delete");
    return m.op.set;
  }
  if (Array.isArray(value)) {
    assert.ok(typeof key === "number");
    const copy: unknown[] = value.slice();
    copy[key] = applyMutation(copy[key], m, depth + 1);
    return copy;
  }
  // Copy with put() so "__proto__" keys stay own properties.
  const name = String(key);
  const last = depth === m.path.length - 1;
  const copy: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(value as object)) {
    if (k === name && last && m.op === "delete") continue;
    put(copy, k, k === name ? applyMutation(x, m, depth + 1) : x);
  }
  if (last && m.op !== "delete" && !Object.hasOwn(copy, name)) put(copy, name, m.op.set);
  return copy;
}

function expectError(fn: () => unknown, m: Mutation, label: string): void {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ValidationError, `${label}: ${String(e)}`);
    assert.deepEqual(e.path, m.path, label);
    assert.equal(e.parameter, m.path.join("."), label);
    assert.equal(e.reason, m.reason, label);
    assert.equal(e instanceof IntegerRangeError, m.reason === "int-range", label);
    return;
  }
  assert.fail(`${label}: expected ${m.reason} at ${m.path.join(".")}`);
}

// --- properties -------------------------------------------------------------------------------------------

describe("validator properties", () => {
  test("the generator covers the interesting shapes", () => {
    const cases = fc.sample(caseArb, { seed: SEED, numRuns: 300 });
    const kinds = new Set<string>();
    const walk = (t: Type): void => {
      kinds.add(t.kind);
      if (t.kind === "array" || t.kind === "map" || t.kind === "nullable") {
        kinds.add(`${t.kind}:${t.element.kind}`);
        walk(t.element);
      } else if (t.kind === "struct") {
        for (const f of t.fields) walk(f.type);
      }
    };
    for (const c of cases) for (const m of c.iface.members) walk(m.kind === "method" ? m.input : m.type);
    for (const k of [
      ...PRIMITIVES,
      "named",
      "struct",
      "enum",
      "array",
      "map",
      "nullable",
      "nullable:array",
      "nullable:map",
    ])
      assert.ok(kinds.has(k), k);
    const text = JSON.stringify(
      cases.map((c) => c.sample.input),
      (_k, v: unknown) => (typeof v === "bigint" ? `big:${v.toString()}` : v),
    );
    assert.ok(text.includes('"kids":[{'), "recursive values");
    assert.ok(text.includes("big:"), "bigints");
    const numbers: number[] = [];
    const collect = (x: unknown): void => {
      if (typeof x === "number") numbers.push(x);
      else if (typeof x === "object" && x !== null) for (const y of Object.values(x)) collect(y);
    };
    for (const c of cases) collect(c.sample.input);
    assert.ok(
      numbers.some((n) => Number.isInteger(n) && !Number.isSafeInteger(n)),
      "unsafe integer-valued doubles",
    );
    assert.ok(
      numbers.some((n) => !Number.isInteger(n)),
      "floats",
    );
    assert.ok(
      numbers.some((n) => Object.is(n, -0)),
      "-0 in untyped content",
    );
    const rich = cases.filter(
      (c) => mutations(new Gen(c.iface, c.ints), methodInput(c.iface), c.sample.input, []).length > 10,
    );
    assert.ok(rich.length > 100, String(rich.length));
  });

  test("1. generated values decode and encode to the normalized value", () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const v = inputValidator(c);
        assert.deepEqual(v.decode(c.sample.input), c.sample.expected);
        assert.deepEqual(v.decode(c.sample.input, { unknownFields: "drop" }), c.sample.expected);
        assert.deepEqual(v.encode(c.sample.input), c.sample.expected);
      }),
      params(RUNS),
    );
  });

  test("2. encode → codec → decode round-trips", () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const v = inputValidator(c);
        const text = jsonCodec.encode(v.encode(c.sample.input));
        const gen = new Gen(c.iface, c.ints);
        const expected = roundTripped(gen, methodInput(c.iface), c.sample.expected, jsonCodec.losslessInts);
        assert.deepEqual(v.decode(jsonCodec.decode(text)), expected);
      }),
      params(RUNS),
    );
  });

  test("2b. the same through a codec without context.source, number mode", () => {
    const plain = createJsonCodec({ sourceText: false });
    assert.equal(plain.losslessInts, false);
    fc.assert(
      fc.property(numberCaseArb, (c) => {
        const v = inputValidator(c);
        const text = plain.encode(v.encode(c.sample.input));
        // int fields hold safe integers; unsafe integers inside object/any come back as (rounded) numbers.
        const expected = roundTripped(new Gen(c.iface, c.ints), methodInput(c.iface), c.sample.expected, false);
        assert.deepEqual(v.decode(plain.decode(text)), expected);
      }),
      params(RUNS),
    );
  });

  test("3. a single mutation is rejected at its path", () => {
    fc.assert(
      fc.property(caseArb, fc.nat(), (c, pick) => {
        const gen = new Gen(c.iface, c.ints);
        const all = mutations(gen, methodInput(c.iface), c.sample.input, []);
        fc.pre(all.length > 0);
        const m = all[pick % all.length];
        assert.ok(m);
        const mutated = applyMutation(c.sample.input, m);
        const v = inputValidator(c);
        const label = `${m.reason} at ${m.path.join(".")}`;
        expectError(() => v.decode(mutated), m, label);
        expectError(() => v.encode(mutated), m, `${label} (encode)`);
        if (m.unknown) assert.deepEqual(v.decode(mutated, { unknownFields: "drop" }), c.sample.expected, label);
        else expectError(() => v.decode(mutated, { unknownFields: "drop" }), m, `${label} (drop)`);
      }),
      params(RUNS),
    );
  });
});
