// ErrorRegistry and the varlink-js InternalError interface (DESIGN.md §6, Q2).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  createErrorRegistry,
  ErrorRegistry,
  ExpectedMoreError,
  ExpectedUpgradeError,
  INTERNAL_ERROR_INTERFACE,
  INTERNAL_ERROR_INTERFACE_IDL,
  InterfaceNotFoundError,
  InternalError,
  InvalidParameterError,
  isVarlinkError,
  MethodNotFoundError,
  MethodNotImplementedError,
  ORG_VARLINK_SERVICE,
  ORG_VARLINK_SERVICE_IDL,
  PermissionDeniedError,
  VarlinkError,
  type ErrorClass,
} from "../../../src/core/errors/index.ts";
import { formatInterface, parseInterface, validateInterface } from "../../../src/core/idl/index.ts";

const SRC = join(import.meta.dirname, "../../../src");

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the usual exact-equality trick
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

/** Field names of an error's `parameters`; `never` for exactly `Record<string, never>` (no parameters). */
type Fields<E extends VarlinkError> =
  Equal<E["parameters"], Record<string, never>> extends true ? never : keyof E["parameters"];

/** Exact field sets of the standard classes: a missing or extra field fails typecheck. */
type FieldChecks = [
  Expect<Equal<Fields<InterfaceNotFoundError>, "interface">>,
  Expect<Equal<Fields<MethodNotFoundError>, "method">>,
  Expect<Equal<Fields<MethodNotImplementedError>, "method">>,
  Expect<Equal<Fields<InvalidParameterError>, "parameter">>,
  Expect<Equal<Fields<PermissionDeniedError>, never>>,
  Expect<Equal<Fields<ExpectedMoreError>, never>>,
  Expect<Equal<Fields<ExpectedUpgradeError>, never>>,
];

/** The seven org.varlink.service error classes. */
const STANDARD_CLASSES: readonly ErrorClass[] = [
  InterfaceNotFoundError,
  MethodNotFoundError,
  MethodNotImplementedError,
  InvalidParameterError,
  PermissionDeniedError,
  ExpectedMoreError,
  ExpectedUpgradeError,
];

/** A §6-style generated error class. */
class ParameterOutOfRange extends VarlinkError<{ field: string }> {
  static readonly errorName = "org.example.ftl.ParameterOutOfRange";
  constructor(parameters: { field: string }, options?: ErrorOptions) {
    super(ParameterOutOfRange.errorName, parameters, options);
  }
  static is(e: unknown): e is ParameterOutOfRange {
    return isVarlinkError(e, ParameterOutOfRange.errorName);
  }
}

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

describe("ErrorRegistry", () => {
  test("register, get, has, create", () => {
    const registry = new ErrorRegistry();
    assert.equal(registry.register(ParameterOutOfRange), registry);
    assert.equal(registry.has(ParameterOutOfRange.errorName), true);
    assert.equal(registry.get(ParameterOutOfRange.errorName), ParameterOutOfRange);
    assert.equal(registry.get("org.example.ftl.Other"), undefined);
    assert.equal(registry.has("org.example.ftl.Other"), false);

    const cause = new Error("c");
    const known = registry.create(ParameterOutOfRange.errorName, { field: "x" }, { cause });
    assert.ok(known instanceof ParameterOutOfRange);
    assert.deepEqual(known.parameters, { field: "x" });
    assert.equal(known.cause, cause);

    const unknown = registry.create("org.example.ftl.Other", { a: 1 });
    assert.equal(unknown.constructor, VarlinkError);
    assert.equal(unknown.error, "org.example.ftl.Other");
    assert.deepEqual(unknown.parameters, { a: 1 });
    assert.deepEqual(registry.create("org.example.ftl.Other").parameters, {});
    assert.deepEqual(registry.create(ParameterOutOfRange.errorName).parameters, {});
  });

  test("registering the same class twice is a no-op", () => {
    const registry = new ErrorRegistry().register(ParameterOutOfRange, ParameterOutOfRange);
    registry.register(ParameterOutOfRange);
    assert.equal(registry.get(ParameterOutOfRange.errorName), ParameterOutOfRange);
  });

  test("a different class with a registered name throws and keeps the first", () => {
    const registry = new ErrorRegistry().register(ParameterOutOfRange);
    assert.throws(() => registry.register(errorClass(ParameterOutOfRange.errorName)), TypeError);
    assert.equal(registry.get(ParameterOutOfRange.errorName), ParameterOutOfRange);
  });

  test("invalid error names throw", () => {
    const registry = new ErrorRegistry();
    for (const name of ["", "Foo", "org.Foo", "org.example.foo", "org.example.", ".Foo", "org..example.Foo", "a b.C"]) {
      assert.throws(() => registry.register(errorClass(name)), TypeError, name);
    }
    assert.throws(() => registry.register(errorClass(42 as unknown as string)), TypeError);
    // Formatting the message must not throw a different error for a bigint or symbol name.
    class BigName extends VarlinkError {
      static readonly errorName = 5n as unknown as string;
    }
    assert.throws(() => registry.register(BigName as unknown as ErrorClass), {
      name: "TypeError",
      message: "invalid varlink error name: 5",
    });
    assert.throws(() => registry.register(errorClass(Symbol("s") as unknown as string)), {
      name: "TypeError",
      message: "invalid varlink error name: Symbol(s)",
    });
    assert.equal(registry.has(""), false);
  });

  test("register is atomic", () => {
    const registry = new ErrorRegistry().register(ParameterOutOfRange);
    const a = errorClass("org.example.a.A");
    const b = errorClass("org.example.b.B");
    // A conflict with an existing class, after valid ones: nothing is registered.
    assert.throws(() => registry.register(a, b, errorClass(ParameterOutOfRange.errorName)), TypeError);
    assert.equal(registry.has("org.example.a.A") || registry.has("org.example.b.B"), false);
    // An invalid name after valid ones.
    assert.throws(() => registry.register(a, errorClass("bad")), TypeError);
    assert.equal(registry.has("org.example.a.A"), false);
    // Two different classes with one name in the same call.
    assert.throws(() => registry.register(a, b, errorClass("org.example.a.A")), TypeError);
    assert.equal(registry.has("org.example.a.A") || registry.has("org.example.b.B"), false);
    // The same class twice in one call is fine.
    registry.register(a, b, a);
    assert.equal(registry.get("org.example.a.A"), a);
    assert.equal(registry.get("org.example.b.B"), b);
  });

  test("createErrorRegistry holds the standard errors and InternalError", () => {
    const registry = createErrorRegistry();
    for (const cls of [...STANDARD_CLASSES, InternalError]) assert.equal(registry.get(cls.errorName), cls);
    const e = registry.create("org.varlink.service.MethodNotFound", { method: "a.b.C" });
    assert.ok(e instanceof MethodNotFoundError);
    assert.notEqual(createErrorRegistry(), registry);
  });

  test("a generated descriptor's errors re-exporting the core classes register without conflict (§5.7)", () => {
    // What codegen emits for org.varlink.service and INTERNAL_ERROR_INTERFACE: the core classes, not new ones.
    const serviceErrors = Object.fromEntries(
      STANDARD_CLASSES.map((cls) => [cls.errorName.slice(ORG_VARLINK_SERVICE.length + 1), cls]),
    );
    const internalErrors = { InternalError };
    const registry = createErrorRegistry();
    registry.register(...Object.values(serviceErrors), ...Object.values(internalErrors));
    assert.ok(registry.create(MethodNotFoundError.errorName, { method: "a.b.C" }) instanceof MethodNotFoundError);
    // A different class under the same name (a regenerated copy) conflicts.
    assert.throws(() => registry.register(errorClass(MethodNotFoundError.errorName)), TypeError);
    assert.throws(() => registry.register(errorClass(InternalError.errorName)), TypeError);
    assert.equal(registry.get(MethodNotFoundError.errorName), MethodNotFoundError);
  });
});

describe("InternalError interface (Q2)", () => {
  test("InternalError", () => {
    assert.equal(InternalError.errorName, `${INTERNAL_ERROR_INTERFACE}.InternalError`);
    const e = new InternalError();
    assert.equal(e.name, "InternalError");
    assert.equal(e.error, InternalError.errorName);
    assert.equal(InternalError.is(e), true);
  });

  test("the IDL parses, validates and is canonical", () => {
    const iface = parseInterface(INTERNAL_ERROR_INTERFACE_IDL);
    assert.equal(iface.name, INTERNAL_ERROR_INTERFACE);
    assert.deepEqual(validateInterface(iface), []);
    assert.equal(formatInterface(iface), INTERNAL_ERROR_INTERFACE_IDL);
    assert.deepEqual(
      iface.members.map((m) => [m.kind, m.name]),
      [["error", "InternalError"]],
    );
    const [member] = iface.members;
    assert.ok(member?.kind === "error" && member.type.fields.length === 0);
    assert.ok(iface.doc !== undefined && member.doc !== undefined);
  });

  test("the interface name appears literally only once in src/", () => {
    // The two generated built-in modules are made from the constants (test/unit/codegen/builtins.test.ts checks
    // they are up to date), so they are skipped; every hand-written file, src/interfaces/ included, is checked.
    const generated = new Set(
      [INTERNAL_ERROR_INTERFACE, ORG_VARLINK_SERVICE].map((name) => join(SRC, "interfaces", `${name}.ts`)),
    );
    const index = join(SRC, "interfaces/index.ts");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") && !generated.has(path)) {
          const lines = readFileSync(path, "utf8").split("\n");
          for (const line of lines) {
            const count = line.split(INTERNAL_ERROR_INTERFACE).length - 1;
            // The one exception: src/interfaces/index.ts imports the generated module, whose file name is the
            // interface name (a module specifier, not a string naming the interface).
            if (path === index && count === 1 && line.endsWith(` from "./${INTERNAL_ERROR_INTERFACE}.ts";`)) {
              assert.match(line, /^export \{ \w+ as InternalErrorInterface \} from /);
              hits.push(`${path} (import)`);
              continue;
            }
            for (let i = 0; i < count; i++) hits.push(path);
          }
        }
      }
    };
    walk(SRC);
    assert.deepEqual(hits.sort(), [join(SRC, "core/errors/standard.ts"), `${index} (import)`].sort());
  });
});

describe("org.varlink.service interface", () => {
  test("ORG_VARLINK_SERVICE_IDL is the UAPI text and matches the core classes", () => {
    const corpus = readFileSync(join(import.meta.dirname, "../../corpus/uapi/org.varlink.service.varlink"), "utf8");
    assert.equal(ORG_VARLINK_SERVICE_IDL, corpus);
    const iface = parseInterface(ORG_VARLINK_SERVICE_IDL);
    assert.equal(iface.name, ORG_VARLINK_SERVICE);
    assert.deepEqual(validateInterface(iface), []);

    // Each class's `parameters` field names, checked exactly at the type level (see FieldChecks).
    const expected = new Map<ErrorClass, string[]>([
      [InterfaceNotFoundError, ["interface"]],
      [MethodNotFoundError, ["method"]],
      [MethodNotImplementedError, ["method"]],
      [InvalidParameterError, ["parameter"]],
      [PermissionDeniedError, []],
      [ExpectedMoreError, []],
      [ExpectedUpgradeError, []],
    ]);
    const checks: FieldChecks = [true, true, true, true, true, true, true];
    assert.equal(checks.length, expected.size);
    const classes = new Map<string, ErrorClass>(STANDARD_CLASSES.map((cls) => [cls.errorName, cls]));
    const errors = iface.members.filter((m) => m.kind === "error");
    assert.equal(errors.length, classes.size);
    for (const member of errors) {
      const cls = classes.get(`${ORG_VARLINK_SERVICE}.${member.name}`);
      assert.ok(cls, member.name);
      assert.deepEqual(
        member.type.fields.map((f) => f.name),
        expected.get(cls),
        member.name,
      );
      assert.ok(member.type.fields.every((f) => f.type.kind === "string"));
    }
  });
});
