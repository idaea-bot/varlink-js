// fd passing end to end over unix sockets with varlink-js-native (DESIGN.md §4.15, §5.1, §5.4): both directions,
// `more` replies, the opt-ins and what happens without them (per kernel: SO_PASSRIGHTS from Linux 6.16), fds bound to
// the first message of a coalesced send and kept apart across separate sends (bounded reads), an 8 MiB message with
// fds (partial writes, fds sent once), the 253-fd cap, upgrade, the handler's fd views. The mid-message rule is
// tested on the framer (test/unit/protocol/framer-fds.test.ts).
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ConnectionClosedError, createServer, OperationNotSupportedError, type ByteChannel } from "../../src/index.ts";
import { connect, listen } from "../../src/node/index.ts";
import { nativeChannel } from "../../src/node/native.ts";
import {
  checkFdLeaks,
  fdService,
  kernelHasPassRights,
  LINUX,
  native,
  openFds,
  pipeWith,
  readFd,
  release,
  SKIP,
  startServer,
  T,
  tempDir,
  until,
} from "./helpers.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A raw native client channel to `address` (fd output allowed), for hand-made bytes. */
async function rawChannel(address: string): Promise<ByteChannel> {
  const sock = native.connect(Buffer.from(address.slice("unix:".length)));
  if (sock.isConnecting())
    await new Promise<void>((resolve, reject) => {
      sock.onconnect = (e) => {
        if (e === null) resolve();
        else reject(e);
      };
    });
  const ch = nativeChannel(native, sock, "client");
  ch.capabilities.fdPassing?.setAllowOutput(true);
  return ch;
}

/** Reads replies (NUL-separated JSON) from `ch` until `n` arrived or EOF. */
async function readReplies(ch: ByteChannel, n: number): Promise<unknown[]> {
  let text = "";
  const out: unknown[] = [];
  while (out.length < n) {
    const chunk = await ch.read();
    if (chunk === null) break;
    text += dec.decode(chunk.bytes);
    let nul: number;
    while ((nul = text.indexOf("\0")) >= 0) {
      out.push(JSON.parse(text.slice(0, nul)));
      text = text.slice(nul + 1);
    }
  }
  return out;
}

function frame(value: unknown): Uint8Array {
  return enc.encode(`${JSON.stringify(value)}\0`);
}

describe("fd passing (varlink-js-native)", { skip: SKIP }, () => {
  checkFdLeaks();
  const dir = tempDir();

  test("client → server: the handler writes through the received fd", T, async () => {
    const fx = await startServer(dir(), "a.sock");
    try {
      const conn = await fx.connect();
      const [r, w] = native.pipe();
      await conn.call("org.example.fd.Write", { text: "through the fd" }, { fds: [w] });
      // The library sent a duplicate: our write end is still ours.
      native.close(w);
      assert.equal(readFd(r), "through the fd");
      native.close(r);
    } finally {
      await fx.close();
    }
  });

  test("the caller's fds may be closed right after the call was made (they were duplicated)", T, async () => {
    const fx = await startServer(dir(), "a2.sock");
    try {
      const conn = await fx.connect();
      const [r, w] = native.pipe();
      const pending = conn.call("org.example.fd.Write", { text: "dup" }, { fds: [w] });
      native.close(w);
      await pending;
      assert.equal(readFd(r), "dup");
      native.close(r);
    } finally {
      await fx.close();
    }
  });

  test("server → client: fds in a reply ({ parameters, fds })", T, async () => {
    const fx = await startServer(dir(), "b.sock");
    try {
      const conn = await fx.connect();
      const reply = await conn.call("org.example.fd.Open", { text: "from the server" }, { acceptFds: true });
      assert.deepEqual(reply.parameters, {});
      assert.equal(reply.fds.length, 1);
      const [fd] = reply.fds;
      assert.ok(fd !== undefined);
      assert.equal(readFd(fd.fd), "from the server");
      fd.close();
      // A plain call afterwards: input is off again, nothing changed for it.
      assert.deepEqual(await conn.call("org.example.fd.Ping", {}), {});
    } finally {
      await fx.close();
    }
  });

  test("server → client: every `more` reply carries its own fds", T, async () => {
    const fx = await startServer(dir(), "c.sock");
    try {
      const conn = await fx.connect();
      const got: string[] = [];
      for await (const item of conn.stream("org.example.fd.Stream", { n: 4 }, { acceptFds: true })) {
        assert.equal(item.fds.length, 1);
        for (const fd of item.fds) {
          got.push(`${String(item.parameters.i)}:${readFd(fd.fd)}`);
          fd.close();
        }
      }
      assert.deepEqual(got, ["0:0", "1:1", "2:2", "3:3"]);
      const all = await conn.collect("org.example.fd.Stream", { n: 3 }, { acceptFds: true });
      assert.deepEqual(
        all.map((r) => r.fds.length),
        [1, 1, 1],
      );
      for (const r of all) for (const fd of r.fds) fd.close();
    } finally {
      await fx.close();
    }
  });

  test("an abandoned stream closes the fds of replies it buffered", T, async () => {
    const fx = await startServer(dir(), "c2.sock");
    try {
      // Counted with no connection open; leaving the stream closes the connection (both ends).
      const before = openFds();
      const conn = await fx.connect();
      const it = conn.stream("org.example.fd.Stream", { n: 5 }, { acceptFds: true });
      const first = await it.next();
      assert.equal(first.done, false);
      for (const fd of first.value.fds) fd.close();
      await it.return();
      await until(() => fx.server.connections === 0);
      await until(() => openFds() <= before);
    } finally {
      await fx.close();
    }
  });

  test("a failed proxy collect (max exceeded after 2 replies) closes the collected replies' fds", T, async () => {
    const fx = await startServer(dir(), "c3.sock");
    try {
      // Counted with no connection open; closed again below (both ends), so only leaked fds stay.
      const before = openFds();
      const conn = await fx.connect();
      const px = await conn.proxy("org.example.fd");
      // The proxy's types leave acceptFds out, but the option goes through to the call (and its fds must not leak).
      const collect = px.Stream?.collect({ n: 5 }, { acceptFds: true, max: 2 } as { max: number });
      await assert.rejects(Promise.resolve(collect), RangeError);
      await conn.close();
      await until(() => fx.server.connections === 0);
      await until(() => openFds() <= before);
    } finally {
      await fx.close();
    }
  });

  test(
    "a reply with fds to a call without acceptFds: on every kernel the reply arrives, the fds are dropped, the connection stays",
    T,
    async (t) => {
      // A client never touches SO_PASSRIGHTS (sd-varlink's fresh client keeps the kernel default: json-stream.c:
      // 691-692), so even on ≥ 6.16 the server's sendmsg is accepted; the client drops the fds (as sd-varlink's plain
      // recv() does, json-stream.c:1318-1321).
      t.diagnostic(`SO_PASSRIGHTS in this kernel: ${String(await kernelHasPassRights())}`);
      const fx = await startServer(dir(), "d.sock");
      try {
        const conn = await fx.connect();
        await conn.call("org.example.fd.Ping", {});
        const before = openFds();
        assert.deepEqual(await conn.call("org.example.fd.Open", { text: "x" }), {});
        assert.deepEqual(await conn.call("org.example.fd.Open", { text: "y" }), {});
        // Still usable, also for an fd-accepting call after it.
        const reply = await conn.call("org.example.fd.Open", { text: "z" }, { acceptFds: true });
        assert.equal(reply.fds.length, 1);
        for (const fd of reply.fds) {
          assert.equal(readFd(fd.fd), "z");
          fd.close();
        }
        assert.deepEqual(await conn.call("org.example.fd.Open", { text: "after" }), {});
        assert.equal(
          fx.errors.some((e) => e.reason === "send-failed"),
          false,
        );
        await until(() => openFds() <= before);
      } finally {
        await fx.close();
      }
    },
  );

  test(
    "a server without allowFdPassingInput (default): on every kernel the call runs, the fds are dropped",
    T,
    async () => {
      const fx = await startServer(dir(), "e0.sock", { allowFdPassingInput: false });
      try {
        const conn = await fx.connect();
        await conn.call("org.example.fd.Ping", {});
        const before = openFds();
        const r = pipeWith("unused");
        try {
          assert.deepEqual(await conn.call("org.example.fd.Count", {}, { fds: [r] }), { n: 0 });
          assert.deepEqual(await conn.call("org.example.fd.Ping", {}), {});
        } finally {
          native.close(r);
        }
        await until(() => openFds() <= before);
      } finally {
        await fx.close();
      }
    },
  );

  test(
    "strict mode, server without allowFdPassingInput: ≥ 6.16 the client's send fails (EPERM), else the call runs without them",
    T,
    async () => {
      const passRights = await kernelHasPassRights();
      const fx = await startServer(dir(), "e.sock", { allowFdPassingInput: false }, true);
      try {
        const before = openFds();
        const conn = await fx.connect();
        await conn.call("org.example.fd.Ping", {});
        const r = pipeWith("unused");
        try {
          if (passRights) {
            const call = conn.call("org.example.fd.Count", {}, { fds: [r] });
            await assert.rejects(call, (e: unknown) => {
              const cause = (e as { cause?: unknown }).cause;
              return (
                e instanceof ConnectionClosedError &&
                cause instanceof OperationNotSupportedError &&
                (cause as { code?: string }).code === "EPERM" &&
                /does not accept file descriptors/.test(cause.message)
              );
            });
            assert.equal(fx.seen.counts.length, 0, "the call must not run");
          } else {
            assert.deepEqual(await conn.call("org.example.fd.Count", {}, { fds: [r] }), { n: 0 });
            await conn.close();
          }
        } finally {
          native.close(r);
        }
        // Every write error path closes the library's duplicates (the CI leak).
        await until(() => fx.server.connections === 0);
        await until(() => openFds() <= before);
      } finally {
        await fx.close();
      }
    },
  );

  test(
    "strict listener set up without input, connections handled by a server with input: fds pass (M1)",
    T,
    async (t) => {
      if (!(await kernelHasPassRights())) {
        // Without the option nothing is refused, so this would pass without the per-connection setsockopt; the
        // first-strict-call counting is covered on every platform by channel.test.
        t.skip("this kernel has no SO_PASSRIGHTS (Linux < 6.16, macOS): nothing to switch back on");
        return;
      }
      // The listening socket gets SO_PASSRIGHTS off (≥ 6.16), inherited by accepted sockets; the server's first
      // setAcceptInput(true) on each connection must reach the setsockopt (serve() would refuse the mismatch, so
      // the channels go to handle() one by one, which is what a custom accept loop does).
      const address = `unix:${dir()}/m1.sock`;
      const listener = await listen(address, { native, fdPassingInputStrict: true, allowFdPassingInput: false });
      const server = createServer({ allowFdPassingInput: true });
      const seen = fdService(server);
      const it = listener[Symbol.asyncIterator]();
      const accepting = (async () => {
        for (;;) {
          const r = await it.next();
          if (r.done === true) return;
          void server.handle(r.value);
        }
      })();
      const calls = native.stats().passRightsCalls;
      const conn = await connect(address, { native, timeout: 20_000 });
      const r = pipeWith("x");
      try {
        // The documented window (DESIGN §4.15): until the server has accepted the connection and run handle()'s
        // setsockopt, the socket still has the listener's SO_PASSRIGHTS (off), and a client sendmsg with fds gets
        // EPERM; in one process the client's write always wins (it lands before the accept). So a plain call first:
        // its reply means the server has adopted and configured the connection.
        assert.deepEqual(await conn.call("org.example.fd.Ping", {}), {});
        assert.equal(native.stats().passRightsCalls, calls + 1, "the first strict setAcceptInput reaches setsockopt");
        assert.deepEqual(await conn.call("org.example.fd.Count", {}, { fds: [r] }), { n: 1 });
        assert.deepEqual(seen.counts, [1]);
      } finally {
        native.close(r);
        await conn.close();
        await listener.close();
        await accepting;
        await server.shutdown({ graceful: false });
      }
    },
  );

  test("listen({fd}) in strict mode prepares the listening socket once (N1)", T, async () => {
    const log: string[] = [];
    const logged = {
      ...native,
      setPassRights: (fd: number, on: boolean) => {
        log.push(`passrights:${String(on)}`);
        return native.setPassRights(fd, on);
      },
      setXattr: (fd: number, value: string) => {
        log.push(`xattr:${value}`);
        native.setXattr(fd, value);
      },
    };
    const net = createNetServer();
    await new Promise<void>((resolve) => net.listen(`${dir()}/n1.sock`, resolve));
    // listen({fd}) takes the fd over: give it a duplicate, ours goes with the net server.
    const fd = native.dup((net as unknown as { _handle: { fd: number } })._handle.fd);
    await new Promise((resolve) => net.close(resolve));
    const listener = await listen({ fd }, { native: logged, fdPassingInputStrict: true, allowFdPassingInput: true });
    await listener.close();
    assert.deepEqual(log, ["passrights:true", "xattr:listen"]);
  });

  test("a server without allowFdPassingOutput: ctx.pushFds throws OperationNotSupportedError", T, async () => {
    const fx = await startServer(dir(), "f.sock", { allowFdPassingOutput: false });
    try {
      const conn = await fx.connect();
      await assert.rejects(conn.call("org.example.fd.Open", { text: "x" }, { acceptFds: true }), (e: unknown) => {
        return (e as { error?: string }).error === "io.github.pzmarzly.varlinkjs.InternalError";
      });
      assert.ok(fx.errors.some((e) => e.error instanceof OperationNotSupportedError));
    } finally {
      await fx.close();
    }
  });

  test("unclaimed fds of a call are closed by the library when the call is done", T, async () => {
    const fx = await startServer(dir(), "g.sock");
    try {
      const conn = await fx.connect();
      // Accepted (both ends open) before counting.
      await conn.call("org.example.fd.Ping", {});
      const before = openFds();
      const a = pipeWith("a");
      const b = pipeWith("b");
      assert.deepEqual(await conn.call("org.example.fd.Count", {}, { fds: [a, b] }), { n: 2 });
      native.close(a);
      native.close(b);
      await until(() => openFds() <= before);
    } finally {
      await fx.close();
    }
  });

  test("coalesced messages: the fds belong to the first message starting in the chunk", T, async () => {
    const fx = await startServer(dir(), "h.sock");
    try {
      const ch = await rawChannel(fx.address);
      const r = pipeWith("x");
      const one = frame({ method: "org.example.fd.Count", parameters: {} });
      const two = frame({ method: "org.example.fd.Count", parameters: {} });
      const both = new Uint8Array(one.length + two.length);
      both.set(one);
      both.set(two, one.length);
      await ch.write(both, [{ fd: r, close: () => undefined }]);
      native.close(r);
      const replies = await readReplies(ch, 2);
      assert.deepEqual(replies, [{ parameters: { n: 1 } }, { parameters: { n: 0 } }]);
      ch.close();
    } finally {
      await fx.close();
    }
  });

  test("separate sends read in one go: A without fds gets none, B gets its own (bounded reads)", T, async () => {
    // maxQueuedCalls 1 parks the server's reader while a call is buffered, so A and B (two sendmsg calls, B with an
    // fd) sit in the kernel together; an unbounded recvmsg would return A + B with B's fd, given to A.
    const fx = await startServer(dir(), "i.sock", { maxQueuedCalls: 1 });
    try {
      const conn = await fx.connect();
      const hold = conn.call("org.example.fd.Hold", {});
      await until(() => fx.seen.holds.length === 1);
      const queued = conn.call("org.example.fd.Count", {});
      // The server buffers `queued` and its reader parks (the queue is full) until Hold returns: whatever arrives
      // meanwhile stays in the kernel. The pauses only let the writes happen; they cannot make the reads race.
      await sleep(50);
      const r = pipeWith("x");
      const a = conn.call("org.example.fd.Count", {});
      const b = conn.call("org.example.fd.Count", {}, { fds: [r] });
      await sleep(50);
      // The addon counts bounded reads that stopped at a NUL with more bytes queued behind it: reading A while B
      // waits in the kernel is one. Without it the test would pass without testing anything (A read alone).
      const cutsBefore = native.stats().boundedCuts;
      release(fx.seen);
      await hold;
      assert.deepEqual(await queued, { n: 0 });
      assert.deepEqual(await a, { n: 0 }, "A must not get B's fd");
      assert.deepEqual(await b, { n: 1 });
      // Linux only: macOS's MSG_PEEK stops at a send that carries fds (its reads never join them anyway), so the peek
      // cannot see B behind A there.
      if (LINUX)
        assert.ok(native.stats().boundedCuts > cutsBefore, "A and B were in the server's receive queue together");
      native.close(r);
    } finally {
      await fx.close();
    }
  });

  test("8 MiB messages with fds both ways: partial writes, the fds sent once", { timeout: 60_000 }, async () => {
    const fx = await startServer(dir(), "j.sock");
    try {
      const conn = await fx.connect({ maxMessageSize: 32 * 1024 * 1024 });
      const big = "y".repeat(8 * 1024 * 1024);
      const [r, w] = native.pipe();
      await conn.call("org.example.fd.Write", { text: big.slice(0, 1000) + "|" }, { fds: [w] });
      native.close(w);
      assert.equal(readFd(r).length, 1001);
      native.close(r);
      // A big call with one fd: the server sees exactly one.
      const a = pipeWith("a");
      assert.deepEqual(await conn.call("org.example.fd.Count", {}, { fds: [a] }), { n: 1 });
      native.close(a);
      const reply = await conn.call("org.example.fd.Big", { size: 8 * 1024 * 1024 }, { acceptFds: true });
      assert.equal((reply.parameters.data as string).length, 8 * 1024 * 1024);
      assert.equal(reply.fds.length, 1);
      for (const fd of reply.fds) {
        assert.equal(readFd(fd.fd), "big");
        fd.close();
      }
      // And a big call carrying fds: 8 MiB of parameters with the fd on its first byte (the server writes little:
      // it shares this thread, which does not read the pipe until the call returned).
      const [r2, w2] = native.pipe();
      await conn.call("org.example.fd.Write", { text: "after 8 MiB", pad: big }, { fds: [w2] });
      native.close(w2);
      assert.equal(readFd(r2), "after 8 MiB");
      native.close(r2);
    } finally {
      await fx.close();
    }
  });

  test("at most 253 fds per message: 254 rejects locally, 253 arrive", { timeout: 60_000 }, async () => {
    const fx = await startServer(dir(), "k.sock");
    try {
      const conn = await fx.connect();
      const r = pipeWith("x");
      await assert.rejects(
        conn.call("org.example.fd.Count", {}, { fds: Array.from({ length: 254 }, () => r) }),
        RangeError,
      );
      assert.equal(conn.isClosed, false);
      assert.deepEqual(await conn.call("org.example.fd.Count", {}, { fds: Array.from({ length: 253 }, () => r) }), {
        n: 253,
      });
      native.close(r);
    } finally {
      await fx.close();
    }
  });

  test(
    "fds need an fd-capable connection: without the addon, OperationNotSupportedError before sending",
    T,
    async () => {
      const fx = await startServer(dir(), "l.sock");
      try {
        const conn = await fx.connect({ native: false });
        const r = pipeWith("x");
        await assert.rejects(conn.call("org.example.fd.Count", {}, { fds: [r] }), OperationNotSupportedError);
        await assert.rejects(
          conn.call("org.example.fd.Open", { text: "x" }, { acceptFds: true }),
          OperationNotSupportedError,
        );
        native.close(r);
        assert.deepEqual(await conn.call("org.example.fd.Count", {}), { n: 0 });
      } finally {
        await fx.close();
      }
    },
  );

  test("upgrade over a native channel: bytes only, the channel keeps peer but drops fd passing", T, async () => {
    const fx = await startServer(dir(), "m.sock");
    try {
      const conn = await fx.connect();
      const { channel } = await conn.upgrade("org.example.fd.Cat", {});
      assert.equal(channel.capabilities.fdPassing, undefined);
      assert.equal(typeof channel.capabilities.peer, "function");
      await assert.rejects(channel.write(enc.encode("x"), [{ fd: 0, close: () => undefined }]), TypeError);
      await channel.write(enc.encode("hello "));
      await channel.write(enc.encode("world"));
      await channel.end();
      let text = "";
      for (;;) {
        const chunk = await channel.read();
        if (chunk === null) break;
        text += dec.decode(chunk.bytes);
      }
      assert.equal(text, "hello world");
      channel.close();
      await channel.closed;
    } finally {
      await fx.close();
    }
  });

  test(
    "the first call on a fresh connection is never lost (pauseOnConnect, then the fd is taken over)",
    T,
    async () => {
      const fx = await startServer(dir(), "n.sock");
      try {
        for (let i = 0; i < 30; i++) {
          const ch = await rawChannel(fx.address);
          // Written in the same turn as the connect: before the server even accepted.
          await ch.write(frame({ method: "org.example.fd.Ping", parameters: {} }));
          assert.deepEqual(await readReplies(ch, 1), [{ parameters: {} }]);
          ch.close();
        }
        // A plain Node client too.
        for (let i = 0; i < 10; i++) {
          const conn = await fx.connect({ native: false });
          assert.deepEqual(await conn.call("org.example.fd.Ping", {}), {});
          await conn.close();
        }
      } finally {
        await fx.close();
      }
    },
  );

  test("ctx.fds are views: close() does nothing, fd is -1 after takeFd and after the call", T, async () => {
    const fx = await startServer(dir(), "o.sock");
    try {
      const conn = await fx.connect();
      const a = pipeWith("a");
      const b = pipeWith("b");
      await conn.call("org.example.fd.Keep", { claim: true }, { fds: [a, b] });
      native.close(a);
      native.close(b);
      const kept = fx.seen.kept[0];
      assert.ok(kept !== undefined);
      const [v0, v1] = kept.fds;
      assert.ok(v0 !== undefined && v1 !== undefined);
      // fd 0 was claimed, fd 1 was closed by the library when the call finished: neither number is ours to use.
      assert.equal(v0.fd, -1);
      assert.equal(v1.fd, -1);
      v1.close(); // a no-op, never a close of whatever reuses that number
      const claimed = kept.claimed;
      assert.ok(claimed !== undefined && claimed.fd >= 0);
      assert.equal(readFd(claimed.fd), "a");
      claimed.close();
    } finally {
      await fx.close();
    }
  });
});
