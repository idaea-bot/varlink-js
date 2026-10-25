// Shared helpers for the Node adapter tests: temp dirs and connected socket pairs.
import { lstat, mkdtemp, readlink, realpath, rm } from "node:fs/promises";
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

/**
 * Why the spawn/activation tests skip on this runtime, or false on Node. Under Bun and Deno the spawned-child paths
 * (exec: socketpair at fd 3, child fixtures, stdio bridges) fail in their node:child_process compat (M8; follow-up
 * card for Bun/Deno support).
 */
export const SPAWN_SKIP: string | false =
  process.versions.bun !== undefined
    ? "Bun: spawned-child transports and activation are Node-only for now (M8 follow-up)"
    : "Deno" in globalThis
      ? "Deno: spawned-child transports and activation are Node-only for now (M8 follow-up)"
      : false;
