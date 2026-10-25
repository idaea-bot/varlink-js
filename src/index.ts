// varlink-js core entry point. Types and errors from M2; client/server from M4 (DESIGN.md §10).
export * from "./core/errors/index.ts";
export * from "./core/types/index.ts";
// Handler-facing protocol API (M3); sessions, framer and message codecs stay internal to core until M4.
export {
  DEFAULT_MAX_MESSAGE_SIZE,
  streamOf,
  type ByteChannel,
  type CallContext,
  type FdHandle,
  type FdPassing,
  type Handler,
  type HandlerResult,
  type Listener,
  type PeerCredentials,
  type ReadChunk,
} from "./core/protocol/index.ts";
