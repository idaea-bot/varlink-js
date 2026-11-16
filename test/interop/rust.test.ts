// rust varlink certification (github.com/varlink/rust `varlink-certification`), both directions over unix and tcp
// (DESIGN.md §7.4). Needs VARLINK_RUST_CERT: the path of the built binary; skipped otherwise.
import assert from "node:assert/strict";
import { access, constants } from "node:fs/promises";
import { certificationSuite } from "./external.ts";
import { freeTcpPort, waitForConnect } from "./helpers.ts";

const binary = process.env["VARLINK_RUST_CERT"];

certificationSuite({
  name: "rust varlink",
  available: async () => {
    if (binary === undefined || binary === "") return "VARLINK_RUST_CERT is not set (path of varlink-certification)";
    try {
      await access(binary, constants.X_OK);
      return null;
    } catch (e) {
      return `${binary} is not executable: ${String(e)}`;
    }
  },
  server: (address) => [binary ?? "", `--varlink=${address}`],
  client: (address) => [binary ?? "", "--client", `--varlink=${address}`],
  // The rust server prints nothing and its own address is all it knows, so the port is picked here (freed just
  // before it binds: a small race with other processes, acceptable in tests).
  tcpAddress: async () => `tcp:127.0.0.1:${String(await freeTcpPort())}`,
  ready: async (child, address) => {
    await waitForConnect(address, 20_000, child);
    return address;
  },
  // main() returns Err (exit 1) on any failed call; on success the last thing on stderr is End's reply.
  passed: (child) => {
    assert.match(child.stderr(), /all_ok: true/);
  },
});
