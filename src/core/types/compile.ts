// Compiles an interface AST into value validators (DESIGN.md §4.3, §4.9). A validator checks a value against
// its IDL type and returns a new normalized copy, or throws ValidationError with the path of the first problem.
import type { Interface, MethodMember, Type, TypeMember } from "../idl/ast.ts";
import { formatType } from "../idl/format.ts";
import { parseInterface } from "../idl/parser.ts";
import { validateInterface } from "../idl/validate.ts";
import {
  IntegerRangeError,
  OperationNotSupportedError,
  ValidationError,
  type ValidationReason,
} from "../errors/local.ts";
import { jsonCodec, type Codec } from "./codec.ts";

/** How `int` values are represented in JS: `number` (safe integers only) or `bigint` (full 64-bit range). */
export type IntsMode = "number" | "bigint";

/** Options for {@link compileInterface}. */
export interface CompileOptions {
  /** Default `"number"`. */
  ints?: IntsMode;
  /** Decode also accepts decimal strings where an `int` is expected (UAPI allows it). Default false. */
  lenientInts?: boolean;
  /** The codec values come from; `ints: "bigint"` needs one with `losslessInts`. Default {@link jsonCodec}. */
  codec?: Codec;
}

/** Options for {@link Validator.decode}. */
export interface DecodeOptions {
  /** Undeclared struct fields: `reject` (default; servers) or `drop` (clients reading replies, UAPI). */
  unknownFields?: "reject" | "drop";
}

/** Validates and normalizes values of one IDL type. */
export interface Validator<T = unknown> {
  /** A value received from the peer (already decoded by the codec). */
  decode(value: unknown, options?: DecodeOptions): T;
  /** A value about to be sent. Unknown fields are always rejected. */
  encode(value: unknown): T;
}

/** A method's validators. */
export interface CompiledMethod {
  readonly name: string;
  /** Fully qualified, e.g. "org.example.ftl.Jump". */
  readonly method: string;
  readonly member: MethodMember;
  readonly input: Validator;
  readonly output: Validator;
}

/** Validators for every member of an interface, keyed by short member name. */
export interface CompiledInterface {
  readonly name: string;
  readonly ast: Interface;
  readonly ints: IntsMode;
  readonly methods: ReadonlyMap<string, CompiledMethod>;
  /** Error parameter validators. */
  readonly errors: ReadonlyMap<string, Validator>;
  readonly types: ReadonlyMap<string, Validator>;
}

/** Deepest struct/array/map nesting a validator accepts. */
export const MAX_VALUE_DEPTH: number = 1024;
/**
 * Longest array encode accepts: each element needs at least 2 bytes (a digit and a comma), so a longer array
 * cannot fit in a 16 MiB message.
 */
export const MAX_ENCODE_ARRAY_LENGTH: number = 8 * 1024 * 1024;

const INTS_MODES = new Set<unknown>(["number", "bigint"]);
const INT_MIN = -(2n ** 63n);
const INT_MAX = 2n ** 64n - 1n;
const LENIENT_INT = /^-?(0|[1-9][0-9]*)$/;
/** Longer decimal strings are out of range anyway; checked before BigInt() parses them. */
const MAX_INT_DIGITS = 21;

type Direction = "reject" | "drop" | "encode";

interface Context {
  readonly dir: Direction;
  /** Path to the value being checked; copied when an error is thrown. */
  readonly path: (string | number)[];
}

type Check = (value: unknown, ctx: Context, depth: number) => unknown;

function fail(ctx: Context, reason: ValidationReason, detail: string): never {
  if (reason === "int-range") throw new IntegerRangeError(ctx.path, detail);
  throw new ValidationError(ctx.path, reason, detail);
}

/** JS type of a value for error messages; never its content. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number")
    return Number.isFinite(value) ? (Number.isInteger(value) ? "integer" : "float") : String(value);
  if (typeof value === "object") return isPlainObject(value) ? "object" : "non-plain object";
  return typeof value;
}

/** An option value for error messages; never throws (bigint, symbol). */
function formatValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return typeof value === "symbol" ? value.toString() : String(value);
}

// JSON.isRawJSON is newer than lib es2024.
const isRawJSONFn: unknown = (JSON as { isRawJSON?: unknown }).isRawJSON;
const isRawJSON: (value: unknown) => boolean =
  typeof isRawJSONFn === "function" ? (isRawJSONFn as (value: unknown) => boolean) : () => false;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  // JSON.rawJSON() objects have a null prototype but are not JSON objects.
  return (proto === Object.prototype || proto === null) && !isRawJSON(value);
}

const hasOwnEnumerable = (o: object, key: string): boolean => Object.prototype.propertyIsEnumerable.call(o, key);

function wrongType(ctx: Context, type: Type, value: unknown): never {
  fail(ctx, value === null ? "null" : "type", `expected ${formatType(type)}, got ${describe(value)}`);
}

function enter(ctx: Context, depth: number): void {
  if (depth >= MAX_VALUE_DEPTH) fail(ctx, "too-deep", `value nested deeper than ${String(MAX_VALUE_DEPTH)} levels`);
}

class Compiler {
  private readonly named = new Map<string, Check>();
  private readonly cache = new Map<Type, Check>();
  private readonly typeMembers = new Map<string, TypeMember>();
  private readonly ints: IntsMode;
  private readonly lenientInts: boolean;

  constructor(iface: Interface, ints: IntsMode, lenientInts: boolean) {
    this.ints = ints;
    this.lenientInts = lenientInts;
    for (const m of iface.members) if (m.kind === "type") this.typeMembers.set(m.name, m);
  }

  /** The check for a `type` member, compiled on first use (so recursive types work). */
  namedCheck(name: string): Check {
    let check = this.named.get(name);
    if (check === undefined) {
      const member = this.typeMembers.get(name);
      // validateInterface() guarantees every reference resolves.
      if (member === undefined) throw new TypeError(`unresolved type ${name}`);
      check = this.compile(member.type);
      this.named.set(name, check);
    }
    return check;
  }

  compile(type: Type): Check {
    let check = this.cache.get(type);
    if (check === undefined) {
      check = this.build(type);
      this.cache.set(type, check);
    }
    return check;
  }

  private build(type: Type): Check {
    switch (type.kind) {
      case "bool":
        return (v, ctx) => (typeof v === "boolean" ? v : wrongType(ctx, type, v));
      case "string":
        return (v, ctx) => {
          if (typeof v !== "string") return wrongType(ctx, type, v);
          // UAPI messages are UTF-8, which cannot encode a lone surrogate (sd-json refuses them).
          if (!v.isWellFormed()) fail(ctx, "type", "string is not valid Unicode (lone surrogate)");
          return v;
        };
      case "int":
        return this.intCheck(type);
      case "float":
        return (v, ctx) => {
          if (typeof v === "number" && Number.isFinite(v)) return v;
          if (typeof v === "bigint") {
            const n = Number(v);
            // On encode, an exactly convertible bigint is sent as a number (works without JSON.rawJSON); an
            // inexact one is sent as given, exact on the wire.
            if (Number.isFinite(n)) return ctx.dir === "encode" && BigInt(n) !== v ? v : n;
          }
          return wrongType(ctx, type, v);
        };
      case "object":
        return (v, ctx) => (isPlainObject(v) ? v : wrongType(ctx, type, v));
      case "any":
        // Same whitelist in both directions. A top-level Infinity (1e400, or an integer literal too long for the
        // codec) could not be sent back. Only the top level is checked; nested content is not inspected.
        return (v, ctx) => {
          if (typeof v === "string") {
            if (!v.isWellFormed()) fail(ctx, "type", "string is not valid Unicode (lone surrogate)");
            return v;
          }
          if (
            typeof v === "boolean" ||
            typeof v === "bigint" ||
            (typeof v === "number" && Number.isFinite(v)) ||
            Array.isArray(v) ||
            isPlainObject(v)
          )
            return v;
          return wrongType(ctx, type, v);
        };
      case "enum": {
        const values = new Set(type.values.map((e) => e.name));
        return (v, ctx) => {
          if (typeof v !== "string") return wrongType(ctx, type, v);
          if (!values.has(v)) fail(ctx, "enum", `expected one of ${[...values].join(", ")}`);
          return v;
        };
      }
      case "named": {
        let target: Check | undefined;
        return (v, ctx, depth) => (target ??= this.namedCheck(type.name))(v, ctx, depth);
      }
      case "nullable": {
        const element = this.compile(type.element);
        return (v, ctx, depth) => (v === null || v === undefined ? null : element(v, ctx, depth));
      }
      case "array": {
        const element = this.compile(type.element);
        return (v, ctx, depth) => {
          if (!Array.isArray(v)) return wrongType(ctx, type, v);
          enter(ctx, depth);
          const length = v.length;
          // Checked before building the copy (a sparse array may be huge); decode is bounded by the message.
          if (length > MAX_ENCODE_ARRAY_LENGTH && ctx.dir === "encode") fail(ctx, "type", "array too long to send");
          const out: unknown[] = [];
          for (let i = 0; i < length; i++) {
            ctx.path.push(i);
            const item: unknown = v[i];
            out.push(element(item === undefined ? null : item, ctx, depth + 1));
            ctx.path.pop();
          }
          return out;
        };
      }
      case "map": {
        const element = this.compile(type.element);
        return (v, ctx, depth) => {
          if (!isPlainObject(v)) return wrongType(ctx, type, v);
          enter(ctx, depth);
          const entries: [string, unknown][] = [];
          for (const key of Object.keys(v)) {
            const item = v[key];
            if (item === undefined && ctx.dir === "encode") continue;
            ctx.path.push(key);
            // Like string values: a lone surrogate cannot be encoded as UTF-8.
            if (!key.isWellFormed()) fail(ctx, "type", "map key is not valid Unicode (lone surrogate)");
            // On decode (hand-made input: JSON has no undefined) undefined is null, as for array elements.
            entries.push([key, element(item === undefined ? null : item, ctx, depth + 1)]);
            ctx.path.pop();
          }
          // fromEntries creates own data properties: a "__proto__" key never touches the prototype.
          return Object.fromEntries(entries);
        };
      }
      case "struct": {
        const fields = type.fields.map((f) => ({
          name: f.name,
          nullable: f.type.kind === "nullable",
          check: this.compile(f.type.kind === "nullable" ? f.type.element : f.type),
          type: f.type,
        }));
        const declared = new Set(fields.map((f) => f.name));
        return (v, ctx, depth) => {
          if (!isPlainObject(v)) return wrongType(ctx, type, v);
          enter(ctx, depth);
          const out: Record<string, unknown> = {};
          for (const field of fields) {
            const value = hasOwnEnumerable(v, field.name) ? v[field.name] : undefined;
            ctx.path.push(field.name);
            if (value === null || value === undefined) {
              if (!field.nullable) {
                if (value === null) fail(ctx, "null", `expected ${formatType(field.type)}, got null`);
                fail(ctx, "missing", `required field is missing (${formatType(field.type)})`);
              }
            } else {
              out[field.name] = field.check(value, ctx, depth + 1);
            }
            ctx.path.pop();
          }
          if (ctx.dir !== "drop") {
            for (const key of Object.keys(v)) {
              if (declared.has(key) || (ctx.dir === "encode" && v[key] === undefined)) continue;
              // ValidationError makes the key safe to send back (well-formed, length-capped) in `parameter`.
              ctx.path.push(key);
              fail(ctx, "unknown-field", "unknown field");
            }
          }
          return out;
        };
      }
    }
  }

  private intCheck(type: Type): Check {
    const bigintMode = this.ints === "bigint";
    const lenient = this.lenientInts;
    return (v, ctx) => {
      let value = v;
      if (typeof value === "string" && lenient && ctx.dir !== "encode") {
        if (!LENIENT_INT.test(value)) return wrongType(ctx, type, value);
        if (value.length > MAX_INT_DIGITS) fail(ctx, "int-range", "integer out of the 64-bit range");
        value = BigInt(value);
      }
      if (typeof value === "number") {
        if (Number.isNaN(value)) return wrongType(ctx, type, value);
        // ±Infinity comes from 1e400 or an integer literal too long to decode (>309 digits, or longer than the
        // codec's bigint limit): out of range, on every runtime.
        if (!Number.isFinite(value)) fail(ctx, "int-range", "integer out of the range -2^63…2^64-1");
        if (!Number.isInteger(value)) return wrongType(ctx, type, value);
        if (!Number.isSafeInteger(value))
          fail(ctx, "int-range", "integer beyond ±(2^53-1) as a JS number (it may have been rounded)");
        const n = value === 0 ? 0 : value; // -0 → 0
        return bigintMode && ctx.dir !== "encode" ? BigInt(n) : n;
      }
      if (typeof value === "bigint") {
        if (value < INT_MIN || value > INT_MAX) fail(ctx, "int-range", "integer out of the range -2^63…2^64-1");
        if (bigintMode) return value;
        const n = Number(value);
        // An unsafe bigint is still sent as given: the codec writes it exactly (or throws without JSON.rawJSON).
        if (ctx.dir === "encode") return Number.isSafeInteger(n) ? n : value;
        if (!Number.isSafeInteger(n))
          fail(ctx, "int-range", 'integer beyond ±(2^53-1) (use ints: "bigint" for the full range)');
        return n;
      }
      return wrongType(ctx, type, value);
    };
  }
}

function validator(check: Check): Validator {
  return {
    decode(value: unknown, options?: DecodeOptions): unknown {
      const dir = options?.unknownFields === "drop" ? "drop" : "reject";
      return check(value, { dir, path: [] }, 0);
    },
    encode(value: unknown): unknown {
      return check(value, { dir: "encode", path: [] }, 0);
    },
  };
}

/**
 * Compiles validators for every method, error and type of `iface`.
 *
 * @throws {IdlSyntaxError} the first problem {@link validateInterface} finds.
 * @throws {OperationNotSupportedError} for `ints: "bigint"` with a codec that would round integers.
 */
export function compileInterface(iface: Interface, options?: CompileOptions): CompiledInterface {
  const [first] = validateInterface(iface);
  if (first) throw first;
  const ints = options?.ints ?? "number";
  // Untyped callers may pass anything.
  if (!INTS_MODES.has(ints)) throw new TypeError(`invalid ints mode: ${formatValue(ints)}`);
  if (ints === "bigint" && !(options?.codec ?? jsonCodec).losslessInts)
    throw new OperationNotSupportedError("bigint mode needs JSON.parse context.source and JSON.rawJSON");

  const compiler = new Compiler(iface, ints, options?.lenientInts === true);
  const methods = new Map<string, CompiledMethod>();
  const errors = new Map<string, Validator>();
  const types = new Map<string, Validator>();
  for (const member of iface.members) {
    switch (member.kind) {
      case "method":
        methods.set(member.name, {
          name: member.name,
          method: `${iface.name}.${member.name}`,
          member,
          input: validator(compiler.compile(member.input)),
          output: validator(compiler.compile(member.output)),
        });
        break;
      case "error":
        errors.set(member.name, validator(compiler.compile(member.type)));
        break;
      case "type":
        types.set(member.name, validator(compiler.namedCheck(member.name)));
        break;
    }
  }
  return { name: iface.name, ast: iface, ints, methods, errors, types };
}

/** {@link parseInterface} + {@link compileInterface}. */
export function compileInterfaceText(idl: string, options?: CompileOptions): CompiledInterface {
  return compileInterface(parseInterface(idl), options);
}
