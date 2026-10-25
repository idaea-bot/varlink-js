// Local errors (DESIGN.md §6): never on the wire, `localName` for CLI output and logs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CallTimeoutError,
  ConnectionClosedError,
  IntegerRangeError,
  isVarlinkError,
  isVarlinkLocalError,
  MessageTooLargeError,
  OperationNotSupportedError,
  ProtocolError,
  UpgradePendingError,
  ValidationError,
  VARLINK_LOCAL_ERROR_BRAND,
  VarlinkLocalError,
} from "../../../src/core/errors/index.ts";

describe("local errors", () => {
  const cases: [new (message: string, options?: ErrorOptions) => VarlinkLocalError, string, string][] = [
    [ConnectionClosedError, "ConnectionClosedError", "io.systemd.Disconnected"],
    [CallTimeoutError, "CallTimeoutError", "io.systemd.TimedOut"],
    [ProtocolError, "ProtocolError", "io.systemd.Protocol"],
    [MessageTooLargeError, "MessageTooLargeError", "io.systemd.Protocol"],
    [UpgradePendingError, "UpgradePendingError", "varlink-js.UpgradePending"],
    [OperationNotSupportedError, "OperationNotSupportedError", "varlink-js.OperationNotSupported"],
  ];

  for (const [cls, name, localName] of cases) {
    test(name, () => {
      const cause = new Error("c");
      const e = new cls("something happened", { cause });
      assert.ok(e instanceof Error);
      assert.ok(e instanceof VarlinkLocalError);
      assert.equal(e.name, name);
      assert.equal(e.message, "something happened");
      assert.equal(e.localName, localName);
      assert.equal(e.cause, cause);
      assert.equal(isVarlinkLocalError(e), true);
      assert.equal(isVarlinkLocalError(e, localName), true);
      assert.equal(isVarlinkLocalError(e, "io.systemd.Other"), false);
      assert.equal(isVarlinkError(e), false);
      const desc = Object.getOwnPropertyDescriptor(e, VARLINK_LOCAL_ERROR_BRAND);
      assert.equal(desc?.value, true);
      assert.equal(desc.enumerable, false);
    });
  }

  test("MessageTooLargeError is a ProtocolError", () => {
    assert.ok(new MessageTooLargeError("big") instanceof ProtocolError);
  });

  test("isVarlinkLocalError never throws and checks the brand", () => {
    assert.equal(VARLINK_LOCAL_ERROR_BRAND, Symbol.for("varlink-js.VarlinkLocalError"));
    for (const v of [null, undefined, 0, "x", new Error("x"), { localName: "io.systemd.Protocol" }]) {
      assert.equal(isVarlinkLocalError(v), false);
    }
    assert.equal(isVarlinkLocalError({ [VARLINK_LOCAL_ERROR_BRAND]: true, localName: "a" }), true);
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    assert.equal(isVarlinkLocalError(proxy), false);
  });
});

describe("ValidationError", () => {
  test("fields and message", () => {
    const e = new ValidationError(["a", "b", 3], "type", "expected int, got string");
    assert.ok(e instanceof VarlinkLocalError);
    assert.equal(e.name, "ValidationError");
    assert.equal(e.localName, "org.varlink.service.InvalidParameter");
    assert.deepEqual(e.path, ["a", "b", 3]);
    assert.ok(Object.isFrozen(e.path));
    assert.equal(e.parameter, "a.b.3");
    assert.equal(e.reason, "type");
    assert.equal(e.message, 'invalid parameter "a.b.3": expected int, got string');
  });

  test("the path is copied; the empty path gives an empty parameter", () => {
    const path: (string | number)[] = ["x"];
    const e = new ValidationError(path, "missing", "required field is missing");
    path.push("y");
    assert.deepEqual(e.path, ["x"]);
    assert.equal(new ValidationError([], "type", "d").parameter, "");
  });

  test("the message escapes control characters in the parameter; `parameter` stays raw", () => {
    const key = "\x1b[2J\nFAKE";
    const e = new ValidationError(["m", key], "unknown-field", "unknown field");
    assert.equal(e.parameter, `m.${key}`);
    assert.equal(e.message, 'invalid parameter "m.\\u001b[2J\\u000aFAKE": unknown field');
    // `"`, `\`, DEL, C1 and U+2028/U+2029 are escaped; NBSP and other printable characters are kept.
    const [ls = "", ps = "", nbsp = ""] = [0x2028, 0x2029, 0xa0].map((c) => String.fromCharCode(c));
    const all = new ValidationError([`"\\\x7f\x80\x9f${ls}${ps}${nbsp}é`], "type", "d");
    assert.equal(all.parameter.length, 9);
    assert.equal(all.message, `invalid parameter "\\"\\\\\\u007f\\u0080\\u009f\\u2028\\u2029${nbsp}é": d`);
    for (const c of e.message + all.message) {
      const code = c.charCodeAt(0);
      assert.ok(code >= 0x20 && !(code >= 0x7f && code <= 0x9f) && code !== 0x2028 && code !== 0x2029, c);
    }
  });

  test("map keys are kept raw (a dot in a key is ambiguous)", () => {
    assert.equal(new ValidationError(["m", "a.b", 0], "null", "d").parameter, "m.a.b.0");
  });

  test("IntegerRangeError", () => {
    const cause = new Error("c");
    const e = new IntegerRangeError(["n"], "integer out of range", { cause });
    assert.ok(e instanceof ValidationError);
    assert.equal(e.name, "IntegerRangeError");
    assert.equal(e.reason, "int-range");
    assert.equal(e.parameter, "n");
    assert.equal(e.localName, "org.varlink.service.InvalidParameter");
    assert.equal(e.cause, cause);
  });
});
