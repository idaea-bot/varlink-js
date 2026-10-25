// VarlinkError, its brand and the standard error classes (DESIGN.md §6).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ExpectedMoreError,
  ExpectedUpgradeError,
  InterfaceNotFoundError,
  InternalError,
  InvalidParameterError,
  isVarlinkError,
  MethodNotFoundError,
  MethodNotImplementedError,
  ORG_VARLINK_SERVICE,
  PermissionDeniedError,
  VARLINK_ERROR_BRAND,
  VarlinkError,
  type ErrorClass,
} from "../../../src/core/errors/index.ts";

describe("VarlinkError", () => {
  test("fields, name, message and cause", () => {
    const cause = new Error("root");
    const e = new VarlinkError("org.example.Failed", { code: 1 }, { cause });
    assert.ok(e instanceof Error);
    assert.equal(e.error, "org.example.Failed");
    assert.deepEqual(e.parameters, { code: 1 });
    assert.equal(e.message, "org.example.Failed");
    assert.equal(e.name, "VarlinkError");
    assert.equal(e.cause, cause);
    assert.deepEqual(new VarlinkError("org.example.Failed").parameters, {});
  });

  test("message is log-safe for an invalid error name from a peer; `error` stays raw", () => {
    const bad = "\x1b[2J\nFAKE LOG LINE";
    const e = new VarlinkError(bad, {});
    assert.equal(e.error, bad);
    assert.equal(e.message, '"\\u001b[2J\\u000aFAKE LOG LINE"');
    const long = new VarlinkError("x".repeat(100_000));
    assert.equal(long.message.length, 256 + 3); // quotes and "…"
    assert.ok(long.message.endsWith('…"'));
    assert.equal(new VarlinkError("org.example.Foo").message, "org.example.Foo");
    assert.equal(new VarlinkError("noInterface").message, '"noInterface"');
  });

  test("the brand is a non-enumerable own property with value true", () => {
    const e = new VarlinkError("org.example.Failed");
    assert.equal(VARLINK_ERROR_BRAND, Symbol.for("varlink-js.VarlinkError"));
    const desc = Object.getOwnPropertyDescriptor(e, VARLINK_ERROR_BRAND);
    assert.deepEqual(desc, { value: true, writable: false, enumerable: false, configurable: false });
    assert.deepEqual(Object.keys(e).includes(String(VARLINK_ERROR_BRAND)), false);
  });

  test("name follows the subclass", () => {
    class MyError extends VarlinkError {}
    assert.equal(new MyError("org.example.X").name, "MyError");
  });
});

describe("isVarlinkError", () => {
  test("brand and optional name filter", () => {
    const e = new VarlinkError("org.example.Failed");
    assert.equal(isVarlinkError(e), true);
    assert.equal(isVarlinkError(e, "org.example.Failed"), true);
    assert.equal(isVarlinkError(e, "org.example.Other"), false);
  });

  test("rejects non-errors", () => {
    for (const v of [null, undefined, 1, "org.example.Failed", new Error("x"), {}, { error: "a.b.C" }, () => 0]) {
      assert.equal(isVarlinkError(v), false);
    }
    assert.equal(isVarlinkError({ [VARLINK_ERROR_BRAND]: "yes", error: "a.b.C" }), false);
    assert.equal(isVarlinkError({ [VARLINK_ERROR_BRAND]: true, error: 1 }), false);
  });

  test("works on a hand-made branded object", () => {
    const fake = { [Symbol.for("varlink-js.VarlinkError")]: true, error: "a.b.C", parameters: {} };
    assert.equal(isVarlinkError(fake), true);
    assert.equal(isVarlinkError(fake, "a.b.C"), true);
  });

  test("works across duplicated module copies", async () => {
    // The query string makes the loader instantiate a second copy of the module.
    const specifier = "../../../src/core/errors/varlink-error.ts?copy";
    const copy = (await import(specifier)) as typeof import("../../../src/core/errors/varlink-error.ts");
    assert.notEqual(copy.VarlinkError, VarlinkError);
    const foreign = new copy.VarlinkError("a.b.C");
    assert.equal(foreign instanceof VarlinkError, false);
    assert.equal(isVarlinkError(foreign, "a.b.C"), true);
    assert.equal(copy.isVarlinkError(new VarlinkError("a.b.C")), true);
    assert.equal(MethodNotFoundError.is(new copy.VarlinkError(MethodNotFoundError.errorName)), true);
  });

  test("never throws on throwing getters or proxies", () => {
    const getter = Object.defineProperty({ [VARLINK_ERROR_BRAND]: true }, "error", {
      get() {
        throw new Error("boom");
      },
    });
    assert.equal(isVarlinkError(getter), false);
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    assert.equal(isVarlinkError(proxy), false);
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    assert.equal(isVarlinkError(revocable.proxy), false);
  });
});

describe("standard errors", () => {
  const cases: [ErrorClass, string, Record<string, unknown>][] = [
    [InterfaceNotFoundError, "InterfaceNotFound", { interface: "org.example.x" }],
    [MethodNotFoundError, "MethodNotFound", { method: "org.example.x.Y" }],
    [MethodNotImplementedError, "MethodNotImplemented", { method: "org.example.x.Y" }],
    [InvalidParameterError, "InvalidParameter", { parameter: "a.b" }],
    [PermissionDeniedError, "PermissionDenied", {}],
    [ExpectedMoreError, "ExpectedMore", {}],
    [ExpectedUpgradeError, "ExpectedUpgrade", {}],
  ];

  for (const [cls, short, params] of cases) {
    test(short, () => {
      assert.equal(cls.errorName, `${ORG_VARLINK_SERVICE}.${short}`);
      const cause = new Error("c");
      const e = new cls(params as never, { cause });
      assert.ok(e instanceof VarlinkError);
      assert.ok(e instanceof cls);
      assert.equal(e.error, cls.errorName);
      assert.equal(e.message, cls.errorName);
      assert.equal(e.name, `${short}Error`);
      assert.deepEqual(e.parameters, params);
      assert.equal(e.cause, cause);
      assert.equal(cls.is(e), true);
      assert.equal(cls.is(new VarlinkError(cls.errorName)), true);
      assert.equal(cls.is(new VarlinkError("org.example.Other")), false);
      assert.equal(cls.is(new Error(cls.errorName)), false);
    });
  }

  test("parameterless errors need no arguments", () => {
    assert.deepEqual(new PermissionDeniedError().parameters, {});
    assert.deepEqual(new ExpectedMoreError().parameters, {});
    assert.deepEqual(new ExpectedUpgradeError().parameters, {});
    assert.deepEqual(new InternalError().parameters, {});
  });

  test("typed parameters", () => {
    const e = new InvalidParameterError({ parameter: "x" });
    const p: string = e.parameters.parameter;
    assert.equal(p, "x");
    const unknown: unknown = e;
    if (InvalidParameterError.is(unknown)) assert.equal(unknown.parameters.parameter, "x");
    else assert.fail("is() should narrow");
  });
});
