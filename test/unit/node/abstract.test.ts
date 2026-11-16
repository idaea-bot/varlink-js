// Abstract unix sockets (`unix:@name`, Linux only; DESIGN.md §4.6, §4.11).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { connect, listen } from "../../../src/node/index.ts";
import { createServer } from "../../../src/rpc/index.ts";

const linuxOnly = { skip: process.platform !== "linux" ? "abstract sockets are Linux-only" : false };

describe("unix:@ abstract sockets", linuxOnly, () => {
  test("listen + connect + call; the address is canonical; close leaves nothing behind", async () => {
    const name = `varlink-js-test-${randomBytes(6).toString("hex")}`;
    const server = createServer({ onError: () => undefined });
    server.addInterface("interface org.example.abstract\n\nmethod Ping() -> ()\n", { Ping: () => ({}) });
    const l = await listen(`unix:@${name}`);
    assert.equal(l.address, `unix:@${name}`);
    server.serve(l);
    const conn = await connect(l.address);
    assert.deepEqual(await conn.call("org.example.abstract.Ping"), {});
    await conn.close();
    await assert.rejects(listen(`unix:@${name}`), (e: unknown) => (e as { code?: unknown }).code === "EADDRINUSE");
    await server.shutdown({ graceful: false });
    // Gone with the socket: the name can be bound again.
    const again = await listen(`unix:@${name}`);
    await again.close();
  });
});
