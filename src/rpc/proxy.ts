// Untyped introspection proxy (DESIGN.md §5.3, §4.11): fetches an interface from the peer, compiles it privately
// and exposes one function per method with runtime validation.
import type { Interface } from "../core/idl/ast.ts";
import type { ValidateReplies } from "../core/protocol/dispatch.ts";
import { compileInterface } from "../core/types/compile.ts";
import {
  connectionInternals,
  type CallOptions,
  type CallSpec,
  type CollectOptions,
  type Connection,
  type StreamIterator,
  type StreamOptions,
} from "./connection.ts";
import { checkMode } from "./util.ts";

/** Options for `conn.proxy()`. */
export interface ProxyOptions {
  /** Reply validation against the fetched interface; default `"throw"`. */
  validateReplies?: ValidateReplies;
}

/** One method of an {@link InterfaceProxy}: callable (single reply), plus the other call shapes. */
export interface ProxyMethod {
  (parameters?: Record<string, unknown>, options?: CallOptions): Promise<Record<string, unknown>>;
  stream(parameters?: Record<string, unknown>, options?: StreamOptions): StreamIterator;
  collect(parameters?: Record<string, unknown>, options?: CollectOptions): Promise<Record<string, unknown>[]>;
  oneway(parameters?: Record<string, unknown>, options?: CallOptions): Promise<void>;
}

/**
 * A frozen object with one {@link ProxyMethod} per method of the interface (by short name; varlink method names
 * start with an upper-case letter, so they never collide with `name`/`interface`). An unknown method is
 * `undefined`. Parameters are always encoded with the method's input type (ValidationError before anything is
 * written); replies are decoded per `validateReplies`; error parameters are checked against the interface's errors.
 */
export type InterfaceProxy = Readonly<Record<string, ProxyMethod | undefined>> & {
  /** The interface name. */
  readonly name: string;
  /** The parsed interface (AST). */
  readonly interface: Interface;
};

/** Builds the proxy for `name` on `conn`. */
export async function createProxy(conn: Connection, name: string, options?: ProxyOptions): Promise<InterfaceProxy> {
  const mode = checkMode(options?.validateReplies, "validateReplies", ["off", "warn", "throw"], "throw");
  const internals = connectionInternals(conn);
  const ast = await conn.getInterface(name);
  const compiled = compileInterface(ast, { ints: internals.ints, codec: internals.codec });
  const out: Record<string, unknown> = {};
  for (const m of compiled.methods.values()) {
    const spec: CallSpec = { input: m.input, output: m.output, mode, errors: compiled };
    const method = m.method;
    const fn = (parameters?: Record<string, unknown>, opts?: CallOptions): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        internals.start("single", method, parameters, opts, spec, {
          value: (v) => {
            resolve(v);
          },
          fail: reject,
        });
      });
    Object.defineProperties(fn, {
      stream: {
        value: (parameters?: Record<string, unknown>, opts?: StreamOptions) =>
          internals.stream(method, parameters, opts, spec),
      },
      collect: {
        value: (parameters?: Record<string, unknown>, opts?: CollectOptions) =>
          new Promise<Record<string, unknown>[]>((resolve, reject) => {
            const replies: Record<string, unknown>[] = [];
            internals.start("more", method, parameters, opts, spec, {
              value: (v, final) => {
                replies.push(v);
                if (final) resolve(replies);
              },
              fail: reject,
            });
          }),
      },
      oneway: {
        value: (parameters?: Record<string, unknown>, opts?: CallOptions) =>
          new Promise<void>((resolve, reject) => {
            internals.start("oneway", method, parameters, opts, spec, {
              value: () => {
                resolve();
              },
              fail: reject,
            });
          }),
      },
    });
    Object.defineProperty(out, m.name, { value: Object.freeze(fn), enumerable: true });
  }
  Object.defineProperty(out, "name", { value: compiled.name, enumerable: true });
  Object.defineProperty(out, "interface", { value: ast, enumerable: true });
  return Object.freeze(out) as InterfaceProxy;
}
