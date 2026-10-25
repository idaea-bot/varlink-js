import type { Position } from "./ast.ts";

/**
 * Machine-readable cause of an {@link IdlSyntaxError}:
 *
 * - `unexpected-character`: a character that cannot start a token (or whitespace after a `?`/`[]`/`[string]` prefix).
 * - `unexpected-token`: a token the grammar does not allow here.
 * - `unexpected-eof`: the text ended in the middle of a declaration.
 * - `expected-line-break`: a member does not start on a new line.
 * - `invalid-interface-name`, `invalid-member-name`, `invalid-field-name`: a name breaks its grammar.
 * - `nested-nullable`: `??T`.
 * - `mixed-struct-enum`: `(a: int, b)`.
 * - `too-deep`: type nesting beyond {@link MAX_TYPE_DEPTH}.
 * - `duplicate-member`, `duplicate-field`: a name repeated within a namespace.
 * - `unresolved-type`: a named type with no member of that name.
 * - `not-a-type`: a named type referring to a method or error.
 * - `invalid-doc`: a doc string that cannot be written back as comments.
 * - `invalid-ast`: a hand-built AST the parser could never produce.
 */
export type IdlErrorCode =
  | "unexpected-character"
  | "unexpected-token"
  | "unexpected-eof"
  | "expected-line-break"
  | "invalid-interface-name"
  | "invalid-member-name"
  | "invalid-field-name"
  | "nested-nullable"
  | "mixed-struct-enum"
  | "too-deep"
  | "duplicate-member"
  | "duplicate-field"
  | "unresolved-type"
  | "not-a-type"
  | "invalid-doc"
  | "invalid-ast";

/** Short description of an arbitrary value for error messages (internal). */
export function describeValue(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : value === null ? "null" : typeof value;
}

/** A syntax or validation error in a varlink interface definition. */
export class IdlSyntaxError extends SyntaxError {
  override readonly name: string = "IdlSyntaxError";
  readonly code: IdlErrorCode;
  /** The message without the `line:column: ` prefix. */
  readonly reason: string;
  /** Where the problem is; always set for errors found in source text. */
  readonly position: Position | undefined;

  constructor(code: IdlErrorCode, reason: string, position?: Position) {
    super(position ? `${String(position.line)}:${String(position.column)}: ${reason}` : reason);
    this.code = code;
    this.reason = reason;
    this.position = position;
  }
}
