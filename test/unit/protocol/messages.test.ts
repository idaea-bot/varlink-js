// Call/reply messages (DESIGN.md §4.4, §4.10): the UAPI header table for decode, exact encode output (F17).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ProtocolError } from "../../../src/core/errors/index.ts";
import {
  decodeCall,
  decodeReply,
  encodeCall,
  encodeReply,
  type CallInit,
  type ReplyInit,
} from "../../../src/core/protocol/index.ts";
import { jsonCodec } from "../../../src/core/types/index.ts";

const M = "org.example.ftl.Jump";

/** [description, message, expected decode (or "protocol" for a ProtocolError)] */
type Row<T> = [string, unknown, T | "protocol"];

const CALL_ROWS: Row<Partial<ReturnType<typeof decodeCall>>>[] = [
  ["minimal", { method: M }, { method: M, parameters: {}, oneway: false, more: false, upgrade: false, ext: {} }],
  ["parameters object", { method: M, parameters: { a: 1 } }, { parameters: { a: 1 } }],
  ["parameters null ≡ absent", { method: M, parameters: null }, { parameters: {} }],
  ["parameters array", { method: M, parameters: [] }, "protocol"],
  ["parameters string", { method: M, parameters: "x" }, "protocol"],
  ["parameters number", { method: M, parameters: 1 }, "protocol"],
  ["parameters true", { method: M, parameters: true }, "protocol"],
  ["method missing", { parameters: {} }, "protocol"],
  ["method null", { method: null }, "protocol"],
  ["method number", { method: 1 }, "protocol"],
  ["method object", { method: {} }, "protocol"],
  ["method syntax is not checked here", { method: "not a method" }, { method: "not a method" }],
  ["oneway true", { method: M, oneway: true }, { oneway: true }],
  ["oneway false", { method: M, oneway: false }, { oneway: false }],
  ["oneway null ≡ absent", { method: M, oneway: null }, { oneway: false }],
  ["oneway string", { method: M, oneway: "true" }, "protocol"],
  ["oneway number", { method: M, oneway: 1 }, "protocol"],
  ["more true", { method: M, more: true }, { more: true }],
  ["more null", { method: M, more: null }, { more: false }],
  ["more number", { method: M, more: 0 }, "protocol"],
  ["upgrade true", { method: M, upgrade: true }, { upgrade: true }],
  ["upgrade null", { method: M, upgrade: null }, { upgrade: false }],
  ["upgrade object", { method: M, upgrade: {} }, "protocol"],
  ["oneway + more", { method: M, oneway: true, more: true }, "protocol"],
  ["more + upgrade", { method: M, more: true, upgrade: true }, "protocol"],
  ["oneway + upgrade", { method: M, oneway: true, upgrade: true }, "protocol"],
  ["all three", { method: M, oneway: true, more: true, upgrade: true }, "protocol"],
  ["one true, others false", { method: M, oneway: true, more: false, upgrade: false }, { oneway: true }],
  ["unknown key", { method: M, foo: 1 }, "protocol"],
  ["reply key in a call", { method: M, continues: true }, "protocol"],
  ["error key in a call", { method: M, error: "a.b.C" }, "protocol"],
  ["vendor ext", { method: M, "com.example.trace": "x" }, { ext: { "com.example.trace": "x" } }],
  ["vendor ext null kept", { method: M, "a.b": null }, { ext: { "a.b": null } }],
  ["top level array", [], "protocol"],
  ["top level null", null, "protocol"],
  ["top level number", 42, "protocol"],
  ["top level string", "x", "protocol"],
];

const REPLY_ROWS: Row<Partial<ReturnType<typeof decodeReply>>>[] = [
  ["empty", {}, { parameters: {}, continues: false, ext: {} }],
  ["parameters", { parameters: { a: [1] } }, { parameters: { a: [1] } }],
  ["parameters null", { parameters: null }, { parameters: {} }],
  ["parameters array", { parameters: [1] }, "protocol"],
  ["parameters number", { parameters: 1 }, "protocol"],
  ["continues true", { continues: true }, { continues: true }],
  ["continues false", { continues: false }, { continues: false }],
  ["continues null", { continues: null }, { continues: false }],
  ["continues string", { continues: "yes" }, "protocol"],
  ["error", { error: "a.b.C" }, { error: "a.b.C" }],
  ["error with odd name (not checked here)", { error: "odd" }, { error: "odd" }],
  ["error null ≡ absent", { error: null }, { continues: false }],
  ["error number", { error: 1 }, "protocol"],
  ["error object", { error: {} }, "protocol"],
  ["continues + error", { continues: true, error: "a.b.C" }, "protocol"],
  ["continues false + error", { continues: false, error: "a.b.C" }, { error: "a.b.C" }],
  ["continues + error null", { continues: true, error: null }, { continues: true }],
  ["method in a reply", { method: M }, "protocol"],
  ["oneway in a reply", { oneway: true }, "protocol"],
  ["more in a reply", { more: true }, "protocol"],
  ["upgrade in a reply", { upgrade: true }, "protocol"],
  ["unknown key", { foo: 1 }, "protocol"],
  ["vendor ext", { "org.example.x": { y: 1 } }, { ext: { "org.example.x": { y: 1 } } }],
  ["top level array", [{}], "protocol"],
  ["top level null", null, "protocol"],
  ["top level boolean", true, "protocol"],
];

function runRows<T extends object>(rows: Row<T>[], decode: (v: unknown) => T): void {
  for (const [name, value, expected] of rows) {
    test(name, () => {
      if (expected === "protocol") {
        assert.throws(() => decode(value), ProtocolError);
        return;
      }
      const got = decode(value);
      for (const [key, v] of Object.entries(expected)) assert.deepEqual(got[key as keyof T], v, key);
      if (!("error" in expected)) assert.equal("error" in got, false);
    });
  }
}

describe("decodeCall", () => {
  runRows(CALL_ROWS, decodeCall);

  test("parameters are used by reference", () => {
    const parameters = { a: 1 };
    assert.equal(decodeCall({ method: M, parameters }).parameters, parameters);
  });

  test("ext is a fresh object with own data properties", () => {
    const value = JSON.parse('{"method":"a.b.C","x.__proto__":{"polluted":true},"a.b":1}') as unknown;
    const { ext } = decodeCall(value);
    assert.deepEqual(Object.keys(ext), ["x.__proto__", "a.b"]);
    assert.deepEqual(Object.getOwnPropertyDescriptor(ext, "a.b"), {
      value: 1,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    assert.equal(Object.getPrototypeOf(ext), Object.prototype);
  });

  test("error messages quote long peer keys cut to 64 characters", () => {
    const key = "k".repeat(200);
    assert.throws(
      () => decodeCall({ method: M, [key]: 1 }),
      (e: unknown) =>
        e instanceof ProtocolError && e.message.includes(`"${"k".repeat(64)}…"`) && !e.message.includes("k".repeat(65)),
    );
  });

  test("null-prototype objects are objects", () => {
    const value = Object.assign(Object.create(null) as object, { method: M });
    assert.equal(decodeCall(value).method, M);
  });
});

describe("decodeReply", () => {
  runRows(REPLY_ROWS, decodeReply);
});

describe("encodeCall", () => {
  const cases: [CallInit, string][] = [
    [{ method: M }, `{"method":"${M}","parameters":{}}`],
    [{ method: M, parameters: {} }, `{"method":"${M}","parameters":{}}`],
    [{ method: M, parameters: { a: 1 } }, `{"method":"${M}","parameters":{"a":1}}`],
    [{ method: M, oneway: false, more: false, upgrade: false }, `{"method":"${M}","parameters":{}}`],
    [{ method: M, oneway: true }, `{"method":"${M}","parameters":{},"oneway":true}`],
    [{ method: M, more: true }, `{"method":"${M}","parameters":{},"more":true}`],
    [{ method: M, upgrade: true, more: false }, `{"method":"${M}","parameters":{},"upgrade":true}`],
    [
      { ext: { "com.example.t": 1 }, more: true, parameters: { x: null }, method: M },
      `{"method":"${M}","parameters":{"x":null},"more":true,"com.example.t":1}`,
    ],
  ];
  for (const [init, text] of cases) {
    test(text, () => {
      assert.equal(encodeCall(init, jsonCodec), text);
    });
  }

  test("caller bugs are TypeErrors", () => {
    const bad: unknown[] = [
      { method: 1 },
      { method: M, parameters: [] },
      { method: M, parameters: null },
      { method: M, parameters: new Date() },
      { method: M, oneway: true, more: true },
      { method: M, more: true, upgrade: true },
      { method: M, more: 1 },
      { method: M, oneway: "yes" },
      { method: M, ext: { noDot: 1 } },
      { method: M, ext: [] },
      { method: M, parameters: { n: Number.NaN } },
      { method: M, ext: { "a.b": Infinity } },
    ];
    for (const init of bad) assert.throws(() => encodeCall(init as CallInit, jsonCodec), TypeError);
  });
});

describe("encodeReply", () => {
  const cases: [ReplyInit, string][] = [
    [{}, `{"parameters":{}}`],
    [{ parameters: { a: "b" } }, `{"parameters":{"a":"b"}}`],
    [{ continues: false }, `{"parameters":{}}`],
    [{ continues: true, parameters: { i: 1 } }, `{"parameters":{"i":1},"continues":true}`],
    [{ parameters: { p: 1 }, error: "a.b.C" }, `{"error":"a.b.C","parameters":{"p":1}}`],
    [{ error: "a.b.C", continues: false }, `{"error":"a.b.C","parameters":{}}`],
    [{ ext: { "x.y": true }, continues: true }, `{"parameters":{},"continues":true,"x.y":true}`],
  ];
  for (const [init, text] of cases) {
    test(text, () => {
      assert.equal(encodeReply(init, jsonCodec), text);
    });
  }

  test("caller bugs are TypeErrors", () => {
    const bad: unknown[] = [
      { error: "a.b.C", continues: true },
      { error: 1 },
      { continues: "yes" },
      { parameters: "x" },
      { parameters: [1] },
      { ext: { continues: 1 } },
      { ext: { error: 1 } },
      { parameters: { x: Infinity } },
    ];
    for (const init of bad) assert.throws(() => encodeReply(init as ReplyInit, jsonCodec), TypeError);
  });

  test("round trip through decode", () => {
    const text = encodeReply({ error: "a.b.C", parameters: { x: [1, "2"] }, ext: { "v.k": 1 } }, jsonCodec);
    assert.deepEqual(decodeReply(jsonCodec.decode(text)), {
      error: "a.b.C",
      parameters: { x: [1, "2"] },
      continues: false,
      ext: { "v.k": 1 },
    });
  });
});
