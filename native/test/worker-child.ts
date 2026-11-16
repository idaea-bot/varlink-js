// Worker for worker.test.ts. workerData.mode:
// - "busy": serves org.example.fd on its own socket with the addon (fd input on: bounded reads through the
//   per-environment buffer) and, from its own client, makes `tiny` pipelined tiny calls plus `calls` calls with fds
//   and big replies, all at once, so its reads overlap the other workers'; posts { texts, tiny }.
// - "hold": serves org.example.fd itself and calls Hold from its own client with an fd: the server side then holds a
//   received fd (ctx.fds of the unfinished call) and a fetched pidfd; posts "holding" (with the addon's tracked-fd
//   count and the received fd's number) and waits to be terminated. fdKind "eventfd": sends an eventfd, not a pipe
//   (with `counter` written into it first).
// - "keep": keeps fds it got as a user (an acceptFds reply, a pulled stream item, ctx.takeFd) while two stream replies
//   stay buffered; posts the kept fds and waits to be terminated.
// - "reuse": closes a tracked fd behind the addon's back and reopens its number on workerData.file; posts it.
// - "pidfd-reuse": closes a tracked pidfd of this process behind the addon's back and reopens its number as a pidfd
//   of the parent process; posts it.
// - "pidfd-reaped": the same with pidfds of two reaped children (`Pid:` -1 both); posts the reused fd and both Pids.
// - "client": connects with the addon to workerData.address (a server in the main thread), makes one call, posts
//   "connected" and keeps the connection open until terminated.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, fstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parentPort, workerData } from "node:worker_threads";
import { connect } from "../../src/node/index.ts";
import * as native from "../index.js";
import { readFd, startServer, until } from "./helpers.ts";

const data = workerData as {
  mode: string;
  dir: string;
  name: string;
  address: string;
  calls: number;
  tiny: number;
  file: string;
  fdKind?: string;
  counter?: number;
};
const port = parentPort;
if (port === null) throw new Error("not a worker");

if (data.mode === "busy") {
  const fx = await startServer(data.dir, data.name);
  const conn = await fx.connect();
  const texts: string[] = [];
  let tiny = 0;
  // The tiny calls are all pipelined at once; the fd calls go one after the other on a second connection (alongside),
  // so the process's fds stay few (all workers share one fd table; macOS's default limit is 256).
  const fdConn = await fx.connect();
  const fdCalls = async (): Promise<void> => {
    for (let i = 0; i < data.calls; i++) {
      const [r, w] = native.pipe();
      try {
        try {
          await fdConn.call("org.example.fd.Write", { text: `${data.name}:${String(i)}` }, { fds: [w] });
        } finally {
          native.close(w);
        }
        texts.push(readFd(r));
      } finally {
        native.close(r);
      }
      const big = await fdConn.call("org.example.fd.Big", { size: 100_000 }, { acceptFds: true });
      for (const fd of big.fds) fd.close();
      if ((big.parameters.data as string).length !== 100_000) throw new Error("short reply");
    }
  };
  await Promise.all([
    ...Array.from({ length: data.tiny }, async () => {
      await conn.call("org.example.fd.Ping", {});
      tiny++;
    }),
    fdCalls(),
  ]);
  await fx.close();
  port.postMessage({ texts: texts.sort(), tiny });
} else if (data.mode === "hold") {
  const fx = await startServer(data.dir, data.name);
  const conn = await fx.connect();
  // Sends a pipe's write end, or (fdKind "eventfd") an eventfd: an fd on the anon inode.
  const [r, w] = data.fdKind === "eventfd" ? [-1, native.eventfd()] : native.pipe();
  if (data.counter !== undefined) {
    // The eventfd's counter, read back by the test after teardown to recognize this eventfd.
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(data.counter));
    if (writeSync(w, buf) !== 8) throw new Error("short eventfd write");
  }
  void conn.call("org.example.fd.Hold", {}, { fds: [w] }).catch(() => undefined);
  await until(() => fx.seen.holds.length === 1);
  // Ours go; what stays is the library's: the server's received fd, its pidfd, the sockets.
  if (r >= 0) native.close(r);
  native.close(w);
  const received = fx.seen.held[0]?.[0] ?? -1;
  port.postMessage({ holding: true, tracked: native.stats().trackedFds, received });
} else if (data.mode === "pidfd-reuse") {
  // A tracked pidfd of this process closed behind the library's back, its number reused by a pidfd of another
  // process (the parent): terminating the worker must not close it.
  const own = native.pidfdOpen(process.pid);
  const tracked = native.dup(own, true);
  native.close(own);
  closeSync(tracked);
  const extra: number[] = [];
  let fd = native.pidfdOpen(process.ppid);
  while (fd !== tracked && extra.length < 64) {
    extra.push(fd);
    fd = native.pidfdOpen(process.ppid);
  }
  for (const e of extra) native.close(e);
  if (fd !== tracked) throw new Error("could not reuse the number");
  port.postMessage({ fd, tracked: native.stats().trackedFds });
} else if (data.mode === "pidfd-reaped") {
  // A tracked pidfd of a reaped child (`Pid:` -1) closed behind the library's back, its number reused by a pidfd of
  // another reaped child (also -1): terminating the worker must not close it (-1 identifies no process).
  const reapedPidfd = async (): Promise<number> => {
    const c = spawn("sleep", ["60"], { stdio: "ignore" });
    await once(c, "spawn");
    if (c.pid === undefined) throw new Error("no child pid");
    const fd = native.pidfdOpen(c.pid);
    const exited = once(c, "exit");
    c.kill("SIGKILL");
    await exited; // libuv has reaped it (waitpid) by now
    return fd;
  };
  const pidOf = (fd: number): string | undefined =>
    /^Pid:\s*(-?\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${String(fd)}`, "utf8"))?.[1];
  const first = await reapedPidfd();
  const second = await reapedPidfd();
  const tracked = native.dup(first, true);
  const trackedPid = pidOf(tracked);
  native.close(first);
  closeSync(tracked);
  const extra: number[] = [];
  let fd = native.dup(second);
  while (fd !== tracked && extra.length < 64) {
    extra.push(fd);
    fd = native.dup(second);
  }
  for (const e of extra) native.close(e);
  native.close(second);
  if (fd !== tracked) throw new Error("could not reuse the number");
  port.postMessage({ fd, tracked: native.stats().trackedFds, trackedPid, reusedPid: pidOf(fd) });
} else if (data.mode === "keep") {
  // Gets fds handed to it as a user (an acceptFds reply, a stream item it pulled, ctx.takeFd in its own server) and
  // keeps them; two more stream replies stay buffered, never delivered. Posts the kept numbers and their inodes.
  const fx = await startServer(data.dir, data.name);
  const conn = await fx.connect();
  const reply = await conn.call("org.example.fd.Open", { text: "reply" }, { acceptFds: true });
  const [r, w] = native.pipe();
  await conn.call("org.example.fd.Keep", { claim: true }, { fds: [r] });
  native.close(r);
  native.close(w);
  const claimed = fx.seen.kept[0]?.claimed;
  const stream = conn.stream("org.example.fd.Stream", { n: 3 }, { acceptFds: true });
  const item = (await stream.next()).value as { fds: { fd: number }[] };
  // The other two replies arrive and wait in the stream's buffer (the server sends them at once).
  await sleep(300);
  const kept = [reply.fds[0]?.fd, claimed?.fd, item.fds[0]?.fd].map((fd) => {
    if (fd === undefined) throw new Error("missing fd");
    return { fd, ino: fstatSync(fd).ino };
  });
  port.postMessage({ kept });
} else if (data.mode === "reuse") {
  // A tracked fd (as the library's duplicates are) closed behind the library's back, its number reused by a file
  // opened here: terminating the worker must not close the file.
  const [r, w] = native.pipe();
  const tracked = native.dup(r, true);
  native.close(r);
  native.close(w);
  closeSync(tracked);
  const extra: number[] = [];
  let fd = openSync(data.file, "r");
  while (fd !== tracked && extra.length < 64) {
    extra.push(fd);
    fd = openSync(data.file, "r");
  }
  for (const e of extra) closeSync(e);
  if (fd !== tracked) throw new Error("could not reuse the number");
  port.postMessage({ fd, ino: fstatSync(fd).ino, tracked: native.stats().trackedFds });
} else {
  const conn = await connect(data.address, { native });
  await conn.call("org.example.fd.Ping", {});
  port.postMessage("connected");
  // Stays open (its reader has a read pending) until the worker is terminated.
}
