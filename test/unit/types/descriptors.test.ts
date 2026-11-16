// Descriptor types (what M6 codegen emits, DESIGN.md §5.3, §5.7) and compileDescriptor's consistency checks.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isVarlinkError, VarlinkError, type ErrorClass } from "../../../src/core/errors/index.ts";
import { IdlSyntaxError } from "../../../src/core/idl/index.ts";
import {
  assertIntsMode,
  compileDescriptor,
  type InterfaceDescriptor,
  type JsonValue,
  type MethodDescriptor,
  type MethodInput,
  type MethodOutput,
} from "../../../src/core/types/index.ts";

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the usual exact-equality trick
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// --- a hand-written descriptor in the style codegen will emit -----------------------------------------

const IDL = `# Faster-than-light travel.
interface org.example.ftl

type Drive (state: (idle, busy), power: ?int)

# [Requires 'more' flag]
method Monitor() -> (drive: Drive)

method Jump(distance: int, extra: ?any) -> ()

error ParameterOutOfRange (field: string)
`;

interface Drive {
  state: "idle" | "busy";
  power?: number | null;
}

class ParameterOutOfRange extends VarlinkError<{ field: string }> {
  static readonly errorName = "org.example.ftl.ParameterOutOfRange";
  constructor(parameters: { field: string }, options?: ErrorOptions) {
    super(ParameterOutOfRange.errorName, parameters, options);
  }
  static is(e: unknown): e is ParameterOutOfRange {
    return isVarlinkError(e, ParameterOutOfRange.errorName);
  }
}

const Monitor: MethodDescriptor<Record<string, never>, { drive: Drive }> = {
  interface: "org.example.ftl",
  name: "Monitor",
  method: "org.example.ftl.Monitor",
  more: "requires",
};
const Jump: MethodDescriptor<{ distance: number; extra?: JsonValue | null }, Record<string, never>> = {
  interface: "org.example.ftl",
  name: "Jump",
  method: "org.example.ftl.Jump",
};

const OrgExampleFtl = {
  name: "org.example.ftl",
  idl: IDL,
  ints: "number",
  methods: { Monitor, Jump },
  errors: { ParameterOutOfRange },
} satisfies InterfaceDescriptor;

// Type-level checks: inference of the phantom types, and assignability to the generic shapes.
type Checks = [
  Expect<Equal<MethodInput<typeof Jump>, { distance: number; extra?: JsonValue | null }>>,
  Expect<Equal<MethodOutput<typeof Monitor>, { drive: Drive }>>,
  Expect<Equal<MethodInput<typeof OrgExampleFtl.methods.Monitor>, Record<string, never>>>,
  Expect<Equal<MethodInput<string>, never>>,
];

// Readonly arrays (e.g. `as const` data) are JsonValues too.
const frozenList = [1, "a", null, [true]] as const;
const readonlyJson: JsonValue = frozenList;
const readonlyNested: JsonValue = { list: frozenList, inner: { r: [] as readonly JsonValue[] } };

test("type-level checks", () => {
  const checks: Checks = [true, true, true, true];
  assert.deepEqual([readonlyJson, readonlyNested], [frozenList, { list: frozenList, inner: { r: [] } }]);
  const desc: InterfaceDescriptor<typeof OrgExampleFtl.methods, typeof OrgExampleFtl.errors> = OrgExampleFtl;
  const cls: ErrorClass = ParameterOutOfRange;
  // @ts-expect-error null is not a JsonValue at the top level (`any` is non-null)
  const notJson: JsonValue = null;
  assert.deepEqual([checks.length, desc.name, cls.errorName, notJson], [4, OrgExampleFtl.name, cls.errorName, null]);
});

function withChanges(change: (d: { -readonly [K in keyof InterfaceDescriptor]: InterfaceDescriptor[K] }) => void) {
  const copy = { ...OrgExampleFtl, methods: { ...OrgExampleFtl.methods }, errors: { ...OrgExampleFtl.errors } };
  const d: { -readonly [K in keyof InterfaceDescriptor]: InterfaceDescriptor[K] } = copy;
  change(d);
  return d;
}

describe("compileDescriptor", () => {
  test("accepts a matching descriptor", () => {
    const compiled = compileDescriptor(OrgExampleFtl);
    assert.equal(compiled.name, "org.example.ftl");
    assert.equal(compiled.ints, "number");
    assert.deepEqual([...compiled.methods.keys()], ["Monitor", "Jump"]);
    assert.deepEqual(compiled.methods.get("Jump")?.input.decode({ distance: 3 }), { distance: 3 });
    assert.deepEqual(compiled.errors.get("ParameterOutOfRange")?.decode({ field: "x" }), { field: "x" });
    assert.equal(compileDescriptor({ ...OrgExampleFtl, ints: "bigint" }).ints, "bigint");
    const lenient = compileDescriptor(OrgExampleFtl, { lenientInts: true }).methods.get("Jump");
    assert.deepEqual(lenient?.input.decode({ distance: "3" }), { distance: 3 });
  });

  const monitorWithoutMore: MethodDescriptor = {
    interface: Monitor.interface,
    name: Monitor.name,
    method: Monitor.method,
  };
  // Each change keeps every other member, so the message shows which check fired.
  const mismatches: [string, Parameters<typeof withChanges>[0], RegExp][] = [
    ["interface name", (d) => (d.name = "org.example.other"), /declares interface org\.example\.ftl/],
    [
      "unknown method",
      (d) => (d.methods = { ...d.methods, Fly: { ...Jump, name: "Fly", method: "org.example.ftl.Fly" } }),
      /no IDL method for methods\.Fly/,
    ],
    ["method key", (d) => (d.methods = { ...d.methods, Hop: Jump }), /no IDL method for methods\.Hop/],
    [
      "interface string",
      (d) => (d.methods = { ...d.methods, Jump: { ...Jump, interface: "org.example" } }),
      /Jump\.interface/,
    ],
    [
      "method string",
      (d) => (d.methods = { ...d.methods, Jump: { ...Jump, method: "org.example.ftl.Monitor" } }),
      /Jump\.method/,
    ],
    ["missing more flag", (d) => (d.methods = { ...d.methods, Monitor: monitorWithoutMore }), /Monitor\.more/],
    [
      "wrong more flag",
      (d) => (d.methods = { ...d.methods, Monitor: { ...Monitor, more: "supports" } }),
      /Monitor\.more/,
    ],
    [
      "extra upgrade flag",
      (d) => (d.methods = { ...d.methods, Jump: { ...Jump, upgrade: "supports" } }),
      /Jump\.upgrade/,
    ],
    [
      "experimental flag",
      (d) => (d.methods = { ...d.methods, Jump: { ...Jump, experimental: true } }),
      /Jump\.experimental/,
    ],
    [
      "error class name",
      (d) => (d.errors = { ParameterOutOfRange: errorClass("org.example.ftl.Other") }),
      /errors\.ParameterOutOfRange has errorName org\.example\.ftl\.Other/,
    ],
    ["error key", (d) => (d.errors = { ...d.errors, Other: ParameterOutOfRange }), /errors\.Other/],
    [
      "error of another interface",
      (d) => (d.errors = { ParameterOutOfRange: errorClass("org.example.x.ParameterOutOfRange") }),
      /errorName org\.example\.x\.ParameterOutOfRange/,
    ],
    ["missing method", (d) => (d.methods = { Jump }), /IDL method Monitor is missing/],
    ["no methods", (d) => (d.methods = {}), /IDL method Monitor is missing/],
    ["missing error", (d) => (d.errors = {}), /IDL error ParameterOutOfRange is missing/],
  ];
  for (const [label, change, message] of mismatches) {
    test(`rejects: ${label}`, () => {
      assert.throws(
        () => compileDescriptor(withChanges(change)),
        (e: unknown) => e instanceof TypeError && message.test(e.message),
      );
    });
  }

  test("an invalid IDL throws IdlSyntaxError", () => {
    assert.throws(() => compileDescriptor({ ...OrgExampleFtl, idl: "interface x" }), IdlSyntaxError);
  });

  test("assertIntsMode", () => {
    assertIntsMode(OrgExampleFtl, "number");
    assert.throws(() => {
      assertIntsMode(OrgExampleFtl, "bigint");
    }, TypeError);
  });
});

function errorClass(errorName: string): ErrorClass {
  return class extends VarlinkError {
    static readonly errorName: string = errorName;
    constructor(parameters: Record<string, unknown>, options?: ErrorOptions) {
      super(errorName, parameters, options);
    }
    static is(e: unknown): boolean {
      return isVarlinkError(e, errorName);
    }
  };
}
