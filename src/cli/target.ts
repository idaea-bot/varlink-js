// Address → target (DESIGN.md §4.14): one small interface over a Connection (unix, unix:@, tcp, and whatever
// varlink-js/node's connect() learns later, e.g. exec:/ssh-* in M8; WebSocket mode) and the simple HTTP mode client.
// The CLI bounds everything with its own deadline signal, so the library's timeouts are off (0).
import type { AddressSpec } from "../core/address/index.ts";
import { createHttpClient, type HttpClient } from "../http/index.ts";
import { connect as nodeConnect } from "../node/index.ts";
import type { Connection, ConnectionOptions } from "../rpc/index.ts";
import { connect as webSocketConnect } from "../websocket/index.ts";
import { CliError } from "./io.ts";

type Params = Record<string, unknown>;

/** What the commands need from a peer. Every operation is bounded by the target's signal. */
export interface Target {
  /** The Connection under the target (socket and WebSocket mode), for library helpers that take one. */
  readonly connection: Connection | undefined;
  /** `service`: in simple HTTP mode, the service to route to (default: derived from the method by the bridge). */
  call(method: string, parameters: Params, service?: string): Promise<Params>;
  stream(method: string, parameters: Params): AsyncIterableIterator<Params>;
  collect(method: string, parameters: Params): Promise<Params[]>;
  /** Resolves once the call was written (simple HTTP mode: rejects, it has no oneway). */
  oneway(method: string, parameters: Params): Promise<void>;
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

function connectionTarget(conn: Connection, signal: AbortSignal): Target {
  return {
    connection: conn,
    call: (method, parameters) => conn.call(method, parameters, { signal }),
    stream: (method, parameters) => conn.stream(method, parameters, { signal }),
    collect: (method, parameters) => conn.collect(method, parameters, { signal }),
    oneway: (method, parameters) => conn.oneway(method, parameters, { signal }),
    introspectionService: () => Promise.resolve(undefined),
    close: () => conn.close(),
  };
}

function httpTarget(client: HttpClient, signal: AbortSignal): Target {
  return {
    connection: undefined,
    call: (method, parameters, service) =>
      client.call(method, parameters, service === undefined ? { signal } : { signal, service }),
    stream: (method, parameters) => client.stream(method, parameters, { signal }),
    collect: (method, parameters) => client.collect(method, parameters, { signal }),
    oneway: (method, parameters) => client.oneway(method, parameters, { signal }),
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
export async function openTarget(spec: AddressSpec, signal: AbortSignal): Promise<Target> {
  switch (spec.kind) {
    case "http":
      return httpTarget(createHttpClient(spec, { timeout: 0, ints: "bigint", onError: () => undefined }), signal);
    case "websocket":
      return connectionTarget(await webSocketConnect(spec, { ...CONNECTION_OPTIONS, signal }), signal);
    default:
      return connectionTarget(await nodeConnect(spec, { ...CONNECTION_OPTIONS, signal }), signal);
  }
}
