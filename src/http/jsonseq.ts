// Incremental splitter for JSON text sequences (RFC 7464, `application/json-seq`; DESIGN.md §4.12). Records start
// with RS (0x1E); a record holding an object or array is complete when its outermost bracket closes, so it is
// handed out at once (no waiting for the LF or the next RS). Internal: not re-exported.
import { MessageTooLargeError, ProtocolError } from "../core/errors/local.ts";

const RS = 0x1e;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

/** JSON whitespace (RFC 8259): space, tab, LF, CR. */
export function isJsonWhitespace(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1 && parts[0] !== undefined) return parts[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Splits a json-seq byte stream into records (the raw bytes of each JSON text). Tolerates whitespace before the
 * first RS, a missing final LF, CRLF and empty records (skipped). An object/array record is complete when its
 * outermost bracket closes (strings and escapes are tracked, so brackets inside strings do not count); after it only
 * whitespace may follow until the next RS. Any other record (a scalar, never a valid reply) ends at the next RS or at
 * the end of the body. Errors (`ProtocolError`): data before the first RS, data after a complete record, a record
 * cut off by the next RS or the end of the body. A record whose JSON text is over `maxRecordSize` bytes
 * (whitespace around it not counted) is a `MessageTooLargeError`. After an error the splitter must not be used again.
 */
export class JsonSeqSplitter {
  readonly #max: number;
  /** An RS was seen: we are inside a record. */
  #inRecord = false;
  /** Bytes of the record's text so far. */
  #size = 0;
  /** The record's text began (first non-whitespace byte). */
  #began = false;
  /** The text is an object or array (tracked to its closing bracket). */
  #container = false;
  /** The container closed: only whitespace until the next RS. */
  #complete = false;
  #depth = 0;
  #inString = false;
  #escape = false;
  /** The record's text so far (earlier chunks). */
  #parts: Uint8Array[] = [];
  #partsSize = 0;

  constructor(maxRecordSize: number) {
    this.#max = maxRecordSize;
  }

  /** Feeds bytes; returns the records completed by them, in order. */
  push(chunk: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    /** Start of the current record's text within `chunk`, or -1. */
    let start = this.#began && !this.#complete ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i] ?? 0;
      if (b === RS) {
        if (this.#inRecord && this.#began && !this.#complete) {
          if (this.#container) throw new ProtocolError("json-seq: a record was cut off by the next record separator");
          out.push(this.#take(chunk, start, i));
        }
        this.#reset();
        this.#inRecord = true;
        start = -1;
        continue;
      }
      if (!this.#inRecord) {
        if (isJsonWhitespace(b)) continue;
        throw new ProtocolError("json-seq: data before the first record separator");
      }
      if (this.#complete) {
        if (isJsonWhitespace(b)) continue;
        throw new ProtocolError("json-seq: data after the JSON text of a record");
      }
      if (!this.#began && isJsonWhitespace(b)) continue;
      // Only the record's text counts (and is kept); whitespace around it is skipped.
      if (++this.#size > this.#max)
        throw new MessageTooLargeError(`json-seq record larger than maxMessageSize (${String(this.#max)} bytes)`);
      if (!this.#began) {
        this.#began = true;
        start = i;
        if (b === OPEN_BRACE || b === OPEN_BRACKET) {
          this.#container = true;
          this.#depth = 1;
        }
        continue;
      }
      if (!this.#container) continue;
      if (this.#inString) {
        if (this.#escape) this.#escape = false;
        else if (b === BACKSLASH) this.#escape = true;
        else if (b === QUOTE) this.#inString = false;
      } else if (b === QUOTE) {
        this.#inString = true;
      } else if (b === OPEN_BRACE || b === OPEN_BRACKET) {
        this.#depth++;
      } else if ((b === CLOSE_BRACE || b === CLOSE_BRACKET) && --this.#depth === 0) {
        out.push(this.#take(chunk, start, i + 1));
        this.#complete = true;
        start = -1;
      }
    }
    if (start >= 0 && start < chunk.length) {
      const rest = chunk.slice(start);
      this.#parts.push(rest);
      this.#partsSize += rest.length;
    }
    return out;
  }

  /** The end of the body: returns the last record if it was still open (a scalar), or throws if it was cut off. */
  end(): Uint8Array[] {
    if (!this.#inRecord || !this.#began || this.#complete) return [];
    if (this.#container) throw new ProtocolError("json-seq: the body ended in the middle of a record");
    const record = this.#take(new Uint8Array(0), -1, 0);
    this.#reset();
    return [record];
  }

  /** The current record's bytes: earlier parts plus `chunk[start, end)` (start -1: nothing from this chunk). */
  #take(chunk: Uint8Array, start: number, end: number): Uint8Array {
    const parts = this.#parts;
    let total = this.#partsSize;
    if (start >= 0) {
      parts.push(chunk.subarray(start, end));
      total += end - start;
    }
    this.#parts = [];
    this.#partsSize = 0;
    return concat(parts, total);
  }

  #reset(): void {
    this.#size = 0;
    this.#began = false;
    this.#container = false;
    this.#complete = false;
    this.#depth = 0;
    this.#inString = false;
    this.#escape = false;
    this.#parts = [];
    this.#partsSize = 0;
  }
}
