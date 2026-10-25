// Typed clients for generated interface descriptors (DESIGN.md §5.3, §4.13): one function per method over a
// Connection or a Pool, plus the runtime helpers generated code calls. Connection and Pool are imported as types
// only, so the generated built-ins (src/interfaces/, imported by connection.ts) do not form an import cycle.
import type { InterfaceDescriptor, MethodDescriptor, MethodInput, MethodOutput } from "../core/types/descriptors.ts";
import type { CallOptions, CollectOptions, Connection, StreamIterator, StreamOptions } from "./connection.ts";
import type { Pool } from "./pool.ts";

/** The `options` of a generated error class constructor (the standard `ErrorOptions`, under a name that a varlink type cannot shadow). */
export type VarlinkErrorOptions = ErrorOptions;

/** Parameters, optional iff the input struct has no required field, then the call options. */
type Args<In, O> = Record<string, never> extends In ? [parameters?: In, options?: O] : [parameters: In, options?: O];

/**
 * One method of a {@link TypedClient}: callable (single reply), plus `.stream()`, `.collect()` and `.oneway()`,
 * mirroring the untyped Connection API (§5.3). `.upgrade()` comes with M9.
 */
export type TypedMethod<M> = {
  (...args: Args<MethodInput<M>, CallOptions>): Promise<MethodOutput<M>>;
  /** A call with `more`: every reply, the final one included (see `Connection.stream`). */
  stream(...args: Args<MethodInput<M>, StreamOptions>): StreamIterator<MethodOutput<M>>;
  /** A call with `more`, collecting every reply (see `Connection.collect`). */
  collect(...args: Args<MethodInput<M>, CollectOptions>): Promise<MethodOutput<M>[]>;
  /** A oneway call; resolves when written. */
  oneway(...args: Args<MethodInput<M>, CallOptions>): Promise<void>;
};

/** A typed client: one {@link TypedMethod} per method of the descriptor, by short name. */
export type TypedClient<D extends InterfaceDescriptor> = {
  readonly [K in keyof D["methods"]]: TypedMethod<D["methods"][K]>;
};

type AnyMethod = MethodDescriptor<object, object>;

/** What a client needs from its target: the typed overloads Connection and Pool share. */
interface ClientTarget {
  addInterface(descriptor: InterfaceDescriptor): void;
  call(method: AnyMethod, parameters: object, options?: CallOptions): Promise<object>;
  stream(method: AnyMethod, parameters: object, options?: StreamOptions): StreamIterator<object>;
  collect(method: AnyMethod, parameters: object, options?: CollectOptions): Promise<object[]>;
  oneway(method: AnyMethod, parameters: object, options?: CallOptions): Promise<void>;
}

function isClientTarget(target: unknown): target is ClientTarget {
  if (typeof target !== "object" || target === null) return false;
  const t = target as Record<string, unknown>;
  return ["addInterface", "call", "stream", "collect", "oneway"].every((k) => typeof t[k] === "function");
}

/**
 * A typed client for a generated descriptor over a {@link Connection} or a {@link Pool} (what generated
 * `X.client(target)` calls). The descriptor is registered on the target first (`addInterface`: idempotent; a
 * different IDL under the name or an `ints` mismatch is a TypeError, on a Pool when an operation leases a
 * connection), so parameters are encoded with the IDL, replies are always decoded (the connection's
 * `validateReplies` `"off"` acts as `"warn"` for typed calls: valid replies match their types, an invalid one is
 * delivered raw and reported to `onError`; `"throw"` rejects it) and error replies of the interface map to the
 * generated classes. The result is a frozen null-prototype object with one frozen function per method.
 *
 * @throws {TypeError} if `target` is not a Connection or a Pool; {@link Connection.addInterface} errors.
 */
export function createClient<D extends InterfaceDescriptor>(descriptor: D, target: Connection | Pool): TypedClient<D> {
  if (!isClientTarget(target)) throw new TypeError("createClient: target must be a Connection or a Pool");
  target.addInterface(descriptor);
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, md] of Object.entries(descriptor.methods)) {
    const fn = (parameters?: object, options?: CallOptions): Promise<object> =>
      target.call(md, parameters ?? {}, options);
    Object.defineProperties(fn, {
      stream: {
        value: (parameters?: object, options?: StreamOptions) => target.stream(md, parameters ?? {}, options),
      },
      collect: {
        value: (parameters?: object, options?: CollectOptions) => target.collect(md, parameters ?? {}, options),
      },
      oneway: {
        value: (parameters?: object, options?: CallOptions) => target.oneway(md, parameters ?? {}, options),
      },
    });
    Object.defineProperty(out, key, { value: Object.freeze(fn), enumerable: true });
  }
  return Object.freeze(out) as TypedClient<D>;
}

/**
 * Freezes a generated descriptor in place: every method descriptor, `methods`, `errors` and the descriptor
 * itself (the error classes are not frozen). Used by generated code; returns its argument.
 */
export function freezeDescriptor<D extends InterfaceDescriptor>(descriptor: D): D {
  for (const md of Object.values(descriptor.methods)) Object.freeze(md);
  Object.freeze(descriptor.methods);
  Object.freeze(descriptor.errors);
  return Object.freeze(descriptor);
}
