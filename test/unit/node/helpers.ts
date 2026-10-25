// Shared helpers for the Node adapter tests: temp dirs and connected socket pairs.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
