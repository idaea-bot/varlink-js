// Property-based tests (DESIGN.md §7.3): random valid ASTs round-trip through the formatter, inserted
// whitespace and comments do not change the AST, and mutated inputs only ever throw IdlSyntaxError.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import {
  formatInterface,
  IdlSyntaxError,
  parseInterface,
  validateInterface,
  type EnumType,
  type EnumValue,
  type Field,
  type Interface,
  type Member,
  type Position,
  type PrimitiveType,
  type StructType,
  type Type,
} from "../../../src/core/idl/index.ts";
import { tokenize } from "../../../src/core/idl/lexer.ts";
import { corpusFiles, stripSpans } from "./helpers.ts";

const SEED = 20261025;
const params = (numRuns: number): fc.Parameters<unknown> => ({ seed: SEED, numRuns });

// --- arbitrary valid ASTs ---------------------------------------------------------------------------

const MARKERS = new Set([
  "[Experimental]",
  "[Supports 'more' flag]",
  "[Requires 'more' flag]",
  "[Supports 'upgrade' flag]",
  "[Requires 'upgrade' flag]",
]);
const PRIMITIVES: PrimitiveType["kind"][] = ["bool", "int", "float", "string", "object", "any"];

const interfaceName = fc.stringMatching(
  /^[A-Za-z][A-Za-z0-9]{0,3}(-{1,2}[A-Za-z0-9]{1,3})?(\.[A-Za-z0-9]{1,4}(-[A-Za-z0-9]{1,2})?){1,3}$/,
);
const memberName = fc.stringMatching(/^[A-Z][A-Za-z0-9]{0,5}$/);
const fieldName = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,3}(_[A-Za-z0-9]{1,3}){0,2}$/);

const docChar = fc.oneof(
  fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 1 }),
  fc.constantFrom(" ", "\t", "#", "[", "]", "'", "\u{00E9}", "\u{00A0}", "\u{3000}", "\u{000B}", "\u{1F600}", "("),
);
const docLine = fc
  .string({ unit: docChar, maxLength: 12 })
  .filter((s) => !/[\n\r\u{2028}\u{2029}]/u.test(s) && !MARKERS.has(s));
const doc: fc.Arbitrary<string | undefined> = fc.option(
  fc.array(docLine, { minLength: 1, maxLength: 3 }).map((lines) => lines.join("\n")),
  { nil: undefined, freq: 3 },
);
const flag = fc.constantFrom<"supports" | "requires" | undefined>(undefined, undefined, "supports", "requires");

/** `{doc, experimental}` without an undefined `doc` key (the parser omits absent docs). */
function annotations(d: string | undefined, experimental: boolean): { doc?: string; experimental: boolean } {
  return d === undefined ? { experimental } : { doc: d, experimental };
}

const enumType: fc.Arbitrary<EnumType> = fc
  .uniqueArray(fc.tuple(fieldName, doc, fc.boolean()), { minLength: 1, maxLength: 4, selector: ([n]) => n })
  .map((values) => ({
    kind: "enum",
    values: values.map(([name, d, e]): EnumValue => ({ name, ...annotations(d, e) })),
  }));

function structType(refs: readonly string[], depth: number): fc.Arbitrary<StructType> {
  return fc
    .uniqueArray(fc.tuple(fieldName, typeArb(refs, depth), doc, fc.boolean()), {
      maxLength: 4,
      selector: ([n]) => n,
    })
    .map((fields) => ({
      kind: "struct",
      fields: fields.map(([name, type, d, e]): Field => ({ name, type, ...annotations(d, e) })),
    }));
}

function typeArb(refs: readonly string[], depth: number): fc.Arbitrary<Type> {
  const leaves: fc.Arbitrary<Type>[] = [fc.constantFrom(...PRIMITIVES).map((kind): Type => ({ kind }))];
  if (refs.length > 0) leaves.push(fc.constantFrom(...refs).map((name): Type => ({ kind: "named", name })));
  const leaf = fc.oneof(...leaves);
  if (depth <= 0) return leaf;
  const inner = typeArb(refs, depth - 1);
  return fc.oneof(
    { weight: 5, arbitrary: leaf },
    { weight: 1, arbitrary: structType(refs, depth - 1) },
    { weight: 1, arbitrary: enumType },
    { weight: 1, arbitrary: inner.map((element): Type => ({ kind: "array", element })) },
    { weight: 1, arbitrary: inner.map((element): Type => ({ kind: "map", element })) },
    {
      weight: 1,
      arbitrary: inner.filter((t) => t.kind !== "nullable").map((element): Type => ({ kind: "nullable", element })),
    },
  );
}

type Kind = Member["kind"];

function memberArb(kind: Kind, name: string, refs: readonly string[]): fc.Arbitrary<Member> {
  const common = fc.tuple(doc, fc.boolean());
  switch (kind) {
    case "type":
      return fc
        .tuple(common, fc.oneof(structType(refs, 2), enumType))
        .map(([[d, e], type]): Member => ({ kind, name, ...annotations(d, e), type }));
    case "error":
      return fc
        .tuple(common, structType(refs, 2))
        .map(([[d, e], type]): Member => ({ kind, name, ...annotations(d, e), type }));
    case "method":
      return fc
        .tuple(common, structType(refs, 2), structType(refs, 2), flag, flag)
        .map(([[d, e], input, output, more, upgrade]): Member => ({
          kind,
          name,
          ...annotations(d, e),
          input,
          output,
          ...(more ? { more } : {}),
          ...(upgrade ? { upgrade } : {}),
        }));
  }
}

const interfaceArb: fc.Arbitrary<Interface> = fc.uniqueArray(memberName, { maxLength: 6 }).chain((names) =>
  fc.tuple(...names.map(() => fc.constantFrom<Kind>("type", "type", "method", "error"))).chain((kinds) => {
    const refs = names.filter((_, i) => kinds[i] === "type");
    const members = names.map((name, i) => memberArb(kinds[i] ?? "type", name, refs));
    return fc
      .tuple(interfaceName, doc, fc.boolean(), fc.tuple(...members))
      .map(([name, d, e, ms]): Interface => ({ kind: "interface", name, ...annotations(d, e), members: ms }));
  }),
);

describe("random valid ASTs", () => {
  test("the generator covers the interesting shapes", () => {
    const samples = fc.sample(interfaceArb, { seed: SEED, numRuns: 300 });
    const text = samples.map((s) => formatInterface(s)).join("\n");
    for (const needle of [
      "# [Experimental]\ninterface",
      "# [Requires 'more' flag]",
      "# [Supports 'upgrade' flag]",
      "?[]",
      "[string]",
      "\n  #",
      "\n    #",
      "(\n",
      "\n\n  ",
      "#\n",
    ]) {
      assert.ok(text.includes(needle), needle);
    }
    assert.ok(samples.filter((s) => s.members.length >= 4).length > 50);
    assert.ok(text.length > 100_000, String(text.length));
  });

  test("validate cleanly and survive format → parse", () => {
    fc.assert(
      fc.property(interfaceArb, (ast) => {
        assert.deepEqual(validateInterface(ast), []);
        const text = formatInterface(ast);
        assert.deepEqual(stripSpans(parseInterface(text)), ast);
      }),
      params(400),
    );
  });
});

// --- whitespace and comment insertion -----------------------------------------------------------------

const WHITESPACE = [
  " ",
  "\t",
  "\u{00A0}",
  "\u{FEFF}",
  "\u{1680}",
  "\u{180E}",
  "\u{2000}",
  "\u{200A}",
  "\u{202F}",
  "\u{205F}",
  "\u{3000}",
];
const LINE_BREAKS = ["\n", "\r\n", "\r", "\u{2028}", "\u{2029}"];

const spaces = fc.array(fc.constantFrom(...WHITESPACE), { minLength: 1, maxLength: 4 }).map((a) => a.join(""));
const lineBreak = fc.constantFrom(...LINE_BREAKS);
const indentation = fc.array(fc.constantFrom(...WHITESPACE), { maxLength: 3 }).map((a) => a.join(""));
const junk = fc.string({ unit: docChar, maxLength: 8 }).filter((s) => !/[\n\r\u{2028}\u{2029}]/u.test(s));

/** Text to insert right after a token: (a) whitespace, (b) a line break, (c) a trailing comment, (d) a detached comment. */
const insertion = fc.oneof(
  spaces,
  fc.tuple(lineBreak, indentation).map(([br, ind]) => br + ind),
  fc.tuple(spaces, junk, lineBreak).map(([sp, j, br]) => `${sp}#${j}${br}`),
  fc
    .tuple(lineBreak, indentation, junk, lineBreak, lineBreak)
    .map(([b1, ind, j, b2, b3]) => `${b1}${ind}#${j}${b2}${b3}`),
);

const PREFIXES = new Set(["?", "[]", "[string]"]);

describe("whitespace and comment insertion", () => {
  test("does not change the AST", () => {
    fc.assert(
      fc.property(
        interfaceArb,
        fc.array(fc.tuple(fc.nat(), insertion), { minLength: 1, maxLength: 12 }),
        (ast, inserts) => {
          const text = formatInterface(ast);
          // Insert directly after a token: never inside one, never after a prefix, and (because doc blocks sit
          // between the previous token's line and their item) never between a doc block and its item.
          const anchors = tokenize(text)
            .filter((t) => t.kind !== "eof" && !PREFIXES.has(t.kind))
            .map((t) => t.end.offset);
          // At most one insertion per anchor (the first): concatenating two could put a trailing comment
          // after a line break, where it becomes a full-line comment and so a doc (see the test below).
          const byOffset = new Map<number, string>();
          for (const [n, s] of inserts) {
            const offset = anchors[n % anchors.length];
            if (offset !== undefined && !byOffset.has(offset)) byOffset.set(offset, s);
          }
          let mutated = "";
          let last = 0;
          for (const offset of [...byOffset.keys()].sort((a, b) => a - b)) {
            mutated += text.slice(last, offset) + (byOffset.get(offset) ?? "");
            last = offset;
          }
          mutated += text.slice(last);
          assert.deepEqual(stripSpans(parseInterface(mutated)), ast, mutated);
        },
      ),
      params(400),
    );
  });

  test("a trailing comment after a line break becomes a doc (why insertions are not concatenated)", () => {
    const text = "interface a.b\ntype T (a: int, b: int)\n";
    const comma = text.indexOf(",") + 1;
    const insert = (s: string): string => text.slice(0, comma) + s + text.slice(comma);
    const fieldB = (source: string): unknown => {
      const t = parseInterface(source).members[0];
      return t?.kind === "type" && t.type.kind === "struct" ? stripSpans(t.type.fields[1]) : undefined;
    };
    assert.deepEqual(fieldB(insert(" #k\n")), { name: "b", type: { kind: "int" }, experimental: false });
    assert.deepEqual(fieldB(insert("\n" + " #k\n")), {
      name: "b",
      type: { kind: "int" },
      doc: "k",
      experimental: false,
    });
  });
});

// --- mutation fuzz ------------------------------------------------------------------------------------

/** Where `offset` is, by the documented line-break rules (independent of the lexer). */
function positionAt(text: string, offset: number): Position {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    const c = text[i];
    if (c === "\r" && text[i + 1] === "\n") continue;
    if (c === "\n" || c === "\r" || c === "\u{2028}" || c === "\u{2029}") {
      line++;
      lineStart = i + 1;
    }
  }
  return { offset, line, column: offset - lineStart + 1 };
}

function checkParse(text: string): void {
  try {
    parseInterface(text);
  } catch (e) {
    if (!(e instanceof IdlSyntaxError)) throw e;
    const { position } = e;
    assert.ok(position, `no position: ${e.message}`);
    assert.ok(position.offset >= 0 && position.offset <= text.length, e.message);
    assert.deepEqual(position, positionAt(text, position.offset), e.message);
  }
}

const POOL = [
  ..."()[]?:,#->_.\n\r \tazAZ09".split(""),
  "\u{2028}",
  "\u{000B}",
  "\u{00E4}",
  "\u{1F600}",
  "\u{3000}",
  "[string]",
  "interface",
  "type",
];

type Mutation = [op: "delete" | "duplicate" | "insert" | "swap" | "truncate", a: number, b: number, ch: string];

const mutation: fc.Arbitrary<Mutation> = fc.tuple(
  fc.constantFrom("delete", "duplicate", "insert", "insert", "swap", "truncate"),
  fc.nat(),
  fc.nat({ max: 40 }),
  fc.constantFrom(...POOL),
);

function mutate(text: string, mutations: readonly Mutation[]): string {
  let s = text;
  for (const [op, a, b, ch] of mutations) {
    const i = s.length === 0 ? 0 : a % (s.length + 1);
    switch (op) {
      case "delete":
        s = s.slice(0, i) + s.slice(i + b + 1);
        break;
      case "duplicate":
        s = s.slice(0, i + b) + s.slice(i, i + b) + s.slice(i + b);
        break;
      case "insert":
        s = s.slice(0, i) + ch + s.slice(i);
        break;
      case "swap": {
        const j = Math.min(s.length - 1, i + b + 1);
        if (i < j) s = s.slice(0, i) + (s[j] ?? "") + s.slice(i + 1, j) + (s[i] ?? "") + s.slice(j + 1);
        break;
      }
      case "truncate":
        s = s.slice(0, i);
        break;
    }
  }
  return s;
}

describe("mutation fuzz", () => {
  const corpus = corpusFiles().map((f) => f.text);

  test("mutated corpus files only throw IdlSyntaxError with a correct position", () => {
    fc.assert(
      fc.property(fc.constantFrom(...corpus), fc.array(mutation, { minLength: 1, maxLength: 4 }), (text, ms) => {
        checkParse(mutate(text, ms));
      }),
      params(3000),
    );
  });

  test("mutated formatter output only throws IdlSyntaxError with a correct position", () => {
    fc.assert(
      fc.property(interfaceArb, fc.array(mutation, { minLength: 1, maxLength: 4 }), (ast, ms) => {
        checkParse(mutate(formatInterface(ast), ms));
      }),
      params(1500),
    );
  });

  test("deep nesting fails fast with too-deep", () => {
    const inputs = [
      `interface a.b\ntype A (${"a: (".repeat(10_000)}`,
      `interface a.b\ntype A (${"a: (".repeat(10_000)}int${")".repeat(10_000)}\n`,
      `interface a.b\ntype A (a: ${"[]".repeat(100_000)}int)\n`,
      `interface a.b\ntype A (a: ${"?[string]".repeat(100_000)}int)\n`,
      `interface a.b\nmethod M(a: ${"(b: ".repeat(10_000)}`,
    ];
    for (const text of inputs) {
      assert.throws(
        () => parseInterface(text),
        (e: unknown) => e instanceof IdlSyntaxError && e.code === "too-deep",
      );
    }
    assert.throws(() => parseInterface(`interface a.b\ntype A (a: ${"?".repeat(100_000)}int)\n`), IdlSyntaxError);
    assert.throws(() => parseInterface(`interface a.b\ntype A ${"(".repeat(100_000)}`), IdlSyntaxError);
  });

  test("large inputs are linear", () => {
    const fields = Array.from({ length: 80_000 }, (_, i) => `  field_${String(i)}: ?[]int`).join(",\n");
    const big = `interface a.b\n\ntype A (\n${fields}\n)\n`;
    assert.ok(big.length > 1_000_000);
    const started = performance.now();
    const ast = parseInterface(big);
    assert.ok(formatInterface(ast) === big, "a canonical 1 MB file must format to itself");
    const words = [
      `interface a${"-".repeat(1_000_000)}`,
      `interface a.${"a-".repeat(500_000)}-\n`,
      `interface a.b\ntype A (${"a_".repeat(500_000)}_: int)\n`,
      `interface a.b\ntype A${"0".repeat(1_000_000)}_ ()\n`,
      `interface a.b\n#${"x".repeat(1_000_000)}\ntype A ()\n`,
      `interface a.b\n${" ".repeat(1_000_000)}type A ()\n`,
      `interface a.b\ntype A (${"x, ".repeat(300_000)}x)\n`,
    ];
    for (const text of words) checkParse(text);
    assert.ok(performance.now() - started < 10_000, "large inputs took too long");
  });
});
