// What codegen emits for an interface (DESIGN.md §5.3, §5.7): method descriptors with phantom input/output
// types, error classes and the verbatim IDL. compileDescriptor() checks a descriptor against its own IDL.
import type { MethodMember } from "../idl/ast.ts";
import { parseInterface } from "../idl/parser.ts";
import type { ErrorClass } from "../errors/varlink-error.ts";
import { compileInterface, type CompiledInterface, type CompileOptions, type IntsMode } from "./compile.ts";

export type { ErrorClass } from "../errors/varlink-error.ts";

/** A JSON value as validators and the codec produce it (`any` is a non-null JsonValue, §5.7). */
export type JsonValue = boolean | number | bigint | string | (JsonValue | null)[] | { [key: string]: JsonValue | null };

/** A method of a generated interface. `"~types"` is a phantom carrying the TS types; never set at runtime. */
export interface MethodDescriptor<
  In extends object = Record<string, unknown>,
  Out extends object = Record<string, unknown>,
> {
  readonly interface: string;
  /** Short name, e.g. "Jump". */
  readonly name: string;
  /** Fully qualified name, e.g. "org.example.ftl.Jump". */
  readonly method: string;
  readonly more?: "supports" | "requires";
  readonly upgrade?: "supports" | "requires";
  readonly experimental?: boolean;
  readonly "~types"?: { readonly input: In; readonly output: Out };
}

/** Input parameters type of a {@link MethodDescriptor}. */
export type MethodInput<M> = M extends MethodDescriptor<infer In, object> ? In : never;
/** Output parameters type of a {@link MethodDescriptor}. */
export type MethodOutput<M> = M extends MethodDescriptor<object, infer Out> ? Out : never;

/** A generated interface: its IDL, `ints` mode, methods and error classes keyed by short member name. */
export interface InterfaceDescriptor<
  M extends Record<string, MethodDescriptor<object, object>> = Record<string, MethodDescriptor<object, object>>,
  E extends Record<string, ErrorClass> = Record<string, ErrorClass>,
> {
  readonly name: string;
  /** The interface's source text, verbatim (served by GetInterfaceDescription, §5.4). */
  readonly idl: string;
  /** The `--ints` mode the types were generated for. */
  readonly ints: IntsMode;
  readonly methods: M;
  readonly errors: E;
}

function mismatch(desc: InterfaceDescriptor, what: string): never {
  throw new TypeError(`descriptor of ${desc.name}: ${what}`);
}

/**
 * Parses and compiles `desc.idl` with `desc.ints`, after checking that the descriptor matches it: interface
 * name, method names, `interface`/`method` strings and flags, and error class names.
 *
 * @throws {TypeError} on a mismatch.
 * @throws {IdlSyntaxError} if the IDL is invalid.
 */
export function compileDescriptor(
  desc: InterfaceDescriptor,
  options?: Omit<CompileOptions, "ints">,
): CompiledInterface {
  const iface = parseInterface(desc.idl);
  if (iface.name !== desc.name) mismatch(desc, `the IDL declares interface ${iface.name}`);
  const methods = new Map<string, MethodMember>();
  const errors = new Set<string>();
  for (const m of iface.members) {
    if (m.kind === "method") methods.set(m.name, m);
    else if (m.kind === "error") errors.add(m.name);
  }
  for (const [key, md] of Object.entries(desc.methods)) {
    const member = methods.get(md.name);
    if (key !== md.name || member === undefined) mismatch(desc, `no IDL method for methods.${key} (${md.name})`);
    if (md.interface !== desc.name) mismatch(desc, `${key}.interface is ${md.interface}`);
    if (md.method !== `${desc.name}.${md.name}`) mismatch(desc, `${key}.method is ${md.method}`);
    if (md.more !== member.more) mismatch(desc, `${key}.more differs from the IDL`);
    if (md.upgrade !== member.upgrade) mismatch(desc, `${key}.upgrade differs from the IDL`);
    if ((md.experimental ?? false) !== member.experimental) mismatch(desc, `${key}.experimental differs from the IDL`);
  }
  for (const [key, cls] of Object.entries(desc.errors)) {
    if (cls.errorName !== `${desc.name}.${key}` || !errors.has(key))
      mismatch(desc, `errors.${key} has errorName ${cls.errorName}, not an error of the IDL`);
  }
  return compileInterface(iface, { ...options, ints: desc.ints });
}

/**
 * Checks that a descriptor was generated for the `ints` mode of the client/server it is bound to (§5.7).
 *
 * @throws {TypeError} on a mismatch.
 */
export function assertIntsMode(desc: Pick<InterfaceDescriptor, "name" | "ints">, runtimeInts: IntsMode): void {
  if (desc.ints !== runtimeInts)
    throw new TypeError(`${desc.name} was generated for ints: "${desc.ints}", but the runtime uses "${runtimeInts}"`);
}
