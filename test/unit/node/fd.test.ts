// listen({fd}) (DESIGN.md §4.11, §5.8): a child process serves on a listening socket it inherited as fd 3.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rename } from "node:fs/promises";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { connect } from "../../../src/node/index.ts";
import { closeServer, listening, tempDir } from "./helpers.ts";

const dir = tempDir();
const CHILD = resolve(import.meta.dirname, "fd-child.ts");

/** The fd of a listening net.Server (private `_handle.fd`; undefined where Node does not expose it). */
function fdOf(server: NetServer): number | undefined {
  const fd = (server as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  return typeof fd === "number" && fd >= 0 ? fd : undefined;
}

/** Spawns the child with `fd` as its fd 3, closes our server, and calls Ping on `dial(printed address)`. */
async function throughChild(server: NetServer, dial: (printed: string) => string): Promise<string> {
  const fd = fdOf(server);
  assert.ok(fd !== undefined);
  const child = spawn(process.execPath, [CHILD], { stdio: ["pipe", "pipe", "inherit", fd] });
  const exited = new Promise<number | null>((r) => child.once("exit", r));
  const { stdin, stdout } = child;
  assert.ok(stdin !== null && stdout !== null);
  try {
    const printed = await new Promise<string>((ok, fail) => {
      let out = "";
      stdout.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.includes("\n")) ok(out.trim());
      });
      child.once("exit", (code) => {
        fail(new Error(`child exited early (${String(code)})`));
      });
    });
    // Only the child listens from now on.
    await closeServer(server);
    const conn = await connect(dial(printed), { timeout: 5000 });
    const reply = (await conn.call("org.example.fd.Ping")) as { pid: number };
    assert.equal(reply.pid, child.pid);
    await conn.close();
    return printed;
  } finally {
    // The child exits once its stdin ends; kill it if it does not within 2 s.
    stdin.end();
    const timer = setTimeout(() => child.kill(), 2000);
    await exited;
    clearTimeout(timer);
  }
}

describe("listen({fd})", () => {
  test("tcp: the address is derived from the socket", async (t) => {
    const server = createNetServer();
    await listening(server, { host: "127.0.0.1", port: 0 });
    if (fdOf(server) === undefined) {
      await closeServer(server);
      t.skip("net.Server._handle.fd is not available on this runtime");
      return;
    }
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    const printed = await throughChild(server, (a) => a);
    assert.equal(printed, `tcp:127.0.0.1:${String(address.port)}`);
  });

  test("unix: served through the inherited fd (Node cannot name the path: address fd:3)", async (t) => {
    const path = join(dir(), "fd");
    const server = createNetServer();
    // Bound elsewhere and moved into place, so our close() (libuv unlinks the bound name) leaves `path` alone.
    await listening(server, { path: `${path}.tmp` });
    await rename(`${path}.tmp`, path);
    if (fdOf(server) === undefined) {
      await closeServer(server);
      t.skip("net.Server._handle.fd is not available on this runtime");
      return;
    }
    const printed = await throughChild(server, () => `unix:${path}`);
    assert.equal(printed, "fd:3");
  });
});
