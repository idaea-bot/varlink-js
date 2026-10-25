// Runtime-agnostic RPC layer over ByteChannel (DESIGN.md §4, §4.11): Connection, Pool, Server, proxy.
export {
  Connection,
  createConnection,
  DEFAULT_COLLECT_MAX,
  DEFAULT_HIGH_WATER_MARK,
  DEFAULT_TIMEOUT,
  type CallOptions,
  type CollectOptions,
  type ConnectionErrorReason,
  type ConnectionOptions,
  type ServiceInfo,
  type StreamIterator,
  type StreamOptions,
} from "./connection.ts";
export { createPool, Pool, type ConnectionFactory, type PoolOptions } from "./pool.ts";
export type { InterfaceProxy, ProxyMethod, ProxyOptions } from "./proxy.ts";
export {
  createServer,
  Server,
  type HandlerOptions,
  type HandlerRegistration,
  type Handlers,
  type ServeListener,
  type ServerErrorReason,
  type ServerOptions,
  type ShutdownOptions,
  type TypedHandler,
  type UntypedHandler,
  type UntypedHandlers,
} from "./server.ts";
