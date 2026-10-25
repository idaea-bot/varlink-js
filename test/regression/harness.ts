// Transport harness for the end-to-end regression suite (DESIGN.md §7.2, §4.11). A Transport serves a Server on
// some kind of connection and gives clients (Connection) and raw byte-level peers. Phase A: pair(); phase B adds
// unix/tcp sockets by implementing Transport and appending to `transports`.
import { ConnectionClosedError } from "../../src/core/errors/index.ts";
import type { ByteChannel, ReadChunk } from "../../src/core/protocol/index.ts";
import { createConnection, type Connection, type ConnectionOptions, type Server } from "../../src/rpc/index.ts";
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
  let buffer: Uint8Array = new Uint8Array(0);
  let eof = false;
  const join = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  };
  const readMessage = async (): Promise<string | null> => {
    for (;;) {
      const nul = buffer.indexOf(0);
      if (nul >= 0) {
        const text = new TextDecoder().decode(buffer.subarray(0, nul));
        buffer = buffer.slice(nul + 1);
        return text;
      }
      if (eof) return null;
      const chunk = await channel.read().catch(() => null);
      if (chunk === null) {
        eof = true;
        continue;
      }
      chunks.push(chunk.bytes);
      buffer = join(buffer, chunk.bytes);
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
    received: () => chunks.reduce(join, new Uint8Array(0)),
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

/** Every transport the e2e suite runs over (phase B appends unixTransport/tcpTransport). */
export const transports: readonly Transport[] = [pairTransport({ highWaterMark: 16 * 1024 })];

/** Polls `condition` on the event loop (no wall-clock sleeps) until true, or fails after `turns`. */
export async function waitFor(condition: () => boolean, turns = 10_000): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("waitFor: condition never became true");
}
