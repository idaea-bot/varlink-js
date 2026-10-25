// Canonical formatter: exact expected output for each layout rule.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  formatInterface,
  formatType,
  IdlSyntaxError,
  MAX_TYPE_DEPTH,
  parseInterface,
  type Interface,
  type Type,
} from "../../../src/core/idl/index.ts";
import { stripSpans } from "./helpers.ts";

const H = "interface a.b\n";

/** Formats `text` and checks the result is a fixpoint. */
function fmt(text: string): string {
  const out = formatInterface(parseInterface(text));
  assert.equal(formatInterface(parseInterface(out)), out, "not a fixpoint");
  return out;
}

/** The formatted body after the interface line. */
function body(text: string): string {
  const out = fmt(H + text);
  assert.ok(out.startsWith(`${H}\n`));
  return out.slice(H.length + 1);
}

describe("layout", () => {
  test("interface only", () => {
    assert.equal(fmt("interface   a.b"), "interface a.b\n");
    assert.equal(fmt("# c\n\ninterface a.b # c\n\n\n# c\n"), "interface a.b\n");
  });

  test("members are separated by one blank line, in source order", () => {
    assert.equal(
      fmt(`${H}error E ()\ntype T ()\n\n\n\nmethod M() -> ()\ntype U (x)`),
      `${H}\nerror E ()\n\ntype T ()\n\nmethod M() -> ()\n\ntype U (x)\n`,
    );
  });

  test("spacing: type/error with a space, method without", () => {
    assert.equal(
      body("type   T(a:int)\nmethod M  (a:int)->(b:int)\nerror E(a:int)"),
      "type T (a: int)\n\nmethod M(a: int) -> (b: int)\n\nerror E (a: int)\n",
    );
  });

  test("empty struct", () => {
    assert.equal(
      body("type T ( )\nmethod M(\n) -> (  )\nerror E (\n# c\n)"),
      "type T ()\n\nmethod M() -> ()\n\nerror E ()\n",
    );
  });

  test("two fields stay on one line, three do not", () => {
    assert.equal(body("type T (a: int, b: int)"), "type T (a: int, b: int)\n");
    assert.equal(body("type T (a: int, b: int, c: int)"), "type T (\n  a: int,\n  b: int,\n  c: int\n)\n");
  });

  test("enums have no field-count rule", () => {
    assert.equal(body("type T (a, b, c, d, e)"), "type T (a, b, c, d, e)\n");
  });

  test("40-character boundary", () => {
    const at40 = `(${"a".repeat(33)}: int)`;
    assert.equal(at40.length, 40);
    assert.equal(body(`type T ${at40}`), `type T ${at40}\n`);
    const name41 = "a".repeat(34);
    assert.equal(body(`type T (${name41}: int)`), `type T (\n  ${name41}: int\n)\n`);
    const enum40 = `(${"v".repeat(29)}, abcdefg)`;
    assert.equal(enum40.length, 40);
    assert.equal(body(`type E ${enum40}`), `type E ${enum40}\n`);
    assert.equal(body(`type E (${"v".repeat(30)}, abcdefg)`), `type E (\n  ${"v".repeat(30)},\n  abcdefg\n)\n`);
  });

  test("the 40-character rule measures the whole nested struct", () => {
    // 1 field, not directly a struct, but the inline form is 44 characters.
    assert.equal(
      body("type T (a: [](bbbbbbbbbbbb: int, cccccccccccccc: int))"),
      "type T (\n  a: [](bbbbbbbbbbbb: int, cccccccccccccc: int)\n)\n",
    );
  });

  test("a field that is directly a struct or enum makes the parent multiline", () => {
    assert.equal(body("type T (s: (x, y))"), "type T (\n  s: (x, y)\n)\n");
    assert.equal(body("type T (s: ())"), "type T (\n  s: ()\n)\n");
    assert.equal(body("type T (s: ?(x, y), m: [string]())"), "type T (s: ?(x, y), m: [string]())\n");
  });

  test("nested struct is laid out at the field's indent", () => {
    assert.equal(
      body("type TypeFoo (anon: (foo: bool, bar: int, baz: [](a: int, b: int)), object: object)"),
      `type TypeFoo (
  anon: (
    foo: bool,
    bar: int,
    baz: [](a: int, b: int)
  ),
  object: object
)
`,
    );
  });

  test("prefixes are printed directly before a multiline element", () => {
    assert.equal(
      body("type T (a: ?[](x: int, y: int, z: int), b: string)"),
      `type T (
  a: ?[](
    x: int,
    y: int,
    z: int
  ),
  b: string
)
`,
    );
  });

  test("a multiline struct inside a single-line parent (libvarlink layout)", () => {
    assert.equal(
      body("type A (x: [](a: int, b: int, c: int))"),
      `type A (x: [](
    a: int,
    b: int,
    c: int
  ))
`,
    );
  });

  test("methods: input and output at indent 0", () => {
    assert.equal(
      body(
        "method CalculateConfiguration(current: Coordinate, target: Coordinate) -> (configuration: DriveConfiguration)\ntype Coordinate ()\ntype DriveConfiguration ()",
      ),
      `method CalculateConfiguration(
  current: Coordinate,
  target: Coordinate
) -> (configuration: DriveConfiguration)

type Coordinate ()

type DriveConfiguration ()
`,
    );
  });
});

describe("comments", () => {
  test("doc on fields forces multiline and blank lines around documented items", () => {
    assert.equal(
      body("type T (\na: int,\n# b doc\nb: int,\nc: int, d: int)"),
      `type T (
  a: int,

  # b doc
  b: int,

  c: int,
  d: int
)
`,
    );
    assert.equal(body("type T (\n# a\na: int,\n# b\nb: int)"), "type T (\n  # a\n  a: int,\n\n  # b\n  b: int\n)\n");
    assert.equal(body("type E (\n# x\nx)"), "type E (\n  # x\n  x\n)\n");
  });

  test("doc lines: one space after #, empty line as #, text kept verbatim", () => {
    const iface: Interface = {
      kind: "interface",
      name: "a.b",
      doc: "first\n\n indented\ttab  \n#hash",
      experimental: false,
      members: [],
    };
    assert.equal(formatInterface(iface), "# first\n#\n#  indented\ttab  \n# #hash\ninterface a.b\n");
    assert.equal(formatInterface({ ...iface, doc: "" }), "#\ninterface a.b\n");
  });

  test("all markers and their order", () => {
    const iface: Interface = {
      kind: "interface",
      name: "a.b",
      doc: "Interface",
      experimental: true,
      members: [
        {
          kind: "method",
          name: "M",
          doc: "Method",
          experimental: true,
          more: "requires",
          upgrade: "supports",
          input: { kind: "struct", fields: [] },
          output: { kind: "struct", fields: [] },
        },
        {
          kind: "method",
          name: "N",
          experimental: false,
          more: "supports",
          upgrade: "requires",
          input: { kind: "struct", fields: [] },
          output: { kind: "struct", fields: [] },
        },
        {
          kind: "type",
          name: "T",
          doc: "[Supports 'more' flag]",
          experimental: true,
          type: {
            kind: "struct",
            fields: [
              { name: "a", experimental: true, type: { kind: "int" } },
              {
                name: "b",
                doc: "B",
                experimental: true,
                type: { kind: "enum", values: [{ name: "x", experimental: true }] },
              },
            ],
          },
        },
        { kind: "error", name: "E", experimental: true, type: { kind: "struct", fields: [] } },
      ],
    };
    const out = formatInterface(iface);
    assert.equal(
      out,
      `# Interface
# [Experimental]
interface a.b

# Method
# [Requires 'more' flag]
# [Supports 'upgrade' flag]
# [Experimental]
method M() -> ()

# [Supports 'more' flag]
# [Requires 'upgrade' flag]
method N() -> ()

# [Supports 'more' flag]
# [Experimental]
type T (
  # [Experimental]
  a: int,

  # B
  # [Experimental]
  b: (
    # [Experimental]
    x
  )
)

# [Experimental]
error E ()
`,
    );
    const back = parseInterface(out);
    assert.equal(formatInterface(back), out);
  });
});

describe("formatType", () => {
  test("single line, no comments", () => {
    const cases: [Type, string][] = [
      [{ kind: "any" }, "any"],
      [{ kind: "nullable", element: { kind: "any" } }, "?any"],
      [{ kind: "map", element: { kind: "struct", fields: [] } }, "[string]()"],
      [
        {
          kind: "nullable",
          element: {
            kind: "array",
            element: {
              kind: "struct",
              fields: [
                { name: "a", experimental: false, type: { kind: "int" } },
                { name: "b", doc: "dropped", experimental: true, type: { kind: "string" } },
              ],
            },
          },
        },
        "?[](a: int, b: string)",
      ],
      [
        {
          kind: "enum",
          values: [
            { name: "x", experimental: false },
            { name: "y", doc: "d", experimental: false },
          ],
        },
        "(x, y)",
      ],
      [{ kind: "array", element: { kind: "named", name: "Foo" } }, "[]Foo"],
    ];
    for (const [type, expected] of cases) assert.equal(formatType(type), expected);
  });

  test("throws on unknown kinds, empty enums and runaway nesting", () => {
    assert.throws(() => formatType({ kind: "uint" } as unknown as Type), IdlSyntaxError);
    assert.throws(
      () => formatType({ kind: "enum", values: [] }),
      (e: unknown) => e instanceof IdlSyntaxError && e.code === "invalid-ast",
    );
    let deep: Type = { kind: "int" };
    for (let i = 0; i < 10_000; i++) deep = { kind: "array", element: deep };
    assert.throws(
      () => formatType(deep),
      (e: unknown) => e instanceof IdlSyntaxError && e.code === "too-deep",
    );
  });
});

describe("hand-built ASTs", () => {
  test("an enum value with a stray type key is still an enum value", () => {
    for (const stray of [undefined, { kind: "int" }]) {
      const iface = {
        kind: "interface",
        name: "a.b",
        experimental: false,
        members: [
          {
            kind: "type",
            name: "E",
            experimental: false,
            type: {
              kind: "enum",
              values: [
                { name: "x", experimental: false, type: stray },
                { name: "y", experimental: false },
              ],
            },
          },
        ],
      } as Interface;
      const out = formatInterface(iface);
      assert.equal(out, "interface a.b\n\ntype E (x, y)\n", JSON.stringify(stray));
      assert.equal(formatInterface(parseInterface(out)), out);
    }
  });
});

describe("round trip at the depth limit", () => {
  const shapes: [string, (n: number) => string][] = [
    ["nested structs", (n) => `${H}type A ${"(a: ".repeat(n)}int${")".repeat(n)}\n`],
    ["prefix chain", (n) => `${H}type A (a: ${"[]".repeat(n)}int)\n`],
  ];
  const parses = (text: string): boolean => {
    try {
      parseInterface(text);
      return true;
    } catch {
      return false;
    }
  };
  for (const [what, make] of shapes) {
    test(what, () => {
      assert.ok(parses(make(1)));
      let n = 1;
      while (n < 1000 && parses(make(n + 1))) n++;
      assert.ok(n >= MAX_TYPE_DEPTH - 1, String(n));
      assert.throws(
        () => parseInterface(make(n + 1)),
        (e: unknown) => e instanceof IdlSyntaxError && e.code === "too-deep",
      );
      const ast = parseInterface(make(n));
      const out = formatInterface(ast);
      assert.deepEqual(stripSpans(parseInterface(out)), stripSpans(ast));
      assert.equal(formatInterface(parseInterface(out)), out, "not a fixpoint");
    });
  }
});

describe("formatInterface rejects invalid ASTs", () => {
  const base: Interface = { kind: "interface", name: "a.b", experimental: false, members: [] };
  const cases: [string, Interface, string][] = [
    ["bad interface name", { ...base, name: "ab" }, "invalid-interface-name"],
    [
      "duplicate members",
      {
        ...base,
        members: [
          { kind: "type", name: "T", experimental: false, type: { kind: "struct", fields: [] } },
          { kind: "error", name: "T", experimental: false, type: { kind: "struct", fields: [] } },
        ],
      },
      "duplicate-member",
    ],
    [
      "unresolved reference",
      {
        ...base,
        members: [
          {
            kind: "type",
            name: "T",
            experimental: false,
            type: { kind: "struct", fields: [{ name: "a", experimental: false, type: { kind: "named", name: "U" } }] },
          },
        ],
      },
      "unresolved-type",
    ],
    ["doc that breaks the comment", { ...base, doc: "a\u{2028}b" }, "invalid-doc"],
    ["marker in doc", { ...base, doc: "[Experimental]" }, "invalid-doc"],
    [
      "empty enum",
      { ...base, members: [{ kind: "type", name: "T", experimental: false, type: { kind: "enum", values: [] } }] },
      "invalid-ast",
    ],
  ];
  for (const [what, iface, code] of cases) {
    test(what, () => {
      assert.throws(
        () => formatInterface(iface),
        (e: unknown) => e instanceof IdlSyntaxError && e.code === code,
      );
    });
  }
});
