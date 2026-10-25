// JSON codec with lossless integers (DESIGN.md §4.3): unsafe integer literals decode to bigint, bigint encodes
// exactly, non-finite numbers are refused. The only place in core that calls JSON.
import { OperationNotSupportedError, ProtocolError } from "../errors/local.ts";

/** Converts between message text and JS values. */
export interface Codec {
  /** @throws {ProtocolError} on invalid JSON (or nesting the parser cannot handle). */
  decode(text: string): unknown;
  /** @throws {TypeError} on NaN/±Infinity, a bigint it cannot write exactly, cycles, or a non-JSON top level. */
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
  if (typeof value === "number" && !Number.isSafeInteger(value) && source !== undefined && INTEGER_SOURCE.test(source))
    return BigInt(source);
  return value;
};

/** Creates the default JSON codec (DESIGN.md §4.3). */
export function createJsonCodec(options?: JsonCodecOptions): Codec {
  const sourceSupported = hasSourceText();
  if (options?.sourceText === true && !sourceSupported)
    throw new OperationNotSupportedError("this runtime's JSON.parse does not pass context.source to revivers");
  const useSource = sourceSupported && options?.sourceText !== false;
  const rawJSON = typeof json.rawJSON === "function" ? (json.rawJSON as (text: string) => unknown) : undefined;

  const replacer: Replacer = (_key, value) => {
    if (typeof value === "bigint") {
      if (rawJSON === undefined) throw new TypeError("bigint cannot be encoded: this runtime lacks JSON.rawJSON");
      return rawJSON(value.toString());
    }
    const n = value instanceof Number ? value.valueOf() : value;
    if (typeof n === "number" && !Number.isFinite(n)) throw new TypeError("NaN/Infinity cannot be encoded (UAPI)");
    return value;
  };

  return {
    losslessInts: useSource && rawJSON !== undefined,
    decode(text: string): unknown {
      try {
        return useSource ? json.parse(text, reviver) : JSON.parse(text);
      } catch (e) {
        throw new ProtocolError("invalid JSON message", { cause: e });
      }
    },
    encode(value: unknown): string {
      const text = json.stringify(value, replacer);
      if (text === undefined) throw new TypeError(`a top-level ${typeof value} cannot be encoded as JSON`);
      return text;
    },
  };
}

/** The default codec: lossless integers where the runtime allows it. */
export const jsonCodec: Codec = createJsonCodec();
