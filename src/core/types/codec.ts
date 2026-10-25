// JSON codec with lossless integers (DESIGN.md §4.3): unsafe integer literals decode to bigint, bigint encodes
// exactly, non-finite numbers are refused, nesting is limited. The only place in core that parses or
// serializes messages.
import { OperationNotSupportedError, ProtocolError } from "../errors/local.ts";

/** Converts between message text and JS values. */
export interface Codec {
  /**
   * @throws {ProtocolError} on invalid JSON or nesting deeper than the codec allows.
   * @throws {TypeError} if `text` is not a string.
   */
  decode(text: string): unknown;
  /** @throws {TypeError} on NaN/±Infinity, a bigint it cannot write exactly, cycles, nesting deeper than MAX_JSON_DEPTH, or a non-JSON top level. */
  encode(value: unknown): string;
  /** True when decode never rounds integers and encode can write bigint. Required by `ints: "bigint"`. */
  readonly losslessInts: boolean;
}

/** Options for {@link createJsonCodec}. */
export interface JsonCodecOptions {
  /**
   * Use the reviver's `context.source` to decode unsafe integers as exact bigints. Default: when the runtime
   * supports it. `false` forces plain `JSON.parse`; `true` throws if the runtime lacks it.
   */
  sourceText?: boolean;
}

/** Deepest `[`/`{` nesting decode accepts: sd-json's DEPTH_MAX (systemd src/libsystemd/sd-json/sd-json.c:49). */
export const MAX_JSON_DEPTH: number = 2048;
/**
 * Longest integer literal (in characters) decoded as an exact bigint: the text is peer-controlled and BigInt()
 * parsing is superlinear. Longer literals stay the number JSON.parse made (Infinity: they exceed 309 digits).
 */
export const MAX_BIGINT_SOURCE_LENGTH: number = 1024;

// `context.source` (JSON.parse source text access) and JSON.rawJSON are newer than lib es2024.
interface ReviverContext {
  source?: string;
}
type SourceReviver = (this: unknown, key: string, value: unknown, context?: ReviverContext) => unknown;
type Replacer = (this: unknown, key: string, value: unknown) => unknown;
interface JsonExt {
  parse(text: string, reviver?: SourceReviver): unknown;
  stringify(value: unknown, replacer: Replacer): string | undefined;
  rawJSON?: unknown;
}
const json = JSON as unknown as JsonExt;

const INTEGER_SOURCE = /^-?\d+$/;
/** An unsafe integer literal has at least 16 digits (2^53 has 16), so text without such a run needs no reviver. */
const LONG_DIGIT_RUN = /\d{16}/;

function hasSourceText(): boolean {
  let supported = false;
  try {
    json.parse("1", (_key, value, context) => {
      if (typeof context?.source === "string") supported = true;
      return value;
    });
  } catch {
    // Not reachable on any known runtime.
  }
  return supported;
}

const reviver: SourceReviver = (_key, value, context) => {
  const source = context?.source;
  if (
    typeof value === "number" &&
    !Number.isSafeInteger(value) &&
    source !== undefined &&
    source.length <= MAX_BIGINT_SOURCE_LENGTH &&
    INTEGER_SOURCE.test(source)
  )
    return BigInt(source);
  return value;
};

const QUOTE = 0x22; // "
const BACKSLASH = 0x5c;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

/** Deepest `[`/`{` nesting outside strings. Decode runs it before JSON.parse, so the text may not be valid JSON. */
function nestingDepth(text: string): number {
  let depth = 0;
  let max = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) {
      for (i++; i < text.length; i++) {
        const s = text.charCodeAt(i);
        if (s === BACKSLASH) i++;
        else if (s === QUOTE) break;
      }
    } else if (c === OPEN_BRACKET || c === OPEN_BRACE) {
      depth++;
      if (depth > max) max = depth;
    } else if (c === CLOSE_BRACKET || c === CLOSE_BRACE) {
      depth--;
    }
  }
  return max;
}

/** Creates the default JSON codec (DESIGN.md §4.3). */
export function createJsonCodec(options?: JsonCodecOptions): Codec {
  const sourceSupported = hasSourceText();
  if (options?.sourceText === true && !sourceSupported)
    throw new OperationNotSupportedError("this runtime's JSON.parse does not pass context.source to revivers");
  const useSource = sourceSupported && options?.sourceText !== false;
  const rawJSON = typeof json.rawJSON === "function" ? (json.rawJSON as (text: string) => unknown) : undefined;

  const replacer: Replacer = function (key, value) {
    // Read the holder: toJSON runs before the replacer, and a BigInt.prototype.toJSON polyfill must not turn
    // bigints into strings or rounded numbers.
    // Use the descriptor so a getter is not invoked a second time; for accessors `value` is its result.
    const desc = Object.getOwnPropertyDescriptor(this, key);
    const raw: unknown = desc !== undefined && "value" in desc ? desc.value : value;
    const big = typeof raw === "bigint" ? raw : typeof value === "bigint" ? value : undefined;
    if (big !== undefined) {
      if (rawJSON === undefined) throw new TypeError("bigint cannot be encoded: this runtime lacks JSON.rawJSON");
      return rawJSON(big.toString());
    }
    // JSON.stringify writes -0 as 0; decode keeps a float -0, so encode does too.
    if (rawJSON !== undefined && Object.is(value, -0)) return rawJSON("-0");
    const n = value instanceof Number ? value.valueOf() : value;
    if (typeof n === "number" && !Number.isFinite(n)) throw new TypeError("NaN/Infinity cannot be encoded (UAPI)");
    return value;
  };

  return {
    losslessInts: useSource && rawJSON !== undefined,
    decode(text: string): unknown {
      // Untyped callers may pass anything; a non-string is a caller bug, not the peer's.
      if (typeof text !== "string") throw new TypeError("decode expects a string");
      // A text of at most 2 * MAX_JSON_DEPTH characters cannot nest deeper than that.
      if (text.length > 2 * MAX_JSON_DEPTH && nestingDepth(text) > MAX_JSON_DEPTH)
        throw new ProtocolError(`JSON nested deeper than ${String(MAX_JSON_DEPTH)} levels`);
      try {
        return useSource && LONG_DIGIT_RUN.test(text) ? json.parse(text, reviver) : JSON.parse(text);
      } catch (e) {
        throw new ProtocolError("invalid JSON message", { cause: e });
      }
    },
    encode(value: unknown): string {
      let text: string | undefined;
      try {
        text = json.stringify(value, replacer);
      } catch (e) {
        if (e instanceof RangeError) throw new TypeError(`cannot encode value: ${e.message}`, { cause: e });
        throw e;
      }
      if (text === undefined) throw new TypeError(`a top-level ${typeof value} cannot be encoded as JSON`);
      // Same bound as decode: peers (sd-json DEPTH_MAX) refuse deeper messages.
      if (text.length > 2 * MAX_JSON_DEPTH && nestingDepth(text) > MAX_JSON_DEPTH)
        throw new TypeError(
          `value nested deeper than ${String(MAX_JSON_DEPTH)} levels cannot be sent (peers refuse it)`,
        );
      // sd-json refuses a raw U+007F in strings and JSON.stringify leaves it unescaped. It can only occur inside
      // strings, so escaping it is lossless.
      return text.replaceAll("\x7f", "\\u007f");
    },
  };
}

/** The default codec: lossless integers where the runtime allows it. */
export const jsonCodec: Codec = createJsonCodec();
