// Tokenizer for the varlink IDL. Lexes lazily (one token per next() call) so errors come out in source
// order, and records per token the trivia that the parser needs: whitespace, line breaks, comments and
// the doc block directly above the token.

import type { Position, Span } from "./ast.ts";
import { IdlSyntaxError } from "./errors.ts";

export type TokenKind = "word" | "(" | ")" | "," | ":" | "?" | "->" | "[]" | "[string]" | "eof";

/** A `#` comment between two tokens. */
export interface Comment {
  /** The text after `#`. */
  text: string;
  span: Span;
  /** Only whitespace precedes the comment on its line. */
  fullLine: boolean;
}

export interface Token {
  kind: TokenKind;
  /** Source text of the token ("" for eof). */
  text: string;
  start: Position;
  end: Position;
  /** Whitespace, a line break or a comment separates the token from the previous one (or the file start). */
  spaceBefore: boolean;
  /** A line break (a comment always ends in one, unless at EOF) separates the token from the previous one. */
  lineBreakBefore: boolean;
  /** Comments between the previous token and this one. */
  comments: readonly Comment[];
  /**
   * Doc block: the full-line comments on the lines immediately above, if the token is the first on its line.
   * Each line has the `#` and one following space removed.
   */
  doc: readonly string[] | undefined;
}

const NO_COMMENTS: readonly Comment[] = [];

/** PEG `whitespace`: ECMA-262 5th ed. whitespace without \v and \f. */
export function isWhitespace(c: number): boolean {
  return (
    c === 0x20 ||
    c === 0x09 ||
    c === 0xa0 ||
    c === 0xfeff ||
    c === 0x1680 ||
    c === 0x180e ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

/** PEG `eol_r` start characters ("\r\n" is one break). */
export function isLineBreak(c: number): boolean {
  return c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
}

function isAlnum(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/** Strips the `#` and one following space: `#foo` → "foo", `#  foo` → " foo", `#` → "". */
function docLine(commentText: string): string {
  return commentText.startsWith(" ") ? commentText.slice(1) : commentText;
}

function describeChar(text: string, offset: number): string {
  const cp = text.codePointAt(offset) ?? 0;
  const hex = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  return cp > 0x20 && cp < 0x7f ? `"${String.fromCodePoint(cp)}"` : hex;
}

export class Lexer {
  readonly text: string;
  private pos = 0;
  private line = 1;
  private lineStart = 0;
  private sawToken = false;

  constructor(text: string) {
    this.text = text;
  }

  position(): Position {
    return { offset: this.pos, line: this.line, column: this.pos - this.lineStart + 1 };
  }

  /** The next token; returns eof tokens forever at the end. Throws `unexpected-character`. */
  next(): Token {
    const text = this.text;
    const len = text.length;
    let spaceBefore = false;
    let lineBreakBefore = false;
    let comments = NO_COMMENTS as Comment[];
    let block: string[] = [];
    let blockLastLine = -1;
    // Whether a token precedes the current position on the current line.
    let lineHasCode = this.sawToken;

    while (this.pos < len) {
      const c = text.charCodeAt(this.pos);
      if (isWhitespace(c)) {
        this.pos++;
        spaceBefore = true;
      } else if (isLineBreak(c)) {
        this.pos += c === 0x0d && text.charCodeAt(this.pos + 1) === 0x0a ? 2 : 1;
        this.line++;
        this.lineStart = this.pos;
        spaceBefore = true;
        lineBreakBefore = true;
        lineHasCode = false;
      } else if (c === 0x23 /* # */) {
        const start = this.position();
        let end = this.pos + 1;
        while (end < len && !isLineBreak(text.charCodeAt(end))) end++;
        const body = text.slice(this.pos + 1, end);
        this.pos = end;
        const comment: Comment = { text: body, span: { start, end: this.position() }, fullLine: !lineHasCode };
        if (comments === NO_COMMENTS) comments = [];
        comments.push(comment);
        if (comment.fullLine) {
          if (block.length > 0 && blockLastLine === start.line - 1) block.push(docLine(body));
          else block = [docLine(body)];
          blockLastLine = start.line;
        }
        spaceBefore = true;
      } else {
        break;
      }
    }

    const start = this.position();
    const doc = block.length > 0 && blockLastLine === start.line - 1 && !lineHasCode ? block : undefined;
    const kind = this.scan(start);
    this.sawToken = true;
    return {
      kind,
      text: text.slice(start.offset, this.pos),
      start,
      end: this.position(),
      spaceBefore,
      lineBreakBefore,
      comments,
      doc,
    };
  }

  /** Consumes one token starting at the current position and returns its kind. */
  private scan(start: Position): TokenKind {
    const text = this.text;
    if (this.pos >= text.length) return "eof";
    const c = text.charCodeAt(this.pos);
    switch (c) {
      case 0x28 /* ( */:
        this.pos++;
        return "(";
      case 0x29 /* ) */:
        this.pos++;
        return ")";
      case 0x2c /* , */:
        this.pos++;
        return ",";
      case 0x3a /* : */:
        this.pos++;
        return ":";
      case 0x3f /* ? */:
        this.pos++;
        return "?";
      case 0x2d /* - */:
        if (text.charCodeAt(this.pos + 1) === 0x3e /* > */) {
          this.pos += 2;
          return "->";
        }
        throw new IdlSyntaxError("unexpected-character", 'unexpected character "-" (expected "->")', start);
      case 0x5b /* [ */:
        if (text.startsWith("[]", this.pos)) {
          this.pos += 2;
          return "[]";
        }
        if (text.startsWith("[string]", this.pos)) {
          this.pos += 8;
          return "[string]";
        }
        throw new IdlSyntaxError(
          "unexpected-character",
          'unexpected character "[" (expected "[]" or "[string]", without spaces)',
          start,
        );
    }
    if (isAlnum(c)) {
      const len = text.length;
      let end = this.pos + 1;
      for (; end < len; end++) {
        const d = text.charCodeAt(end);
        if (isAlnum(d) || d === 0x5f /* _ */ || d === 0x2e /* . */) continue;
        // A "-" continues a word unless it starts "->".
        if (d === 0x2d && text.charCodeAt(end + 1) !== 0x3e) continue;
        break;
      }
      this.pos = end;
      return "word";
    }
    throw new IdlSyntaxError("unexpected-character", `unexpected character ${describeChar(text, this.pos)}`, start);
  }
}

/** Lexes the whole text (up to and including the eof token). */
export function tokenize(text: string): Token[] {
  const lexer = new Lexer(text);
  const tokens: Token[] = [];
  for (;;) {
    const token = lexer.next();
    tokens.push(token);
    if (token.kind === "eof") return tokens;
  }
}
