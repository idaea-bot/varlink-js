// Test-only helpers for the IDL tests.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { IdlSyntaxError, parseInterface, type Position } from "../../../src/core/idl/index.ts";

/** Deep copy of an AST (or any JSON-like value) without `span`/`nameSpan` keys. */
export function stripSpans<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v: unknown) => stripSpans(v)) as T;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (key !== "span" && key !== "nameSpan") out[key] = stripSpans(v);
    }
    return out as T;
  }
  return value;
}

/** The parse error for `text` (fails if it parses). */
export function parseError(text: string, options?: { validate?: boolean }): IdlSyntaxError {
  try {
    parseInterface(text, options);
  } catch (e) {
    assert.ok(e instanceof IdlSyntaxError, `expected IdlSyntaxError, got ${String(e)}`);
    return e;
  }
  assert.fail(`expected a parse error for ${JSON.stringify(text)}`);
}

/** `line:column` of a position, for compact assertions. */
export function lc(position: Position | undefined): string {
  return position ? `${String(position.line)}:${String(position.column)}` : "none";
}

export interface CorpusFile {
  /** Path relative to test/corpus, e.g. "uapi/org.example.ftl.varlink". */
  name: string;
  text: string;
}

/** Every `*.varlink` under test/corpus (tests run from the repository root). */
export function corpusFiles(): CorpusFile[] {
  const root = resolve("test/corpus");
  const files: CorpusFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".varlink"))
        files.push({ name: relative(root, path), text: readFileSync(path, "utf8") });
    }
  };
  walk(root);
  return files.sort((a, b) => a.name.localeCompare(b.name));
}
