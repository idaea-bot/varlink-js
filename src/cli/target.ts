// Address → target (DESIGN.md §4.14): one small interface over a Connection (unix, unix:@, tcp, the spawned exec:,
// ssh-unix: and ssh-exec: of varlink-js/node's connect(); WebSocket mode) and the simple HTTP mode client.
// The CLI bounds everything with its own deadline signal, so the library's timeouts are off (0).
import type { AddressSpec } from "../core/address/index.ts";
import { OperationNotSupportedError } from "../core/errors/index.ts";
import type { ByteChannel, FdHandle } from "../core/protocol/index.ts";
import { createHttpClient, type HttpClient } from "../http/index.ts";
import { connect as nodeConnect, type NativeAddon } from "../node/index.ts";
import type { Connection, ConnectionOptions, WithFds } from "../rpc/index.ts";
import { connect as webSocketConnect } from "../websocket/index.ts";
import { CliError } from "./io.ts";

type Params = Record<string, unknown>;

/** What the commands need from a peer. Every operation is bounded by the target's signal. */
export interface Target {
  /** The Connection under the target (socket and WebSocket mode), for library helpers that take one. */
  readonly connection: Connection | undefined;
  /**
   * `service`: in simple HTTP mode, the service to route to (default: derived from the method by the bridge). `fds`
   * (M11, `--push-fd=`) go with the call; a target that cannot pass fds rejects with OperationNotSupportedError
   * before sending anything (as do the other operations).
   */
  call(method: string, parameters: Params, service?: string, fds?: readonly FdHandle[]): Promise<Params>;
  /**
   * M11 (`--exec`): a call that accepts fds in its reply. A target that cannot receive fds makes it a plain call
   * (no fds), like varlinkctl when it cannot enable fd input.
   */
  callAcceptingFds(method: string, parameters: Params, fds?: readonly FdHandle[]): Promise<WithFds>;
  stream(method: string, parameters: Params, fds?: readonly FdHandle[]): AsyncIterableIterator<Params>;
  collect(method: string, parameters: Params, fds?: readonly FdHandle[]): Promise<Params[]>;
  /** Resolves once the call was written (simple HTTP mode: rejects, it has no oneway). */
  oneway(method: string, parameters: Params, fds?: readonly FdHandle[]): Promise<void>;
  /**
   * A protocol upgrade: the upgraded channel (the connection is finished; close the channel). Simple HTTP mode has
   * none (a CliError).
   */
  upgrade(method: string, parameters: Params): Promise<ByteChannel>;
  /**
   * The service to send an `org.varlink.service` call to: `undefined` on a connection (it is the service); in simple
   * HTTP mode `iface` when given, else the bridge's only service (more than one: a CliError).
   */
  introspectionService(iface?: string): Promise<string | undefined>;
  /** Closes the connection (idempotent; simple HTTP mode has none). */
  close(): Promise<void>;
}

/** Options of every connection the CLI opens: lossless ints, raw replies, no library timeout. */
const CONNECTION_OPTIONS: ConnectionOptions = {
  timeout: 0,
  ints: "bigint",
  validateReplies: "off",
  onError: () => undefined,
};

/** Call options with `fds` only when there are some (so fd-less calls stay exactly as before M11). */
function withFds(signal: AbortSignal, fds: readonly FdHandle[] | undefined): { signal: AbortSignal; fds?: FdHandle[] } {
  return fds === undefined || fds.length === 0 ? { signal } : { signal, fds: [...fds] };
}

function connectionTarget(conn: Connection, signal: AbortSignal): Target {
  return {
    connection: conn,
    call: (method, parameters, _service, fds) => conn.call(method, parameters, withFds(signal, fds)),
    async callAcceptingFds(method, parameters, fds) {
      try {
        return await conn.call(method, parameters, { ...withFds(signal, fds), acceptFds: true });
      } catch (e) {
        // Refused locally, before anything was sent: this connection cannot receive fds.
        if (!(e instanceof OperationNotSupportedError) || (fds !== undefined && fds.length > 0)) throw e;
        return { parameters: await conn.call(method, parameters, { signal }), fds: [] };
      }
    },
    stream: (method, parameters, fds) => conn.stream(method, parameters, withFds(signal, fds)),
    collect: (method, parameters, fds) => conn.collect(method, parameters, withFds(signal, fds)),
    oneway: (method, parameters, fds) => conn.oneway(method, parameters, withFds(signal, fds)),
    upgrade: async (method, parameters) => (await conn.upgrade(method, parameters, { signal })).channel,
    introspectionService: () => Promise.resolve(undefined),
    close: () => conn.close(),
  };
}

/** Simple HTTP mode has no fds: rejects (before anything is sent) when there are some. */
function noFds(fds: readonly FdHandle[] | undefined): Promise<void> {
  return fds === undefined || fds.length === 0
    ? Promise.resolve()
    : Promise.reject(new OperationNotSupportedError("simple HTTP mode cannot pass file descriptors"));
}

function httpTarget(client: HttpClient, signal: AbortSignal): Target {
  return {
    connection: undefined,
    call: async (method, parameters, service, fds) => {
      await noFds(fds);
      return client.call(method, parameters, service === undefined ? { signal } : { signal, service });
    },
    callAcceptingFds: async (method, parameters, fds) => {
      await noFds(fds);
      return { parameters: await client.call(method, parameters, { signal }), fds: [] };
    },
    stream: (method, parameters, fds) => {
      if (fds !== undefined && fds.length > 0)
        throw new OperationNotSupportedError("simple HTTP mode cannot pass file descriptors");
      return client.stream(method, parameters, { signal });
    },
    collect: async (method, parameters, fds) => {
      await noFds(fds);
      return client.collect(method, parameters, { signal });
    },
    oneway: async (method, parameters, fds) => {
      await noFds(fds);
      return client.oneway(method, parameters, { signal });
    },
    upgrade: () =>
      Promise.reject(
        new CliError(
          "simple HTTP mode has no protocol upgrade; use the WebSocket address of the service (…/ws/services/<service>)",
        ),
      ),
    async introspectionService(iface) {
      if (iface !== undefined) return iface;
      const services = await client.listServices({ signal });
      const [only] = services;
      if (services.length === 1 && only !== undefined) return only;
      throw new CliError(
        `simple HTTP mode cannot tell which service to ask: the bridge serves ${String(services.length)} services; ` +
          "use the WebSocket address of one (…/ws/services/<service>)",
      );
    },
    close: () => Promise.resolve(),
  };
}

/**
 * Opens a target for `spec`; `signal` bounds the connect phase and every later operation (aborting it after
 * connecting closes the connection, as the library does for an aborted call). Connect failures reject as the library
 * reports them (e.g. `ECONNREFUSED`, `OperationNotSupportedError` for kinds the runtime adapter cannot dial yet).
 */
export async function openTarget(spec: AddressSpec, signal: AbortSignal, native?: NativeAddon): Promise<Target> {
  switch (spec.kind) {
    case "http":
      return httpTarget(createHttpClient(spec, { timeout: 0, ints: "bigint", onError: () => undefined }), signal);
    case "websocket":
      return connectionTarget(await webSocketConnect(spec, { ...CONNECTION_OPTIONS, signal }), signal);
    default:
      // `native` (M11, only for --push-fd=/--exec): unix sockets through varlink-js-native (fd passing).
      return connectionTarget(
        await nodeConnect(spec, { ...CONNECTION_OPTIONS, signal, ...(native === undefined ? {} : { native }) }),
        signal,
      );
  }
}
