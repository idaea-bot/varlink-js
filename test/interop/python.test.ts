// python-varlink certification, both directions over unix and tcp (DESIGN.md §7.4). Needs VARLINK_PYTHON: a
// python with the `varlink` package (CI: `pip install varlink==31.0.0`); skipped otherwise.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { certificationSuite } from "./external.ts";

const python = process.env["VARLINK_PYTHON"];
const MODULE = "varlink.tests.test_certification";

certificationSuite({
  name: "python-varlink",
  available: async () => {
    if (python === undefined || python === "") return "VARLINK_PYTHON is not set (a python with `varlink` installed)";
    try {
      await promisify(execFile)(python, ["-c", `import ${MODULE}`], { timeout: 20_000 });
      return null;
    } catch (e) {
      return `${python} cannot import ${MODULE}: ${String(e)}`;
    }
  },
  server: (address) => [python ?? "", "-u", "-m", MODULE, `--varlink=${address}`],
  client: (address) => [python ?? "", "-m", MODULE, "--client", `--varlink=${address}`],
  // Port 0: python binds it and prints the real one, so there is no window where another process could take it.
  tcpAddress: () => Promise.resolve("tcp:127.0.0.1:0"),
  ready: async (child, address) => {
    // `Listening on /path` (unix) or `Listening on ('127.0.0.1', 41234)` (tcp, the bound address tuple).
    const [, printed] = await child.waitForLine(/^Listening on (.+)$/, 20_000);
    if (!address.startsWith("tcp:")) return address;
    const port = /^\('([^']+)', (\d+)/.exec(printed ?? "");
    assert.ok(port?.[2] !== undefined, `cannot parse the port from ${String(printed)}`);
    return `tcp:127.0.0.1:${port[2]}`;
  },
  passed: (child) => {
    assert.equal(child.stdout().trimEnd().split("\n").at(-1), "Certification passed");
  },
});
