// Negative cases: one row per grammar or validation rule, with the expected code and line:column.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  formatInterface,
  formatType,
  IdlSyntaxError,
  MAX_TYPE_DEPTH,
  parseInterface,
  validateInterface,
  type IdlErrorCode,
  type Interface,
  type Type,
} from "../../../src/core/idl/index.ts";
import { lc, parseError } from "./helpers.ts";

const H = "interface a.b\n";

const deepParens = (n: number): string => `${H}type A ${"(a: ".repeat(n)}int${")".repeat(n)}\n`;

// [description, input, code, "line:column"]
const CASES: [string, string, IdlErrorCode, string][] = [
  // file structure
  ["empty input", "", "unexpected-eof", "1:1"],
  ["only comments", "# x\n\n", "unexpected-eof", "3:1"],
  ["member before interface", "type T ()\n", "unexpected-token", "1:1"],
  ["interface keyword only", "interface", "unexpected-eof", "1:10"],
  ["interface keyword then punctuation", "interface (", "unexpected-token", "1:11"],
  ["second interface", `${H}interface c.d\n`, "unexpected-token", "2:1"],
  ["unknown keyword", `${H}struct T ()\n`, "unexpected-token", "2:1"],
  ["capitalised keyword", `${H}Type T ()\n`, "unexpected-token", "2:1"],
  ["stray paren", `${H})\n`, "unexpected-token", "2:1"],
  ["junk after member on the same line", `${H}type T () x\n`, "unexpected-token", "2:11"],

  // interface names
  ["single component", "interface a\n", "invalid-interface-name", "1:11"],
  ["trailing hyphen", "interface a-.b\n", "invalid-interface-name", "1:11"],
  ["trailing hyphen at end", "interface a.b-\n", "invalid-interface-name", "1:11"],
  ["leading hyphen in a component", "interface a.-b\n", "invalid-interface-name", "1:11"],
  ["leading hyphen", "interface -a.b\n", "unexpected-character", "1:11"],
  ["empty component", "interface a..b\n", "invalid-interface-name", "1:11"],
  ["trailing dot", "interface a.b.\n", "invalid-interface-name", "1:11"],
  ["first component starts with a digit", "interface 1a.b\n", "invalid-interface-name", "1:11"],
  ["underscore", "interface a_b.c\n", "invalid-interface-name", "1:11"],
  ["non-ASCII", "interface \u{00E4}.b\n", "unexpected-character", "1:11"],

  // member names
  ["lowercase type name", `${H}type t ()\n`, "invalid-member-name", "2:6"],
  ["lowercase method name", `${H}method m() -> ()\n`, "invalid-member-name", "2:8"],
  ["lowercase error name", `${H}error e ()\n`, "invalid-member-name", "2:7"],
  ["underscore in member name", `${H}type T_x ()\n`, "invalid-member-name", "2:6"],
  ["non-ASCII in member name", `${H}type T\u{00E4} ()\n`, "unexpected-character", "2:7"],
  ["missing member name", `${H}type ()\n`, "unexpected-token", "2:6"],

  // field names
  ["double underscore", `${H}type T (a__b: int)\n`, "invalid-field-name", "2:9"],
  ["leading underscore", `${H}type T (_a: int)\n`, "unexpected-character", "2:9"],
  ["trailing underscore", `${H}type T (a_: int)\n`, "invalid-field-name", "2:9"],
  ["digit start", `${H}type T (1a: int)\n`, "invalid-field-name", "2:9"],
  ["hyphen in field name", `${H}type T (a-b: int)\n`, "invalid-field-name", "2:9"],
  ["dot in field name", `${H}type T (a.b: int)\n`, "invalid-field-name", "2:9"],
  ["bad enum value", `${H}type T (a, b__c)\n`, "invalid-field-name", "2:12"],
  ["non-ASCII field name", `${H}type T (\u{00E4}: int)\n`, "unexpected-character", "2:9"],

  // types
  ["nested nullable", `${H}type T (a: ??int)\n`, "nested-nullable", "2:13"],
  ["nested nullable via named", `${H}type T (a: ??T)\n`, "nested-nullable", "2:13"],
  ["space after ?", `${H}type T (a: ? int)\n`, "unexpected-character", "2:13"],
  ["space after []", `${H}type T (a: [] int)\n`, "unexpected-character", "2:14"],
  ["space after [string]", `${H}type T (a: [string] int)\n`, "unexpected-character", "2:20"],
  ["line break after ?", `${H}type T (a: ?\nint)\n`, "unexpected-character", "2:13"],
  ["comment after []", `${H}type T (a: []# c\nint)\n`, "unexpected-character", "2:14"],
  ["space between prefixes", `${H}type T (a: ? []int)\n`, "unexpected-character", "2:13"],
  ["space inside []", `${H}type T (a: [ ]int)\n`, "unexpected-character", "2:12"],
  ["space inside [string]", `${H}type T (a: [ string]int)\n`, "unexpected-character", "2:12"],
  ["[strings]", `${H}type T (a: [strings]int)\n`, "unexpected-character", "2:12"],
  ["[int]", `${H}type T (a: [int]int)\n`, "unexpected-character", "2:12"],
  ["lowercase type reference", `${H}type T (a: foo)\n`, "unexpected-token", "2:12"],
  ["keyword as type", `${H}type T (a: type)\n`, "unexpected-token", "2:12"],
  ["bad type reference", `${H}type T (a: Foo_bar)\n`, "invalid-member-name", "2:12"],
  ["missing type", `${H}type T (a: )\n`, "unexpected-token", "2:12"],
  ["prefix without element", `${H}type T (a: [])\n`, "unexpected-token", "2:14"],
  ["primitive as type body", `${H}type Foo string\n`, "unexpected-token", "2:10"],
  ["named type as type body", `${H}type Foo Bar\n`, "unexpected-token", "2:10"],
  ["nullable struct as type body", `${H}type Foo ?(a: int)\n`, "unexpected-token", "2:10"],
  ["array as type body", `${H}type Foo []int\n`, "unexpected-token", "2:10"],
  ["primitive as error payload", `${H}error E string\n`, "unexpected-token", "2:9"],

  // structs and enums
  ["trailing comma in struct", `${H}type T (a: int, )\n`, "unexpected-token", "2:15"],
  ["trailing comma in enum", `${H}type T (a, )\n`, "unexpected-token", "2:10"],
  ["leading comma", `${H}type T (, a)\n`, "unexpected-token", "2:9"],
  ["double comma", `${H}type T (a,, b)\n`, "unexpected-token", "2:11"],
  ["missing comma", `${H}type T (a: int b: int)\n`, "unexpected-token", "2:16"],
  ["missing comma in enum", `${H}type T (a b)\n`, "unexpected-token", "2:11"],
  ["struct then enum item", `${H}type T (a: int, b)\n`, "mixed-struct-enum", "2:17"],
  ["enum then struct item", `${H}type T (a, b: int)\n`, "mixed-struct-enum", "2:12"],
  ["enum as method input", `${H}method M(x) -> ()\n`, "unexpected-token", "2:11"],
  ["enum as method output", `${H}method M() -> (x, y)\n`, "unexpected-token", "2:17"],
  ["enum as error payload", `${H}error E (x)\n`, "unexpected-token", "2:11"],
  ["unclosed struct at EOF", `${H}type T (a: int`, "unexpected-eof", "2:15"],
  ["EOF after colon", `${H}type T (a:`, "unexpected-eof", "2:11"],
  ["EOF after prefix", `${H}type T (a: ?`, "unexpected-eof", "2:13"],
  ["EOF after (", `${H}type T (`, "unexpected-eof", "2:9"],

  // methods
  ["missing ->", `${H}method M() ()\n`, "unexpected-token", "2:12"],
  ["EOF instead of ->", `${H}method M()`, "unexpected-eof", "2:11"],
  ["lone -", `${H}method M() - ()\n`, "unexpected-character", "2:12"],
  ["> without -", `${H}method M() > ()\n`, "unexpected-character", "2:12"],
  ["missing output", `${H}method M() ->\n`, "unexpected-eof", "3:1"],
  ["primitive output", `${H}method M() -> int\n`, "unexpected-token", "2:15"],

  // line breaks between members
  ["no line break after interface name", "interface a.b type T ()\n", "expected-line-break", "1:15"],
  ["no line break between members", `${H}type T () type U ()\n`, "expected-line-break", "2:11"],
  ["two methods on one line", `${H}method A() -> () method B() -> ()\n`, "expected-line-break", "2:18"],
  ["method after ) on the same line", `${H}type T (\n  a: int\n) method B() -> ()\n`, "expected-line-break", "4:3"],

  // characters
  ["vertical tab", `${H}type T ()\u{000B}\n`, "unexpected-character", "2:10"],
  ["form feed", `${H}\u{000C}type T ()\n`, "unexpected-character", "2:1"],
  ["NUL", `${H}type T (a: int)\u{0000}`, "unexpected-character", "2:16"],
  ["NEL is not whitespace", `${H}type T ()\u{0085}\n`, "unexpected-character", "2:10"],
  ["zero-width space is not whitespace", `${H}type\u{200B}T ()\n`, "unexpected-character", "2:5"],
  ["stray ]", `${H}type T (a: int])\n`, "unexpected-character", "2:15"],
  ["semicolon", `${H}type T ();\n`, "unexpected-character", "2:10"],
  ["astral character", `${H}type T (\u{1F600}: int)\n`, "unexpected-character", "2:9"],

  // depth
  [`parens nested ${String(MAX_TYPE_DEPTH + 1)} deep`, deepParens(MAX_TYPE_DEPTH + 1), "too-deep", "2:264"],
  [
    `prefixes nested ${String(MAX_TYPE_DEPTH)} deep under a struct`,
    `${H}type A (a: ${"[]".repeat(64)}int)\n`,
    "too-deep",
    "2:138",
  ],

  // validation (positions from spans)
  ["duplicate type", `${H}type T ()\ntype T ()\n`, "duplicate-member", "3:6"],
  ["duplicate across kinds", `${H}type T ()\nmethod T() -> ()\n`, "duplicate-member", "3:8"],
  ["duplicate error", `${H}error E ()\nerror E ()\n`, "duplicate-member", "3:7"],
  ["duplicate field", `${H}type T (a: int, a: string)\n`, "duplicate-field", "2:17"],
  ["duplicate method parameter", `${H}method M(a: int, a: int) -> ()\n`, "duplicate-field", "2:18"],
  ["duplicate enum value", `${H}type T (a, a)\n`, "duplicate-field", "2:12"],
  ["duplicate in nested struct", `${H}type T (s: [](x: int, x: int))\n`, "duplicate-field", "2:23"],
  ["unresolved reference", `${H}type T (a: U)\n`, "unresolved-type", "2:12"],
  ["unresolved in method", `${H}method M() -> (r: ?[]Nope)\n`, "unresolved-type", "2:22"],
  ["reference to a method", `${H}method M() -> ()\ntype T (a: M)\n`, "not-a-type", "3:12"],
  ["reference to an error", `${H}error E ()\nmethod M(e: E) -> ()\n`, "not-a-type", "3:13"],
  ["validation errors come in source order", `${H}type T (a: Nope)\ntype T ()\n`, "unresolved-type", "2:12"],
];

describe("parse errors", () => {
  for (const [what, input, code, position] of CASES) {
    test(`${what} → ${code} at ${position}`, () => {
      const err = parseError(input);
      assert.equal(err.code, code, err.message);
      assert.equal(lc(err.position), position, err.message);
      assert.ok(err.position, "position");
      assert.ok(err.position.offset >= 0 && err.position.offset <= input.length);
    });
  }

  test("depth limit leaves no room for a stack overflow", () => {
    assert.equal(parseError(deepParens(100_000)).code, "too-deep");
  });
});

describe("IdlSyntaxError", () => {
  test("shape", () => {
    const err = parseError(`${H}type t ()\n`);
    assert.ok(err instanceof SyntaxError);
    assert.ok(err instanceof Error);
    assert.equal(err.name, "IdlSyntaxError");
    assert.equal(err.code, "invalid-member-name");
    assert.equal(err.reason, 'invalid member name "t"');
    assert.equal(err.message, '2:6: invalid member name "t"');
    assert.deepEqual(err.position, { offset: 19, line: 2, column: 6 });
    assert.match(String(err), /^IdlSyntaxError: 2:6: /);
  });

  test("without a position the message is the reason", () => {
    const err = new IdlSyntaxError("invalid-ast", "bad");
    assert.equal(err.message, "bad");
    assert.equal(err.position, undefined);
  });
});

describe("validateInterface on hand-built ASTs", () => {
  const ok = (members: unknown[], extra: Record<string, unknown> = {}): Interface =>
    ({ kind: "interface", name: "a.b", experimental: false, members, ...extra }) as Interface;
  const struct = (fields: unknown[]): unknown => ({ kind: "struct", fields });
  const field = (name: unknown, type: unknown, extra: Record<string, unknown> = {}): unknown => ({
    name,
    type,
    experimental: false,
    ...extra,
  });
  const codes = (iface: unknown): IdlErrorCode[] => validateInterface(iface as Interface).map((e) => e.code);

  test("a valid AST", () => {
    assert.deepEqual(
      codes(
        ok([
          {
            kind: "type",
            name: "T",
            experimental: false,
            type: struct([field("next", { kind: "nullable", element: { kind: "named", name: "T" } })]),
          },
          { kind: "method", name: "M", experimental: false, input: struct([]), output: struct([]), more: "requires" },
        ]),
      ),
      [],
    );
  });

  test("returns every problem, without positions", () => {
    const iface = {
      kind: "interface",
      name: "bad",
      experimental: false,
      members: [
        {
          kind: "type",
          name: "lower",
          experimental: false,
          type: struct([
            field("a__b", { kind: "named", name: "Missing" }),
            field("x", { kind: "int" }),
            field("x", { kind: "nullable", element: { kind: "nullable", element: { kind: "int" } } }),
          ]),
        },
        {
          kind: "method",
          name: "M",
          experimental: false,
          input: { kind: "enum", values: [{ name: "v", experimental: false }] },
          output: struct([field("r", { kind: "named", name: "M" })]),
        },
        { kind: "error", name: "M", doc: "line\r", experimental: false, type: struct([]) },
        { kind: "type", name: "E", experimental: false, type: { kind: "enum", values: [] } },
        { kind: "type", name: "P", experimental: false, type: { kind: "int" } },
      ],
    };
    const errors = validateInterface(iface as unknown as Interface);
    assert.deepEqual(errors.map((e) => e.code).sort(), [
      "duplicate-field",
      "duplicate-member",
      "invalid-ast",
      "invalid-ast",
      "invalid-ast",
      "invalid-doc",
      "invalid-field-name",
      "invalid-interface-name",
      "invalid-member-name",
      "nested-nullable",
      "not-a-type",
      "unresolved-type",
    ]);
    for (const e of errors) {
      assert.equal(e.position, undefined);
      assert.equal(e.message, e.reason);
    }
  });

  test("doc strings", () => {
    const withDoc = (kind: string, doc: string): unknown => {
      const base = { name: "X", doc, experimental: false };
      return kind === "method"
        ? ok([{ ...base, kind, input: struct([]), output: struct([]) }])
        : ok([{ ...base, kind, type: struct([]) }]);
    };
    for (const bad of ["a\rb", "a\u{2028}", "\u{2029}", "[Experimental]", "x\n[Experimental]\ny"]) {
      assert.deepEqual(codes(withDoc("type", bad)), ["invalid-doc"], JSON.stringify(bad));
    }
    for (const marker of [
      "[Supports 'more' flag]",
      "[Requires 'more' flag]",
      "[Supports 'upgrade' flag]",
      "[Requires 'upgrade' flag]",
    ]) {
      assert.deepEqual(codes(withDoc("method", `doc\n${marker}`)), ["invalid-doc"], marker);
      assert.deepEqual(codes(withDoc("type", marker)), [], marker);
      assert.deepEqual(codes(withDoc("error", marker)), [], marker);
    }
    for (const fine of ["", "\n", " [Experimental]", "[Experimental] ", "# x", "a\tb"]) {
      assert.deepEqual(codes(withDoc("method", fine)), [], JSON.stringify(fine));
    }
    assert.deepEqual(codes(ok([], { doc: "[Experimental]" })), ["invalid-doc"]);
    assert.deepEqual(
      codes(
        ok([
          {
            kind: "type",
            name: "T",
            experimental: false,
            type: struct([field("f", { kind: "int" }, { doc: "[Experimental]" })]),
          },
        ]),
      ),
      ["invalid-doc"],
    );
  });

  test("malformed nodes are invalid-ast, never exceptions", () => {
    const bad: unknown[] = [
      null,
      42,
      "interface",
      {},
      { kind: "interface" },
      ok([null]),
      ok([{ kind: "struct", name: "T", experimental: false }]),
      ok([{ kind: "type", name: 7, experimental: false, type: struct([]) }]),
      ok([{ kind: "type", name: "T", experimental: "yes", type: struct([]) }]),
      ok([{ kind: "type", name: "T", experimental: false, doc: 5, type: struct([]) }]),
      ok([{ kind: "type", name: "T", experimental: false, type: { kind: "struct" } }]),
      ok([{ kind: "type", name: "T", experimental: false, type: struct([null]) }]),
      ok([{ kind: "type", name: "T", experimental: false, type: struct([field(null, { kind: "int" })]) }]),
      ok([{ kind: "type", name: "T", experimental: false, type: struct([field("a", { kind: "uint" })]) }]),
      ok([{ kind: "type", name: "T", experimental: false, type: struct([field("a", null)]) }]),
      ok([{ kind: "type", name: "T", experimental: false, type: struct([field("a", { kind: "named", name: 1 })]) }]),
      ok([{ kind: "type", name: "T", experimental: false, more: "supports", type: struct([]) }]),
      ok([{ kind: "method", name: "M", experimental: false, input: struct([]), output: struct([]), more: "always" }]),
      ok([{ kind: "method", name: "M", experimental: false, input: struct([]) }]),
      ok({ length: 1 } as unknown as unknown[]),
    ];
    for (const iface of bad) {
      const errors = validateInterface(iface as Interface);
      assert.ok(errors.length > 0, JSON.stringify(iface));
      assert.ok(
        errors.every((e) => e instanceof IdlSyntaxError),
        JSON.stringify(iface),
      );
      assert.ok(
        errors.some((e) => e.code === "invalid-ast"),
        JSON.stringify(iface),
      );
    }
  });

  test("more/upgrade only on methods", () => {
    const typeWith = (fieldExtra: Record<string, unknown>, valueExtra: Record<string, unknown>): Interface =>
      ok([
        {
          kind: "type",
          name: "T",
          experimental: false,
          type: struct([
            field("a", { kind: "enum", values: [{ name: "x", experimental: false, ...valueExtra }] }, fieldExtra),
          ]),
        },
      ]);
    assert.deepEqual(codes(ok([], { more: "supports" })), ["invalid-ast"]);
    assert.deepEqual(codes(ok([], { upgrade: "requires" })), ["invalid-ast"]);
    assert.deepEqual(codes(typeWith({ more: "supports" }, {})), ["invalid-ast"]);
    assert.deepEqual(codes(typeWith({}, { upgrade: "requires" })), ["invalid-ast"]);
    assert.deepEqual(codes(typeWith({}, {})), []);
  });

  test("docs must be well-formed UTF-16", () => {
    for (const bad of ["\u{D800}", "a\u{DC00}b", "x\n\u{DBFF}"]) {
      assert.deepEqual(codes(ok([], { doc: bad })), ["invalid-doc"], JSON.stringify(bad));
    }
    assert.deepEqual(codes(ok([], { doc: "\u{1F600}" })), []);
  });

  test("deep and cyclic types stop at MAX_TYPE_DEPTH", () => {
    let deep: Type = { kind: "int" };
    for (let i = 0; i < 100_000; i++) deep = { kind: "array", element: deep };
    const iface = ok([{ kind: "type", name: "T", experimental: false, type: struct([field("a", deep)]) }]);
    assert.deepEqual(codes(iface), ["too-deep"]);

    const cyclic: Record<string, unknown> = { kind: "struct", fields: [] };
    (cyclic.fields as unknown[]).push(field("self", cyclic));
    assert.deepEqual(codes(ok([{ kind: "type", name: "T", experimental: false, type: cyclic }])), ["invalid-ast"]);

    // The member's struct is level 1, so 63 prefixes below it reach the limit.
    let chain: Type = { kind: "int" };
    for (let i = 0; i < MAX_TYPE_DEPTH - 1; i++) chain = { kind: "array", element: chain };
    assert.deepEqual(
      codes(ok([{ kind: "type", name: "T", experimental: false, type: struct([field("a", chain)]) }])),
      [],
    );
    chain = { kind: "array", element: chain };
    assert.deepEqual(codes(ok([{ kind: "type", name: "T", experimental: false, type: struct([field("a", chain)]) }])), [
      "too-deep",
    ]);
  });

  const isInvalidAst =
    (reason: RegExp) =>
    (e: unknown): boolean =>
      e instanceof IdlSyntaxError && e.code === "invalid-ast" && reason.test(e.reason);

  test("a cycle is invalid-ast, in validateInterface and formatType", () => {
    const self: Record<string, unknown> = { kind: "struct", fields: [] };
    self.fields = [field("a", self), field("b", self)];
    const started = performance.now();
    const errors = validateInterface(ok([{ kind: "type", name: "T", experimental: false, type: self }]));
    assert.deepEqual(
      errors.map((e) => [e.code, e.reason]),
      [
        ["invalid-ast", "cyclic AST"],
        ["invalid-ast", "cyclic AST"],
      ],
    );
    assert.throws(() => formatType(self as unknown as Type), isInvalidAst(/^cyclic AST$/));
    assert.ok(performance.now() - started < 2_000);
  });

  test("a heavily shared AST is invalid-ast (too large), quickly", () => {
    // 40 levels, each with two fields pointing at the same next level: 2^40 paths, 41 objects.
    let level: unknown = { kind: "int" };
    for (let i = 0; i < 40; i++) level = struct([field("a", level), field("b", level)]);
    const started = performance.now();
    const errors = validateInterface(ok([{ kind: "type", name: "T", experimental: false, type: level }]));
    assert.deepEqual(
      errors.map((e) => [e.code, e.reason]),
      [["invalid-ast", "AST too large"]],
    );
    assert.throws(() => formatType(level as Type), isInvalidAst(/^AST too large$/));
    assert.throws(
      () => formatInterface(ok([{ kind: "type", name: "T", experimental: false, type: level }])),
      isInvalidAst(/^AST too large$/),
    );
    assert.ok(performance.now() - started < 2_000, String(performance.now() - started));
  });

  test("shared, non-cyclic subtrees are valid", () => {
    const int = { kind: "int" };
    const shared = struct([field("x", int), field("y", int)]);
    const iface = ok([
      { kind: "type", name: "T", experimental: false, type: struct([field("a", int), field("b", int)]) },
      { kind: "type", name: "U", experimental: false, type: shared },
      { kind: "error", name: "E", experimental: false, type: shared },
      { kind: "method", name: "M", experimental: false, input: shared, output: struct([field("s", shared)]) },
    ]);
    assert.deepEqual(codes(iface), []);
    assert.equal(
      formatInterface(iface),
      `interface a.b

type T (a: int, b: int)

type U (x: int, y: int)

error E (x: int, y: int)

method M(x: int, y: int) -> (
  s: (x: int, y: int)
)
`,
    );
    assert.equal(formatType(shared as Type), "(x: int, y: int)");
  });

  test("sorted by position when known", () => {
    const at = (offset: number): unknown => ({
      start: { offset, line: 1, column: offset + 1 },
      end: { offset: offset + 1, line: 1, column: offset + 2 },
    });
    const iface = ok([
      {
        kind: "type",
        name: "T",
        experimental: false,
        type: struct([field("a", { kind: "named", name: "Z", span: at(50) })]),
      },
      { kind: "type", name: "lower", experimental: false, type: struct([]), nameSpan: at(10) },
      { kind: "type", name: "U", experimental: false, type: struct([field("b", { kind: "named", name: "Y" })]) },
    ]);
    const errors = validateInterface(iface);
    assert.deepEqual(
      errors.map((e) => [e.code, e.position?.offset]),
      [
        ["invalid-member-name", 10],
        ["unresolved-type", 50],
        ["unresolved-type", undefined],
      ],
    );
  });
});

test("a large parsed interface never hits the shared-node budget", () => {
  // MAX_AST_NODES only counts repeat visits of shared nodes, which the parser never produces.
  const fields = Array.from({ length: 400_000 }, (_, i) => `a${String(i)}: ?[]int`).join(", ");
  const iface = parseInterface(`interface a.b\ntype A (${fields})\n`);
  assert.deepEqual(validateInterface(iface), []);
});

test("parseInterface rejects non-string input with a TypeError", () => {
  for (const bad of [new Uint8Array([105]), undefined, 42]) {
    assert.throws(() => parseInterface(bad as unknown as string), TypeError);
  }
});
