// varlink-js core entry point (DESIGN.md §4.11): types and errors (M2), the handler-facing protocol API (M3), the
// RPC layer and address parser (M4).
export * from "./core/errors/index.ts";
export * from "./core/types/index.ts";
export { formatAddress, parseAddress, type AddressSpec } from "./core/address/index.ts";
// Handler-facing protocol API (M3). Sessions, framer, message codecs and dispatchCall stay internal (M4 decision):
// transports import core by relative path.
export {
  DEFAULT_MAX_MESSAGE_SIZE,
  streamOf,
  type ByteChannel,
  type CallContext,
  type DispatchErrorReason,
  type FdHandle,
  type FdPassing,
  type Handler,
  type HandlerResult,
  type Listener,
  type PeerCredentials,
  type ReadChunk,
  type ValidateReplies,
} from "./core/protocol/index.ts";
export * from "./rpc/index.ts";
