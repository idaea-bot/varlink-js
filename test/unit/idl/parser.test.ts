// Positive parser cases: every type form, comments and line breaks everywhere legal, positions,
// doc comment attachment and the systemd annotations.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  formatType,
  parseInterface,
  type Interface,
  type MethodMember,
  type StructType,
  type TypeMember,
} from "../../../src/core/idl/index.ts";
import { lc, parseError, stripSpans } from "./helpers.ts";

const H = "interface a.b\n";

function member(iface: Interface, name: string): Interface["members"][number] {
  const m = iface.members.find((x) => x.name === name);
  assert.ok(m, `member ${name}`);
  return m;
}

function typeMember(iface: Interface, name: string): TypeMember {
  const m = member(iface, name);
  assert.equal(m.kind, "type");
  return m;
}

function method(iface: Interface, name: string): MethodMember {
  const m = member(iface, name);
  assert.equal(m.kind, "method");
  return m;
}

function struct(iface: Interface, name: string): StructType {
  const { type } = typeMember(iface, name);
  assert.equal(type.kind, "struct");
  return type;
}

/** field name → single-line type string */
function fieldTypes(s: StructType): Record<string, string> {
  return Object.fromEntries(s.fields.map((f) => [f.name, formatType(f.type)]));
}

describe("structure", () => {
  test("exact AST of a small interface", () => {
    const ast = parseInterface(`${H}type T (a: int, b: ?[]N)\ntype N (x, y)\nmethod M(i: T) -> ()\nerror E ()\n`);
    assert.deepEqual(stripSpans(ast), {
      kind: "interface",
      name: "a.b",
      experimental: false,
      members: [
        {
          kind: "type",
          name: "T",
          experimental: false,
          type: {
            kind: "struct",
            fields: [
              { name: "a", experimental: false, type: { kind: "int" } },
              {
                name: "b",
                experimental: false,
                type: { kind: "nullable", element: { kind: "array", element: { kind: "named", name: "N" } } },
              },
            ],
          },
        },
        {
          kind: "type",
          name: "N",
          experimental: false,
          type: {
            kind: "enum",
            values: [
              { name: "x", experimental: false },
              { name: "y", experimental: false },
            ],
          },
        },
        {
          kind: "method",
          name: "M",
          experimental: false,
          input: { kind: "struct", fields: [{ name: "i", experimental: false, type: { kind: "named", name: "T" } }] },
          output: { kind: "struct", fields: [] },
        },
        { kind: "error", name: "E", experimental: false, type: { kind: "struct", fields: [] } },
      ],
    });
  });

  test("spans", () => {
    const ast = parseInterface(`${H}type T (a: int)\n`);
    assert.deepEqual(ast.nameSpan, {
      start: { offset: 10, line: 1, column: 11 },
      end: { offset: 13, line: 1, column: 14 },
    });
    const t = typeMember(ast, "T");
    assert.deepEqual(t.span, { start: { offset: 14, line: 2, column: 1 }, end: { offset: 29, line: 2, column: 16 } });
    assert.deepEqual(t.nameSpan?.start, { offset: 19, line: 2, column: 6 });
    assert.deepEqual(t.type.span?.start, { offset: 21, line: 2, column: 8 });
    const [field] = struct(ast, "T").fields;
    assert.deepEqual(field?.span, {
      start: { offset: 22, line: 2, column: 9 },
      end: { offset: 28, line: 2, column: 15 },
    });
    assert.deepEqual(field.type.span, {
      start: { offset: 25, line: 2, column: 12 },
      end: { offset: 28, line: 2, column: 15 },
    });
    assert.deepEqual(ast.span, { start: { offset: 0, line: 1, column: 1 }, end: { offset: 29, line: 2, column: 16 } });
  });

  test("empty interface (zero members, deliberate leniency)", () => {
    for (const text of ["interface a.b\n", "interface a.b", "  interface a.b  \n\n  # c\n", "interface\n# c\n  a.b"]) {
      assert.deepEqual(stripSpans(parseInterface(text)), {
        kind: "interface",
        name: "a.b",
        experimental: false,
        members: [],
      });
    }
  });

  test("interface names", () => {
    for (const name of ["a.b", "org.example.ftl", "A.B", "a.1b", "a-b.c", "a--b.c-d.0", "io.systemd.Resolve.Monitor"]) {
      assert.equal(parseInterface(`interface ${name}\n`).name, name);
    }
  });

  test("file without final newline and comment at EOF", () => {
    assert.equal(parseInterface(`${H}type T ()`).members.length, 1);
    assert.equal(parseInterface(`${H}type T () # end`).members.length, 1);
    assert.equal(parseInterface(`${H}type T ()\n# end`).members.length, 1);
    assert.equal(parseInterface(`${H}# end`).members.length, 0);
  });

  test("method input and output are separate structs", () => {
    const m = method(parseInterface(`${H}method M(a: int) -> (a: string)\n`), "M");
    assert.equal(formatType(m.input), "(a: int)");
    assert.equal(formatType(m.output), "(a: string)");
  });

  test("references: forward, recursive, mutual", () => {
    const ast = parseInterface(`${H}type A (b: B, self: ?A)\ntype B (a: []A)\nmethod M(a: A) -> (b: B)\n`);
    assert.equal(ast.members.length, 3);
  });
});

describe("types", () => {
  test("every type form", () => {
    const ast = parseInterface(`${H}type T (
  b: bool, i: int, f: float, s: string, o: object, a: any,
  na: ?any, no: ?object, ns: ?string, nas: ?[]?string, arr: []int, map: [string]int,
  set: [string](), nset: ?[string](), nm: ?[string]?[]?T, anr: []?[string]?T,
  e: (x, y), st: (p: int, q: (r: string, s: (one))), ref: T, empty: (), ne: ?(a), aa: [][][]int
)\n`);
    assert.deepEqual(fieldTypes(struct(ast, "T")), {
      b: "bool",
      i: "int",
      f: "float",
      s: "string",
      o: "object",
      a: "any",
      na: "?any",
      no: "?object",
      ns: "?string",
      nas: "?[]?string",
      arr: "[]int",
      map: "[string]int",
      set: "[string]()",
      nset: "?[string]()",
      nm: "?[string]?[]?T",
      anr: "[]?[string]?T",
      e: "(x, y)",
      st: "(p: int, q: (r: string, s: (one)))",
      ref: "T",
      empty: "()",
      ne: "?(a)",
      aa: "[][][]int",
    });
  });

  test("?any and ?[]?string shapes", () => {
    const s = struct(parseInterface(`${H}type T (a: ?any, b: ?[]?string)\n`), "T");
    assert.deepEqual(stripSpans(s.fields.map((f) => f.type)), [
      { kind: "nullable", element: { kind: "any" } },
      { kind: "nullable", element: { kind: "array", element: { kind: "nullable", element: { kind: "string" } } } },
    ]);
  });

  test("[string]() is a map of the empty struct", () => {
    const s = struct(parseInterface(`${H}type T (set: [string]())\n`), "T");
    assert.deepEqual(stripSpans(s.fields[0]?.type), { kind: "map", element: { kind: "struct", fields: [] } });
  });

  test("type members may be enums; enum values may be any field name", () => {
    const t = typeMember(parseInterface(`${H}type E (type, method, error, interface, int, Self, if, a_b)\n`), "E");
    assert.equal(formatType(t.type), "(type, method, error, interface, int, Self, if, a_b)");
  });

  test("keywords and uppercase names are valid field names", () => {
    const s = struct(
      parseInterface(
        `${H}type T (type: int, method: int, error: int, interface: int, bool: bool, any: any, Server: string, Self: ?int)\n`,
      ),
      "T",
    );
    assert.deepEqual(
      s.fields.map((f) => f.name),
      ["type", "method", "error", "interface", "bool", "any", "Server", "Self"],
    );
  });

  test("nesting up to MAX_TYPE_DEPTH", () => {
    const parens = `${H}type A ${"(a: ".repeat(64)}int${")".repeat(64)}\n`;
    assert.equal(parseInterface(parens).members.length, 1);
    const prefixes = `${H}type A (a: ${"[]".repeat(63)}int)\n`;
    assert.equal(parseInterface(prefixes).members.length, 1);
  });
});

describe("whitespace, comments and line breaks", () => {
  test("comments and line breaks between all tokens (except after prefixes)", () => {
    const text = `# license

# between
interface # c
  a.b # c
type # c
  T # c
  ( # c
  a # c
  : # c
  int # c
  , # c
  b: ?int # c
  ) # c
method # c
M # c
( # c
) # c
-> # c
( # c
  # c
) # c
error E (
  x
  :
  [string]int
  ,
  y : int
)
# at EOF`;
    const ast = parseInterface(text);
    assert.deepEqual(stripSpans(ast), {
      kind: "interface",
      name: "a.b",
      doc: "between",
      experimental: false,
      members: [
        {
          kind: "type",
          name: "T",
          experimental: false,
          type: {
            kind: "struct",
            fields: [
              { name: "a", experimental: false, type: { kind: "int" } },
              { name: "b", experimental: false, type: { kind: "nullable", element: { kind: "int" } } },
            ],
          },
        },
        {
          kind: "method",
          name: "M",
          experimental: false,
          input: { kind: "struct", fields: [] },
          output: { kind: "struct", fields: [] },
        },
        {
          kind: "error",
          name: "E",
          experimental: false,
          type: {
            kind: "struct",
            fields: [
              { name: "x", experimental: false, type: { kind: "map", element: { kind: "int" } } },
              { name: "y", experimental: false, type: { kind: "int" } },
            ],
          },
        },
      ],
    });
  });

  test("no whitespace needed around punctuation", () => {
    const ast = parseInterface(`${H}type T(a:int,b:?[]T)\nmethod M(a:int)->(b:T)\nerror E(x:int)\ntype N(x,y)\n`);
    assert.equal(ast.members.length, 4);
  });

  test("CRLF, lone CR, U+2028 and U+2029 line breaks", () => {
    for (const br of ["\r\n", "\r", "\u{2028}", "\u{2029}", "\n"]) {
      const text = `interface a.b${br}type T ()${br}${br}# doc${br}error E (x: int)${br}`;
      const ast = parseInterface(text);
      const e = member(ast, "E");
      assert.equal(lc(e.nameSpan?.start), "5:7", JSON.stringify(br));
      assert.equal(e.doc, "doc");
      assert.equal(e.nameSpan?.start.offset, text.indexOf("E ("));
      const err = parseError(`interface a.b${br}${br}type t ()`);
      assert.equal(lc(err.position), "3:6", JSON.stringify(br));
    }
  });

  test("mixed line breaks count once each", () => {
    const err = parseError("interface a.b\r\n\r\n\n\u{2028}type t ()");
    assert.equal(lc(err.position), "5:6");
    assert.equal(err.position?.offset, 24);
  });

  test("Unicode whitespace", () => {
    const ws = "\u{00A0}\u{FEFF}\u{1680}\u{180E}\u{2000}\u{2005}\u{200A}\u{202F}\u{205F}\u{3000}\t ";
    const text = `\u{FEFF}interface${ws}a.b${ws}\ntype${ws}T${ws}(${ws}a${ws}:${ws}int${ws},${ws}b: ?int${ws})${ws}\n`;
    const ast = parseInterface(text);
    assert.deepEqual(fieldTypes(struct(ast, "T")), { a: "int", b: "?int" });
    // Columns count UTF-16 code units.
    const err = parseError(`interface\u{3000}a.b\ntype\u{3000}\u{3000}t ()`);
    assert.equal(lc(err.position), "2:7");
  });

  test("columns count UTF-16 code units (astral characters in comments)", () => {
    const err = parseError(`interface a.b # \u{1F600}\u{1F600}\ntype T () # \u{1F600}\n  method m() -> ()`);
    assert.equal(lc(err.position), "3:10");
  });
});

describe("doc comments", () => {
  const text = `# License header

# Interface doc
#
#  indented
#no space
interface a.b

# detached by a blank line

# Type doc
type T (
  # field a
  a: int,
  b: int, # trailing comment, not doc
  # field c
  c: (
    # value x
    x,
    y # trailing
  ),
  d: int, e: int
)

#Method doc
method M(
  # param
  p: int
) -> (
  # result
  r: int
)

# Error doc${"  "}
error E (
  # error field
  f: string
)
`;
  const ast = parseInterface(text);

  test("interface doc: block directly above, one space stripped", () => {
    assert.equal(ast.doc, "Interface doc\n\n indented\nno space");
  });

  test("member docs; trailing whitespace kept", () => {
    assert.equal(member(ast, "T").doc, "Type doc");
    assert.equal(member(ast, "M").doc, "Method doc");
    assert.equal(member(ast, "E").doc, "Error doc  ");
  });

  test("field, parameter and enum value docs", () => {
    const fields = struct(ast, "T").fields;
    assert.deepEqual(
      fields.map((f) => f.doc),
      ["field a", undefined, "field c", undefined, undefined],
    );
    assert.equal(fields.filter((f) => "doc" in f).length, 2, "absent docs are absent keys");
    const c = fields[2]?.type;
    assert.equal(c?.kind, "enum");
    assert.deepEqual(
      c.values.map((v) => v.doc),
      ["value x", undefined],
    );
    const m = method(ast, "M");
    assert.equal(m.input.fields[0]?.doc, "param");
    assert.equal(m.output.fields[0]?.doc, "result");
    const e = member(ast, "E");
    assert.equal(e.kind === "error" ? e.type.fields[0]?.doc : undefined, "error field");
  });

  test("doc belongs only to the first item on the next line", () => {
    const s = struct(parseInterface(`${H}type T (\n  # d\n  a: int, b: int\n)\n`), "T");
    assert.deepEqual(
      s.fields.map((f) => f.doc),
      ["d", undefined],
    );
  });

  test("blank or whitespace-only line detaches", () => {
    for (const gap of ["\n", "  \n", "\t\u{3000}\n"]) {
      const iface = parseInterface(`# not doc\n${gap}interface a.b\n\n# x\n${gap}type T ()\n`);
      assert.equal(iface.doc, undefined);
      assert.equal(member(iface, "T").doc, undefined);
    }
  });

  test("only the last block counts", () => {
    const iface = parseInterface(`${H}# one\n\n# two\n# three\ntype T ()\n`);
    assert.equal(member(iface, "T").doc, "two\nthree");
  });

  test("a trailing comment is not doc, even directly above", () => {
    const iface = parseInterface(`${H}type T (a: int, # c\n b: int)\ntype U () # c\ntype V ()\n`);
    assert.equal(struct(iface, "T").fields[1]?.doc, undefined);
    assert.equal(member(iface, "V").doc, undefined);
  });

  test("comments between tokens of an item are dropped", () => {
    const iface = parseInterface(`${H}type T (\n  a:\n  # not doc\n  int\n)\n`);
    assert.deepEqual(stripSpans(struct(iface, "T").fields[0]), {
      name: "a",
      experimental: false,
      type: { kind: "int" },
    });
  });

  test("empty comment lines", () => {
    assert.equal(parseInterface("#\ninterface a.b\n").doc, "");
    assert.equal(parseInterface("# \ninterface a.b\n").doc, "");
    assert.equal(parseInterface("#\n#\ninterface a.b\n").doc, "\n");
  });

  test("doc lines may contain anything but line breaks", () => {
    assert.equal(parseInterface("# a\tb # c \u{000B}\u{1F600}\ninterface a.b\n").doc, "a\tb # c \u{000B}\u{1F600}");
  });
});

describe("systemd annotations", () => {
  const ast = parseInterface(`# [Experimental]
interface a.b

# [Supports 'more' flag]
method A() -> ()

# doc
# [Requires 'more' flag]
# [Supports 'more' flag]
# [Supports 'upgrade' flag]
# [Experimental]
# more doc
method B() -> ()

# [Requires 'upgrade' flag]
# [Supports 'upgrade' flag]
method C() -> ()

#[Experimental]
#  [Experimental]
method D(
  # [Experimental]
  p: int
) -> ()

# [Supports 'more' flag]
# [Experimental]
type T (
  # [Experimental]
  a: int,
  b: (
    # [Experimental]
    x,
    y
  )
)

# [Requires 'upgrade' flag]
error E ()
`);

  test("interface", () => {
    assert.equal(ast.experimental, true);
    assert.equal("doc" in ast, false);
  });

  test("more and upgrade on methods; requires beats supports; markers leave doc", () => {
    assert.deepEqual(stripSpans(method(ast, "A")), {
      kind: "method",
      name: "A",
      experimental: false,
      more: "supports",
      input: { kind: "struct", fields: [] },
      output: { kind: "struct", fields: [] },
    });
    const b = method(ast, "B");
    assert.equal(b.doc, "doc\nmore doc");
    assert.equal(b.more, "requires");
    assert.equal(b.upgrade, "supports");
    assert.equal(b.experimental, true);
    const c = method(ast, "C");
    assert.equal(c.upgrade, "requires");
    assert.equal("more" in c, false);
  });

  test("the marker must match exactly after stripping one space", () => {
    const d = method(ast, "D");
    assert.equal(d.experimental, true);
    assert.equal(d.doc, " [Experimental]");
    assert.equal(d.input.fields[0]?.experimental, true);
  });

  test("experimental on fields and enum values", () => {
    const [a, b] = struct(ast, "T").fields;
    assert.ok(a && b);
    assert.equal(a.experimental, true);
    assert.equal("doc" in a, false);
    assert.equal(b.experimental, false);
    assert.equal(b.type.kind === "enum" ? b.type.values[0]?.experimental : undefined, true);
  });

  test("more/upgrade markers are plain doc text on non-methods", () => {
    const t = typeMember(ast, "T");
    assert.equal(t.doc, "[Supports 'more' flag]");
    assert.equal(t.experimental, true);
    assert.equal("more" in t, false);
    assert.equal(member(ast, "E").doc, "[Requires 'upgrade' flag]");
  });
});

describe("options", () => {
  test("validate: false skips semantic checks", () => {
    const ast = parseInterface(`${H}type T (a: Missing)\ntype T ()\n`, { validate: false });
    assert.equal(ast.members.length, 2);
    assert.equal(parseError(`${H}type T (a: Missing)\n`).code, "unresolved-type");
  });
});
