// Socket activation (DESIGN.md §5.8): listenFromEnv/listenAuto in a child that inherits fds and LISTEN_* (set by
// `/bin/sh -c 'LISTEN_PID=$$ … exec'`), listenStdio, mergeListeners, listen({fd}, {address}).
import assert from "node:assert/strict";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import type { ByteChannel, Listener } from "../../../src/core/protocol/index.ts";
import { connect, fromNodeSocket, listen, listenStdio, mergeListeners } from "../../../src/node/index.ts";
import { createConnection, type Connection } from "../../../src/rpc/index.ts";
import { pair } from "../../../src/testing/index.ts";
import { closeServer, listening, tempDir } from "./helpers.ts";

const dir = tempDir();
const CHILD = resolve(import.meta.dirname, "activation-child.ts");
const LINUX = process.platform === "linux";
const CONNECTED = LINUX ? "auto" : "connected";
const LISTEN_PID_SCRIPT = 'LISTEN_PID=$$; export LISTEN_PID; exec "$0" "$@"';

/** The fd of a listening net.Server (private `_handle.fd`). */
function fdOf(server: NetServer): number {
  const fd = (server as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  assert.ok(typeof fd === "number" && fd >= 0, "net.Server._handle.fd is not available");
  return fd;
}

/** A listening unix socket bound as `<name>.tmp` and moved to `<name>` (so our close() leaves the path alone). */
async function unixSocket(name: string): Promise<{ server: NetServer; fd: number; path: string; procPath: string }> {
  const path = join(dir(), name);
  const server = createNetServer();
  await listening(server, { path: `${path}.tmp` });
  await rename(`${path}.tmp`, path);
  // /proc/net/unix reports the name the socket was bound to.
  return { server, fd: fdOf(server), path, procPath: `${path}.tmp` };
}

interface Activation {
  /** fds 3, 4, … ("pipe" = a connected socketpair end; its parent end is `sockets[i]`). */
  fds?: (number | "pipe")[];
  /** LISTEN_* and other variables; LISTEN_PID is set to the child's pid unless `pid` says otherwise. */
  env?: Record<string, string>;
  /** "own" (default): LISTEN_PID = the child's pid; "other": "1"; "absent": not set. */
  pid?: "own" | "other" | "absent";
  args?: string[];
}

function activate(a: Activation): { child: ChildProcess; exited: Promise<number | null>; sockets: Socket[] } {
  const ours = ["LISTEN_PID", "LISTEN_PIDFDID", "LISTEN_FDS", "LISTEN_FDNAMES", "SYSTEMD_VARLINK_LISTEN"];
  const env: Record<string, string | undefined> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !ours.includes(key))),
    ...a.env,
  };
  const pid = a.pid ?? "own";
  if (pid === "other") env.LISTEN_PID = "1";
  const fds = a.fds ?? [];
  const stdio: StdioOptions = ["ignore", "pipe", "inherit", ...fds];
  const args = [CHILD, ...(a.args ?? [])];
  const child: ChildProcess =
    pid === "own"
      ? spawn("/bin/sh", ["-c", LISTEN_PID_SCRIPT, process.execPath, ...args], { stdio, env })
      : spawn(process.execPath, args, { stdio, env });
  const exited = new Promise<number | null>((r) => child.once("exit", r));
  const sockets: Socket[] = [];
  const pipes = child.stdio as unknown as (Socket | null)[];
  fds.forEach((fd, i) => {
    const socket = pipes[3 + i];
    if (fd !== "pipe" || socket === undefined || socket === null) return;
    socket.allowHalfOpen = true;
    sockets.push(socket);
  });
  return { child, exited, sockets };
}

interface Report {
  result: "null" | "listener" | "error";
  address?: string;
  message?: string;
  after?: Record<string, string>;
  exists?: boolean;
}

/** Runs the child in --report mode: its one JSON line. */
async function report(a: Activation): Promise<Report> {
  const { child, exited } = activate({ ...a, args: ["--report", ...(a.args ?? [])] });
  const stdout = child.stdout;
  assert.ok(stdout !== null);
  let out = "";
  for await (const chunk of stdout) out += String(chunk);
  assert.equal(await exited, 0);
  return JSON.parse(out) as Report;
}

interface PingReply {
  pid: number;
  before: Record<string, string>;
  after: Record<string, string>;
  address: string;
}

const ping = async (conn: Connection): Promise<PingReply> =>
  (await conn.call("org.example.child.Ping")) as unknown as PingReply;

describe("listenFromEnv in an activated child", () => {
  test("a listening unix fd named varlink: served, variables unset, exits once idle", async () => {
    const s = await unixSocket("l1");
    const { child, exited } = activate({
      fds: [s.fd],
      env: { LISTEN_FDS: "1", LISTEN_FDNAMES: "varlink", LISTEN_PIDFDID: "42" },
      args: ["--accept=auto"],
    });
    await closeServer(s.server);
    const conn = await connect(`unix:${s.path}`);
    const reply = await ping(conn);
    assert.equal(reply.pid, child.pid);
    assert.deepEqual(reply.before, {
      LISTEN_PID: String(child.pid),
      LISTEN_FDS: "1",
      LISTEN_FDNAMES: "varlink",
      LISTEN_PIDFDID: "42",
    });
    assert.deepEqual(reply.after, {});
    // On Linux the address comes from /proc (the bound name); elsewhere Node cannot name the socket.
    assert.equal(reply.address, LINUX ? `unix:${s.procPath}` : "fd:3");
    await conn.close();
    assert.equal(await exited, 0, "exitOnIdle: 0 shut the server down; closed resolved; exit(0)");
    assert.ok(existsSync(s.path), "closing a {fd} listener never unlinks");
  });

  test(`a connected fd (accept: ${CONNECTED}) is served as one connection`, async () => {
    const { exited, sockets } = activate({
      fds: ["pipe"],
      env: { LISTEN_FDS: "1", LISTEN_FDNAMES: "varlink" },
      args: [`--accept=${CONNECTED}`],
    });
    const [socket] = sockets;
    assert.ok(socket !== undefined);
    const conn = createConnection(fromNodeSocket(socket));
    const reply = await ping(conn);
    assert.equal(reply.address, "fd:3");
    assert.deepEqual(reply.after, {});
    await conn.close();
    assert.equal(await exited, 0);
  });

  test(
    "/proc detection: a connected socketpair with accept: auto",
    { skip: LINUX ? false : "needs Linux /proc (no SO_ACCEPTCONN without the native addon)" },
    async () => {
      const { exited, sockets } = activate({ fds: ["pipe"], env: { LISTEN_FDS: "1" }, args: ["--accept=auto"] });
      const [socket] = sockets;
      assert.ok(socket !== undefined);
      const conn = createConnection(fromNodeSocket(socket));
      assert.equal((await ping(conn)).address, "fd:3");
      await conn.close();
      assert.equal(await exited, 0);
    },
  );

  test("LISTEN_PID of another process or absent → null (variables unset anyway)", async () => {
    for (const pid of ["other", "absent"] as const) {
      const r = await report({ pid, env: { LISTEN_FDS: "1", LISTEN_FDNAMES: "varlink" } });
      assert.equal(r.result, "null", pid);
      assert.deepEqual(r.after, {}, pid);
    }
  });

  test("malformed LISTEN_FDS / LISTEN_FDNAMES are TypeErrors naming the variable (unset anyway)", async () => {
    for (const [env, name] of [
      [{ LISTEN_FDS: "0" }, "LISTEN_FDS"],
      [{ LISTEN_FDS: "abc" }, "LISTEN_FDS"],
      [{ LISTEN_FDS: "1025" }, "LISTEN_FDS"],
      [{ LISTEN_FDS: "-1" }, "LISTEN_FDS"],
      [{ LISTEN_FDS: "1", LISTEN_FDNAMES: "varlink:extra" }, "LISTEN_FDNAMES"],
      [{ LISTEN_FDS: "2", LISTEN_FDNAMES: "varlink" }, "LISTEN_FDNAMES"],
    ] as const) {
      const r = await report({ env });
      assert.equal(r.result, "error", JSON.stringify(env));
      assert.match(r.message ?? "", /^TypeError: /);
      assert.ok(r.message?.includes(name), r.message);
      assert.deepEqual(r.after, {});
    }
  });

  test("selection by name among several fds; empty names count", async () => {
    const a = await unixSocket("n-a");
    const b = await unixSocket("n-b");
    try {
      const env = { LISTEN_FDS: "3", LISTEN_FDNAMES: "other::varlink" };
      const fds = [a.fd, b.fd, b.fd];
      const byDefault = await report({ fds, env, args: ["--accept=listening"] });
      assert.equal(byDefault.address, LINUX ? `unix:${b.procPath}` : "fd:5");
      const named = await report({ fds, env, args: ["--accept=listening", "--name=other"] });
      assert.equal(named.address, LINUX ? `unix:${a.procPath}` : "fd:3");
      const none = await report({ fds, env, args: ["--name=missing"] });
      assert.equal(none.result, "null");
    } finally {
      await closeServer(a.server);
      await closeServer(b.server);
    }
  });

  test("several fds with the name: one merged listener serving all", async () => {
    const a = await unixSocket("m-a");
    const b = await unixSocket("m-b");
    const { exited } = activate({
      fds: [a.fd, b.fd],
      env: { LISTEN_FDS: "2", LISTEN_FDNAMES: "varlink:varlink" },
      args: ["--accept=listening"],
    });
    await closeServer(a.server);
    await closeServer(b.server);
    const ca = await connect(`unix:${a.path}`);
    const cb = await connect(`unix:${b.path}`);
    const [ra, rb] = await Promise.all([ping(ca), ping(cb)]);
    assert.equal(ra.pid, rb.pid);
    assert.equal(ra.address, LINUX ? `unix:${a.procPath}` : "fd:3", "the merged address is the first one's");
    await ca.close();
    await cb.close();
    assert.equal(await exited, 0);
  });

  test("without LISTEN_FDNAMES a single fd is used, several are not", async () => {
    const a = await unixSocket("u-a");
    try {
      const one = await report({ fds: [a.fd], env: { LISTEN_FDS: "1" }, args: ["--accept=listening"] });
      assert.equal(one.result, "listener");
      const two = await report({ fds: [a.fd, a.fd], env: { LISTEN_FDS: "2" } });
      assert.equal(two.result, "null");
    } finally {
      await closeServer(a.server);
    }
  });

  test("unsetEnvironment: false keeps the variables", async () => {
    const a = await unixSocket("k-a");
    try {
      const r = await report({
        fds: [a.fd],
        env: { LISTEN_FDS: "1", LISTEN_FDNAMES: "varlink" },
        args: ["--accept=listening", "--keep-env"],
      });
      assert.equal(r.result, "listener");
      const after = r.after ?? {};
      assert.equal(after.LISTEN_FDS, "1");
      assert.equal(after.LISTEN_FDNAMES, "varlink");
      assert.match(after.LISTEN_PID ?? "", /^\d+$/);
    } finally {
      await closeServer(a.server);
    }
  });
});

describe("listenAuto in a child", () => {
  test("SYSTEMD_VARLINK_LISTEN=<address> listens there (and is not unset)", async () => {
    const path = join(dir(), "auto1");
    const r = await report({ pid: "absent", env: { SYSTEMD_VARLINK_LISTEN: `unix:${path}` } });
    assert.equal(r.result, "listener");
    assert.equal(r.address, `unix:${path}`);
    assert.equal(r.after?.SYSTEMD_VARLINK_LISTEN, `unix:${path}`);
  });

  test("LISTEN_FDS plus SYSTEMD_VARLINK_LISTEN: merged, the activation fd first", async () => {
    const a = await unixSocket("auto2");
    try {
      const r = await report({
        fds: [a.fd],
        env: { LISTEN_FDS: "1", LISTEN_FDNAMES: "varlink", SYSTEMD_VARLINK_LISTEN: `unix:${join(dir(), "auto3")}` },
        args: ["--accept=listening"],
      });
      assert.equal(r.result, "listener");
      assert.equal(r.address, LINUX ? `unix:${a.procPath}` : "fd:3");
    } finally {
      await closeServer(a.server);
    }
  });

  test("an invalid SYSTEMD_VARLINK_LISTEN rejects", async () => {
    const r = await report({ pid: "absent", env: { SYSTEMD_VARLINK_LISTEN: "nonsense" } });
    assert.equal(r.result, "error");
  });

  test("nothing at all → null", async () => {
    assert.equal((await report({ pid: "absent" })).result, "null");
  });
});

describe("listen({fd}, { address })", () => {
  test("the given address replaces fd:<n>; closing never unlinks it", async () => {
    const a = await unixSocket("fa");
    try {
      const r = await report({ fds: [a.fd], pid: "absent", args: [`--fd-address=unix:${a.path}`] });
      assert.deepEqual(r, { result: "listener", address: `unix:${a.path}`, exists: true });
      const bad = await report({ fds: [a.fd], pid: "absent", args: ["--fd-address=nonsense"] });
      assert.equal(bad.result, "error");
      assert.match(bad.message ?? "", /^TypeError: /);
    } finally {
      await closeServer(a.server);
    }
  });

  test("the address option needs {fd}", async () => {
    await assert.rejects(listen("tcp:127.0.0.1:0", { address: "tcp:127.0.0.1:1" }), TypeError);
  });
});

/** A listener over given channels (then done) that records close(). */
class FakeListener implements Listener {
  readonly address: string;
  closed = 0;
  readonly #channels: ByteChannel[];
  #wake: (() => void) | undefined;
  #ended = false;

  constructor(address: string, channels: ByteChannel[], endAfter = true) {
    this.address = address;
    this.#channels = channels;
    this.#ended = endAfter;
  }

  [Symbol.asyncIterator](): AsyncIterator<ByteChannel> {
    return {
      next: async () => {
        for (;;) {
          const c = this.#channels.shift();
          if (c !== undefined) return { value: c, done: false };
          if (this.#ended) return { value: undefined, done: true };
          await new Promise<void>((r) => (this.#wake = r));
        }
      },
      return: () => {
        this.#ended = true;
        this.#wake?.();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  close(): Promise<void> {
    this.closed++;
    this.#ended = true;
    this.#wake?.();
    return Promise.resolve();
  }
}

describe("mergeListeners", () => {
  test("yields from all until all are done; address is the first one's", async () => {
    const [a1] = pair();
    const [b1] = pair();
    const [b2] = pair();
    const merged = mergeListeners([new FakeListener("unix:/a", [a1]), new FakeListener("unix:/b", [b1, b2])]);
    assert.equal(merged.address, "unix:/a");
    const got: ByteChannel[] = [];
    for await (const c of merged) got.push(c);
    assert.equal(got.length, 3);
    assert.ok(got.includes(a1) && got.includes(b1) && got.includes(b2));
  });

  test("close() closes all and ends a pending next()", async () => {
    const a = new FakeListener("unix:/a", [], false);
    const b = new FakeListener("unix:/b", [], false);
    const merged = mergeListeners([a, b]);
    const it = merged[Symbol.asyncIterator]();
    const next = it.next();
    await merged.close();
    assert.deepEqual(await next, { value: undefined, done: true });
    assert.equal(a.closed + b.closed, 2);
  });

  test("one iteration at a time; again after return()", async () => {
    const merged = mergeListeners([new FakeListener("unix:/a", [], false)]);
    const it = merged[Symbol.asyncIterator]();
    assert.throws(() => merged[Symbol.asyncIterator](), TypeError);
    await it.return?.();
    const again = merged[Symbol.asyncIterator]();
    await again.return?.();
  });

  test("a source's iteration error reaches next() once", async () => {
    const boom = new Error("boom");
    const failing: Listener = {
      address: "unix:/f",
      close: () => Promise.resolve(),
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(boom) }),
    };
    const merged = mergeListeners([failing, new FakeListener("unix:/a", [], false)]);
    const it = merged[Symbol.asyncIterator]();
    await assert.rejects(it.next(), (e) => e === boom);
    await merged.close();
  });

  test("needs at least one listener", () => {
    assert.throws(() => mergeListeners([]), TypeError);
  });
});

describe("listenStdio", () => {
  test("address stdio:; close() before taking the channel leaves process.stdin alone", async () => {
    const before = process.stdin.listenerCount("data");
    const l = listenStdio();
    assert.equal(l.address, "stdio:");
    await l.close();
    const it = l[Symbol.asyncIterator]();
    assert.deepEqual(await it.next(), { value: undefined, done: true });
    assert.equal(process.stdin.listenerCount("data"), before);
  });
});
