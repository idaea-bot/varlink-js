// `varlink-js bridge` in-process (DESIGN.md §4.14): stdin → socket, socket → stdout, half-close, EOF, errors.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { controlledStdin, rawServer, runCli, startFixture, waitFor, type Fixture } from "./helpers.ts";

let fx: Fixture;
before(async () => {
  fx = await startFixture();
});
after(async () => {
  await fx.close();
});

const call = (method: string, parameters: object): string => `${JSON.stringify({ method, parameters })}\0`;

describe("bridge", () => {
  for (const transport of ["unix", "tcp"] as const)
    test(`a byte pipe over ${transport}: replies come out, stdin EOF half-closes, peer EOF ends it (exit 0)`, async () => {
      const stdin = controlledStdin();
      let out = "";
      const p = runCli(["bridge", transport === "unix" ? fx.unix : fx.tcp], {
        stdin,
        onStdout: (text) => (out = text),
      });
      stdin.push(call("org.example.cli.Echo", { value: 9223372036854775807n.toString() }));
      // Split one message across two chunks: bytes, not messages.
      const second = call("org.example.cli.Echo", { value: 2 });
      stdin.push(second.slice(0, 10));
      stdin.push(second.slice(10));
      await waitFor(() => out.split("\0").length === 3);
      stdin.end();
      const r = await p;
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, '{"parameters":{"value":"9223372036854775807"}}\0{"parameters":{"value":2}}\0');
      assert.equal(r.stderr, "");
    });

  test("the peer's EOF ends the bridge while stdin is still open", async () => {
    const raw = await rawServer(['{"parameters":{}}']);
    try {
      const stdin = controlledStdin();
      let out = "";
      const p = runCli(["bridge", raw.address], { stdin, onStdout: (text) => (out = text) });
      stdin.push(call("a.b.C", {}));
      await waitFor(() => out.includes("\0"));
      await raw.close();
      const r = await p;
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, '{"parameters":{}}\0');
    } finally {
      await raw.close();
    }
  });

  test("connect failure, unsupported kinds, arguments", async () => {
    const refused = await runCli(["bridge", "unix:/nonexistent/x"]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^Failed to connect to unix:\/nonexistent\/x: /);
    for (const address of ["ws://127.0.0.1:1/ws/services/a.b", "http://127.0.0.1:1/", "exec:/bin/true"]) {
      const r = await runCli(["bridge", address]);
      assert.equal(r.code, 1, address);
      assert.match(r.stderr, /addresses are not supported by bridge/, address);
    }
    const none = await runCli(["bridge"]);
    assert.equal(none.code, 1);
  });

  test("SIGINT: closed, 130; stdout EPIPE: 0", async () => {
    const controller = new AbortController();
    const stdin = controlledStdin();
    const p = runCli(["bridge", fx.unix], { stdin, signal: controller.signal });
    setTimeout(() => {
      controller.abort("SIGINT");
    }, 50);
    assert.equal((await p).code, 130);

    const stdin2 = controlledStdin();
    const p2 = runCli(["bridge", fx.unix], { stdin: stdin2, stdoutBreaksAfter: 0 });
    stdin2.push(call("org.example.cli.Echo", { value: 1 }));
    const r2 = await p2;
    assert.equal(r2.code, 0);
    assert.equal(r2.stderr, "");
  });
});
