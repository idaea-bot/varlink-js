// Helpers for the interop suite (DESIGN.md §7.4): child processes with readiness lines and deadlines, free tcp
// ports, connect polling, temp dirs, and the gating of tests on optional external implementations.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as netCreateServer, connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { parseAddress } from "../../src/core/address/index.ts";
import { socketOptions } from "../../src/node/connect.ts";

/** Repository root (absolute). */
export const ROOT: string = new URL("../../", import.meta.url).pathname;

/** The certification CLIs. */
export const SERVER_SCRIPT: string = join(ROOT, "examples/certification/server.ts");
export const CLIENT_SCRIPT: string = join(ROOT, "examples/certification/client.ts");

/** Set in CI jobs whose external implementation must be there: a skip becomes a failure. */
export const REQUIRE_INTEROP: boolean = process.env["VARLINK_REQUIRE_INTEROP"] === "1";

/**
 * Gate for a test needing an optional implementation: `null` when available, else skips `t` with `reason` (or
 * fails it under VARLINK_REQUIRE_INTEROP=1) and returns the reason. Use: `if (gate(t, why) !== null) return;`.
 */
export function gate(t: TestContext, missing: string | null): string | null {
  if (missing === null) return null;
  if (REQUIRE_INTEROP) assert.fail(`${missing} (VARLINK_REQUIRE_INTEROP=1 turns this skip into a failure)`);
  t.skip(missing);
  return missing;
}

/** A spawned child process with its output collected. */
export interface Child {
  readonly process: ChildProcess;
  stdout(): string;
  stderr(): string;
  /** Resolves with the first stdout line matching `pattern`, or rejects at the deadline or when the child exits. */
  waitForLine(pattern: RegExp, timeoutMs: number): Promise<RegExpMatchArray>;
  /** Resolves when the child exited (code, or the signal that killed it). */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** SIGKILL unless it already exited; waits for the exit. */
  kill(): Promise<void>;
  /** Output for diagnostics. */
  describe(): string;
}

/** Spawns `command` (no shell) with stdin closed. */
export function spawnChild(command: string, args: readonly string[]): Child {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
  let out = "";
  let err = "";
  let spawnError: Error | undefined;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", (e) => {
      spawnError = e;
      resolve({ code: null, signal: null });
    });
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  let done = false;
  void exited.then(() => {
    done = true;
  });
  child.stdout.setEncoding("utf8").on("data", (s: string) => {
    out += s;
  });
  child.stderr.setEncoding("utf8").on("data", (s: string) => {
    err += s;
  });
  const describe = (): string =>
    `$ ${command} ${args.join(" ")}\n--- stdout ---\n${out}\n--- stderr ---\n${err}` +
    (spawnError === undefined ? "" : `\n--- spawn error ---\n${String(spawnError)}`);
  return {
    process: child,
    stdout: () => out,
    stderr: () => err,
    exited,
    describe,
    waitForLine: (pattern, timeoutMs) =>
      new Promise((resolve, reject) => {
        const check = (): boolean => {
          for (const line of out.split("\n")) {
            const m = pattern.exec(line);
            if (m !== null) {
              finish();
              resolve(m);
              return true;
            }
          }
          return false;
        };
        const onData = (): void => {
          check();
        };
        const timer = setTimeout(() => {
          finish();
          reject(new Error(`no line matching ${String(pattern)} within ${String(timeoutMs)} ms\n${describe()}`));
        }, timeoutMs);
        const finish = (): void => {
          clearTimeout(timer);
          child.stdout.off("data", onData);
        };
        child.stdout.on("data", onData);
        if (check()) return;
        void exited.then(() => {
          // The last data events are delivered before "close".
          if (!check()) {
            finish();
            reject(new Error(`exited before printing a line matching ${String(pattern)}\n${describe()}`));
          }
        });
      }),
    kill: async () => {
      if (!done) child.kill("SIGKILL");
      await exited;
    },
  };
}

/** Awaits `p`, failing after `timeoutMs` with `what` (the timer is always cleared). */
export async function within<T>(p: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what}: no result within ${String(timeoutMs)} ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A tcp port that was free a moment ago on 127.0.0.1 (bound to port 0, then released). For servers that print
 * no address (rust): a small race with other processes, accepted for tests.
 */
export function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = netCreateServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address !== null) resolve(address.port);
        else reject(new Error("no tcp port"));
      });
    });
  });
}

function tryConnect(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect(socketOptions(parseAddress(address)));
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Polls until a connect to `address` succeeds (servers without a readiness line), or fails at the deadline. */
export async function waitForConnect(address: string, timeoutMs: number, child?: Child): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const state = { exited: false };
  void child?.exited.then(() => {
    state.exited = true;
  });
  for (;;) {
    if (await tryConnect(address)) return;
    if (state.exited)
      throw new Error(`server exited before accepting connections on ${address}\n${child?.describe() ?? ""}`);
    if (Date.now() > deadline)
      throw new Error(`nothing accepts connections on ${address} after ${String(timeoutMs)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A fresh `vj-` temp dir (removed by the returned cleanup). */
export async function tempDir(): Promise<{ dir: string; remove: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "vj-"));
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

/** Runs `body`; on failure, writes each child's command line and output into the test's diagnostics. */
export async function withDiagnostics(
  t: TestContext,
  children: () => readonly Child[],
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (e) {
    for (const c of children()) t.diagnostic(c.describe());
    throw e;
  }
}
