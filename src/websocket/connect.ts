// connect()/createPool(): a Connection over a WebSocket to a UAPI bridge (DESIGN.md §4.12; UAPI "WebSocket Mode").
import { parseAddress, type AddressSpec } from "../core/address/parse.ts";
import {
  CallTimeoutError,
  ConnectionClosedError,
  OperationNotSupportedError,
  safeQuote,
} from "../core/errors/local.ts";
import { createConnection, DEFAULT_TIMEOUT, type Connection, type ConnectionOptions } from "../rpc/connection.ts";
import { createPool as createFactoryPool, type Pool, type PoolOptions } from "../rpc/pool.ts";
import type { ByteChannel } from "../core/protocol/channel.ts";
import { checkTimeout } from "../rpc/util.ts";
import {
  checkChannelOptions,
  closeSocket,
  fromWebSocket,
  type WebSocketChannelOptions,
  type WebSocketLike,
} from "./channel.ts";

/**
 * A WHATWG `WebSocket` constructor (structurally typed). Pass one to {@link connect} to use a client that can set
 * headers or client certificates (e.g. a subclass of the `ws` package's `WebSocket` that adds its options).
 */
export type WebSocketConstructorLike = new (url: string, protocols?: string | string[]) => WebSocketLike;

/** Options for {@link connect}: the connection's and the channel's options, plus the connect-phase ones. */
export interface WebSocketConnectOptions extends ConnectionOptions, WebSocketChannelOptions {
  /** Aborts the connect phase (the promise rejects with the signal's reason). Not used after connecting. */
  signal?: AbortSignal;
  /** WebSocket subprotocols to request. */
  protocols?: string | string[];
  /** The constructor to use; default `globalThis.WebSocket`. */
  WebSocket?: WebSocketConstructorLike;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/** `href` without user and password, for error messages (they get logged). */
function redactUrl(href: string): string {
  try {
    const url = new URL(href);
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return "(invalid URL)";
  }
}

/** The ws(s):// URL to dial for a WebSocket-mode address (`http(s)://…/ws/services/<svc>` becomes ws(s)://). */
function dialUrl(spec: AddressSpec): string {
  switch (spec.kind) {
    case "websocket":
      return spec.url.replace(/^http/i, "ws");
    case "http":
      throw new TypeError(
        `${safeQuote(redactUrl(spec.url))} is a simple HTTP mode bridge URL, not a WebSocket endpoint (…/ws/services/<service>): ` +
          "use createHttpClient() from varlink-js/http",
      );
    default:
      throw new OperationNotSupportedError(
        `varlink-js/websocket connects to ws://, wss:// and http(s)://…/ws/services/<service> addresses, not ${spec.kind}: use varlink-js/node`,
      );
  }
}

/**
 * Opens a WebSocket and wraps it in a channel inside the `open` handler (so no message can arrive before the
 * channel listens); the connect phase is bounded by `timeout` (ms, 0 = none) and `signal`.
 */
function openChannel(
  Ctor: WebSocketConstructorLike,
  url: string,
  protocols: string | string[] | undefined,
  timeout: number,
  signal: AbortSignal | undefined,
  channelOptions: WebSocketChannelOptions,
): Promise<ByteChannel> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the abort reason as is
      reject(signal.reason);
      return;
    }
    // A throw here (invalid URL, a fragment: SyntaxError) rejects the promise as is.
    const ws = protocols === undefined ? new Ctor(url) : new Ctor(url, protocols);
    ws.binaryType = "arraybuffer";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onFailed);
      ws.removeEventListener("close", onFailed);
    };
    const fail = (error: unknown): void => {
      cleanup();
      // Keep an error listener until the socket's last event: some implementations (the `ws` package) throw on an
      // `error` nobody listens to, and closing a CONNECTING socket may emit one.
      if (ws.readyState !== CLOSED) {
        const lateError = (): void => undefined;
        const lateClose = (): void => {
          ws.removeEventListener("error", lateError);
          ws.removeEventListener("close", lateClose);
        };
        ws.addEventListener("error", lateError);
        ws.addEventListener("close", lateClose);
        closeSocket(ws, 1000);
      }
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the abort reason as is
      reject(error);
    };
    const opened = (): void => {
      try {
        resolve(fromWebSocket(ws, channelOptions));
      } catch (e) {
        fail(e);
      }
    };
    const onOpen = (): void => {
      cleanup();
      opened();
    };
    const onFailed = (event: unknown): void => {
      // Browsers do not expose why (e.g. the bridge's 502 when the service is unreachable).
      fail(new ConnectionClosedError("websocket connect failed", { cause: event }));
    };
    const onAbort = (): void => {
      fail(signal?.reason);
    };
    if (ws.readyState === OPEN) {
      opened();
      return;
    }
    if (ws.readyState !== CONNECTING) {
      fail(new ConnectionClosedError("websocket connect failed"));
      return;
    }
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onFailed);
    ws.addEventListener("close", onFailed);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeout > 0)
      timer = setTimeout(() => {
        fail(new CallTimeoutError("connect timed out"));
      }, timeout);
  });
}

/**
 * Connects to a varlink service through a UAPI HTTP bridge in WebSocket mode (DESIGN.md §4.12) and returns a
 * {@link Connection} over it: the full protocol (oneway, more, pipelining) tunnelled verbatim, no fds. Addresses:
 * `ws://…`, `wss://…`, and `http(s)://…/ws/services/<service>` (dialled as ws(s)://). A simple HTTP mode base URL
 * is a TypeError (use `createHttpClient` from `varlink-js/http`); socket addresses reject with
 * `OperationNotSupportedError` (use `varlink-js/node`).
 *
 * Uses `options.WebSocket`, else `globalThis.WebSocket` (absent: `OperationNotSupportedError`). The connect phase is
 * bounded by `options.timeout` (default 45 s, 0 = none; `CallTimeoutError("connect timed out")`) and
 * `options.signal` (its reason); the socket is closed on either. A failed handshake rejects with
 * `ConnectionClosedError("websocket connect failed")` — the WebSocket API does not tell why (a bridge answers 502
 * when the service is unreachable, 404 for an unknown service). Constructor errors (an invalid URL) reject as is.
 *
 * @throws {TypeError} (as a rejection) for an invalid address string.
 */
export async function connect(address: string | AddressSpec, options?: WebSocketConnectOptions): Promise<Connection> {
  const spec = typeof address === "string" ? parseAddress(address) : address;
  const url = dialUrl(spec);
  const {
    signal,
    protocols,
    WebSocket: ctorOption,
    maxBufferedBytes,
    writeHighWaterMark,
    ...connectionOptions
  } = options ?? {};
  const channelOptions = checkChannelOptions({
    ...(maxBufferedBytes === undefined ? {} : { maxBufferedBytes }),
    ...(writeHighWaterMark === undefined ? {} : { writeHighWaterMark }),
  });
  const timeout = checkTimeout(connectionOptions.timeout, "timeout", DEFAULT_TIMEOUT);
  // Typed by lib dom or @types/node depending on the consumer: only `typeof … === "function"` is relied on.
  const globalCtor: unknown = globalThis.WebSocket;
  const Ctor = ctorOption ?? (globalCtor as WebSocketConstructorLike | undefined);
  if (typeof Ctor !== "function")
    throw new OperationNotSupportedError("this runtime has no global WebSocket: pass options.WebSocket");
  const channel = await openChannel(Ctor, url, protocols, timeout, signal, channelOptions);
  try {
    return createConnection(channel, connectionOptions);
  } catch (e) {
    channel.close();
    throw e;
  }
}

/**
 * A {@link Pool} of WebSocket connections to `address` (DESIGN.md §5.2): `max`/`idleTimeout` configure the pool,
 * `timeout` both the pool (lease wait) and the connections, every other option is passed to each {@link connect}
 * (whose connect phase is aborted when the waiting operation gives up or the pool closes).
 */
export function createPool(address: string | AddressSpec, options?: PoolOptions & WebSocketConnectOptions): Pool {
  const { max, idleTimeout, ...connectOptions } = options ?? {};
  const timeout = connectOptions.timeout;
  const poolOptions: PoolOptions = {
    ...(max === undefined ? {} : { max }),
    ...(idleTimeout === undefined ? {} : { idleTimeout }),
    ...(timeout === undefined ? {} : { timeout }),
  };
  return createFactoryPool((signal) => connect(address, { ...connectOptions, signal }), poolOptions);
}
