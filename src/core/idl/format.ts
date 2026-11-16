// Canonical formatter in libvarlink's `varlink format` style (lib/interface.c, lib/type.c), which is also
// the style of the UAPI spec's examples; systemd's annotation comments are written in systemd's order.
// DESIGN.md §4.8 lists where libvarlink and systemd differ and which one is followed.

import {
  EXPERIMENTAL_MARKER,
  MAX_AST_NODES,
  MAX_TYPE_DEPTH,
  MORE_MARKERS,
  UPGRADE_MARKERS,
  type EnumType,
  type EnumValue,
  type Field,
  type Interface,
  type Member,
  type StructType,
  type Type,
} from "./ast.ts";
import { describeValue, IdlSyntaxError } from "./errors.ts";
import { validateInterface } from "./validate.ts";

const INDENT = "  ";
/** libvarlink's "no longer than half a line". */
const MAX_INLINE_LENGTH = 40;

/**
 * Formats an interface canonically. Only doc comments and annotations survive; the output ends with one "\n".
 *
 * The AST must be plain data that does not change during the call (it is read again after validation), and
 * the output size is not bounded beyond what the AST implies.
 *
 * @throws {IdlSyntaxError} the first problem {@link validateInterface} finds.
 */
export function formatInterface(iface: Interface): string {
  const [first] = validateInterface(iface);
  if (first) throw first;
  let out = commentLines(iface, "") + `interface ${iface.name}\n`;
  for (const member of iface.members) out += "\n" + formatMember(member) + "\n";
  return out;
}

/**
 * Formats a type on a single line without comments, e.g. `?[](a: int, b: string)`. Names are not checked.
 *
 * @throws {IdlSyntaxError} `invalid-ast` for an unknown kind, an empty enum, a cycle or a hugely shared
 * subtree; `too-deep` for nesting deeper than {@link MAX_TYPE_DEPTH}.
 */
export function formatType(type: Type): string {
  return inline(type, 1, { path: new Set(), seen: new WeakSet(), repeats: 0 });
}

/** Nodes on the current path, nodes visited and repeat visits of shared nodes, as in validateInterface(). */
interface InlineState {
  readonly path: Set<Type>;
  readonly seen: WeakSet<Type>;
  repeats: number;
}

function inline(type: Type, level: number, state: InlineState): string {
  if (typeof type !== "object" || (type as unknown) === null) {
    throw new IdlSyntaxError("invalid-ast", "type is not an object");
  }
  if (!state.seen.has(type)) state.seen.add(type);
  else if (++state.repeats > MAX_AST_NODES) throw new IdlSyntaxError("invalid-ast", "AST too large");
  if (state.path.has(type)) throw new IdlSyntaxError("invalid-ast", "cyclic AST");
  // Primitive and named leaves may sit one level below the deepest composite (as in the parser).
  const leaf =
    type.kind !== "struct" &&
    type.kind !== "enum" &&
    type.kind !== "array" &&
    type.kind !== "map" &&
    type.kind !== "nullable";
  if (level > MAX_TYPE_DEPTH + (leaf ? 1 : 0)) {
    throw new IdlSyntaxError("too-deep", `types nested deeper than ${String(MAX_TYPE_DEPTH)} levels`);
  }
  state.path.add(type);
  const out = inlineNode(type, level, state);
  state.path.delete(type);
  return out;
}

/** Hand-built ASTs: an items list must be a dense array of objects (a hole would print as an empty item). */
function checkItems(items: readonly unknown[]): void {
  if (!Array.isArray(items)) throw new IdlSyntaxError("invalid-ast", "fields/values is not an array");
  for (let i = 0; i < items.length; i++) {
    const item: unknown = items[i];
    if (!(i in items) || typeof item !== "object" || item === null) {
      throw new IdlSyntaxError("invalid-ast", "field or enum value is not an object");
    }
  }
}

function inlineNode(type: Type, level: number, state: InlineState): string {
  switch (type.kind) {
    case "bool":
    case "int":
    case "float":
    case "string":
    case "object":
    case "any":
      return type.kind;
    case "named":
      return type.name;
    case "array":
      return "[]" + inline(type.element, level + 1, state);
    case "map":
      return "[string]" + inline(type.element, level + 1, state);
    case "nullable":
      return "?" + inline(type.element, level + 1, state);
    case "struct":
      checkItems(type.fields);
      return "(" + type.fields.map((f) => `${f.name}: ${inline(f.type, level + 1, state)}`).join(", ") + ")";
    case "enum":
      checkItems(type.values);
      if (type.values.length === 0) throw new IdlSyntaxError("invalid-ast", "an enum needs at least one value");
      return "(" + type.values.map((v) => v.name).join(", ") + ")";
    default:
      throw new IdlSyntaxError("invalid-ast", `unknown type kind ${describeValue((type as { kind: unknown }).kind)}`);
  }
}

function comment(text: string, indent: string): string {
  return text === "" ? `${indent}#\n` : `${indent}# ${text}\n`;
}

/** Doc lines, then (methods) the more and upgrade markers, then the experimental marker. */
function commentLines(
  item: { doc?: string; experimental: boolean; more?: "supports" | "requires"; upgrade?: "supports" | "requires" },
  indent: string,
): string {
  let out = "";
  if (item.doc !== undefined) for (const line of item.doc.split("\n")) out += comment(line, indent);
  if (item.more) out += comment(MORE_MARKERS[item.more], indent);
  if (item.upgrade) out += comment(UPGRADE_MARKERS[item.upgrade], indent);
  if (item.experimental) out += comment(EXPERIMENTAL_MARKER, indent);
  return out;
}

function hasComments(item: Field | EnumValue): boolean {
  return item.doc !== undefined || item.experimental;
}

function formatMember(member: Member): string {
  const comments = commentLines(member, "");
  switch (member.kind) {
    case "type":
      return `${comments}type ${member.name} ${parens(member.type, 0)}`;
    case "method":
      return `${comments}method ${member.name}${parens(member.input, 0)} -> ${parens(member.output, 0)}`;
    case "error":
      return `${comments}error ${member.name} ${parens(member.type, 0)}`;
    default:
      // Unreachable after validation, unless the AST changed in between.
      throw new IdlSyntaxError(
        "invalid-ast",
        `unknown member kind ${describeValue((member as { kind: unknown }).kind)}`,
      );
  }
}

/** libvarlink is_multiline(). */
function isMultiline(type: StructType | EnumType): boolean {
  const items: readonly (Field | EnumValue)[] = type.kind === "struct" ? type.fields : type.values;
  if (items.length === 0) return false;
  if (type.kind === "struct" && type.fields.length > 2) return true;
  if (items.some(hasComments)) return true;
  if (type.kind === "struct" && type.fields.some((f) => f.type.kind === "struct" || f.type.kind === "enum"))
    return true;
  return formatType(type).length > MAX_INLINE_LENGTH;
}

/** A type inside a struct or enum laid out at `level`; prefixes keep the level of their element. */
function nested(type: Type, level: number): string {
  switch (type.kind) {
    case "array":
      return "[]" + nested(type.element, level);
    case "map":
      return "[string]" + nested(type.element, level);
    case "nullable":
      return "?" + nested(type.element, level);
    case "struct":
    case "enum":
      return parens(type, level);
    default:
      return formatType(type);
  }
}

/**
 * A struct or enum whose closing paren sits at indent `level`. Like libvarlink, field types are laid out
 * one level deeper even when this struct stays on one line, so a nested multiline struct keeps its comments.
 */
function parens(type: StructType | EnumType, level: number): string {
  const items: readonly (Field | EnumValue)[] = type.kind === "struct" ? type.fields : type.values;
  // Decided by the parent's kind, so an enum value with a stray `type` key still prints as an enum value.
  const item = (i: Field | EnumValue): string =>
    type.kind === "struct" ? `${i.name}: ${nested((i as Field).type, level + 1)}` : i.name;
  if (!isMultiline(type)) return "(" + items.map(item).join(", ") + ")";
  const indent = INDENT.repeat(level + 1);
  let out = "(";
  items.forEach((it, i) => {
    const prev = items[i - 1];
    if (prev) out += ",";
    out += "\n";
    if (prev && (hasComments(prev) || hasComments(it))) out += "\n";
    out += commentLines(it, indent) + indent + item(it);
  });
  return out + "\n" + INDENT.repeat(level) + ")";
}
