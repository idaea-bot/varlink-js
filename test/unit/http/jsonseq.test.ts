// JsonSeqSplitter (RFC 7464 records, DESIGN.md §4.12): every split point, tolerated variations, errors.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MessageTooLargeError, ProtocolError } from "../../../src/index.ts";
import { JsonSeqSplitter } from "../../../src/http/jsonseq.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const RS = "\x1e";

/** Splits `text` at `cuts` and returns the records as strings, plus after which chunk each one came out. */
function run(text: string, cuts: number[], max = 1 << 20): { records: string[]; at: number[] } {
  const bytes = enc(text);
  const s = new JsonSeqSplitter(max);
  const records: string[] = [];
  const at: number[] = [];
  let prev = 0;
  const bounds = [...cuts, bytes.length];
  bounds.forEach((cut, i) => {
    for (const r of s.push(bytes.subarray(prev, cut))) {
      records.push(dec(r));
      at.push(i);
    }
    prev = cut;
  });
  for (const r of s.end()) {
    records.push(dec(r));
    at.push(bounds.length);
  }
  return { records, at };
}

describe("JsonSeqSplitter", () => {
  test("records with LF, CRLF, no LF at the end, empty records and leading whitespace", () => {
    const text = ` \n${RS}{"a":1}\n${RS}${RS}\r\n${RS}  {"b":[1,{"c":"}]{["}]}\r\n${RS}{"d":"\\"}"}`;
    assert.deepEqual(run(text, []).records, ['{"a":1}', '{"b":[1,{"c":"}]{["}]}', '{"d":"\\"}"}']);
  });

  test("every split point gives the same records (strings with brackets, escapes, multi-byte UTF-8)", () => {
    const text = `${RS}{"x":"é}\\\\","y":[[]]}\n${RS}{"z":"🙂{"}\n${RS}\n{"pretty":\n  [1,\n   2]\n}\n`;
    const expected = ['{"x":"é}\\\\","y":[[]]}', '{"z":"🙂{"}', '{"pretty":\n  [1,\n   2]\n}'];
    const n = enc(text).length;
    for (let i = 0; i <= n; i++) assert.deepEqual(run(text, [i]).records, expected, `cut at ${String(i)}`);
    for (let i = 0; i <= n; i++)
      for (let j = i; j <= n; j += 3)
        assert.deepEqual(run(text, [i, j]).records, expected, `cuts ${String(i)},${String(j)}`);
    // One byte at a time.
    assert.deepEqual(
      run(
        text,
        Array.from({ length: n }, (_, i) => i),
      ).records,
      expected,
    );
  });

  test("an object record is handed out when its bracket closes, before the LF or the next RS", () => {
    const text = `${RS}{"a":1}\n${RS}{"b":2}`;
    const closeAt = text.indexOf("}") + 1;
    const { records, at } = run(text, [closeAt]);
    assert.deepEqual(records, ['{"a":1}', '{"b":2}']);
    assert.deepEqual(at, [0, 1]);
  });

  test("a scalar record ends at the next RS or the end of the body", () => {
    assert.deepEqual(run(`${RS}42\n${RS}"s"\n${RS}true`, []).records, ["42\n", '"s"\n', "true"]);
  });

  test("errors: data before the first RS, data after a record, a record cut off by RS or by the end", () => {
    for (const text of [`x${RS}{}`, `${RS}{} x`, `${RS}{"a":1${RS}{}`, `${RS}{"a":"}`])
      assert.throws(() => run(text, []), ProtocolError, JSON.stringify(text));
  });

  test("a record over the limit is MessageTooLargeError (its JSON text); exactly the limit is fine", () => {
    const record = `{"a":"${"x".repeat(100)}"}`;
    const size = enc(record).length;
    assert.deepEqual(run(`${RS}  ${record}\r\n`, [], size).records, [record]);
    assert.throws(() => run(`${RS}${record}`, [], size - 1), MessageTooLargeError);
    assert.throws(() => run(`${RS}${"1".repeat(size + 1)}`, [], size), MessageTooLargeError);
    // Many records each at the limit are fine.
    assert.equal(run(`${RS}${record}\n`.repeat(50), [], size).records.length, 50);
  });
});

test("an error after complete records of the same chunk: the records first, then the error", () => {
  const s = new JsonSeqSplitter(16);
  const records = s.push(new TextEncoder().encode(`\x1e{"i":0}\n\x1e{"i":"${"x".repeat(40)}"}\n`));
  assert.deepEqual(
    records.map((r) => new TextDecoder().decode(r)),
    ['{"i":0}'],
  );
  assert.throws(() => {
    s.throwIfFailed();
  }, MessageTooLargeError);
  assert.throws(() => s.push(new Uint8Array(0)), MessageTooLargeError);
  assert.throws(() => s.end(), MessageTooLargeError);
});
