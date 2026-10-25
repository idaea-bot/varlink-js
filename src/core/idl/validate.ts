// Semantic checks on an AST, parsed or hand-built. Hand-built ASTs are treated as untrusted input
// (any shape, cycles, shared subtrees), so everything is checked through `unknown`, recursion stops at
// MAX_TYPE_DEPTH or at a node already on the path, and shared nodes are revisited at most MAX_AST_NODES times.

import {
  EXPERIMENTAL_MARKER,
  MAX_AST_NODES,
  MAX_TYPE_DEPTH,
  MORE_MARKERS,
  PRIMITIVE_KINDS,
  UPGRADE_MARKERS,
  type Interface,
  type Position,
} from "./ast.ts";
import { describeValue, IdlSyntaxError, type IdlErrorCode } from "./errors.ts";
import { isFieldName, isInterfaceName, isMemberName } from "./names.ts";

type Node = Record<string, unknown>;

function isNode(x: unknown): x is Node {
  return typeof x === "object" && x !== null;
}

function spanStart(node: Node, key: "span" | "nameSpan"): Position | undefined {
  const span = node[key];
  if (!isNode(span) || !isNode(span.start)) return undefined;
  const { offset, line, column } = span.start;
  if (typeof offset !== "number" || typeof line !== "number" || typeof column !== "number") return undefined;
  return { offset, line, column };
}

function namePosition(node: Node): Position | undefined {
  return spanStart(node, "nameSpan") ?? spanStart(node, "span");
}

const PRIMITIVES = new Set<unknown>(PRIMITIVE_KINDS);
const METHOD_MARKERS = new Set([
  EXPERIMENTAL_MARKER,
  MORE_MARKERS.supports,
  MORE_MARKERS.requires,
  UPGRADE_MARKERS.supports,
  UPGRADE_MARKERS.requires,
]);
const FLAG_VALUES = new Set<unknown>([undefined, "supports", "requires"]);
// "\r", U+2028 and U+2029 would end a comment line early.
const COMMENT_BREAKING = new RegExp(`[\r${String.fromCharCode(0x2028, 0x2029)}]`);

/**
 * Checks what the AST types cannot express: name grammars, unique names, resolvable type references,
 * no `??T`, non-empty enums, structs where the grammar needs them, nesting depth, no cycles, a bounded
 * size, and doc strings that survive a format/parse round trip. Never throws.
 *
 * @returns all problems, sorted by position where known (errors without a position come last); `[]` if valid.
 */
export function validateInterface(iface: Interface): IdlSyntaxError[] {
  const validator = new Validator();
  try {
    validator.interface(iface);
  } catch {
    // Only reachable with exotic input (throwing getters, proxies).
    validator.add("invalid-ast", "the AST could not be inspected", undefined);
  }
  const errors = validator.errors;
  const known = errors.filter((e) => e.position !== undefined);
  known.sort((a, b) => (a.position?.offset ?? 0) - (b.position?.offset ?? 0));
  return [...known, ...errors.filter((e) => e.position === undefined)];
}

class Validator {
  readonly errors: IdlSyntaxError[] = [];
  /** Member name → kind of its first declaration. */
  private readonly members = new Map<string, unknown>();
  /** Composite type nodes on the current recursion path. */
  private readonly path = new Set<Node>();
  /** Type nodes visited so far, and how often an already-visited (shared) node was visited again. */
  private readonly seen = new WeakSet<object>();
  private repeats = 0;

  add(code: IdlErrorCode, reason: string, position: Position | undefined): void {
    this.errors.push(new IdlSyntaxError(code, reason, position));
  }

  interface(iface: unknown): void {
    if (!isNode(iface) || iface.kind !== "interface") {
      this.add("invalid-ast", 'not an interface node (kind "interface")', undefined);
      return;
    }
    if (typeof iface.name !== "string") {
      this.add("invalid-ast", "interface name is not a string", namePosition(iface));
    } else if (!isInterfaceName(iface.name)) {
      this.add("invalid-interface-name", `invalid interface name "${iface.name}"`, namePosition(iface));
    }
    this.common(iface, false);
    if (!Array.isArray(iface.members)) {
      this.add("invalid-ast", "interface members is not an array", spanStart(iface, "span"));
      return;
    }
    const members = iface.members as unknown[];
    // Names first, so references can point forward.
    for (const member of members) {
      if (!isNode(member)) continue;
      const { name } = member;
      if (typeof name !== "string") continue;
      if (!isMemberName(name)) this.add("invalid-member-name", `invalid member name "${name}"`, namePosition(member));
      if (this.members.has(name)) {
        this.add("duplicate-member", `duplicate member name "${name}"`, namePosition(member));
      } else {
        this.members.set(name, member.kind);
      }
    }
    for (const member of members) this.member(member);
  }

  private member(member: unknown): void {
    if (!isNode(member)) {
      this.add("invalid-ast", "member is not an object", undefined);
      return;
    }
    const position = spanStart(member, "span");
    if (typeof member.name !== "string") this.add("invalid-ast", "member name is not a string", position);
    const method = member.kind === "method";
    this.common(member, method);
    switch (member.kind) {
      case "type":
        if (!isNode(member.type) || (member.type.kind !== "struct" && member.type.kind !== "enum")) {
          this.add("invalid-ast", "a type member must be a struct or an enum", position);
        } else {
          this.type(member.type, 1);
        }
        break;
      case "method":
        this.struct(member.input, "method input", position);
        this.struct(member.output, "method output", position);
        if (!FLAG_VALUES.has(member.more) || !FLAG_VALUES.has(member.upgrade)) {
          this.add("invalid-ast", 'more/upgrade must be "supports" or "requires"', position);
        }
        break;
      case "error":
        this.struct(member.type, "error payload", position);
        break;
      default:
        this.add("invalid-ast", `unknown member kind ${describeValue(member.kind)}`, position);
    }
  }

  private struct(type: unknown, what: string, position: Position | undefined): void {
    if (!isNode(type) || type.kind !== "struct") this.add("invalid-ast", `${what} must be a struct`, position);
    else this.type(type, 1);
  }

  /** `doc`, `experimental` and (methods only) `more`/`upgrade` of interfaces, members, fields and enum values. */
  private common(node: Node, method: boolean): void {
    const position = spanStart(node, "span") ?? namePosition(node);
    if (typeof node.experimental !== "boolean") this.add("invalid-ast", "experimental is not a boolean", position);
    if (!method && (node.more !== undefined || node.upgrade !== undefined)) {
      this.add("invalid-ast", "more/upgrade are only allowed on methods", position);
    }
    const { doc } = node;
    if (doc === undefined) return;
    if (typeof doc !== "string") {
      this.add("invalid-ast", "doc is not a string", position);
      return;
    }
    if (!doc.isWellFormed()) this.add("invalid-doc", "doc contains a lone surrogate", position);
    if (COMMENT_BREAKING.test(doc)) {
      this.add("invalid-doc", "doc contains a line break other than \\n", position);
    }
    for (const line of doc.split("\n")) {
      if (line === EXPERIMENTAL_MARKER || (method && METHOD_MARKERS.has(line))) {
        this.add("invalid-doc", `doc line "${line}" would be read back as an annotation`, position);
      }
    }
  }

  private type(type: unknown, level: number): void {
    if (this.repeats > MAX_AST_NODES) return;
    if (isNode(type)) {
      if (!this.seen.has(type)) this.seen.add(type);
      else if (++this.repeats > MAX_AST_NODES) {
        this.add("invalid-ast", "AST too large", undefined);
        return;
      }
    }
    if (!isNode(type)) {
      this.add("invalid-ast", "type is not an object", undefined);
      return;
    }
    const position = spanStart(type, "span");
    const { kind } = type;
    if (PRIMITIVES.has(kind)) return;
    if (kind === "named") {
      this.named(type, position);
      return;
    }
    if (kind !== "struct" && kind !== "enum" && kind !== "array" && kind !== "map" && kind !== "nullable") {
      this.add("invalid-ast", `unknown type kind ${describeValue(kind)}`, position);
      return;
    }
    if (this.path.has(type)) {
      this.add("invalid-ast", "cyclic AST", position);
      return;
    }
    if (level > MAX_TYPE_DEPTH) {
      this.add("too-deep", `types nested deeper than ${String(MAX_TYPE_DEPTH)} levels`, position);
      return;
    }
    this.path.add(type);
    if (kind === "struct") {
      this.items(type.fields, "fields", true, level, position);
    } else if (kind === "enum") {
      this.items(type.values, "values", false, level, position);
    } else {
      const { element } = type;
      if (kind === "nullable" && isNode(element) && element.kind === "nullable") {
        this.add("nested-nullable", "a nullable type cannot be nullable", spanStart(element, "span") ?? position);
      }
      this.type(element, level + 1);
    }
    this.path.delete(type);
  }

  private named(type: Node, position: Position | undefined): void {
    const { name } = type;
    if (typeof name !== "string") {
      this.add("invalid-ast", "type name is not a string", position);
    } else if (!isMemberName(name)) {
      this.add("invalid-member-name", `invalid type name "${name}"`, position);
    } else if (!this.members.has(name)) {
      this.add("unresolved-type", `unknown type "${name}"`, position);
    } else if (this.members.get(name) !== "type") {
      this.add("not-a-type", `"${name}" is not a type`, position);
    }
  }

  /** Struct fields (`typed`) or enum values. */
  private items(items: unknown, what: string, typed: boolean, level: number, position: Position | undefined): void {
    if (!Array.isArray(items)) {
      this.add("invalid-ast", `${what} is not an array`, position);
      return;
    }
    if (!typed && items.length === 0) this.add("invalid-ast", "an enum needs at least one value", position);
    const seen = new Set<string>();
    for (const item of items as unknown[]) {
      if (!isNode(item)) {
        this.add("invalid-ast", `${what} entry is not an object`, position);
        continue;
      }
      const { name } = item;
      const itemPosition = namePosition(item);
      if (typeof name !== "string") {
        this.add("invalid-ast", "field name is not a string", itemPosition);
      } else {
        if (!isFieldName(name)) this.add("invalid-field-name", `invalid field name "${name}"`, itemPosition);
        if (seen.has(name)) this.add("duplicate-field", `duplicate field name "${name}"`, itemPosition);
        seen.add(name);
      }
      this.common(item, false);
      if (typed) this.type(item.type, level + 1);
    }
  }
}
