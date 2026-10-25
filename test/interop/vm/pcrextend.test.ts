// A real systemd service over exec: (DESIGN.md §5.8): systemd-pcrextend gets a connected socketpair as fd 3 and
// answers GetInfo. Needs root (and Linux); skipped otherwise.
import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { describe, test } from "node:test";
import { connect } from "../../../src/node/index.ts";

const PCREXTEND = "/usr/lib/systemd/systemd-pcrextend";

function skipReason(): string | false {
  if (process.platform !== "linux") return `Linux-only (this is ${process.platform})`;
  if (process.getuid?.() !== 0) return "needs root (run the suite with sudo)";
  try {
    accessSync(PCREXTEND, constants.X_OK);
  } catch {
    return `${PCREXTEND} not found`;
  }
  return false;
}

describe("systemd-pcrextend over exec:", { skip: skipReason() }, () => {
  test("GetInfo names the product and io.systemd.PCRExtend", async () => {
    const conn = await connect(`exec:${PCREXTEND}`, { timeout: 10_000 });
    try {
      const info = await conn.getInfo();
      assert.match(info.product, /systemd-pcrextend/);
      assert.ok(info.interfaces.includes("io.systemd.PCRExtend"), info.interfaces.join(", "));
    } finally {
      await conn.close();
      await conn.closed;
    }
  });
});
