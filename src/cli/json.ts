// JSON output in sd-json's formats (DESIGN.md §4.14): `pretty` is byte-identical to sd_json_variant_dump with
// SD_JSON_FORMAT_PRETTY (TAB indentation, `"key" : value`, `{}`/`[]` for empty containers), `short` is minimal.
// Values come from the lossless codec: bigints print as plain integer literals, so no integer is ever rounded.

/** Output style of a JSON value. */
export type JsonStyle = "pretty" | "short";

/** RFC 7464 record separator, written before each JSON-SEQ record. */
export const RS = "\x1e";

function scalar(value: unknown): string {
  switch (typeof value) {
    case "bigint":
      return value.toString();
    case "number":
      // Non-finite numbers never come from the codec; JSON has no spelling for them.
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "string":
    case "boolean":
      return JSON.stringify(value);
    default:
      return "null";
  }
}

function format(value: unknown, style: JsonStyle, indent: string): string {
  if (typeof value !== "object" || value === null) return scalar(value);
  const inner = indent + "\t";
  if (Array.isArray(value)) {
    const items = value as unknown[];
    if (items.length === 0) return "[]";
    const parts = items.map((item) => format(item, style, inner));
    return style === "pretty" ? `[\n${parts.map((p) => inner + p).join(",\n")}\n${indent}]` : `[${parts.join(",")}]`;
  }
  // Object.entries: own enumerable string keys in JS order (integer-like keys first, then insertion order).
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "{}";
  const parts = entries.map(
    ([k, v]) => `${JSON.stringify(k)}${style === "pretty" ? " : " : ":"}${format(v, style, inner)}`,
  );
  return style === "pretty" ? `{\n${parts.map((p) => inner + p).join(",\n")}\n${indent}}` : `{${parts.join(",")}}`;
}

/** `value` as JSON in `style`, followed by a newline; with `seq`, as one RFC 7464 record (RS before it). */
export function formatJson(value: unknown, style: JsonStyle, seq = false): string {
  return `${seq ? RS : ""}${format(value, style, "")}\n`;
}
