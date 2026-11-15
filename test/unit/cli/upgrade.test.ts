// `varlink-js call --upgrade` in-process (DESIGN.md §4.14, §5.6): the upgrade call, then stdin → service and service →
// stdout as a raw byte pipe (half-close per direction, done after both), error replies, timeouts, signals, EPIPE,
// backpressure both ways. Runtime-agnostic (Node, Bun, Deno).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Context } from "../../../src/cli/context.ts";
import { BrokenPipeError, CliError } from "../../../src/cli/io.ts";
import { writeFailure } from "../../../src/cli/node-io.ts";
import { isDisconnect, pipeUpgraded } from "../../../src/cli/upgrade.ts";
import {
  ConnectionClosedError,
  createServer,
  PermissionDeniedError,
  type ByteChannel,
  type CallContext,
  type Server,
} from "../../../src/index.ts";
import { listen } from "../../../src/node/index.ts";
import { fromWebSocket } from "../../../src/websocket/index.ts";
import { FakeWebSocket } from "../websocket/fake.ts";
import { controlledStdin, fakeIo, isPattern, pattern, runCli, waitFor, waitForStable, type FakeIo } from "./helpers.ts";

const IDL = `interface org.example.cliup

# Upper-cases what it reads; ends its side at the client's EOF.
# [Requires 'upgrade' flag]
method Upper() -> ()

# Records its parameters, then echoes.
# [Requires 'upgrade' flag]
method Params(a: ?int) -> ()

# An error reply instead of upgrading.
# [Supports 'upgrade' flag]
method Deny() -> ()

# Never answers.
# [Requires 'upgrade' flag]
method Hang() -> ()

# Writes TOTAL pattern bytes (counting flushed ones), then reads to EOF and ends.
# [Requires 'upgrade' flag]
method Flood() -> ()

# Reads nothing until the test opens its gate, then everything (to EOF), and ends.
# [Requires 'upgrade' flag]
method Slurp() -> ()

# Reads one chunk, writes its first line back, then closes the connection with the rest unread (like \`head -n1\`).
# [Requires 'upgrade' flag]
method HeadClose() -> ()

# Writes "BYE\\n" and ends its side at once, then reads to EOF.
# [Requires 'upgrade' flag]
method EndFirst() -> ()
`;
const I = "org.example.cliup";
const TOTAL = 8 * 1024 * 1024;
const CHUNK = 64 * 1024;
const T = { timeout: 60_000 };

let server: Server;
let dir: string;
let unix: string;
let tcp: string;
const seen = {
  params: [] as unknown[],
  hangs: 0,
  upperEnded: 0,
  flushed: 0,
  received: [] as Uint8Array[],
  slurpReading: (): void => undefined,
  slurpGate: Promise.resolve(),
  headLines: [] as string[],
  endFirst: "",
  endFirstDone: false,
};

/** An endless stdin (like `yes |`) that counts its reads and notes when it is let go (`return()`). */
function endlessStdin(): { iterable: AsyncIterable<Uint8Array>; pulled(): number; released(): boolean } {
  const line = new TextEncoder().encode("y\n".repeat(512));
  let pulled = 0;
  let released = false;
  return {
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          pulled++;
          return Promise.resolve({ done: false, value: line });
        },
        return: () => {
          released = true;
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    },
    pulled: () => pulled,
    released: () => released,
  };
}

/**
 * A raw socket server on tcp:127.0.0.1:0 that answers the first message (the upgrade call) with an empty reply, then
 * hands the socket to `upgraded` (for resets the library's own server never does).
 */
async function rawUpgradeServer(
  upgraded: (socket: Socket) => void,
): Promise<{ address: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const raw = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    const onData = (chunk: Uint8Array): void => {
      if (!chunk.includes(0)) return;
      socket.off("data", onData);
      socket.write('{"parameters":{}}\0', () => {
        upgraded(socket);
      });
    };
    socket.on("data", onData);
  });
  await new Promise<void>((resolve) => raw.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const addr = raw.address();
  assert.ok(addr !== null && typeof addr === "object");
  return {
    address: `tcp:127.0.0.1:${String(addr.port)}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => raw.close(resolve));
    },
  };
}

function upper(bytes: Uint8Array): Uint8Array {
  return bytes.map((b) => (b >= 0x61 && b <= 0x7a ? b - 0x20 : b));
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "vj-cliup-"));
  server = createServer({ onError: () => undefined });
  server.addInterface(IDL, {
    Upper: async (_p, ctx: CallContext) => {
      const ch = await ctx.upgrade();
      try {
        for (let c = await ch.read(); c !== null; c = await ch.read()) await ch.write(upper(c.bytes));
        await ch.end();
      } finally {
        seen.upperEnded++;
      }
    },
    Params: async (p, ctx: CallContext) => {
      seen.params.push(p);
      const ch = await ctx.upgrade();
      for (let c = await ch.read(); c !== null; c = await ch.read()) await ch.write(upper(c.bytes));
      await ch.end();
    },
    Deny: () => {
      throw new PermissionDeniedError();
    },
    Hang: (_p, ctx: CallContext) => {
      seen.hangs++;
      return new Promise((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          resolve({});
        });
      });
    },
    Flood: async (_p, ctx: CallContext) => {
      const ch = await ctx.upgrade();
      for (let at = 0; at < TOTAL; at += CHUNK) {
        await ch.write(pattern(at, CHUNK));
        seen.flushed += CHUNK;
      }
      for (let c = await ch.read(); c !== null; c = await ch.read()) {
        // drained
      }
      await ch.end();
    },
    Slurp: async (_p, ctx: CallContext) => {
      const ch = await ctx.upgrade();
      await seen.slurpGate;
      for (let c = await ch.read(); c !== null; c = await ch.read()) seen.received.push(new Uint8Array(c.bytes));
      await ch.end();
    },
    HeadClose: async (_p, ctx: CallContext) => {
      const ch = await ctx.upgrade();
      const c = await ch.read();
      const line = c === null ? "" : (new TextDecoder().decode(c.bytes).split("\n")[0] ?? "");
      seen.headLines.push(line);
      await ch.write(new TextEncoder().encode(`${line}\n`));
      ch.close();
      await ch.closed;
    },
    EndFirst: async (_p, ctx: CallContext) => {
      const ch = await ctx.upgrade();
      await ch.write(new TextEncoder().encode("BYE\n"));
      await ch.end();
      const decoder = new TextDecoder();
      for (let c = await ch.read(); c !== null; c = await ch.read())
        seen.endFirst += decoder.decode(c.bytes, { stream: true });
      seen.endFirstDone = true;
    },
  });
  unix = `unix:${join(dir, "s")}`;
  server.serve(await listen(unix));
  const tcpListener = await listen("tcp:127.0.0.1:0");
  server.serve(tcpListener);
  tcp = tcpListener.address;
});

after(async () => {
  await server.shutdown({ graceful: false });
  await rm(dir, { recursive: true, force: true });
});

describe("call --upgrade", () => {
  for (const transport of ["unix", "tcp"] as const)
    test(`over ${transport}: stdin goes to the service, its bytes to stdout; stdin EOF → exit 0`, T, async () => {
      const r = await runCli(["call", "--upgrade", transport === "unix" ? unix : tcp, `${I}.Upper`], {
        stdin: "hello, upgraded world\n",
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, "");
      // The confirming reply's parameters are not printed.
      assert.equal(r.stdout, "HELLO, UPGRADED WORLD\n");
    });

  test("interactive: output arrives as the service writes it, before stdin ends", T, async () => {
    const stdin = controlledStdin();
    let out = "";
    const p = runCli(["call", "--upgrade", unix, `${I}.Upper`], { stdin, onStdout: (t) => (out = t) });
    stdin.push("one ");
    await waitFor(() => out === "ONE ");
    stdin.push("two");
    await waitFor(() => out === "ONE TWO");
    stdin.end();
    const r = await p;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "ONE TWO");
  });

  test("PARAMETERS from argv only: absent and '-' are {}, stdin is never parsed as parameters", T, async () => {
    seen.params.length = 0;
    const a = await runCli(["call", "--upgrade", unix, `${I}.Params`], { stdin: '{"a":1}' });
    const b = await runCli(["call", "--upgrade", unix, `${I}.Params`, "-"], { stdin: "x" });
    const c = await runCli(["call", "--upgrade", unix, `${I}.Params`, '{"a":2}'], { stdin: "" });
    assert.deepEqual(
      [a, b, c].map((r) => [r.code, r.stdout]),
      [
        [0, '{"A":1}'],
        [0, "X"],
        [0, ""],
      ],
    );
    assert.deepEqual(seen.params, [{}, {}, { a: 2 }]);
    const bad = await runCli(["call", "--upgrade", unix, `${I}.Params`, "[1]"]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /^Failed to parse parameters at <argv>: not a JSON object\n$/);
  });

  test("an error reply: 'Upgrade via M() failed with error: NAME', exit 1, nothing on stdout", T, async () => {
    const r = await runCli(["call", "--upgrade", tcp, `${I}.Deny`], { stdin: "ignored" });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, `Upgrade via ${I}.Deny() failed with error: org.varlink.service.PermissionDenied\n`);
  });

  test("--timeout bounds the upgrade call (exit 1) but not the stream", T, async () => {
    const hung = await runCli(["call", "--upgrade", "--timeout=100ms", unix, `${I}.Hang`]);
    assert.equal(hung.code, 1);
    assert.equal(hung.stderr, `Failed to upgrade connection via ${I}.Hang(): timed out after 0.1s\n`);
    // The stream outlives the timeout: stdin arrives well after it.
    const stdin = controlledStdin();
    let out = "";
    const p = runCli(["call", "--upgrade", "--timeout=+50ms", unix, `${I}.Upper`], {
      stdin,
      onStdout: (t) => (out = t),
    });
    stdin.push("a");
    await waitFor(() => out === "A");
    await new Promise((resolve) => setTimeout(resolve, 200));
    stdin.push("b");
    stdin.end();
    const r = await p;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "AB");
  });

  test("simple HTTP mode has no upgrade: a clear error, exit 1", T, async () => {
    const r = await runCli(["call", "--upgrade", "http://127.0.0.1:9/", `${I}.Upper`]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^simple HTTP mode has no protocol upgrade; use the WebSocket address/);
  });

  test("SIGINT during the pipe: the connection is closed, exit 130", T, async () => {
    const controller = new AbortController();
    const stdin = controlledStdin();
    const ended = seen.upperEnded;
    const p = runCli(["call", "--upgrade", unix, `${I}.Upper`], {
      stdin,
      signal: controller.signal,
      onStdout: (t) => {
        if (t === "X") controller.abort("SIGINT");
      },
    });
    stdin.push("x");
    const r = await p;
    assert.equal(r.code, 130);
    assert.equal(r.stdout, "X");
    // The service saw the connection go (EOF or an error ends its loop).
    await waitFor(() => seen.upperEnded > ended);
  });

  test("SIGTERM during the upgrade call: exit 143", T, async () => {
    const controller = new AbortController();
    const hangs = seen.hangs;
    const p = runCli(["call", "--upgrade", unix, `${I}.Hang`], { signal: controller.signal });
    await waitFor(() => seen.hangs > hangs);
    controller.abort("SIGTERM");
    assert.equal((await p).code, 143);
  });

  test("stdout EPIPE: the command stops quietly, exit 0", T, async () => {
    const stdin = controlledStdin();
    const p = runCli(["call", "--upgrade", unix, `${I}.Upper`], { stdin, stdoutBreaksAfter: 0 });
    stdin.push("x");
    const r = await p;
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
  });

  // M1: like socket-forward, a disconnect while writing ends stdin → service quietly; while reading it is that
  // direction's EOF. Exit 0 once both directions are done. The service's reply, sent before it went, is not lost to
  // our failing writes (M9 VM interop: Node destroyed the socket on EPIPE and dropped it; src/node/socket.ts).
  for (const transport of ["unix", "tcp"] as const)
    test(
      `over ${transport}: the service reads one line, answers and goes while stdin is endless (yes |): its answer, exit 0`,
      T,
      async () => {
        const stdin = endlessStdin();
        const lines = seen.headLines.length;
        const r = await runCli(["call", "--upgrade", transport === "unix" ? unix : tcp, `${I}.HeadClose`], {
          stdin: stdin.iterable,
        });
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.stderr, "");
        // Bun's net.Socket drops received bytes once a write fails (test/unit/node/socket.test.ts): not checked there.
        if (process.versions.bun === undefined) assert.equal(r.stdout, "y\n");
        assert.ok(seen.headLines.length > lines, "the service read a line");
        assert.ok(stdin.released(), "stdin was let go (no read left pending)");
        assert.ok(stdin.pulled() > 1);
      },
    );

  test("a TCP reset while we write: exit 0, stdin is let go", T, async () => {
    // A real RST once the first upgraded bytes arrive: our next write fails with EPIPE/ECONNRESET, the read too.
    const raw = await rawUpgradeServer((socket) => {
      socket.once("data", () => {
        socket.resetAndDestroy();
      });
    });
    try {
      const stdin = endlessStdin();
      const r = await runCli(["call", "--upgrade", raw.address, "org.example.raw.Up"], { stdin: stdin.iterable });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, "");
      assert.ok(stdin.released());
    } finally {
      await raw.close();
    }
  });

  test("a TCP reset while we read: stdout ends at once, exit 0 only after stdin's EOF", T, async () => {
    // A real RST while we only read (stdin open, nothing written): the read's ECONNRESET is that direction's EOF.
    const raw = await rawUpgradeServer((socket) => {
      setTimeout(() => {
        socket.resetAndDestroy();
      }, 50);
    });
    try {
      const stdin = controlledStdin();
      let ended = false;
      let settled = false;
      const p = runCli(["call", "--upgrade", raw.address, "org.example.raw.Up"], {
        stdin,
        onStdoutEnd: () => (ended = true),
      });
      void p.then(() => (settled = true));
      await waitFor(() => ended);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(settled, false, "the command waits for stdin's EOF");
      stdin.end();
      const r = await p;
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, "");
      assert.equal(r.stdout, "");
    } finally {
      await raw.close();
    }
  });

  test(
    "L4c: the service ends its side first: stdout ends at once, stdin is still forwarded, exit 0 after stdin's EOF",
    T,
    async () => {
      seen.endFirst = "";
      seen.endFirstDone = false;
      const stdin = controlledStdin();
      let ended = false;
      let settled = false;
      const p = runCli(["call", "--upgrade", unix, `${I}.EndFirst`], { stdin, onStdoutEnd: () => (ended = true) });
      void p.then(() => (settled = true));
      await waitFor(() => ended);
      stdin.push("after ");
      await waitFor(() => seen.endFirst === "after ");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(settled, false, "the command waits for stdin's EOF");
      stdin.push("the end");
      stdin.end();
      const r = await p;
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "BYE\n");
      assert.ok(r.io.stdoutEnded);
      await waitFor(() => seen.endFirstDone);
      assert.equal(seen.endFirst, "after the end");
    },
  );

  test("stdout is ended when the service's side ends, also on the normal path", T, async () => {
    const r = await runCli(["call", "--upgrade", unix, `${I}.Upper`], { stdin: "x" });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.io.stdoutEnded);
  });

  test(
    "backpressure service → stdout: a blocked stdout stops the service's writes; then everything arrives",
    T,
    async () => {
      seen.flushed = 0;
      let writes = 0;
      let release: () => void = () => undefined;
      const blocked = new Promise<void>((resolve) => (release = resolve));
      const stdin = controlledStdin();
      const p = runCli(["call", "--upgrade", tcp, `${I}.Flood`], {
        stdin,
        beforeStdoutWrite: async () => {
          writes++;
          await blocked;
        },
      });
      await waitFor(() => writes > 0, 20_000);
      const stalledAt = await waitForStable(() => seen.flushed);
      assert.ok(stalledAt < TOTAL, `the service wrote everything (${String(stalledAt)}) into a blocked stdout`);
      assert.equal(writes, 1, "one stdout write at a time");
      release();
      await waitFor(() => seen.flushed === TOTAL, 20_000);
      stdin.end();
      const r = await p;
      assert.equal(r.code, 0, r.stderr);
      assert.ok(isPattern(r.io.stdoutChunks, TOTAL), "stdout has exactly the service's bytes");
    },
  );

  test("backpressure stdin → service: a service that does not read stops stdin being pulled", T, async () => {
    seen.received = [];
    let open: () => void = () => undefined;
    seen.slurpGate = new Promise<void>((resolve) => (open = resolve));
    let pulled = 0;
    const stdin: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (pulled * CHUNK >= TOTAL) return Promise.resolve({ done: true, value: undefined });
          const chunk = pattern(pulled * CHUNK, CHUNK);
          pulled++;
          return Promise.resolve({ done: false, value: chunk });
        },
      }),
    };
    const p = runCli(["call", "--upgrade", tcp, `${I}.Slurp`], { stdin });
    await waitFor(() => pulled > 0, 20_000);
    const stalledAt = await waitForStable(() => pulled);
    assert.ok(stalledAt * CHUNK < TOTAL, "all of stdin was read while the service was not reading");
    open();
    const r = await p;
    assert.equal(r.code, 0, r.stderr);
    assert.ok(isPattern(seen.received, TOTAL), "the service got exactly stdin's bytes");
  });
});

/** A ByteChannel whose read and write fail as given (undefined: read waits forever, write succeeds). */
function failingChannel(failures: { read?: unknown; write?: unknown }): ByteChannel & { ended(): boolean } {
  let ended = false;
  return {
    capabilities: {},
    closed: Promise.resolve(),
    read: () =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the failure as given
      failures.read === undefined ? new Promise(() => undefined) : Promise.reject(failures.read),
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the failure as given
    write: () => (failures.write === undefined ? Promise.resolve() : Promise.reject(failures.write)),
    end: () => {
      ended = true;
      return Promise.resolve();
    },
    close: () => undefined,
    ended: () => ended,
  };
}

function pipeContext(io: FakeIo): Context {
  return { io, out: (data) => io.stdout.write(data) } as Partial<Context> as Context;
}

const errno = (code: string): Error => Object.assign(new Error(`${code} (test)`), { code });

describe("call --upgrade: the pipe's failure classification (socket-forward's ERRNO_IS_DISCONNECT)", () => {
  test("isDisconnect: disconnect errnos and ConnectionClosedError (also as a cause) yes, anything else no", () => {
    // ECANCELED: libuv's (Bun's) code for a write pending when the socket closed under it after a peer reset.
    for (const code of ["ECONNRESET", "EPIPE", "ECONNABORTED", "ENOTCONN", "ESHUTDOWN", "ETIMEDOUT", "ECANCELED"])
      assert.equal(isDisconnect(errno(code)), true, code);
    assert.equal(isDisconnect(new ConnectionClosedError("gone")), true);
    assert.equal(isDisconnect(new Error("wrapped", { cause: errno("ECONNRESET") })), true);
    for (const e of [errno("EIO"), errno("EBADF"), new TypeError("x"), new Error("plain"), "ECONNRESET", null, 1])
      assert.equal(isDisconnect(e), false, String(e));
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    assert.equal(isDisconnect(hostile), false);
  });

  test("isDisconnect: a ConnectionClosedError marked local: true (also along the chain) is no disconnect", () => {
    const local = Object.assign(new ConnectionClosedError("websocket receive buffer limit exceeded"), { local: true });
    assert.equal(isDisconnect(local), false);
    assert.equal(isDisconnect(new ConnectionClosedError("the websocket is closed", { cause: local })), false);
    assert.equal(isDisconnect(Object.assign(new ConnectionClosedError("x"), { local: false })), true);
  });

  for (const [what, message] of [
    ["the receive buffer limit (1009)", "more than eight bytes"],
    ["an unsupported message data type (1003)", 42],
    ["an unreadable Blob", { size: 3, arrayBuffer: () => Promise.reject(new Error("unreadable")) }],
  ] as const) {
    test(`a WebSocket channel's own failure, ${what}: 'Upgraded connection failed: …', not EOF`, T, async () => {
      const io = fakeIo({ stdin: controlledStdin() });
      const ws = new FakeWebSocket();
      const p = pipeUpgraded(pipeContext(io), fromWebSocket(ws, { maxBufferedBytes: 8 }));
      ws.message(message);
      await assert.rejects(p, (e: unknown) => {
        assert.ok(e instanceof CliError, String(e));
        assert.match(e.message, /^Upgraded connection failed: /);
        return true;
      });
      assert.equal(io.stdoutEnded, false, "stdout is not ended as if the service had finished");
    });
  }

  test("CLI-wide: a write to stdout failing with any disconnect errno is a BrokenPipeError (exit 0)", () => {
    for (const code of ["EPIPE", "ECONNRESET", "ENOTCONN", "ECONNABORTED", "ESHUTDOWN"])
      assert.ok(writeFailure(errno(code), 1) instanceof BrokenPipeError, code);
    const other = writeFailure(errno("EIO"), 2);
    assert.ok(other instanceof CliError);
    assert.match(other.message, /^Failed to write to stderr: .*EIO/);
  });

  test(
    "the WebSocket Close guard timeout (not local: the peer never answered) ends the pipe like a disconnect",
    T,
    async () => {
      const io = fakeIo({ stdin: "data" });
      const channel = failingChannel({ read: new ConnectionClosedError("the websocket did not close in time") });
      await pipeUpgraded(pipeContext(io), channel);
      assert.ok(io.stdoutEnded);
    },
  );

  test("a non-disconnect read failure: 'Upgraded connection failed: …' (exit 1 in the CLI)", T, async () => {
    const io = fakeIo({ stdin: controlledStdin() });
    await assert.rejects(pipeUpgraded(pipeContext(io), failingChannel({ read: errno("EIO") })), (e: unknown) => {
      assert.ok(e instanceof CliError);
      assert.match(e.message, /^Upgraded connection failed: .*EIO/);
      return true;
    });
    assert.equal(io.stdoutEnded, false);
  });

  test("a non-disconnect write failure: 'Upgraded connection failed: …'", T, async () => {
    const io = fakeIo({ stdin: "data" });
    await assert.rejects(pipeUpgraded(pipeContext(io), failingChannel({ write: new TypeError("bad chunk") })), {
      name: "CliError",
      message: /^Upgraded connection failed: .*bad chunk/,
    });
  });

  test("a disconnect on both sides: resolves (exit 0); stdin let go, stdout ended", T, async () => {
    const stdin = endlessStdin();
    const io = fakeIo({ stdin: stdin.iterable });
    const channel = failingChannel({ read: errno("ECONNRESET"), write: errno("EPIPE") });
    await pipeUpgraded(pipeContext(io), channel);
    assert.ok(stdin.released());
    assert.ok(io.stdoutEnded);
    assert.equal(channel.ended(), false, "no half-close after a failed write");
  });

  test("a ConnectionClosedError on write ends stdin → channel; the read side still decides", T, async () => {
    const stdin = endlessStdin();
    const io = fakeIo({ stdin: stdin.iterable });
    let resolveRead: (v: null) => void = () => undefined;
    const channel: ByteChannel = {
      ...failingChannel({ write: new ConnectionClosedError("the socket is closed") }),
      read: () => new Promise((resolve) => (resolveRead = resolve)),
    };
    let settled = false;
    const p = pipeUpgraded(pipeContext(io), channel).then(() => (settled = true));
    await waitFor(() => stdin.released());
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, "still reading");
    resolveRead(null);
    await p;
    assert.ok(io.stdoutEnded);
  });
});
