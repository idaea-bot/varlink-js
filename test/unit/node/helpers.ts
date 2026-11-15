// Shared helpers for the Node adapter tests: temp dirs and connected socket pairs.
import { chmod, lstat, mkdtemp, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, before } from "node:test";

/** A fresh `vj-` temp dir for the current file, removed in `after`. Call at module level. */
export function tempDir(): () => string {
  let dir = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "vj-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return () => dir;
}

/** Resolves once `server` is listening. */
export function listening(server: Server, options: Parameters<Server["listen"]>[0]): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** Closes `server` (and resolves once its `close` event fired). */
export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/** A connected tcp socket pair over 127.0.0.1 (both half-open capable). */
export async function tcpPair(): Promise<{ client: Socket; server: Socket; close(): Promise<void> }> {
  const listener = createServer({ allowHalfOpen: true, pauseOnConnect: true });
  await listening(listener, { host: "127.0.0.1", port: 0 });
  const accepted = new Promise<Socket>((resolve) => listener.once("connection", resolve));
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("no tcp address");
  const client = netConnect({ host: "127.0.0.1", port: address.port, allowHalfOpen: true });
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  const server = await accepted;
  // Accepted connections are not ours to wait for: stop listening now.
  listener.close();
  return {
    client,
    server,
    close: async () => {
      client.destroy();
      server.destroy();
      await Promise.all(
        [client, server].map((s) =>
          s.closed
            ? Promise.resolve()
            : new Promise<void>((r) =>
                s.once("close", () => {
                  r();
                }),
              ),
        ),
      );
    },
  };
}

/** Event-loop turns (no wall clock). */
export async function turns(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * `realpath()` that also works for a socket where the runtime refuses it (Bun on macOS: EOPNOTSUPP): the directory is
 * made real and the last name kept (after following a final symlink chain).
 */
export async function realpathOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    let current = resolve(path);
    for (let hops = 0; hops < 40 && (await lstat(current)).isSymbolicLink(); hops++)
      current = resolve(dirname(current), await readlink(current));
    return join(await realpath(dirname(current)), basename(current));
  }
}

const IS_BUN = process.versions.bun !== undefined;
const IS_DENO = process.versions.deno !== undefined;

/**
 * The argv that runs the `.ts` fixture `script` with the runtime running the tests: `node script`, `bun script`, or
 * `deno run -A --no-check script`. Deno rewrites a bare `deno script` into `deno run -A …` only when `execPath` is
 * an element of the argv it spawns. It cannot do that inside a shell script or a `#!` line, where a bare
 * `deno script` would run without permissions.
 */
export function childCommand(script: string): string[] {
  return [process.execPath, ...(IS_DENO ? ["run", "-A", "--no-check"] : []), script];
}

/** Writes an executable `#!/bin/sh` script at `path` that execs {@link childCommand}(script) with its arguments. */
export async function writeWrapper(path: string, script: string): Promise<string> {
  const words = childCommand(script).map((w) => `"${w}"`);
  await writeFile(path, `#!/bin/sh\nexec ${words.join(" ")} "$@"\n`);
  await chmod(path, 0o755);
  return path;
}

/**
 * As of Bun 1.4.4, `node:child_process` does not publish the `child_process` diagnostics channel, so a test cannot
 * run code at the moment of the spawn (the abort/timeout-during-spawn tests).
 */
export const BUN_NO_SPAWN_DIAGNOSTICS: string | false = IS_BUN
  ? "as of Bun 1.4.4, node:child_process does not publish the child_process diagnostics channel (no hook at the spawn)"
  : false;

/**
 * As of Bun 1.4.4 and Deno 2.9.8, `process.stdout.end()` on a socket stdout sends no FIN, so a stdio server's peer
 * sees EOF only when the process exits (the must-exit rule of `listenStdio` covers it), never while it keeps running.
 */
export const STDOUT_END_NO_FIN: string | false = IS_BUN
  ? "as of Bun 1.4.4, process.stdout.end() on a socket stdout sends no FIN (EOF only at exit)"
  : IS_DENO
    ? "as of Deno 2.9.8, process.stdout.end() on a socket stdout sends no FIN (EOF only at exit)"
    : false;
