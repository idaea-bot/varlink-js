// The native ByteChannel itself (DESIGN.md §4.15): MSG_CTRUNC, rejected fds, half-close and close, a write error that
// keeps unread input readable, and the C helpers (dup, pipe, close-on-exec, isUnixSocket, memfd).
import assert from "node:assert/strict";
import { closeSync, fstatSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import {
  ConnectionClosedError,
  createServer as createVarlinkServer,
  OperationNotSupportedError,
  type ByteChannel,
} from "../../src/index.ts";
import { nativeChannel } from "../../src/node/native.ts";
import type { NativeSocket } from "../index.js";
import { checkFdLeaks, kernelHasPassRights, LINUX, native, pipeWith, readFd, SKIP, T, tempDir } from "./helpers.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A connected pair over a unix socket: the client and the accepted side, both native sockets. */
async function socketPair(
  path: string,
  server: Server | undefined,
): Promise<{ client: NativeSocket; accepted: NativeSocket }> {
  if (server === undefined) throw new Error("the test server is not running");
  const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
  const client = native.connect(Buffer.from(path));
  if (client.isConnecting())
    await new Promise<void>((resolve, reject) => {
      client.onconnect = (e) => {
        if (e === null) resolve();
        else reject(e);
      };
    });
  const socket = await accepted;
  const fd = (socket as unknown as { _handle: { fd: number } })._handle.fd;
  const sock = native.adopt(fd);
  socket.destroy();
  return { client, accepted: sock };
}

function channels(pair: { client: NativeSocket; accepted: NativeSocket }): { a: ByteChannel; b: ByteChannel } {
  return { a: nativeChannel(native, pair.client, "client"), b: nativeChannel(native, pair.accepted, "server") };
}

async function readAll(ch: ByteChannel): Promise<string> {
  let text = "";
  for (;;) {
    const chunk = await ch.read();
    if (chunk === null) return text;
    text += dec.decode(chunk.bytes);
  }
}

describe("native channel", { skip: SKIP }, () => {
  let server: Server | undefined;
  checkFdLeaks(async () => {
    const s = server;
    server = undefined;
    if (s !== undefined) await new Promise((resolve) => s.close(resolve));
  });
  const dir = tempDir();
  let path = "";
  before(async () => {
    path = join(dir(), "pair.sock");
    const s = createServer({ pauseOnConnect: true, allowHalfOpen: true });
    server = s;
    await new Promise<void>((resolve) => s.listen(path, resolve));
  });

  test(
    "MSG_CTRUNC: the received fds are closed and the chunk is marked truncated",
    {
      ...T,
      // Seen on macOS 27: an fd that did not fit a truncated control buffer is still installed in the receiver,
      // unreported (so nobody can close it). Linux closes those. macOS is a development platform only.
      skip: LINUX ? false : "macOS leaks the fds that do not fit a truncated control buffer (kernel behaviour)",
    },
    async () => {
      const pair = await socketPair(path, server);
      pair.accepted.setAcceptFds(true);
      pair.accepted.setControlBufferFds(1);
      const { a, b } = channels(pair);
      a.capabilities.fdPassing?.setAllowOutput(true);
      b.capabilities.fdPassing?.setAcceptInput(true);
      // The test hook survives the channel's construction (it switched input off, then on again here).
      pair.accepted.setControlBufferFds(1);
      const x = pipeWith("x");
      const y = pipeWith("y");
      // CMSG_SPACE rounds the payload up to 8 bytes on 64-bit Linux: a "1-fd" buffer holds 2, so send 3.
      const sent = [x, y, x].map((fd) => ({ fd, close: () => undefined }));
      try {
        await a.write(enc.encode("m"), sent);
        const chunk = await b.read();
        assert.equal(chunk?.fdError, "truncated");
        assert.equal(chunk.fds, undefined);
        assert.equal(dec.decode(chunk.bytes), "m");
      } finally {
        a.close();
        b.close();
        native.close(x);
        native.close(y);
      }
    },
  );

  test("input off (default): on every kernel the bytes arrive and the fds are dropped silently", T, async () => {
    // The channel never touches SO_PASSRIGHTS by default (json-stream.c:691-692): the sender is not refused.
    const { a, b } = channels(await socketPair(path, server));
    const x = pipeWith("payload");
    try {
      a.capabilities.fdPassing?.setAllowOutput(true);
      b.capabilities.fdPassing?.setAcceptInput(false);
      await a.write(enc.encode("1\0"), [{ fd: x, close: () => undefined }]);
      const dropped = await b.read();
      assert.ok(dropped !== null);
      assert.equal(dec.decode(dropped.bytes), "1\0");
      assert.equal(dropped.fds, undefined, "dropped silently, as sd-varlink's plain recv()");
      assert.equal(dropped.fdError, undefined);
    } finally {
      native.close(x);
      a.close();
      b.close();
    }
  });

  test(
    "input off, strict channel: ≥ 6.16 the sender's write fails (EPERM, a clear local error), else the fds are dropped",
    T,
    async () => {
      const passRights = await kernelHasPassRights();
      const pair = await socketPair(path, server);
      const a = nativeChannel(native, pair.client, "client");
      const b = nativeChannel(native, pair.accepted, "server", true);
      const x = pipeWith("payload");
      try {
        a.capabilities.fdPassing?.setAllowOutput(true);
        // Strict: switching input off sets SO_PASSRIGHTS = 0 (a change from the kernel default).
        b.capabilities.fdPassing?.setAcceptInput(false);
        if (passRights) {
          await assert.rejects(a.write(enc.encode("1\0"), [{ fd: x, close: () => undefined }]), (e: unknown) => {
            return (
              e instanceof OperationNotSupportedError &&
              (e as { code?: string }).code === "EPERM" &&
              /does not accept file descriptors/.test(e.message)
            );
          });
        } else {
          await a.write(enc.encode("1\0"), [{ fd: x, close: () => undefined }]);
          const dropped = await b.read();
          assert.ok(dropped !== null);
          assert.equal(dec.decode(dropped.bytes), "1\0");
          assert.equal(dropped.fds, undefined, "dropped silently, as sd-varlink's plain recv()");
          assert.equal(dropped.fdError, undefined);
        }
      } finally {
        native.close(x);
        a.close();
        b.close();
      }
    },
  );

  test(
    "MSG_CTRUNC at a server: the call runs without its fds and onError says fds-dropped (json-stream.c:1308-1317)",
    { ...T, skip: LINUX ? false : "macOS leaks the fds that do not fit a truncated control buffer (kernel behaviour)" },
    async () => {
      const pair = await socketPair(path, server);
      const { a, b } = channels(pair);
      const errors: string[] = [];
      const srv = createVarlinkServer({
        allowFdPassingInput: true,
        onError: (_e, info) => errors.push(info.reason),
      });
      srv.addInterface("interface org.example.t\n\nmethod Count() -> (n: int)\n", {
        Count: (_p, ctx) => ({ n: ctx.fds.length }),
      });
      const x = pipeWith("x");
      try {
        const served = srv.handle(b);
        // After handle() switched input on: the test hook shrinks the server's control buffer.
        pair.accepted.setControlBufferFds(1);
        a.capabilities.fdPassing?.setAllowOutput(true);
        const call = enc.encode('{"method":"org.example.t.Count","parameters":{}}\0');
        await a.write(
          call,
          [x, x, x].map((fd) => ({ fd, close: () => undefined })),
        );
        let text = "";
        while (!text.includes("\0")) {
          const chunk = await a.read();
          if (chunk === null) break;
          text += dec.decode(chunk.bytes);
        }
        assert.equal(text, '{"parameters":{"n":0}}\0', "the call ran, without fds");
        assert.deepEqual(errors, ["fds-dropped"]);
        a.close();
        await served;
      } finally {
        native.close(x);
        a.close();
        b.close();
        await srv.shutdown({ graceful: false });
      }
    },
  );

  test("input on: fds are delivered with their chunk", T, async () => {
    const { a, b } = channels(await socketPair(path, server));
    const x = pipeWith("payload");
    try {
      a.capabilities.fdPassing?.setAllowOutput(true);
      b.capabilities.fdPassing?.setAcceptInput(true);
      await a.write(enc.encode("2\0"), [{ fd: x, close: () => undefined }]);
      const delivered = await b.read();
      assert.equal(delivered?.fds?.length, 1);
      for (const fd of delivered.fds) {
        assert.equal(readFd(fd.fd), "payload");
        fd.close();
      }
    } finally {
      native.close(x);
      a.close();
      b.close();
    }
  });

  test(
    "bounded reads: two queued sends, the second with an fd, come back as two chunks (fd on the second)",
    T,
    async () => {
      const { a, b } = channels(await socketPair(path, server));
      const x = pipeWith("payload");
      try {
        a.capabilities.fdPassing?.setAllowOutput(true);
        b.capabilities.fdPassing?.setAcceptInput(true);
        // Both are in b's receive queue before b reads: an unbounded recvmsg would return "A\0B\0" with B's fd.
        await a.write(enc.encode("A\0"));
        await a.write(enc.encode("B\0"), [{ fd: x, close: () => undefined }]);
        const first = await b.read();
        assert.ok(first !== null);
        assert.equal(dec.decode(first.bytes), "A\0");
        assert.equal(first.fds, undefined);
        const second = await b.read();
        assert.ok(second !== null);
        assert.equal(dec.decode(second.bytes), "B\0");
        assert.equal(second.fds?.length, 1);
        for (const fd of second.fds ?? []) fd.close();
      } finally {
        native.close(x);
        a.close();
        b.close();
      }
    },
  );

  test("bounded reads (input on): a message over 64 KiB arrives whole, its fd on the first chunk", T, async () => {
    // The peek window starts at 4 KiB and widens ×4 up to the 64 KiB buffer while no NUL is in sight.
    const { a, b } = channels(await socketPair(path, server));
    const x = pipeWith("big");
    try {
      a.capabilities.fdPassing?.setAllowOutput(true);
      b.capabilities.fdPassing?.setAcceptInput(true);
      const big = new Uint8Array(200 * 1024).fill(0x61);
      big[big.length - 1] = 0;
      const written = a.write(big, [{ fd: x, close: () => undefined }]);
      let total = 0;
      let fds = 0;
      let first = true;
      while (total < big.length) {
        const chunk = await b.read();
        assert.ok(chunk !== null);
        if (!first) assert.equal(chunk.fds, undefined, "the fd rides on the first chunk only");
        first = false;
        fds += chunk.fds?.length ?? 0;
        for (const fd of chunk.fds ?? []) fd.close();
        total += chunk.bytes.length;
      }
      await written;
      assert.equal(total, big.length);
      assert.equal(fds, 1);
    } finally {
      native.close(x);
      a.close();
      b.close();
    }
  });

  test("bounded reads (input on): 2000 small pipelined messages come back one per read, in order", T, async () => {
    const { a, b } = channels(await socketPair(path, server));
    try {
      b.capabilities.fdPassing?.setAcceptInput(true);
      const n = 2000;
      const parts: string[] = [];
      for (let i = 0; i < n; i++) parts.push(`{"i":${String(i)}}\0`);
      const written = a.write(enc.encode(parts.join("")));
      const got: string[] = [];
      let pending = "";
      while (got.length < n) {
        const chunk = await b.read();
        assert.ok(chunk !== null);
        const text = dec.decode(chunk.bytes);
        // Never past a NUL: a chunk holds at most one message end, and it is its last byte.
        assert.ok(text.indexOf("\0") === -1 || text.indexOf("\0") === text.length - 1, "one message end per read");
        pending += text;
        if (pending.endsWith("\0")) {
          got.push(pending.slice(0, -1));
          pending = "";
        }
      }
      await written;
      assert.deepEqual(
        got,
        parts.map((p) => p.slice(0, -1)),
      );
    } finally {
      a.close();
      b.close();
    }
  });

  for (const offset of [4095, 4096, 16383, 16384, 65535, 65536])
    test(
      `bounded reads (input on): a message whose NUL is at offset ${String(offset)}, then one with an fd: each gets its own fds`,
      T,
      async () => {
        const { a, b } = channels(await socketPair(path, server));
        const x = pipeWith("second");
        try {
          a.capabilities.fdPassing?.setAllowOutput(true);
          b.capabilities.fdPassing?.setAcceptInput(true);
          const first = new Uint8Array(offset + 1).fill(0x61);
          first[offset] = 0;
          const widenings = native.stats().peekWidenings;
          // Back to back: the second (with its fd) is queued right behind the first (Linux). macOS refuses a sendmsg
          // with fds while unread bytes fill the peer's buffer (EMSGSIZE, not EAGAIN), so there the second goes once
          // the first message was read (its reads end at a send with fds anyway; the window logic is what is tested).
          const second = (): Promise<void> => a.write(enc.encode("B\0"), [{ fd: x, close: () => undefined }]);
          let sendSecond: () => void = () => undefined;
          const written = LINUX
            ? Promise.all([a.write(first), second()])
            : Promise.all([a.write(first), new Promise<void>((resolve) => (sendSecond = resolve)).then(second)]);
          written.catch(() => undefined);
          // Let the kernel queue as much as it takes before reading, so the peek sees full windows.
          await new Promise((resolve) => setTimeout(resolve, 20));
          const messages: { length: number; fds: number }[] = [];
          let length = 0;
          let fds = 0;
          while (messages.length < 2) {
            const chunk = await b.read();
            assert.ok(chunk !== null);
            const nul = chunk.bytes.indexOf(0);
            assert.ok(nul === -1 || nul === chunk.bytes.length - 1, "never past a NUL");
            if (chunk.fds !== undefined) {
              assert.equal(length, 0, "fds only on a message's first chunk");
              for (const fd of chunk.fds) {
                assert.equal(readFd(fd.fd), "second");
                fd.close();
              }
            }
            fds += chunk.fds?.length ?? 0;
            length += chunk.bytes.length;
            if (nul !== -1) {
              messages.push({ length, fds });
              length = 0;
              fds = 0;
              sendSecond();
            }
          }
          await written;
          assert.deepEqual(messages, [
            { length: offset + 1, fds: 0 },
            { length: 2, fds: 1 },
          ]);
          // The first window is 4 KiB: a NUL beyond it needs the widening (where the kernel queued enough to fill
          // the window; macOS's 8 KiB unix socket buffers do only for the smallest cases, so this is Linux only).
          if (offset >= 4096 && (LINUX || offset < 8192))
            assert.ok(native.stats().peekWidenings > widenings, "the peek window was widened");
        } finally {
          native.close(x);
          a.close();
          b.close();
        }
      },
    );

  test("strict: the first setAcceptFds always reaches the SO_PASSRIGHTS setsockopt (M1)", T, async () => {
    // An accepted socket inherits its listener's SO_PASSRIGHTS, which strict mode may have set off: the first strict
    // call must not assume the kernel default (on) and skip turning it on. Counted on every platform.
    const pair = await socketPair(path, server);
    const a = nativeChannel(native, pair.client, "client");
    const b = nativeChannel(native, pair.accepted, "server", true);
    try {
      const before = native.stats().passRightsCalls;
      b.capabilities.fdPassing?.setAcceptInput(true);
      assert.equal(native.stats().passRightsCalls, before + 1, "the first strict call sets it, on too");
      // Known from now on, on every kernel (without SO_PASSRIGHTS the requested state is recorded anyway, as
      // json-stream.c:711 does after ignoring "not supported"): the same value again is no change
      // (json-stream.c:691-692), another one is.
      b.capabilities.fdPassing?.setAcceptInput(true);
      assert.equal(native.stats().passRightsCalls, before + 1, "no setsockopt for an unchanged value");
      b.capabilities.fdPassing?.setAcceptInput(false);
      assert.equal(native.stats().passRightsCalls, before + 2);
      b.capabilities.fdPassing?.setAcceptInput(false);
      assert.equal(native.stats().passRightsCalls, before + 2);
      // Non-strict channels never touch it.
      const n = native.stats().passRightsCalls;
      a.capabilities.fdPassing?.setAcceptInput(true);
      a.capabilities.fdPassing?.setAcceptInput(false);
      assert.equal(native.stats().passRightsCalls, n);
    } finally {
      a.close();
      b.close();
    }
  });

  test("setters type-check their arguments", T, async () => {
    const pair = await socketPair(path, server);
    try {
      for (const call of [
        () => {
          pair.client.setAcceptFds("yes" as unknown as boolean);
        },
        () => {
          pair.client.setControlBufferFds("3" as unknown as number);
        },
        () => {
          native.setPassRights(pair.client.getFd(), 1 as unknown as boolean);
        },
      ])
        assert.throws(call, (e: unknown) => (e as { code?: string }).code === "ERR_INVALID_ARG_TYPE");
    } finally {
      pair.client.close();
      pair.accepted.close();
    }
  });

  test("output off: write() with fds rejects (OperationNotSupportedError)", T, async () => {
    const { a, b } = channels(await socketPair(path, server));
    await assert.rejects(a.write(enc.encode("x"), [{ fd: 0, close: () => undefined }]), OperationNotSupportedError);
    a.close();
    b.close();
  });

  test("end() half-closes; both ends done → closed resolves by itself", T, async () => {
    const { a, b } = channels(await socketPair(path, server));
    await a.write(enc.encode("ping"));
    await a.end();
    await assert.rejects(a.write(enc.encode("late")), ConnectionClosedError);
    assert.equal(await readAll(b), "ping");
    await b.write(enc.encode("pong"));
    await b.end();
    assert.equal(await readAll(a), "pong");
    await a.closed;
    await b.closed;
  });

  test("close(): idempotent, a pending read gives null, later writes reject", T, async () => {
    const { a, b } = channels(await socketPair(path, server));
    const pending = a.read();
    a.close();
    a.close();
    assert.equal(await pending, null);
    assert.equal(await a.read(), null);
    await assert.rejects(a.write(enc.encode("x")), ConnectionClosedError);
    await a.closed;
    // The peer sees EOF.
    assert.equal(await b.read(), null);
    b.close();
  });

  test("a write failing because the peer is gone keeps what the peer sent readable", T, async () => {
    const { a, b } = channels(await socketPair(path, server));
    await b.write(enc.encode("goodbye"));
    b.close();
    let failure: unknown;
    const chunk = new Uint8Array(64 * 1024);
    for (let i = 0; i < 1000 && failure === undefined; i++)
      try {
        await a.write(chunk);
      } catch (e) {
        failure = e;
      }
    assert.ok(failure !== undefined, "a write must fail");
    const code = (failure as { code?: string }).code ?? "";
    assert.ok(["EPIPE", "ECONNRESET", "ENOTCONN"].includes(code), code);
    await assert.rejects(a.write(chunk), (e: unknown) => e === failure);
    let text = "";
    try {
      text = await readAll(a);
    } catch {
      // A reset after the data is fine: the data came first.
    }
    assert.equal(text, "goodbye");
    a.close();
  });

  test("helpers: dup is close-on-exec and ≥ 3, isUnixSocket, setCloexec, memfdSealed (Linux)", T, () => {
    const [r, w] = native.pipe();
    const d = native.dup(r);
    assert.ok(d >= 3);
    assert.equal(native.isUnixSocket(r), false);
    native.setCloexec(r);
    assert.throws(() => {
      native.close(-1);
    }, /non-negative/);
    for (const fd of [r, w, d]) native.close(fd);
    assert.throws(
      () => {
        native.close(d);
      },
      (e: unknown) => (e as { code?: string }).code === "EBADF",
    );
    if (LINUX) {
      const m = native.memfdSealed("t", enc.encode("sealed"));
      assert.equal(readFd(m), "sealed");
      assert.ok(fstatSync(m).isFile());
      native.close(m);
    } else {
      assert.throws(
        () => native.memfdSealed("t", enc.encode("x")),
        (e: unknown) => (e as { code?: string }).code === "ENOSYS",
      );
    }
  });

  test("tracking a number again replaces its stale entry (closed behind the addon's back, reused)", T, () => {
    const [r, w] = native.pipe();
    try {
      const base = native.stats().trackedFds;
      const d = native.dup(r, true);
      assert.equal(native.stats().trackedFds, base + 1);
      // Closed without the addon knowing (still tracked), then the lowest free number is d again.
      closeSync(d);
      const again = native.dup(w, true);
      assert.equal(again, d, "the number was reused");
      assert.equal(native.stats().trackedFds, base + 1, "one entry per number");
      native.close(again);
      assert.equal(native.stats().trackedFds, base);
    } finally {
      native.close(r);
      native.close(w);
    }
  });

  test("errors carry code, errno and syscall", T, () => {
    try {
      native.connect(Buffer.from(join(dir(), "missing.sock")));
      assert.fail("connect must throw");
    } catch (e) {
      const err = e as { code?: string; errno?: number; syscall?: string };
      assert.equal(err.code, "ENOENT");
      assert.ok(typeof err.errno === "number" && err.errno < 0);
      assert.equal(err.syscall, "connect");
    }
  });
});
