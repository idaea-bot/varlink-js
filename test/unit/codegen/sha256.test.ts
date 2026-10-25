// The generated header's pure-TS SHA-256 (DESIGN.md §4.13) against FIPS 180-2 / RFC 6234 vectors and node:crypto.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sha256Hex, sha256Utf8 } from "../../../src/codegen/sha256.ts";

test("NIST / RFC 6234 test vectors", () => {
  const vectors: [string, string][] = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
    [
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
      "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
    ],
    ["a".repeat(1_000_000), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"],
  ];
  for (const [input, digest] of vectors) assert.equal(sha256Utf8(input), digest, `${String(input.length)} bytes`);
});

test("hashes the UTF-8 encoding of non-ASCII text", () => {
  for (const text of ["zażółć gęślą jaźń", "日本語のテキスト", "emoji 🦊🔥 and a combining é", "\u0000\u007f\u0080"])
    assert.equal(sha256Utf8(text), createHash("sha256").update(text, "utf8").digest("hex"), text);
});

test("matches node:crypto at every length around the 64-byte block and 56-byte padding boundaries", () => {
  for (let n = 0; n <= 200; n++) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 31 + n) & 0xff);
    assert.equal(sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"), `length ${String(n)}`);
  }
});
