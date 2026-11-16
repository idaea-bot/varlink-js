// The channel over a connected activation fd (DESIGN.md §4.7, §5.8; connectedChannel in src/node/activation.ts),
// driven in a child that gets a socket made here as its fd 3: half-close both ways, close() closes the fd once, a
// second close() is a no-op, closed resolves. Both a spawn stdio pipe (a socketpair) and an accepted unix socket
// (O_NONBLOCK, set by the runtime's event loop and shared through the inherited open file description), with the
// child opening the fd only after the peer's data arrived.
import assert from "node:assert/strict";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { createServer as createNetServer, connect as netConnect, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { childCommand, listening, tempDir } from "./helpers.ts";

const dir = tempDir();
const CHILD = resolve(import.meta.dirname, "connected-fd-child.ts");
const IS_DENO = process.versions.deno !== undefined;

interface ChildReport {
  got: string;
  socket: boolean;
  secondClose: string;
  fd: string;
  readAfterClose: unknown;
}

/** An accepted unix socket's fd (private `_handle.fd`) and the connected client, our end. */
async function acceptedFd(name: string): Promise<{ fd: number; accepted: Socket; peer: Socket }> {
  const server = createNetServer({ allowHalfOpen: true, pauseOnConnect: true });
  await listening(server, { path: join(dir(), name) });
  const accepted = new Promise<Socket>((r) => server.once("connection", r));
  const peer = netConnect({ path: join(dir(), name), allowHalfOpen: true });
  await new Promise<void>((ok, fail) => {
    peer.once("connect", ok);
    peer.once("error", fail);
  });
  const socket = await accepted;
  server.close();
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  assert.ok(typeof fd === "number" && fd >= 0, "net.Socket._handle.fd is not available");
  return { fd, accepted: socket, peer };
}

/**
 * Runs the child with `kind` of fd 3: our end writes "ping" at once, records what it reads and when it sees EOF
 * (answering it with "after" and its own EOF). The child's report and what our end saw.
 */
async function run(
  kind: "pipe" | "nonblocking",
  scenario: "close" | "end",
): Promise<{ report: ChildReport; peerGot: string; peerEof: boolean; code: number | null }> {
  let entry: "pipe" | number = "pipe";
  let ours: { accepted: Socket; peer: Socket } | undefined;
  if (kind === "nonblocking") {
    const a = await acceptedFd(`${scenario}.sock`);
    entry = a.fd;
    ours = a;
  }
  const [file = "", ...args] = childCommand(CHILD);
  const stdio: StdioOptions = ["ignore", "pipe", "inherit", entry];
  const child: ChildProcess = spawn(file, [...args, scenario, "300"], { stdio });
  const exited = new Promise<number | null>((r) => child.once("exit", r));
  // The child has its copy once spawned; ours goes.
  ours?.accepted.destroy();
  const peer = ours?.peer ?? (child.stdio as unknown as (Socket | null)[])[3];
  assert.ok(peer !== undefined && peer !== null);
  peer.allowHalfOpen = true;
  let peerGot = "";
  let peerEof = false;
  peer.on("data", (d: Buffer) => {
    peerGot += d.toString();
  });
  const eof = new Promise<void>((ok) =>
    peer.once("end", () => {
      peerEof = true;
      peer.end("after");
      ok();
    }),
  );
  peer.on("error", () => undefined);
  peer.write("ping");
  const stdout = child.stdout;
  assert.ok(stdout !== null);
  let out = "";
  for await (const chunk of stdout) out += String(chunk);
  const code = await exited;
  await eof;
  peer.destroy();
  return { report: JSON.parse(out) as ChildReport, peerGot, peerEof, code };
}

/** fd 3 was closed: EBADF, or the number already names another file (the runtime reused it). */
function assertFdClosed(fd: string): void {
  assert.ok(fd === "EBADF" || fd === "reused", `fd 3 after close: ${fd}`);
}

const NONBLOCKING_SKIP = IS_DENO ? "as of Deno 2.9.8 a net.Socket has no real fd (_handle.fd) to pass on" : false;

for (const kind of ["pipe", "nonblocking"] as const) {
  describe(`connected activation fd (${kind})`, { skip: kind === "nonblocking" ? NONBLOCKING_SKIP : false }, () => {
    test("close(): the peer sees EOF, the fd is closed, a second close() is a no-op, closed resolves", async () => {
      const r = await run(kind, "close");
      assert.equal(r.code, 0);
      assert.equal(r.report.socket, true);
      assert.equal(r.report.got, "ping");
      assert.equal(r.peerGot, "pong");
      assert.ok(r.peerEof);
      assert.equal(r.report.secondClose, "ok");
      assertFdClosed(r.report.fd);
      assert.equal(r.report.readAfterClose, null);
    });

    test("end() half-closes: the peer sees EOF while the channel still reads", async () => {
      const r = await run(kind, "end");
      assert.equal(r.code, 0);
      assert.equal(r.peerGot, "pong");
      assert.ok(r.peerEof);
      // The peer sends "after" only once it saw our EOF: had EOF come from close(), the child could not read it.
      assert.equal(r.report.got, "pingafter");
      assertFdClosed(r.report.fd);
    });
  });
}
