// Call and reply messages (DESIGN.md §4.4, §4.10): UAPI header validation on decode, minimal encoding (F17).
import { ProtocolError } from "../errors/local.ts";
import type { Codec } from "../types/codec.ts";

/** A decoded method call. Absent/null headers are normalized: `parameters` `{}`, flags `false`. */
export interface Call {
  method: string;
  parameters: Record<string, unknown>;
  oneway: boolean;
  more: boolean;
  upgrade: boolean;
  /** Vendor extension keys (containing `.`), as received. */
  ext: Record<string, unknown>;
}

/** A decoded reply. */
export interface Reply {
  parameters: Record<string, unknown>;
  continues: boolean;
  error?: string;
  ext: Record<string, unknown>;
}

/** A call to encode. */
export interface CallInit {
  method: string;
  parameters?: Record<string, unknown>;
  oneway?: boolean;
  more?: boolean;
  upgrade?: boolean;
  /** Vendor extension keys; each must contain `.`. Written after the headers. */
  ext?: Record<string, unknown>;
}

/** A reply to encode. */
export interface ReplyInit {
  parameters?: Record<string, unknown>;
  continues?: boolean;
  error?: string;
  ext?: Record<string, unknown>;
}

const CALL_HEADERS: ReadonlySet<string> = new Set(["method", "parameters", "oneway", "more", "upgrade"]);
const REPLY_HEADERS: ReadonlySet<string> = new Set(["parameters", "continues", "error"]);
const CALL_FLAGS = ["oneway", "more", "upgrade"] as const;

/** Whether `v` is a plain object: prototype `Object.prototype` or `null`. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** A peer-chosen key for an error message: cut to 64 code units, JSON-quoted. */
function quoteKey(key: string): string {
  return JSON.stringify(key.length > 64 ? `${key.slice(0, 64)}…` : key);
}

function defineData(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Header values by name and the vendor extensions, after checking for unknown keys. */
function splitHeaders(
  value: unknown,
  headers: ReadonlySet<string>,
  what: "call" | "reply",
): { h: Map<string, unknown>; ext: Record<string, unknown> } {
  if (!isPlainObject(value)) throw new ProtocolError(`${what} message must be a JSON object`);
  const h = new Map<string, unknown>();
  const ext: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (headers.has(key)) {
      // UAPI: every header is nullable; null ≡ absent.
      if (v !== null) h.set(key, v);
    } else if (key.includes(".")) {
      defineData(ext, key, v);
    } else {
      throw new ProtocolError(`unknown ${what} header ${quoteKey(key)}`);
    }
  }
  return { h, ext };
}

function flag(h: Map<string, unknown>, name: string, what: "call" | "reply"): boolean {
  const v = h.get(name);
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw new ProtocolError(`${what} header "${name}" must be a boolean`);
  return v;
}

function parametersOf(h: Map<string, unknown>, what: "call" | "reply"): Record<string, unknown> {
  const v = h.get("parameters");
  if (v === undefined) return {};
  if (!isPlainObject(v)) throw new ProtocolError(`${what} header "parameters" must be an object`);
  return v;
}

/**
 * Checks a decoded call message against the UAPI header rules (the method name's syntax is checked by dispatch).
 *
 * @param value The codec's output for one message.
 * @throws {ProtocolError} on any violation; the connection must be closed.
 */
export function decodeCall(value: unknown): Call {
  const { h, ext } = splitHeaders(value, CALL_HEADERS, "call");
  const method = h.get("method");
  if (typeof method !== "string") throw new ProtocolError('call header "method" must be a string');
  const oneway = flag(h, "oneway", "call");
  const more = flag(h, "more", "call");
  const upgrade = flag(h, "upgrade", "call");
  if (Number(oneway) + Number(more) + Number(upgrade) > 1)
    throw new ProtocolError('at most one of the call headers "oneway", "more", "upgrade" may be true');
  return { method, parameters: parametersOf(h, "call"), oneway, more, upgrade, ext };
}

/**
 * Checks a decoded reply message against the UAPI header rules (rules that need the call, such as `continues`
 * without `more`, are the session's).
 *
 * @throws {ProtocolError} on any violation; the connection must be closed.
 */
export function decodeReply(value: unknown): Reply {
  const { h, ext } = splitHeaders(value, REPLY_HEADERS, "reply");
  const continues = flag(h, "continues", "reply");
  const error = h.get("error");
  if (error !== undefined && typeof error !== "string")
    throw new ProtocolError('reply header "error" must be a string');
  if (continues && error !== undefined) throw new ProtocolError('a reply with "error" must not have "continues" set');
  const reply: Reply = { parameters: parametersOf(h, "reply"), continues, ext };
  if (error !== undefined) reply.error = error;
  return reply;
}

function checkParameters(parameters: unknown): Record<string, unknown> {
  if (parameters === undefined) return {};
  if (!isPlainObject(parameters)) throw new TypeError("parameters must be a plain object");
  return parameters;
}

function checkFlag(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

function appendExt(out: Record<string, unknown>, ext: unknown, headers: ReadonlySet<string>): void {
  if (ext === undefined) return;
  if (!isPlainObject(ext)) throw new TypeError("ext must be a plain object");
  for (const key of Object.keys(ext)) {
    if (!key.includes(".") || headers.has(key))
      throw new TypeError(`ext key ${quoteKey(key)} must contain "." (vendor extension)`);
    defineData(out, key, ext[key]);
  }
}

/**
 * Encodes a call: `method, parameters, oneway|more|upgrade, ext…`. `parameters` is always written; false flags
 * are omitted (F17).
 *
 * @throws {TypeError} on caller bugs (bad types, several flags, bad ext keys) and from the codec.
 */
export function encodeCall(call: CallInit, codec: Codec): string {
  if (typeof call.method !== "string") throw new TypeError("method must be a string");
  const out: Record<string, unknown> = { method: call.method, parameters: checkParameters(call.parameters) };
  let set = 0;
  for (const name of CALL_FLAGS) {
    if (checkFlag(call[name], name)) {
      out[name] = true;
      set++;
    }
  }
  if (set > 1) throw new TypeError("at most one of oneway, more, upgrade may be true");
  appendExt(out, call.ext, CALL_HEADERS);
  return codec.encode(out);
}

/**
 * Encodes a reply: `error?, parameters, continues?, ext…`. `parameters` is always written; `continues: false`
 * and an absent `error` are omitted (F17).
 *
 * @throws {TypeError} on caller bugs (bad types, `continues` with `error`, bad ext keys) and from the codec.
 */
export function encodeReply(reply: ReplyInit, codec: Codec): string {
  const continues = checkFlag(reply.continues, "continues");
  const out: Record<string, unknown> = {};
  if (reply.error !== undefined) {
    if (typeof reply.error !== "string") throw new TypeError("error must be a string");
    if (continues) throw new TypeError("an error reply cannot have continues");
    out.error = reply.error;
  }
  out.parameters = checkParameters(reply.parameters);
  if (continues) out.continues = true;
  appendExt(out, reply.ext, REPLY_HEADERS);
  return codec.encode(out);
}
