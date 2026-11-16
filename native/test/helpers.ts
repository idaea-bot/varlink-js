// Shared helpers of the varlink-js-native tests (DESIGN.md §4.15): the addon, the skip reason, fd counting, a server
// with fd-passing test methods, and small fd I/O helpers.
import assert from "node:assert/strict";
import { readdirSync, readSync, writeSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createServer,
  VarlinkError,
  type CallContext,
  type FdHandle,
  type PeerCredentials,
  type Server,
  type ServerOptions,
} from "../../src/index.ts";
import { connect, listen, type NodeListener } from "../../src/node/index.ts";
import type { Connection } from "../../src/rpc/index.ts";
import * as native from "../index.js";

export { native };

/** Why the tests cannot run here (undefined if they can): the addon must be built and loadable. */
export const SKIP: string | undefined = native.isAvailable()
  ? undefined
  : `varlink-js-native is not available (${native.loadError?.message ?? "unknown reason"}); run npm --prefix native run build`;

export const LINUX: boolean = process.platform === "linux";
/** Per-test timeout (`VJN_TIMEOUT` ms overrides it, e.g. when hunting a hang). */
export const T: { timeout: number } = { timeout: Number(process.env.VJN_TIMEOUT ?? 30_000) };

/** The number of open fds of this process. */
export function openFds(): number {
  return readdirSync(LINUX ? "/proc/self/fd" : "/dev/fd").length;
}

/**
 * Asserts that a test file leaves no fd behind: counts in `before`, then again in `after` (polled briefly: closing
 * a libuv handle completes a turn later), after `cleanup`. Call it first in the suite.
 */
export function checkFdLeaks(cleanup?: () => Promise<void>): void {
  let start = 0;
  before(() => {
    // The runtime opens some fds lazily (on macOS a kqueue when stdout, a socket under `node --test`, is first
    // used): make that happen before counting.
    process.stdout.write("");
    process.stderr.write("");
    start = openFds();
  });
  after(async () => {
    // File-level resources opened after the first count (a listening server) go first.
    await cleanup?.();
    let now = openFds();
    for (let i = 0; i < 50 && now !== start; i++) {
      await sleep(20);
      now = openFds();
    }
    assert.equal(now, start, `fds leaked: ${String(now - start)}`);
  });
}

/** A fresh temp dir for the current file, removed in `after`. */
export function tempDir(): () => string {
  let dir = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "vjn-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return () => dir;
}

/** Reads `fd` (blocking) to EOF as UTF-8. */
export function readFd(fd: number): string {
  const buf = Buffer.alloc(65536);
  let out = "";
  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, null);
    if (n === 0) return out;
    out += buf.toString("utf8", 0, n);
  }
}

/** A pipe whose write end got `text` and was closed: returns the read end (ours to close). */
export function pipeWith(text: string): number {
  const [r, w] = native.pipe();
  writeSync(w, text);
  native.close(w);
  return r;
}

export const IDL = `interface org.example.fd

# Writes text into the fd sent with the call (pad: ignored, to make the call big).
method Write(text: string, pad: ?string) -> ()

# Replies with a pipe (in the reply's fds) holding text.
method Open(text: string) -> ()

# n replies, each with a pipe holding its index.
method Stream(n: int) -> (i: int)

# How many fds came with the call (left to the library to close).
method Count() -> (n: int)

method Peer() -> (uid: int, gid: int, pid: int, pidfd: bool)

method Ping() -> ()

# A reply of size bytes, with a pipe holding "big".
method Big(size: int) -> (data: string)

# Echoes the upgraded stream.
# [Requires 'upgrade' flag]
method Cat() -> ()

# Waits until the test releases it (Seen.release), holding the peer's pidfd and the fds sent with it meanwhile.
method Hold() -> ()

# Keeps ctx.fds and ctx.peer for the test to look at after the call (claims fd 0 if claim).
method Keep(claim: bool) -> ()

# Fails with Nope, carrying a pipe holding text.
method FailWithFd(text: string) -> ()

error Nope ()
`;

/** What the test service saw and kept. */
export interface Seen {
  counts: number[];
  /** Resolvers of pending Hold calls. */
  holds: (() => void)[];
  /** The pidfd numbers Hold calls fetched (-1: none). */
  pidfds: number[];
  /** The received fd numbers of Hold calls (ctx.fds). */
  held: number[][];
  /** ctx.fds and ctx.peer of Keep calls; the fd it claimed, if any. */
  kept: { fds: readonly FdHandle[]; peer: PeerCredentials | undefined; claimed: FdHandle | undefined }[];
}

/** Lets every pending Hold call return. */
export function release(seen: Seen): void {
  for (const r of seen.holds.splice(0)) r();
}

/** Attaches a pipe holding `text` to the call's next reply; pushFds duplicated it, so ours goes at once. */
function push(ctx: CallContext, text: string): void {
  const r = pipeWith(text);
  try {
    ctx.pushFds(r);
  } finally {
    native.close(r);
  }
}

export function fdService(
  server: Server,
  seen: Seen = { counts: [], holds: [], kept: [], pidfds: [], held: [] },
): Seen {
  server.addInterface(IDL, {
    Hold: (_p: Record<string, never>, ctx: CallContext) =>
      new Promise<Record<string, never>>((resolve) => {
        // Fetches the peer's pidfd (Linux ≥ 6.5): held by the connection while the call waits.
        seen.pidfds.push(ctx.peer?.pidfd?.fd ?? -1);
        seen.held.push(ctx.fds.map((f) => f.fd));
        seen.holds.push(() => {
          resolve({});
        });
      }),
    Keep: (p: { claim: boolean }, ctx: CallContext) => {
      seen.kept.push({ fds: ctx.fds, peer: ctx.peer, claimed: p.claim ? ctx.takeFd(0) : undefined });
      return {};
    },
    FailWithFd: (p: { text: string }, ctx: CallContext) => {
      push(ctx, p.text);
      throw new VarlinkError("org.example.fd.Nope", {});
    },
    Write: (p: { text: string }, ctx: CallContext) => {
      const fd = ctx.takeFd(0);
      try {
        writeSync(fd.fd, p.text);
      } finally {
        fd.close();
      }
      return {};
    },
    Open: (p: { text: string }, ctx: CallContext) => {
      push(ctx, p.text);
      return {};
    },
    Stream: async function* (p: { n: number }, ctx: CallContext) {
      for (let i = 0; i < p.n; i++) {
        // A turn between replies, like a real producer.
        await Promise.resolve();
        push(ctx, String(i));
        if (i === p.n - 1) return { i };
        yield { i };
      }
      return { i: -1 };
    },
    Count: (_p: Record<string, never>, ctx: CallContext) => {
      seen.counts.push(ctx.fds.length);
      return { n: ctx.fds.length };
    },
    Peer: (_p: Record<string, never>, ctx: CallContext) => {
      const peer = ctx.peer;
      if (peer === undefined) return { uid: -1, gid: -1, pid: -1, pidfd: false };
      return { uid: peer.uid, gid: peer.gid, pid: peer.pid, pidfd: peer.pidfd !== undefined && peer.pidfd.fd >= 0 };
    },
    Ping: () => ({}),
    Big: (p: { size: number }, ctx: CallContext) => {
      push(ctx, "big");
      return { data: "x".repeat(p.size) };
    },
    Cat: async (_p: Record<string, never>, ctx: CallContext) => {
      const ch = await ctx.upgrade();
      for (;;) {
        const chunk = await ch.read();
        if (chunk === null) break;
        await ch.write(chunk.bytes);
      }
      await ch.end();
      return {};
    },
  });
  return seen;
}

/** A running fd test server on a unix socket in `dir`, with the addon. */
export interface Fixture {
  readonly server: Server;
  readonly listener: NodeListener;
  readonly address: string;
  readonly seen: Seen;
  readonly errors: { reason: string; error: unknown }[];
  connect(options?: { native?: boolean; maxMessageSize?: number }): Promise<Connection>;
  close(): Promise<void>;
}

export async function startServer(
  dir: string,
  name: string,
  options?: ServerOptions,
  strict = false,
): Promise<Fixture> {
  const errors: { reason: string; error: unknown }[] = [];
  const server = createServer({
    allowFdPassingInput: true,
    allowFdPassingOutput: true,
    onError: (error, info) => {
      errors.push({ reason: info.reason, error });
    },
    ...options,
  });
  const seen = fdService(server);
  const address = `unix:${join(dir, name)}`;
  // Default: SO_PASSRIGHTS left alone, as sd-varlink. `strict`: the listener (and each connection) gets it from the
  // server's input setting, as with SD_VARLINK_SERVER_FD_PASSING_INPUT_STRICT.
  const listener = await listen(address, {
    native,
    ...(strict ? { fdPassingInputStrict: true, allowFdPassingInput: options?.allowFdPassingInput ?? true } : {}),
  });
  server.serve(listener);
  const conns: Connection[] = [];
  return {
    server,
    listener,
    address,
    seen,
    errors,
    async connect(o) {
      const conn = await connect(address, {
        timeout: 20_000,
        ...(o?.native === false ? {} : { native }),
        ...(o?.maxMessageSize === undefined ? {} : { maxMessageSize: o.maxMessageSize }),
      });
      conns.push(conn);
      return conn;
    },
    async close() {
      await Promise.all(conns.map((c) => c.close()));
      await server.shutdown({ graceful: false });
    },
  };
}

let passRights: Promise<boolean> | undefined;

/**
 * Whether this kernel has SO_PASSRIGHTS (Linux ≥ 6.16), observed by setting it on a real socket: there, fds sent to a
 * socket with it off make the SENDER's sendmsg fail with EPERM; elsewhere they arrive and the receiver drops them.
 */
export function kernelHasPassRights(): Promise<boolean> {
  passRights ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), "vjn-probe-"));
    const server = createNetServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(join(dir, "p.sock"), resolve);
      });
      const fd = (server as unknown as { _handle: { fd: number } })._handle.fd;
      return native.setPassRights(fd, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return passRights;
}

/** Polls `predicate` (every 10 ms, up to `ms`). */
export async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await sleep(10);
  }
}
