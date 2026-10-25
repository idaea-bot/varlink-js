// Recursive-descent parser for the varlink IDL (UAPI.20 grammar; DESIGN.md §4.8 lists the decisions).
// Recursion only happens through nested types and is capped at MAX_TYPE_DEPTH, so no input can
// overflow the stack.

import {
  EXPERIMENTAL_MARKER,
  MAX_TYPE_DEPTH,
  MORE_MARKERS,
  PRIMITIVE_KINDS,
  UPGRADE_MARKERS,
  type EnumType,
  type EnumValue,
  type Field,
  type Interface,
  type Member,
  type Position,
  type PrimitiveType,
  type Span,
  type StructType,
  type Type,
} from "./ast.ts";
import { IdlSyntaxError, type IdlErrorCode } from "./errors.ts";
import { Lexer, type Token } from "./lexer.ts";
import { isFieldName, isInterfaceName, isMemberName } from "./names.ts";
import { validateInterface } from "./validate.ts";

/** Options for {@link parseInterface}. */
export interface ParseOptions {
  /** Run {@link validateInterface} and throw its first error (default true). */
  validate?: boolean;
}

/**
 * Parses a varlink interface definition. Comments that are not doc comments are dropped.
 *
 * @throws {IdlSyntaxError} on any syntax error, or (unless `validate: false`) the first validation error.
 * @throws {TypeError} if `text` is not a string (e.g. a Uint8Array: decode it first).
 */
export function parseInterface(text: string, options?: ParseOptions): Interface {
  if (typeof text !== "string") throw new TypeError("parseInterface: text must be a string");
  const iface = new Parser(text).parseInterface();
  if (options?.validate !== false) {
    const [first] = validateInterface(iface);
    if (first) throw first;
  }
  return iface;
}

interface DocInfo {
  doc?: string;
  experimental: boolean;
  more?: "supports" | "requires";
  upgrade?: "supports" | "requires";
}

/** Turns a doc block into doc text plus the systemd annotations (more/upgrade only on methods). */
function docInfo(lines: readonly string[] | undefined, method: boolean): DocInfo {
  const info: DocInfo = { experimental: false };
  if (!lines) return info;
  const kept: string[] = [];
  for (const line of lines) {
    if (line === EXPERIMENTAL_MARKER) info.experimental = true;
    else if (method && line === MORE_MARKERS.requires) info.more = "requires";
    else if (method && line === MORE_MARKERS.supports) info.more ??= "supports";
    else if (method && line === UPGRADE_MARKERS.requires) info.upgrade = "requires";
    else if (method && line === UPGRADE_MARKERS.supports) info.upgrade ??= "supports";
    else kept.push(line);
  }
  if (kept.length > 0) info.doc = kept.join("\n");
  return info;
}

const PRIMITIVES = new Set<string>(PRIMITIVE_KINDS);
const MEMBER_KEYWORDS = new Set(["type", "method", "error"]);

function describe(token: Token): string {
  return token.kind === "word" ? `"${token.text}"` : `"${token.kind}"`;
}

class Parser {
  private readonly lexer: Lexer;
  private tok: Token;
  /** End of the last consumed token. */
  private lastEnd: Position;

  constructor(text: string) {
    this.lexer = new Lexer(text);
    this.lastEnd = this.lexer.position();
    this.tok = this.lexer.next();
  }

  /** The kind of the lookahead token (a method, so TypeScript does not keep a narrowing across advance()). */
  private peek(): Token["kind"] {
    return this.tok.kind;
  }

  private advance(): Token {
    const token = this.tok;
    this.lastEnd = token.end;
    this.tok = this.lexer.next();
    return token;
  }

  private span(start: Position): Span {
    return { start, end: this.lastEnd };
  }

  private fail(code: IdlErrorCode, reason: string, position: Position = this.tok.start): never {
    throw new IdlSyntaxError(code, reason, position);
  }

  private unexpected(expected: string): never {
    if (this.peek() === "eof") this.fail("unexpected-eof", `expected ${expected}, found end of input`);
    this.fail("unexpected-token", `expected ${expected}, found ${describe(this.tok)}`);
  }

  private expect(kind: Token["kind"], expected: string): Token {
    if (this.peek() !== kind) this.unexpected(expected);
    return this.advance();
  }

  private word(expected: string): Token {
    return this.expect("word", expected);
  }

  parseInterface(): Interface {
    const keyword = this.tok;
    if (keyword.kind !== "word" || keyword.text !== "interface") this.unexpected('"interface"');
    this.advance();
    const nameTok = this.word("an interface name");
    if (!isInterfaceName(nameTok.text)) {
      this.fail("invalid-interface-name", `invalid interface name "${nameTok.text}"`, nameTok.start);
    }
    const members: Member[] = [];
    while (this.peek() !== "eof") {
      if (this.peek() !== "word" || !MEMBER_KEYWORDS.has(this.tok.text)) {
        this.unexpected('"type", "method", "error" or end of input');
      }
      if (!this.tok.lineBreakBefore)
        this.fail("expected-line-break", `expected a line break before "${this.tok.text}"`);
      members.push(this.parseMember());
    }
    return {
      kind: "interface",
      name: nameTok.text,
      ...docInfo(keyword.doc, false),
      members,
      span: this.span(keyword.start),
      nameSpan: { start: nameTok.start, end: nameTok.end },
    };
  }

  private parseMember(): Member {
    const keyword = this.advance();
    const nameTok = this.word("a member name");
    if (!isMemberName(nameTok.text)) {
      this.fail("invalid-member-name", `invalid member name "${nameTok.text}"`, nameTok.start);
    }
    const name = nameTok.text;
    const nameSpan = { start: nameTok.start, end: nameTok.end };
    switch (keyword.text) {
      case "type": {
        const type = this.parseParens(1, undefined);
        return { kind: "type", name, ...docInfo(keyword.doc, false), type, span: this.span(keyword.start), nameSpan };
      }
      case "method": {
        const input = this.parseStruct("method parameters");
        this.expect("->", '"->"');
        const output = this.parseStruct("method results");
        return {
          kind: "method",
          name,
          ...docInfo(keyword.doc, true),
          input,
          output,
          span: this.span(keyword.start),
          nameSpan,
        };
      }
      default: {
        const type = this.parseStruct("error parameters");
        return { kind: "error", name, ...docInfo(keyword.doc, false), type, span: this.span(keyword.start), nameSpan };
      }
    }
  }

  private parseStruct(what: string): StructType {
    return this.parseParens(1, what) as StructType;
  }

  /**
   * `( … )` at nesting `level`: the empty struct, a struct (first item `name :`) or an enum (bare `name`).
   * With `structOnly` set, an enum is an error (the string names the context).
   */
  private parseParens(level: number, structOnly: string | undefined): StructType | EnumType {
    if (level > MAX_TYPE_DEPTH) this.fail("too-deep", `types nested deeper than ${String(MAX_TYPE_DEPTH)} levels`);
    const open = this.expect("(", structOnly === undefined ? '"(" (a struct or enum)' : '"(" (a struct)');
    if (this.peek() === ")") {
      this.advance();
      return { kind: "struct", fields: [], span: this.span(open.start) };
    }
    let isStruct: boolean | undefined;
    const fields: Field[] = [];
    const values: EnumValue[] = [];
    for (;;) {
      const nameTok = this.word(isStruct === undefined ? 'a field name or ")"' : "a field name");
      if (!isFieldName(nameTok.text)) {
        this.fail("invalid-field-name", `invalid field name "${nameTok.text}"`, nameTok.start);
      }
      const hasType = this.peek() === ":";
      if (isStruct === undefined) {
        if (!hasType && structOnly !== undefined) this.unexpected(`":" (${structOnly} must be a struct)`);
        isStruct = hasType;
      } else if (hasType !== isStruct) {
        if (isStruct && this.peek() !== "," && this.peek() !== ")") this.unexpected('":"');
        this.fail(
          "mixed-struct-enum",
          isStruct
            ? `"${nameTok.text}" has no type, but this is a struct`
            : `"${nameTok.text}" has a type, but this is an enum`,
          nameTok.start,
        );
      }
      const info = docInfo(nameTok.doc, false);
      const nameSpan = { start: nameTok.start, end: nameTok.end };
      if (isStruct) {
        this.advance();
        const type = this.parseType(level + 1);
        fields.push({ name: nameTok.text, type, ...info, span: this.span(nameTok.start), nameSpan });
      } else {
        values.push({ name: nameTok.text, ...info, span: nameSpan, nameSpan: { ...nameSpan } });
      }
      if (this.peek() === ")") break;
      const comma = this.expect(",", '"," or ")"');
      if (this.peek() === ")") this.fail("unexpected-token", 'trailing "," is not allowed', comma.start);
    }
    this.advance();
    const span = this.span(open.start);
    return isStruct ? { kind: "struct", fields, span } : { kind: "enum", values, span };
  }

  /** A type whose composite node (if any) sits at nesting `level`. */
  private parseType(level: number): Type {
    const tok = this.tok;
    switch (tok.kind) {
      case "?": {
        this.prefix(level);
        if (this.peek() === "?") this.fail("nested-nullable", 'a nullable type cannot be nullable ("??")');
        const element = this.parseType(level + 1);
        return { kind: "nullable", element, span: this.span(tok.start) };
      }
      case "[]":
      case "[string]": {
        this.prefix(level);
        const element = this.parseType(level + 1);
        return { kind: tok.kind === "[]" ? "array" : "map", element, span: this.span(tok.start) };
      }
      case "(":
        return this.parseParens(level, undefined);
      case "word": {
        this.advance();
        const span = this.span(tok.start);
        if (PRIMITIVES.has(tok.text)) return { kind: tok.text as PrimitiveType["kind"], span };
        if (isMemberName(tok.text)) return { kind: "named", name: tok.text, span };
        if (/^[A-Z]/.test(tok.text)) this.fail("invalid-member-name", `invalid type name "${tok.text}"`, tok.start);
        return this.fail("unexpected-token", `expected a type, found "${tok.text}"`, tok.start);
      }
      default:
        return this.unexpected("a type");
    }
  }

  /** Consumes a `?`/`[]`/`[string]` prefix, which must be directly followed by its element. */
  private prefix(level: number): void {
    if (level > MAX_TYPE_DEPTH) this.fail("too-deep", `types nested deeper than ${String(MAX_TYPE_DEPTH)} levels`);
    const tok = this.advance();
    if (this.tok.spaceBefore) {
      this.fail("unexpected-character", `no whitespace or comment allowed after "${tok.kind}"`, tok.end);
    }
  }
}
