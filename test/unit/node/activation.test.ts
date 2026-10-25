// Socket activation (DESIGN.md §5.8): listenFromEnv/listenAuto in a child that inherits fds and LISTEN_* (set by
// `/bin/sh -c 'LISTEN_PID=$$ … exec'`), listenStdio, mergeListeners, listen({fd}, {address}).
import assert from "node:assert/strict";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import type { ByteChannel, Listener } from "../../../src/core/protocol/index.ts";
import { procLookup, procSockets } from "../../../src/node/activation.ts";
import { connect, fromNodeSocket, listen, listenStdio, mergeListeners } from "../../../src/node/index.ts";
import { createConnection, createServer, type Connection } from "../../../src/rpc/index.ts";
import { pair } from "../../../src/testing/index.ts";
import { closeServer, listening, tempDir, turns, SPAWN_SKIP } from "./helpers.ts";

const dir = tempDir();
const CHILD = resolve(import.meta.dirname, "activation-child.ts");
const LINUX = process.platform === "linux";
const CONNECTED = LINUX ? "auto" : "connected";
const LISTEN_PID_SCRIPT = 'LISTEN_PID=$$; export LISTEN_PID; exec "$0" "$@"';
/** What a connected-mode exec: runs: the hint names the same pid as LISTEN_PID. */
const HINT_SCRIPT =
  'LISTEN_PID=$$; VARLINK_JS_ACTIVATION=connected:$$; export LISTEN_PID VARLINK_JS_ACTIVATION; exec "$0" "$@"';

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
  /** Set VARLINK_JS_ACTIVATION=connected:<the child's pid> as our exec: does (needs pid "own"). */
  hint?: boolean;
  args?: string[];
}

function activate(a: Activation): { child: ChildProcess; exited: Promise<number | null>; sockets: Socket[] } {
  const ours = [
    "LISTEN_PID",
    "LISTEN_PIDFDID",
    "LISTEN_FDS",
    "LISTEN_FDNAMES",
    "SYSTEMD_VARLINK_LISTEN",
    "VARLINK_JS_ACTIVATION",
  ];
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
      ? spawn("/bin/sh", ["-c", a.hint === true ? HINT_SCRIPT : LISTEN_PID_SCRIPT, process.execPath, ...args], {
          stdio,
          env,
        })
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
  bound?: string[];
  left?: string[];
  fds?: { ours: Record<string, string>; theirs: Record<string, string | null> };
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

describe("listenFromEnv in an activated child", { skip: SPAWN_SKIP }, () => {
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

  test("VARLINK_JS_ACTIVATION=connected:<pid>: a connected fd with accept: auto on every system (hint unset)", async () => {
    const { child, exited, sockets } = activate({
      fds: ["pipe"],
      env: { LISTEN_FDS: "1", LISTEN_FDNAMES: "varlink" },
      hint: true,
      args: ["--accept=auto"],
    });
    const [socket] = sockets;
    assert.ok(socket !== undefined);
    const conn = createConnection(fromNodeSocket(socket));
    const reply = await ping(conn);
    assert.equal(reply.address, "fd:3");
    assert.equal(reply.before.VARLINK_JS_ACTIVATION, `connected:${String(child.pid)}`);
    assert.deepEqual(reply.after, {});
    await conn.close();
    assert.equal(await exited, 0);
  });

  test(
    "a stale hint (another pid, or no pid) is ignored: the fd is taken as listening",
    { skip: LINUX ? "Linux asks /proc" : false },
    async () => {
      // A connected socket taken for listening: listen() on it fails (and closes it).
      for (const hint of ["connected:1", `connected:${String(process.pid)}`, "connected", "connected:"]) {
        const r = await report({
          fds: ["pipe"],
          env: { LISTEN_FDS: "1", VARLINK_JS_ACTIVATION: hint },
          args: ["--accept=auto"],
        });
        assert.equal(r.result, "error", hint);
        assert.deepEqual(r.after, {}, hint);
      }
    },
  );

  test(
    "/proc wins over the hint: a listening fd with the hint and accept: auto is served as listening",
    { skip: LINUX ? false : "needs Linux /proc" },
    async () => {
      const a = await unixSocket("hint-proc");
      try {
        const r = await report({ fds: [a.fd], env: { LISTEN_FDS: "1" }, hint: true, args: ["--accept=auto"] });
        assert.equal(r.result, "listener");
        assert.equal(r.address, `unix:${a.procPath}`);
      } finally {
        await closeServer(a.server);
      }
    },
  );

  test(
    "without the hint a connected fd needs accept: connected off Linux",
    { skip: LINUX ? "Linux asks /proc" : false },
    async () => {
      // A connected socket taken for listening: listen() on it fails (and closes it).
      for (const hint of [undefined, "listening", "yes"]) {
        const env = { LISTEN_FDS: "1", ...(hint === undefined ? {} : { VARLINK_JS_ACTIVATION: hint }) };
        const auto = await report({ fds: ["pipe"], env, args: ["--accept=auto"] });
        assert.equal(auto.result, "error", String(hint));
        assert.deepEqual(auto.after, {}, String(hint));
      }
      const explicit = await report({ fds: ["pipe"], env: { LISTEN_FDS: "1" }, args: ["--accept=connected"] });
      assert.equal(explicit.result, "listener");
    },
  );

  test("the hint never overrides an explicit accept mode", async () => {
    const a = await unixSocket("hint-l");
    try {
      const r = await report({ fds: [a.fd], env: { LISTEN_FDS: "1" }, hint: true, args: ["--accept=listening"] });
      assert.equal(r.result, "listener");
      assert.equal(r.address, LINUX ? `unix:${a.procPath}` : "fd:3");
    } finally {
      await closeServer(a.server);
    }
  });

  test("invalid options throw after the variables were unset", async () => {
    const r = await report({ env: { LISTEN_FDS: "1", VARLINK_JS_ACTIVATION: "connected" }, args: ["--accept=bogus"] });
    assert.equal(r.result, "error");
    assert.match(r.message ?? "", /^TypeError: .*accept/);
    assert.deepEqual(r.after, {});
  });

  test(
    "the activation fds are /dev/null in our spawned children (not close-on-exec)",
    { skip: LINUX ? false : "needs Linux /proc" },
    async () => {
      const a = await unixSocket("cloexec-a");
      const b = await unixSocket("cloexec-b");
      try {
        // Two fds, only one selected: neither may reach a grandchild.
        const r = await report({
          fds: [a.fd, b.fd],
          env: { LISTEN_FDS: "2", LISTEN_FDNAMES: "varlink:other" },
          args: ["--accept=listening", "--grandchild"],
        });
        assert.equal(r.result, "listener");
        const fds = r.fds;
        assert.ok(fds !== undefined);
        for (const fd of ["3", "4"]) {
          assert.match(fds.ours[fd] ?? "", /^socket:\[\d+\]$/, `our fd ${fd}`);
          const theirs = fds.theirs[fd];
          assert.notEqual(theirs, fds.ours[fd], `the grandchild's fd ${fd} is not the activation socket`);
          assert.ok(theirs === "/dev/null" || theirs === null, `grandchild fd ${fd}: ${String(theirs)}`);
        }
      } finally {
        await closeServer(a.server);
        await closeServer(b.server);
      }
    },
  );

  test(
    "the /dev/null cover also applies to an exec: grandchild with a listening socket",
    { skip: LINUX ? false : "needs Linux /proc" },
    async () => {
      const a = await unixSocket("cloexec-xa");
      const b = await unixSocket("cloexec-xb");
      const cmd = join(dir(), "child.sh");
      await writeFile(cmd, `#!/bin/sh\nexec "${process.execPath}" "${CHILD}" "$@"\n`);
      await chmod(cmd, 0o755);
      try {
        const r = await report({
          fds: [a.fd, b.fd],
          env: { LISTEN_FDS: "2", LISTEN_FDNAMES: "varlink:other" },
          args: ["--accept=listening", `--grandchild-exec=${cmd}`],
        });
        assert.equal(r.result, "listener");
        const fds = r.fds;
        assert.ok(fds !== undefined);
        // Slot 3 is the exec: listening socket (ours, not the activation one); slot 4 must be covered.
        assert.match(fds.theirs["3"] ?? "", /^socket:\[\d+\]$/);
        assert.notEqual(fds.theirs["3"], fds.ours["3"]);
        assert.match(fds.ours["4"] ?? "", /^socket:\[\d+\]$/);
        assert.equal(fds.theirs["4"], "/dev/null");
      } finally {
        await closeServer(a.server);
        await closeServer(b.server);
      }
    },
  );

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

describe("/proc socket tables (fixture files)", () => {
  const UNIX_HEADER = "Num       RefCount Protocol Flags    Type St Inode Path\n";
  const TCP_HEADER =
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
  const unixRow = (flags: string, inode: number, path = ""): string =>
    `0000000000000000: 00000002 00000000 ${flags} 0001 01 ${String(inode)}${path === "" ? "" : ` ${path}`}\n`;
  const tcpRow = (st: string, inode: number): string =>
    `   0: 0100007F:1F90 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${String(inode)} 1 0000000000000000 100 0 0 10 0\n`;

  async function tables(base: string, t: { unix?: string; tcp?: string; tcp6?: string }): Promise<void> {
    await mkdir(join(base, "net"), { recursive: true });
    await writeFile(join(base, "net", "unix"), UNIX_HEADER + (t.unix ?? ""));
    await writeFile(join(base, "net", "tcp"), TCP_HEADER + (t.tcp ?? ""));
    await writeFile(join(base, "net", "tcp6"), TCP_HEADER + (t.tcp6 ?? ""));
  }

  test("procSockets parses unix (listening flag, path, abstract) and tcp/tcp6 (state) from a base dir", async () => {
    const base = join(dir(), "proc-parse");
    await tables(base, {
      unix: unixRow("00010000", 11, "/run/a.sock") + unixRow("00000000", 12) + unixRow("00010000", 13, "@abs"),
      tcp: tcpRow("0A", 21) + tcpRow("01", 22),
      tcp6: tcpRow("0a", 23),
    });
    const s = procSockets(base);
    assert.deepEqual(s.get("11"), { listening: true, address: "unix:/run/a.sock" });
    assert.deepEqual(s.get("12"), { listening: false });
    assert.deepEqual(s.get("13"), { listening: true, address: "unix:@abs" });
    assert.deepEqual(s.get("21"), { listening: true });
    assert.deepEqual(s.get("22"), { listening: false });
    assert.deepEqual(s.get("23"), { listening: true });
    assert.equal(procSockets(join(dir(), "proc-missing")).size, 0, "unreadable tables: empty");
  });

  test("procLookup: our namespace first, then pid 1's, read lazily once on the first miss", async () => {
    const self = join(dir(), "proc-self");
    const init = join(dir(), "proc-1");
    // Under PrivateNetwork=yes systemd's Accept=yes socket (31) is only in pid 1's namespace.
    await tables(self, { unix: unixRow("00010000", 30, "/run/ours.sock") });
    const lookup = procLookup([self, init]);
    assert.deepEqual(lookup("30"), { listening: true, address: "unix:/run/ours.sock" });
    // pid 1's tables did not exist yet: not read on a hit.
    await tables(init, {
      unix: unixRow("00000000", 31, "/run/accept.sock") + unixRow("00000000", 30),
      tcp6: tcpRow("0A", 32),
    });
    assert.deepEqual(lookup("31"), { listening: false, address: "unix:/run/accept.sock" }, "found in pid 1's");
    assert.deepEqual(lookup("32"), { listening: true });
    assert.deepEqual(lookup("30"), { listening: true, address: "unix:/run/ours.sock" }, "ours wins");
    assert.equal(lookup("99"), undefined, "unknown in both: /proc is silent");
    // Read once: a socket that appears later is not seen by this lookup.
    await tables(init, { unix: unixRow("00000000", 33) });
    assert.equal(lookup("33"), undefined);
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

  test("registry entries of an {fd} listener stay at shutdown; a path listener's are removed", async () => {
    const a = await unixSocket("fr");
    const reg = join(dir(), "fd-registry");
    try {
      const r = await report({
        fds: [a.fd],
        pid: "absent",
        args: [`--fd-address=unix:${a.path}`, `--registry=${reg}`],
      });
      assert.deepEqual(r.bound, ["org.example.child"]);
      assert.deepEqual(r.left, ["org.example.child"], "the inherited socket outlives us: the entry stays");
      assert.equal(readlinkSync(join(reg, "org.example.child")), a.path);
    } finally {
      await closeServer(a.server);
    }
    // A path listener owns its socket: its entries go at shutdown.
    const own = join(dir(), "fr-own");
    const reg2 = join(dir(), "path-registry");
    const server = createServer({ onError: () => undefined });
    server.addInterface("interface org.example.own\n\nmethod Ping() -> ()\n", {});
    await server.serve(await listen(`unix:${own}`), { registry: { directory: reg2 } });
    assert.deepEqual(readdirSync(reg2), ["org.example.own"]);
    await server.shutdown();
    assert.deepEqual(readdirSync(reg2), []);
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

  test("a failing source close() still closes the others and the queued channels, then rejects", async () => {
    const boom = new Error("close failed");
    const [queued, peer] = pair();
    const failing: Listener = {
      address: "unix:/f",
      close: () => Promise.reject(boom),
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => undefined) }),
    };
    const other = new FakeListener("unix:/a", [queued], false);
    const merged = mergeListeners([failing, other]);
    const it = merged[Symbol.asyncIterator]();
    await turns(3); // the channel is queued, nobody took it
    await assert.rejects(merged.close(), (e) => e === boom);
    assert.equal(other.closed, 1);
    assert.equal(await peer.read(), null, "the queued channel was closed");
    assert.deepEqual(await it.next(), { value: undefined, done: true });
  });

  test("a rejecting return() of a source is not an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const rejecting: Listener = {
        address: "unix:/r",
        close: () => Promise.resolve(),
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<never>(() => undefined),
          return: () => Promise.reject(new Error("return failed")),
        }),
      };
      const merged = mergeListeners([rejecting]);
      const it = merged[Symbol.asyncIterator]();
      await it.return?.();
      await turns(5);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
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
