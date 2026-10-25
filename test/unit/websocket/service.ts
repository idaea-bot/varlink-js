// Test helpers (dev-only): the varlink service behind the bridge fixture, served over pair() (or a tcp listener),
// and a typed descriptor of its interface.
import type { ByteChannel } from "../../../src/core/protocol/index.ts";
import {
  isVarlinkError,
  streamOf,
  VarlinkError,
  type CallContext,
  type InterfaceDescriptor,
  type MethodDescriptor,
} from "../../../src/index.ts";
import { createServer, type Server } from "../../../src/rpc/index.ts";
import { pair } from "../../../src/testing/index.ts";

export const SERVICE = "org.example.ws";

export const IDL = `interface org.example.ws

method Echo(text: string) -> (text: string)

method Ping() -> ()

# Recorded by the service (a oneway target).
method Log(text: string) -> ()

# [Supports 'more' flag]
method Count(n: int, delayMs: ?int, firstDelayMs: ?int) -> (i: int)

# Never answers; ends when the connection goes.
method Hang() -> ()

method Fail(code: int) -> ()

# Integers beyond 2^53.
method Big() -> (n: int)

# Replies shaped like json-seq error records: {error} then {i}, then (final) {error, parameters} if last is set.
# [Supports 'more' flag]
method Tricky(last: bool) -> (error: ?string, parameters: ?object, i: ?int)

# Endless: one reply every few ms until the client goes.
# [Supports 'more' flag]
method Monitor() -> (i: int)

error Oops (code: int)
`;

export class OopsError extends VarlinkError<{ code: number }> {
  static readonly errorName: string = "org.example.ws.Oops";
  constructor(parameters: { code: number }, options?: ErrorOptions) {
    super(OopsError.errorName, parameters, options);
  }
  static is(e: unknown): e is OopsError {
    return isVarlinkError(e, OopsError.errorName);
  }
}

const m = (name: string, more?: "supports"): MethodDescriptor<object, object> => ({
  interface: SERVICE,
  name,
  method: `${SERVICE}.${name}`,
  ...(more === undefined ? {} : { more }),
});

export const Echo: MethodDescriptor<{ text: string }, { text: string }> = m("Echo") as MethodDescriptor<
  { text: string },
  { text: string }
>;

export const DESC: InterfaceDescriptor = {
  name: SERVICE,
  idl: IDL,
  ints: "number",
  methods: {
    Echo,
    Ping: m("Ping"),
    Log: m("Log"),
    Count: m("Count", "supports"),
    Hang: m("Hang"),
    Fail: m("Fail"),
    Big: m("Big"),
    Tricky: m("Tricky", "supports"),
    Monitor: m("Monitor", "supports"),
  },
  errors: { Oops: OopsError },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else
      signal.addEventListener(
        "abort",
        () => {
          resolve();
        },
        { once: true },
      );
  });
}

export interface Backend {
  readonly server: Server;
  /** Texts received by Log, in order. */
  readonly logged: string[];
  /** Opens a connection to the service over pair(). */
  connect(): Promise<ByteChannel>;
  stop(): Promise<void>;
}

/** The test service (createServer + the IDL above), not yet listening anywhere. */
export function createService(): { server: Server; logged: string[] } {
  const logged: string[] = [];
  const server = createServer({
    vendor: "varlink-js",
    product: "ws-test",
    version: "1",
    url: "https://example.com",
    onError: () => undefined,
  });
  server.addInterface(IDL, {
    Echo: (p: { text: string }) => ({ text: p.text }),
    Ping: () => ({}),
    Log: (p: { text: string }) => {
      logged.push(p.text);
    },
    Count: async function* (p: { n: number; delayMs?: number; firstDelayMs?: number }) {
      if (p.firstDelayMs !== undefined) await sleep(p.firstDelayMs);
      return yield* streamOf(
        (async function* () {
          for (let i = 0; i < p.n; i++) {
            if (i > 0 && p.delayMs !== undefined) await sleep(p.delayMs);
            yield { i };
          }
        })(),
      );
    },
    Hang: async (_p: Record<string, unknown>, ctx: CallContext) => {
      await whenAborted(ctx.signal);
    },
    Fail: (p: { code: number }) => {
      throw new VarlinkError("org.example.ws.Oops", { code: p.code });
    },
    Big: () => ({ n: 2n ** 60n + 1n }),
    Tricky: async function* (p: { last: boolean }) {
      await Promise.resolve();
      yield { error: "org.example.ws.NotAnError" };
      yield { i: 1 };
      return p.last ? { error: "org.example.ws.Oops", parameters: { code: 1 } } : { i: 2 };
    },
    Monitor: async function* (_p: Record<string, unknown>, ctx: CallContext) {
      for (let i = 0; !ctx.signal.aborted; i++) {
        yield { i };
        await sleep(5);
      }
    },
  });
  return { server, logged };
}

/** The test service over in-memory pairs. */
export function startBackend(): Backend {
  const { server, logged } = createService();
  return {
    server,
    logged,
    connect: () => {
      const [client, end] = pair();
      void server.handle(end);
      return Promise.resolve(client);
    },
    stop: () => server.shutdown({ graceful: false }),
  };
}
