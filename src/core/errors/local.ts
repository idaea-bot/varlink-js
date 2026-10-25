// Local errors (DESIGN.md §6): raised by this library, never sent on the wire. `localName` is the
// systemd-equivalent error name, for CLI output and logs.

/**
 * Instance brand of {@link VarlinkLocalError}: set as a non-enumerable own property whose value is `true`, but
 * read like any property, so an object inheriting from a VarlinkLocalError also passes {@link isVarlinkLocalError}.
 */
export const VARLINK_LOCAL_ERROR_BRAND: unique symbol = Symbol.for("varlink-js.VarlinkLocalError");

/** Base class of the local errors. */
export class VarlinkLocalError extends Error {
  /** systemd-equivalent error name, e.g. "io.systemd.Disconnected". */
  readonly localName: string;

  constructor(localName: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.localName = localName;
    Object.defineProperty(this, VARLINK_LOCAL_ERROR_BRAND, { value: true });
  }
}

/**
 * Brand check: whether `e` is a {@link VarlinkLocalError} (from any copy of this module), optionally with the
 * given `localName`. Never throws.
 */
export function isVarlinkLocalError(e: unknown, localName?: string): e is VarlinkLocalError {
  if (typeof e !== "object" || e === null) return false;
  try {
    if ((e as Record<PropertyKey, unknown>)[VARLINK_LOCAL_ERROR_BRAND] !== true) return false;
    const name = (e as { localName?: unknown }).localName;
    return typeof name === "string" && (localName === undefined || name === localName);
  } catch {
    return false;
  }
}

/** The connection closed (or broke) while a call was pending. */
export class ConnectionClosedError extends VarlinkLocalError {
  constructor(message: string, options?: ErrorOptions) {
    super("io.systemd.Disconnected", message, options);
  }
}

/** A call did not complete within its timeout. */
export class CallTimeoutError extends VarlinkLocalError {
  constructor(message: string, options?: ErrorOptions) {
    super("io.systemd.TimedOut", message, options);
  }
}

/** The peer broke the protocol (invalid JSON, bad message header, …); the connection is closed. */
export class ProtocolError extends VarlinkLocalError {
  constructor(message: string, options?: ErrorOptions) {
    super("io.systemd.Protocol", message, options);
  }
}

/** A message exceeded `maxMessageSize`. */
export class MessageTooLargeError extends ProtocolError {}

/** A call was made while an `upgrade` call is pending on the connection. */
export class UpgradePendingError extends VarlinkLocalError {
  constructor(message: string, options?: ErrorOptions) {
    super("varlink-js.UpgradePending", message, options);
  }
}

/** The runtime or transport cannot do this (fds over TCP, `ints: "bigint"` without `context.source`, …). */
export class OperationNotSupportedError extends VarlinkLocalError {
  constructor(message: string, options?: ErrorOptions) {
    super("varlink-js.OperationNotSupported", message, options);
  }
}

/**
 * Why a value failed validation:
 *
 * - `missing`: a required struct field is absent.
 * - `null`: `null` where the type is not nullable.
 * - `type`: a value of the wrong JS type (or a non-integer for `int`, a non-finite number, …).
 * - `enum`: a string that is not one of the enum's values.
 * - `unknown-field`: a struct field the IDL does not declare.
 * - `int-range`: an integer outside the supported range, or an unsafe `number` (it may have been rounded).
 * - `too-deep`: values nested more than `MAX_VALUE_DEPTH` (1024) levels.
 */
export type ValidationReason = "missing" | "null" | "type" | "enum" | "unknown-field" | "int-range" | "too-deep";

/** Longest {@link ValidationError.parameter}, in UTF-16 code units, before the "…" marking a cut. */
const MAX_PARAMETER_LENGTH = 256;

/** `s` cut to {@link MAX_PARAMETER_LENGTH} code units on a code point boundary, with "…" appended if cut. */
function truncate(s: string): string {
  if (s.length <= MAX_PARAMETER_LENGTH) return s;
  let end = MAX_PARAMETER_LENGTH;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // do not split a surrogate pair (s is well-formed)
  return `${s.slice(0, end)}…`;
}

/** C0 controls, DEL, C1 controls, and the line/paragraph separators U+2028/U+2029. */
const isUnsafeInMessage = (c: number): boolean => c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029;

/** `s` in double quotes, JSON-style, with `"`, `\` and every unsafe character escaped (safe to log). */
function quote(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c) out += `\\${s[i] ?? ""}`;
    else if (isUnsafeInMessage(c)) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += s[i] ?? "";
  }
  return `${out}"`;
}

/**
 * A value does not match its IDL type. On a server this becomes `org.varlink.service.InvalidParameter` with
 * {@link parameter}; on a client the call is rejected with it. Reason `int-range` always uses the
 * {@link IntegerRangeError} subclass.
 */
export class ValidationError extends VarlinkLocalError {
  /** Path to the bad value: field names and map keys as strings, array indices as numbers. */
  readonly path: readonly (string | number)[];
  /**
   * {@link path} joined with "." ("" for the value itself). Ambiguous if a map key contains ".". Lone surrogates
   * are replaced with U+FFFD and the result is cut to {@link MAX_PARAMETER_LENGTH} code units plus "…", so a
   * peer-controlled path can always be sent back in `InvalidParameter`. The message quotes it JSON-style, with
   * control characters (C0, DEL, C1) and U+2028/U+2029 as `\uXXXX` escapes, so it is safe to log.
   */
  readonly parameter: string;
  readonly reason: ValidationReason;

  constructor(path: readonly (string | number)[], reason: ValidationReason, detail: string, options?: ErrorOptions) {
    const parameter = truncate(path.map((s) => (typeof s === "string" ? s.toWellFormed() : String(s))).join("."));
    super("org.varlink.service.InvalidParameter", `invalid parameter ${quote(parameter)}: ${detail}`, options);
    this.path = Object.freeze([...path]);
    this.parameter = parameter;
    this.reason = reason;
  }
}

/** The {@link ValidationError} for reason `int-range` (DESIGN.md §4.3). */
export class IntegerRangeError extends ValidationError {
  constructor(path: readonly (string | number)[], detail: string, options?: ErrorOptions) {
    super(path, "int-range", detail, options);
  }
}
