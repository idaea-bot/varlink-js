// Maps varlink error names to error classes, so a client can turn an error reply into the most specific
// class (DESIGN.md §6).
import { isInterfaceName, isMemberName } from "../idl/names.ts";
import {
  ExpectedMoreError,
  ExpectedUpgradeError,
  InterfaceNotFoundError,
  InternalError,
  InvalidParameterError,
  MethodNotFoundError,
  MethodNotImplementedError,
  PermissionDeniedError,
} from "./standard.ts";
import { VarlinkError, type ErrorClass } from "./varlink-error.ts";

function isErrorName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const dot = name.lastIndexOf(".");
  return dot > 0 && isInterfaceName(name.slice(0, dot)) && isMemberName(name.slice(dot + 1));
}

/** A value for error messages; never throws (bigint, symbol). */
function formatValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return typeof value === "symbol" ? value.toString() : String(value);
}

/** Error classes by fully qualified varlink error name. */
export class ErrorRegistry {
  readonly #classes = new Map<string, ErrorClass>();

  /**
   * Registers classes by their `errorName`. Registering the same class again is a no-op. Atomic: if any class
   * is rejected, none is registered.
   *
   * @throws {TypeError} if an `errorName` is not a fully qualified error name (`interface.Name`), or is already
   * registered (or passed earlier in the same call) for a different class.
   */
  register(...classes: ErrorClass[]): this {
    const added = new Map<string, ErrorClass>();
    for (const cls of classes) {
      const name = cls.errorName;
      if (!isErrorName(name)) throw new TypeError(`invalid varlink error name: ${formatValue(name)}`);
      const existing = this.#classes.get(name) ?? added.get(name);
      if (existing === cls) continue;
      if (existing !== undefined) throw new TypeError(`error ${name} is already registered to another class`);
      added.set(name, cls);
    }
    for (const [name, cls] of added) this.#classes.set(name, cls);
    return this;
  }

  get(name: string): ErrorClass | undefined {
    return this.#classes.get(name);
  }

  has(name: string): boolean {
    return this.#classes.has(name);
  }

  /**
   * An instance of the class registered for `error`, or a plain {@link VarlinkError} keeping the name and
   * parameters. Does not validate `parameters`: callers check them against the interface first (M4 uses the
   * compiled error validators).
   */
  create(error: string, parameters?: Record<string, unknown>, options?: ErrorOptions): VarlinkError {
    const cls = this.#classes.get(error);
    if (cls === undefined) return new VarlinkError(error, parameters ?? {}, options);
    return new cls((parameters ?? {}) as never, options);
  }
}

/** A registry holding the seven org.varlink.service errors and {@link InternalError}. */
export function createErrorRegistry(): ErrorRegistry {
  return new ErrorRegistry().register(
    InterfaceNotFoundError,
    MethodNotFoundError,
    MethodNotImplementedError,
    InvalidParameterError,
    PermissionDeniedError,
    ExpectedMoreError,
    ExpectedUpgradeError,
    InternalError,
  );
}
