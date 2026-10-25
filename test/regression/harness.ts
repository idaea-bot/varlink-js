// Transport harness for the end-to-end regression suite (DESIGN.md §7.2, §4.11). A Transport serves a Server on
// some kind of connection and gives clients (Connection) and raw byte-level peers: pair(), unix and tcp sockets.
import { mkdtemp, rm } from "node:fs/promises";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAddress } from "../../src/core/address/index.ts";
import { ConnectionClosedError } from "../../src/core/errors/index.ts";
import type { ByteChannel, ReadChunk } from "../../src/core/protocol/index.ts";
import { socketOptions } from "../../src/node/connect.ts";
import { connect, fromNodeSocket, listen, type NodeListener } from "../../src/node/index.ts";
import {
  createConnection,
  type Connection,
  type ConnectionOptions,
  type ServeListener,
  type Server,
} from "../../src/rpc/index.ts";
import { pair, type PairOptions } from "../../src/testing/index.ts";

/** Byte-level access to one connection to the server (the client side). */
export interface RawPeer {
  write(bytes: Uint8Array): Promise<void>;
  /** The next NUL-terminated message as text, or null at EOF. */
  readMessage(): Promise<string | null>;
  /** Every message until EOF. */
  readAll(): Promise<string[]>;
  /** Every byte received so far. */
  received(): Uint8Array;
  /** Half-close (FIN). */
  end(): Promise<void>;
  /** Abrupt close: the server's read rejects (RST; pair: a faulty-style reset). */
  reset(): void;
  close(): void;
}

/** A running server endpoint. */
export interface Endpoint {
  connect(options?: ConnectionOptions): Promise<Connection>;
  raw(): Promise<RawPeer>;
  /** Drops every server-side connection, as a server restart does (absent if the transport cannot). */
  restart?(): Promise<void>;
  close(): Promise<void>;
}

export interface Transport {
  readonly name: string;
  /**
   * Whether `RawPeer.reset()` is seen by the server as a disconnect (a rejected read). False for unix sockets: they
   * have no RST, so a destroyed peer is a clean EOF (half-close), which is not "gone" (DESIGN.md §4.11).
   */
  readonly abruptReset: boolean;
  start(server: Server): Promise<Endpoint>;
}

/** Options shared by the transports: a small pipe buffer so backpressure kicks in (F3). */
export interface TransportOptions {
  highWaterMark?: number;
}

/**
 * A server-side channel wrapper whose `reset()` makes the pending (and every later) read reject, like a socket
 * after an RST, and closes the inner channel.
 */
export function resettable(inner: ByteChannel): ByteChannel & { reset(): void } {
  let resetError: ConnectionClosedError | undefined;
  let rejectPending: ((e: unknown) => void) | undefined;
  return {
    read(): Promise<ReadChunk | null> {
      if (resetError !== undefined) return Promise.reject(resetError);
      return new Promise((resolve, reject) => {
        rejectPending = reject;
        inner.read().then(
          (chunk) => {
            rejectPending = undefined;
            resolve(chunk);
          },
          (e: unknown) => {
            rejectPending = undefined;
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- pass the channel's error on
            reject(e);
          },
        );
      });
    },
    write: (chunk) => inner.write(chunk),
    end: () => inner.end(),
    close: (reason?: unknown) => {
      inner.close(reason);
    },
    get closed() {
      return inner.closed;
    },
    capabilities: {},
    reset() {
      resetError = new ConnectionClosedError("connection reset by peer");
      rejectPending?.(resetError);
      inner.close(resetError);
    },
  };
}

/** A RawPeer over the client end of a channel. */
export function rawPeerOf(channel: ByteChannel, reset: () => void): RawPeer {
  const chunks: Uint8Array[] = [];
  /** Received bytes not yet returned as messages; joined only when a NUL arrives (sockets give small chunks). */
  let pending: Uint8Array[] = [];
  let eof = false;
  const concat = (parts: readonly Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  const readMessage = async (): Promise<string | null> => {
    for (;;) {
      // Only the newest chunk and a leftover (always first) can hold a NUL: the others were checked as newest.
      if (pending.at(-1)?.includes(0) === true || pending[0]?.includes(0) === true) {
        const buffer = concat(pending);
        const nul = buffer.indexOf(0);
        pending = nul + 1 < buffer.length ? [buffer.subarray(nul + 1)] : [];
        return new TextDecoder().decode(buffer.subarray(0, nul));
      }
      if (eof) return null;
      const chunk = await channel.read().catch(() => null);
      if (chunk === null) {
        eof = true;
        continue;
      }
      chunks.push(chunk.bytes);
      pending.push(chunk.bytes);
    }
  };
  return {
    write: (bytes) => channel.write(bytes),
    readMessage,
    readAll: async () => {
      const out: string[] = [];
      for (let m = await readMessage(); m !== null; m = await readMessage()) out.push(m);
      return out;
    },
    received: () => concat(chunks),
    end: () => channel.end(),
    reset,
    close: () => {
      channel.close();
    },
  };
}

/** server.handle() on one end of an in-memory pair per connection. */
export function pairTransport(options: TransportOptions = {}): Transport {
  const pairOptions: PairOptions = options.highWaterMark === undefined ? {} : { highWaterMark: options.highWaterMark };
  return {
    name: "pair",
    abruptReset: true,
    start(server: Server): Promise<Endpoint> {
      const serverSides = new Set<ByteChannel>();
      const handled = new Set<Promise<void>>();
      const open = (): { client: ByteChannel; server: ReturnType<typeof resettable> } => {
        const [client, inner] = pair(pairOptions);
        const side = resettable(inner);
        serverSides.add(side);
        const h = server.handle(side).finally(() => {
          serverSides.delete(side);
          handled.delete(h);
        });
        handled.add(h);
        return { client, server: side };
      };
      const endpoint: Endpoint = {
        connect: (connOptions) => Promise.resolve(createConnection(open().client, connOptions)),
        raw: () => {
          const { client, server: side } = open();
          return Promise.resolve(
            rawPeerOf(client, () => {
              side.reset();
              client.close();
            }),
          );
        },
        restart: async () => {
          for (const side of serverSides) side.close();
          await Promise.all([...handled]);
        },
        close: async () => {
          for (const side of serverSides) side.close();
          await Promise.all([...handled]);
        },
      };
      return Promise.resolve(endpoint);
    },
  };
}

/** A served listener that records the server-side channels it hands out (so restart() can drop them). */
function tracked(listener: NodeListener, channels: Set<ByteChannel>): ServeListener {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const channel of listener) {
        channels.add(channel);
        void channel.closed.then(() => channels.delete(channel));
        yield channel;
      }
    },
    close: () => listener.close(),
  };
}

/** Connects a raw net.Socket (allowHalfOpen, like connect()). */
function rawSocket(address: string): Promise<Socket> {
  const opts = socketOptions(parseAddress(address));
  return new Promise((resolve, reject) => {
    const socket = netConnect(opts);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/** server.serve() over a real listening socket; `address` makes the listen address (and the temp dir if needed). */
function socketTransport(name: string, abruptReset: boolean, address: (dir: string) => string): Transport {
  return {
    name,
    abruptReset,
    async start(server: Server): Promise<Endpoint> {
      const dir = await mkdtemp(join(tmpdir(), "vj-"));
      const channels = new Set<ByteChannel>();
      let listener = await listen(address(dir));
      // Restarts listen again on the very same address (tcp: the real port).
      const canonical = listener.address;
      server.serve(tracked(listener, channels));
      const dropConnections = async (): Promise<void> => {
        const all = [...channels];
        for (const channel of all) channel.close();
        await Promise.all(all.map((c) => c.closed));
      };
      const peers = new Set<Socket>();
      return {
        connect: (options) => connect(canonical, options),
        raw: async () => {
          const socket = await rawSocket(canonical);
          peers.add(socket);
          socket.once("close", () => peers.delete(socket));
          const channel = fromNodeSocket(socket);
          return rawPeerOf(channel, () => {
            // tcp: a real RST; unix has none, so the server sees EOF.
            if (abruptReset) socket.resetAndDestroy();
            else socket.destroy();
          });
        },
        restart: async () => {
          await listener.close();
          await dropConnections();
          listener = await listen(canonical);
          server.serve(tracked(listener, channels));
        },
        close: async () => {
          await listener.close();
          for (const socket of peers) socket.destroy();
          await dropConnections();
          await rm(dir, { recursive: true, force: true });
        },
      };
    },
  };
}

/** server.serve(listen("unix:<tmp>/s")). */
export const unixTransport: Transport = socketTransport("unix", false, (dir) => `unix:${join(dir, "s")}`);
/** server.serve(listen("tcp:127.0.0.1:0")). */
export const tcpTransport: Transport = socketTransport("tcp", true, () => "tcp:127.0.0.1:0");

/** Every transport the e2e suite runs over. */
export const transports: readonly Transport[] = [
  pairTransport({ highWaterMark: 16 * 1024 }),
  unixTransport,
  tcpTransport,
];

/** Polls `condition` on the event loop (no wall-clock sleeps) until true, or fails after `turns`. */
export async function waitFor(condition: () => boolean, turns = 10_000): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("waitFor: condition never became true");
}
