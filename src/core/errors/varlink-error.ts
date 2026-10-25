// VarlinkError: an error reply on the wire (DESIGN.md §6). Recognised by a brand rather than instanceof, so
// it works across duplicated module copies.

/**
 * Instance brand of {@link VarlinkError}: set as a non-enumerable own property whose value is `true`, but read
 * like any property, so an object inheriting from a VarlinkError also passes {@link isVarlinkError}.
 */
export const VARLINK_ERROR_BRAND: unique symbol = Symbol.for("varlink-js.VarlinkError");

/** A varlink error reply: a fully qualified error name plus its parameters. */
export class VarlinkError<P extends Record<string, unknown> = Record<string, unknown>> extends Error {
  /** Fully qualified varlink error name, e.g. "org.varlink.service.MethodNotFound". */
  readonly error: string;
  readonly parameters: P;

  constructor(error: string, parameters?: P, options?: ErrorOptions) {
    super(error, options);
    this.name = new.target.name;
    this.error = error;
    this.parameters = parameters ?? ({} as P);
    Object.defineProperty(this, VARLINK_ERROR_BRAND, { value: true });
  }
}

/**
 * Brand check: whether `e` is a {@link VarlinkError} (from any copy of this module), optionally with the varlink
 * error name `error`. Never throws, even for proxies or throwing getters.
 */
export function isVarlinkError(e: unknown, error?: string): e is VarlinkError {
  if (typeof e !== "object" || e === null) return false;
  try {
    if ((e as Record<PropertyKey, unknown>)[VARLINK_ERROR_BRAND] !== true) return false;
    const name = (e as { error?: unknown }).error;
    return typeof name === "string" && (error === undefined || name === error);
  } catch {
    return false;
  }
}

/**
 * A class for one varlink error name (standard errors, {@link InternalError}, codegen output): a fixed
 * `errorName`, a `(parameters, options?)` constructor and a static `is()` guard.
 */
export interface ErrorClass {
  readonly errorName: string;
  new (parameters: never, options?: ErrorOptions): VarlinkError;
  is(e: unknown): boolean;
}
