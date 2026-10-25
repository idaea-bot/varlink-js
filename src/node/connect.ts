// connect(): a Connection over a Node socket (DESIGN.md §4.7, §4.11, §5.1).
import { connect as netConnect, type NetConnectOpts, type Socket } from "node:net";
import { parseAddress, type AddressSpec } from "../core/address/parse.ts";
import { CallTimeoutError, OperationNotSupportedError } from "../core/errors/local.ts";
import { createConnection, DEFAULT_TIMEOUT, type Connection, type ConnectionOptions } from "../rpc/connection.ts";
import { checkTimeout } from "../rpc/util.ts";
import { fromNodeSocket } from "./socket.ts";

/** Options for {@link connect}: the connection's options, plus a `signal` bounding the connect phase. */
export interface ConnectOptions extends ConnectionOptions {
  /** Aborts the connect phase (the promise rejects with the signal's reason). Not used after connecting. */
  signal?: AbortSignal;
}

/** The `net.connect` options for an address, or an OperationNotSupportedError for kinds Node cannot dial here. */
export function socketOptions(spec: AddressSpec): NetConnectOpts {
  switch (spec.kind) {
    case "unix":
      return { path: spec.path, allowHalfOpen: true };
    case "unix-abstract":
      if (process.platform !== "linux")
        throw new OperationNotSupportedError(`abstract unix sockets (unix:@) need Linux, not ${process.platform}`);
      return { path: `\0${spec.name}`, allowHalfOpen: true };
    case "tcp":
      return { host: spec.host, port: spec.port, allowHalfOpen: true, noDelay: true };
    default:
      throw new OperationNotSupportedError(`connect() does not support ${spec.kind} addresses yet`);
  }
}

/** Opens a socket; the connect phase is bounded by `timeout` (ms, 0 = none) and `signal`. */
export function openSocket(spec: AddressSpec, timeout: number, signal: AbortSignal | undefined): Promise<Socket> {
  return new Promise((resolve, reject) => {
    // A throw here (unsupported kind) rejects the promise.
    const opts = socketOptions(spec);
    if (signal?.aborted === true) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the abort reason as is
      reject(signal.reason);
      return;
    }
    const socket = netConnect(opts);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const fail = (error: unknown): void => {
      cleanup();
      // Keep a listener: the destroyed socket must not throw an unhandled `error` later.
      socket.on("error", () => undefined);
      socket.destroy();
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the Node error or abort reason
      reject(error);
    };
    const onConnect = (): void => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error): void => {
      fail(error);
    };
    const onAbort = (): void => {
      fail(signal?.reason);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeout > 0)
      timer = setTimeout(() => {
        fail(new CallTimeoutError("connect timed out"));
      }, timeout);
  });
}

/**
 * Connects to a varlink service (DESIGN.md §5.1) and returns a {@link Connection} over the socket. Supported here:
 * `unix:/path` (and bare paths), `unix:@name` (Linux only), `tcp:host:port` (`TCP_NODELAY` on). Other kinds reject
 * with `OperationNotSupportedError` (exec/ssh and WebSocket/HTTP come in later milestones). The connect phase is
 * bounded by `options.timeout` (default 45 s, 0 = none; expiry rejects with `CallTimeoutError("connect timed out")`)
 * and `options.signal` (rejects with its reason); the socket is destroyed on either. Connection errors (`ENOENT`,
 * `ECONNREFUSED`, …) reject with the Node error. Sockets are half-open capable (`allowHalfOpen`).
 *
 * @throws {TypeError} (as a rejection) for an invalid address string.
 */
export async function connect(address: string | AddressSpec, options?: ConnectOptions): Promise<Connection> {
  const spec = typeof address === "string" ? parseAddress(address) : address;
  const { signal, ...connectionOptions } = options ?? {};
  const timeout = checkTimeout(connectionOptions.timeout, "timeout", DEFAULT_TIMEOUT);
  const socket = await openSocket(spec, timeout, signal);
  try {
    return createConnection(fromNodeSocket(socket), connectionOptions);
  } catch (e) {
    socket.destroy();
    throw e;
  }
}
