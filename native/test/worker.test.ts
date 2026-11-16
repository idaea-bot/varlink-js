// varlink-js-native in worker threads (DESIGN.md §4.15): each environment has its own instance data (read buffer,
// socket list, tracked fds), so several workers using the addon at once do not share a buffer (H2: stressed with
// thousands of tiny pipelined messages through bounded reads, plus fds and big replies); terminating a worker closes
// its poll handles and the fds its JS held for the library (received fds of an unfinished call, a fetched pidfd)
// through the environment cleanup hook (no abort, no leak; M4, review-2 LOW-2), but not the fds handed to users nor
// a tracked number that was closed otherwise and reused (review-3 M2, L2, L3). What teardown closes on Linux: from 6.9
// every tracked fd still matching its identity (pidfds are pidfs inodes); before 6.9, where pidfds share the anon
// inode with eventfd/epoll/…, the same for non-anon fds plus a tracked pidfd that /proc still shows as a pidfd of the
// same pid (> 0); other anon-inode fds (a received eventfd: tested on every kernel) are left open (best-effort leak,
// counted in stats().teardownSkipped; review-5 M1), as is a reused pidfd of another process (tested on every kernel
// with pidfds) and a pidfd of a reaped process (`Pid:` -1, which identifies nothing: tested before 6.9; CI's
// ubuntu-22.04 entry sets VJN_REQUIRE_ANON_PIDFD=1 so that test fails rather than skips on a newer runner kernel).
import assert from "node:assert/strict";
import { closeSync, fstatSync, readFileSync, readlinkSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Worker } from "node:worker_threads";
import { checkFdLeaks, LINUX, native, openFds, SKIP, startServer, T, tempDir, until } from "./helpers.ts";

const child = new URL("./worker-child.ts", import.meta.url);

/**
 * Probes pidfds once: `skip` says why the pidfd tests cannot run at all (undefined if they can), `anonSkip` why the
 * anon-inode pidfd test cannot (it needs pidfds on the anon inode: Linux < 6.9). Never throws (ENOSYS before 5.3,
 * EPERM under a seccomp filter, …: a skip reason), so the file always loads.
 */
function probePidfds(): { skip: string | undefined; anonSkip: string | undefined } {
  if (SKIP !== undefined) return { skip: SKIP, anonSkip: SKIP };
  if (!LINUX) return { skip: "pidfds are Linux-only", anonSkip: "pidfds are Linux-only" };
  const fds: number[] = [];
  try {
    fds.push(native.pidfdOpen(process.pid));
    fds.push(native.eventfd());
    const [ps, es] = fds.map((fd) => fstatSync(fd));
    const anon = ps?.dev === es?.dev && ps?.ino === es?.ino;
    return { skip: undefined, anonSkip: anon ? undefined : "pidfds have their own pidfs inodes here (Linux ≥ 6.9)" };
  } catch (e) {
    const reason = `the pidfd probe failed (${(e as NodeJS.ErrnoException).code ?? String(e)})`;
    return { skip: reason, anonSkip: reason };
  } finally {
    for (const fd of fds) native.close(fd);
  }
}

const PIDFDS = probePidfds();
/**
 * `VJN_REQUIRE_ANON_PIDFD=1` (CI's ubuntu-22.04 entry, a kernel before 6.9): the anon-inode pidfd test must run, so a
 * runner kernel change fails it instead of skipping it silently.
 */
const REQUIRE_ANON_PIDFD = process.env.VJN_REQUIRE_ANON_PIDFD === "1";

/** Test options for a test that needs pidfds on the anon inode (see requireAnonPidfd). */
function anonPidfdOptions(): { timeout: number; skip: string | undefined } {
  return { ...T, skip: REQUIRE_ANON_PIDFD && SKIP === undefined ? undefined : PIDFDS.anonSkip };
}

/** First line of such a test: fails (rather than skips) when VJN_REQUIRE_ANON_PIDFD=1 and the kernel cannot run it. */
function requireAnonPidfd(): void {
  if (PIDFDS.anonSkip !== undefined) assert.fail(`VJN_REQUIRE_ANON_PIDFD=1, but: ${PIDFDS.anonSkip}`);
}

/** The `Pid:` of `/proc/self/fdinfo/<fd>` (a pidfd's process; "-1" once reaped), or undefined. */
function fdinfoPid(fd: number): string | undefined {
  return /^Pid:\s*(-?\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${String(fd)}`, "utf8"))?.[1];
}

function run(
  data: Record<string, unknown>,
  trackUnmanagedFds = true,
): { worker: Worker; message: Promise<unknown>; exit: Promise<number> } {
  const worker = new Worker(child, { workerData: data, trackUnmanagedFds });
  const message = new Promise<unknown>((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  const exit = new Promise<number>((resolve) => worker.once("exit", resolve));
  return { worker, message, exit };
}

describe("worker threads", { skip: SKIP }, () => {
  checkFdLeaks();
  const dir = tempDir();

  test(
    "stress: three workers, each 3000 tiny pipelined calls plus 40 with fds and 100 kB replies, at once",
    { timeout: 30_000 },
    async () => {
      const calls = 40;
      const tiny = 3000;
      const names = ["wa.sock", "wb.sock", "wc.sock"];
      const workers = names.map((name) => run({ mode: "busy", dir: dir(), name, calls, tiny }));
      const results = (await Promise.all(workers.map((w) => w.message))) as { texts: string[]; tiny: number }[];
      names.forEach((name, k) => {
        const expect = Array.from({ length: calls }, (_, i) => `${name}:${String(i)}`).sort();
        assert.deepEqual(results[k]?.texts, expect);
        assert.equal(results[k].tiny, tiny);
      });
      for (const w of workers) assert.equal(await w.exit, 0);
    },
  );

  test(
    "terminating a worker that kept fds handed to it (acceptFds reply, stream item, takeFd): they stay open; " +
      "buffered, undelivered stream replies are closed",
    T,
    async () => {
      const before = openFds();
      const w = run({ mode: "keep", dir: dir(), name: "wk.sock" });
      const message = (await w.message) as { kept: { fd: number; ino: number }[] };
      assert.equal(message.kept.length, 3);
      await w.worker.terminate();
      await w.exit;
      try {
        // The users' fds survive the worker (the process owns them now); what the library still held is gone.
        for (const k of message.kept) assert.equal(fstatSync(k.fd).ino, k.ino, `fd ${String(k.fd)} still open`);
        await until(() => openFds() <= before + message.kept.length);
      } finally {
        for (const k of message.kept) closeSync(k.fd);
      }
      await until(() => openFds() <= before);
    },
  );

  test("teardown leaves a tracked fd number alone when it was closed otherwise and reused", T, async () => {
    const file = join(dir(), "reuse.txt");
    writeFileSync(file, "reused");
    // Node would close the file the worker opens with fs at its exit itself (trackUnmanagedFds): off, it stands for a
    // file of another thread that reused the number.
    const skipped = native.stats().teardownSkipped;
    const w = run({ mode: "reuse", file }, false);
    const message = (await w.message) as { fd: number; ino: number; tracked: number };
    assert.equal(message.tracked, 1, "the closed number is still tracked");
    await w.worker.terminate();
    await w.exit;
    let ino: number | undefined;
    try {
      ino = fstatSync(message.fd).ino;
    } finally {
      if (ino !== undefined) closeSync(message.fd);
    }
    assert.equal(ino, message.ino, "the file that reused the number stays open");
    assert.equal(native.stats().teardownSkipped, skipped + 1, "counted as skipped");
  });

  test(
    "teardown leaves a tracked pidfd number alone when it was closed otherwise and reused by a pidfd of another process",
    // Every Linux kernel with pidfds: before 6.9 the /proc class tells the pids apart, from 6.9 the pidfs inodes differ.
    { ...T, skip: PIDFDS.skip },
    async () => {
      const skipped = native.stats().teardownSkipped;
      // trackUnmanagedFds off: the worker closes the tracked number with closeSync (no "closed but not opened" warning).
      const w = run({ mode: "pidfd-reuse" }, false);
      const message = (await w.message) as { fd: number; tracked: number };
      assert.equal(message.tracked, 1, "the closed number is still tracked");
      await w.worker.terminate();
      await w.exit;
      try {
        assert.equal(readlinkSync(`/proc/self/fd/${String(message.fd)}`), "anon_inode:[pidfd]", "still open");
        assert.equal(fdinfoPid(message.fd), String(process.ppid), "the parent's pidfd");
      } finally {
        native.close(message.fd);
      }
      assert.equal(native.stats().teardownSkipped, skipped + 1, "counted as skipped");
    },
  );

  test(
    "teardown leaves a tracked pidfd of a reaped process (Pid: -1) alone when its number was reused by a pidfd of " +
      "another reaped process (anon inode: -1 identifies nothing)",
    anonPidfdOptions(),
    async () => {
      requireAnonPidfd();
      const skipped = native.stats().teardownSkipped;
      const w = run({ mode: "pidfd-reaped" }, false);
      const message = (await w.message) as { fd: number; tracked: number; trackedPid: string; reusedPid: string };
      assert.equal(message.tracked, 1, "the closed number is still tracked");
      assert.equal(message.trackedPid, "-1", "the tracked pidfd's process was reaped");
      assert.equal(message.reusedPid, "-1", "the reusing pidfd's process was reaped");
      await w.worker.terminate();
      await w.exit;
      let link: string | undefined;
      try {
        link = readlinkSync(`/proc/self/fd/${String(message.fd)}`);
      } catch {
        // closed by teardown: the assertion below says so
      }
      try {
        assert.equal(link, "anon_inode:[pidfd]", "still open (teardown left it alone)");
        assert.equal(fdinfoPid(message.fd), "-1");
      } finally {
        if (link === "anon_inode:[pidfd]") native.close(message.fd);
      }
      assert.equal(native.stats().teardownSkipped, skipped + 1, "counted as skipped");
    },
  );

  test("pidfdOpen's argument error names the pid", { skip: SKIP }, () => {
    assert.throws(() => native.pidfdOpen(-1), { code: "ERR_INVALID_ARG_VALUE", message: /^pid must be/ });
  });

  test(
    "terminating a worker that holds a received eventfd: it stays open (anon inode, best-effort leak), counted",
    { ...T, skip: LINUX ? undefined : "eventfds are Linux-only" },
    async () => {
      const skipped = native.stats().teardownSkipped;
      // The worker writes this counter into its eventfd before sending it; reading it back here proves the fd still
      // open after teardown is that same eventfd.
      const counter = 0x5eedn;
      const w = run({ mode: "hold", dir: dir(), name: "we.sock", fdKind: "eventfd", counter: Number(counter) });
      const message = (await w.message) as { holding: boolean; received: number };
      assert.equal(message.holding, true);
      assert.ok(message.received >= 0, "the server received the eventfd");
      await w.worker.terminate();
      await w.exit;
      try {
        assert.equal(readlinkSync(`/proc/self/fd/${String(message.received)}`), "anon_inode:[eventfd]", "still open");
        const buf = Buffer.alloc(8);
        assert.equal(readSync(message.received, buf, 0, 8, null), 8);
        assert.equal(buf.readBigUInt64LE(), counter, "the worker's eventfd (its counter)");
      } finally {
        native.close(message.received);
      }
      assert.equal(native.stats().teardownSkipped, skipped + 1, "exactly the eventfd was left open");
    },
  );

  test("the anon-inode probe works (Linux: eventfd)", { skip: !LINUX }, () => {
    assert.equal(native.stats().anonProbe, "eventfd");
  });

  test("terminating a worker that holds received fds and a pidfd: all of them closed", T, async () => {
    const before = openFds();
    const skipped = native.stats().teardownSkipped;
    const w = run({ mode: "hold", dir: dir(), name: "wh.sock" });
    const message = (await w.message) as { holding: boolean; tracked: number };
    assert.equal(message.holding, true);
    // At least the received fd of the held call (and the pidfd where SO_PEERPIDFD exists) are tracked by the addon.
    assert.ok(message.tracked >= 1, `tracked fds: ${String(message.tracked)}`);
    assert.ok(openFds() > before);
    await w.worker.terminate();
    await w.exit;
    await until(() => openFds() <= before);
    assert.equal(
      native.stats().teardownSkipped,
      skipped,
      "teardown closed every tracked fd (the pidfd too where the kernel has SO_PEERPIDFD)",
    );
  });

  test("terminating a worker with an open native connection: no abort, its sockets are closed", T, async () => {
    const fx = await startServer(dir(), "wt.sock");
    try {
      const before = openFds();
      const w = run({ mode: "client", address: fx.address });
      assert.equal(await w.message, "connected");
      assert.equal(fx.server.connections, 1);
      await w.worker.terminate();
      await w.exit;
      // The worker's socket is closed: the server sees the peer go away, and the process keeps no fd of it.
      await until(() => fx.server.connections === 0);
      await until(() => openFds() <= before);
    } finally {
      await fx.close();
    }
  });
});
