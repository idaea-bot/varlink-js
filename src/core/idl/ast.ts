// AST of a varlink interface definition (UAPI.20 "Interface Definition"). Built by parseInterface(),
// checked by validateInterface(), printed by formatInterface(). Spans are optional so ASTs can be built by hand.

/** A point in the source text. */
export interface Position {
  /** UTF-16 index into the source. */
  offset: number;
  /** 1-based line; "\n", "\r\n", "\r", U+2028 and U+2029 each end a line. */
  line: number;
  /** 1-based column, in UTF-16 code units. */
  column: number;
}

/** A source range; `end` is exclusive. */
export interface Span {
  start: Position;
  end: Position;
}

/** A parsed `.varlink` file. */
export interface Interface {
  kind: "interface";
  /** Reverse-domain name, e.g. `org.example.ftl`. */
  name: string;
  /** Doc comment: lines joined with "\n" ("" = one empty comment line); absent when there is none. */
  doc?: string;
  /** systemd's `# [Experimental]` marker. */
  experimental: boolean;
  /** Members in source order. */
  members: Member[];
  span?: Span;
  nameSpan?: Span;
}

/** A `type`, `method` or `error` declaration. Members share one namespace. */
export type Member = TypeMember | MethodMember | ErrorMember;

/** `type Name (…)`: a named struct or enum. */
export interface TypeMember {
  kind: "type";
  name: string;
  doc?: string;
  experimental: boolean;
  type: StructType | EnumType;
  span?: Span;
  nameSpan?: Span;
}

/** `method Name(…) -> (…)`. `more`/`upgrade` come from systemd's `# [Supports|Requires '…' flag]` markers. */
export interface MethodMember {
  kind: "method";
  name: string;
  doc?: string;
  experimental: boolean;
  input: StructType;
  output: StructType;
  more?: "supports" | "requires";
  upgrade?: "supports" | "requires";
  span?: Span;
  nameSpan?: Span;
}

/** `error Name (…)`. */
export interface ErrorMember {
  kind: "error";
  name: string;
  doc?: string;
  experimental: boolean;
  type: StructType;
  span?: Span;
  nameSpan?: Span;
}

/** Any type expression. */
export type Type = PrimitiveType | NamedType | StructType | EnumType | ArrayType | MapType | NullableType;

/** `bool`, `int`, `float`, `string`, `object` (foreign JSON object) or `any`. */
export interface PrimitiveType {
  kind: "bool" | "int" | "float" | "string" | "object" | "any";
  span?: Span;
}

/** A reference to a `type` member of the same interface. */
export interface NamedType {
  kind: "named";
  name: string;
  span?: Span;
}

/** `(name: type, …)`; `()` is the empty struct. */
export interface StructType {
  kind: "struct";
  fields: Field[];
  span?: Span;
}

/** `(one, two, …)`, at least one value. */
export interface EnumType {
  kind: "enum";
  values: EnumValue[];
  span?: Span;
}

/** `[]T` */
export interface ArrayType {
  kind: "array";
  element: Type;
  span?: Span;
}

/** `[string]T` */
export interface MapType {
  kind: "map";
  element: Type;
  span?: Span;
}

/** `?T`; the element is never itself nullable. */
export interface NullableType {
  kind: "nullable";
  element: Type;
  span?: Span;
}

/** A struct field (or method parameter). */
export interface Field {
  name: string;
  type: Type;
  doc?: string;
  experimental: boolean;
  span?: Span;
  nameSpan?: Span;
}

/** An enum value. */
export interface EnumValue {
  name: string;
  doc?: string;
  experimental: boolean;
  span?: Span;
  /** Same range as `span` (a value is just its name); present for symmetry with {@link Field}. */
  nameSpan?: Span;
}

/** The primitive type keywords. */
export const PRIMITIVE_KINDS: readonly PrimitiveType["kind"][] = ["bool", "int", "float", "string", "object", "any"];

/** Maximum nesting of parenthesised types and `?`/`[]`/`[string]` prefixes (a member's own struct is level 1). */
export const MAX_TYPE_DEPTH: number = 64;

/**
 * Most repeat visits of an already-visited type node that validateInterface() and formatType() allow, so
 * hand-built ASTs with heavily shared subtrees cannot make them exponential. Parsed ASTs never share nodes,
 * so they never count against it, whatever their size. Not re-exported by index.ts.
 */
export const MAX_AST_NODES: number = 1_000_000;

/** systemd annotation comment lines (sd-varlink-idl.c), part of systemd's API. */
export const EXPERIMENTAL_MARKER = "[Experimental]";
export const MORE_MARKERS: { readonly supports: string; readonly requires: string } = {
  supports: "[Supports 'more' flag]",
  requires: "[Requires 'more' flag]",
};
export const UPGRADE_MARKERS: { readonly supports: string; readonly requires: string } = {
  supports: "[Supports 'upgrade' flag]",
  requires: "[Requires 'upgrade' flag]",
};
