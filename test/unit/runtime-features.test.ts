// Runtime features the JSON codec (DESIGN.md §4.3) relies on. The CI floor job runs the compiled
// version of this file on Node 22.12.0, the `engines` minimum.
import assert from "node:assert/strict";
import { test } from "node:test";

interface ReviverContext {
  source?: string;
}
type SourceReviver = (this: unknown, key: string, value: unknown, context?: ReviverContext) => unknown;
interface JsonWithRaw {
  parse(text: string, reviver: SourceReviver): unknown;
  rawJSON?: (text: string) => unknown;
  isRawJSON?: (value: unknown) => boolean;
}
const json = JSON as unknown as JsonWithRaw;

test("JSON.parse reviver receives context.source for primitives", () => {
  const seen: Record<string, string | undefined> = {};
  json.parse('{"big":18446744073709551615,"neg":-9223372036854775808,"f":1e300,"s":"x"}', (key, value, ctx) => {
    if (key !== "") seen[key] = ctx?.source;
    return value;
  });
  assert.deepEqual(seen, {
    big: "18446744073709551615",
    neg: "-9223372036854775808",
    f: "1e300",
    s: '"x"',
  });
});

test("JSON.parse + context.source recovers 64-bit integers exactly", () => {
  const parsed = json.parse('{"u":18446744073709551615,"i":-9223372036854775808,"safe":42}', (_key, value, ctx) => {
    const src = ctx?.source;
    if (typeof value === "number" && src !== undefined && /^-?\d+$/.test(src) && !Number.isSafeInteger(value)) {
      return BigInt(src);
    }
    return value;
  });
  assert.deepEqual(parsed, { u: 18446744073709551615n, i: -9223372036854775808n, safe: 42 });
});

test("JSON.rawJSON exists and serialises bigint exactly", () => {
  const rawJSON = json.rawJSON;
  assert.equal(typeof rawJSON, "function");
  if (rawJSON === undefined) return;
  const text = JSON.stringify({ u: 18446744073709551615n, n: 1 }, (_key, value: unknown) =>
    typeof value === "bigint" ? rawJSON(value.toString()) : value,
  );
  assert.equal(text, '{"u":18446744073709551615,"n":1}');
  assert.equal(json.isRawJSON?.(rawJSON("1")), true);
});
