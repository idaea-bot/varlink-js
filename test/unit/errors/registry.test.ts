// ErrorRegistry and the varlink-js InternalError interface (DESIGN.md §6, Q2).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
  PermissionDeniedError,
  VarlinkError,
  type ErrorClass,
} from "../../../src/core/errors/index.ts";
import { formatInterface, parseInterface, validateInterface } from "../../../src/core/idl/index.ts";

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

  test("createErrorRegistry holds the standard errors and InternalError", () => {
    const registry = createErrorRegistry();
    const expected: ErrorClass[] = [
      InterfaceNotFoundError,
      MethodNotFoundError,
      MethodNotImplementedError,
      InvalidParameterError,
      PermissionDeniedError,
      ExpectedMoreError,
      ExpectedUpgradeError,
      InternalError,
    ];
    for (const cls of expected) assert.equal(registry.get(cls.errorName), cls, cls.errorName);
    const e = registry.create("org.varlink.service.MethodNotFound", { method: "a.b.C" });
    assert.ok(e instanceof MethodNotFoundError);
    assert.notEqual(createErrorRegistry(), registry);
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
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) {
          const count = readFileSync(path, "utf8").split(INTERNAL_ERROR_INTERFACE).length - 1;
          for (let i = 0; i < count; i++) hits.push(path);
        }
      }
    };
    walk(resolve("src"));
    assert.deepEqual(hits, [resolve("src/core/errors/standard.ts")]);
  });
});
