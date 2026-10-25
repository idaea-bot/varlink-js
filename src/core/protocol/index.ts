// Protocol layer (DESIGN.md §4.1–§4.5, §5.4, §4.10): ByteChannel types, framer, messages, sans-IO sessions and
// dispatch.
export type { ByteChannel, FdHandle, FdPassing, Listener, PeerCredentials, ReadChunk } from "./channel.ts";
export { ClientSession, type ClientEvent, type ClientSessionOptions } from "./client-session.ts";
export {
  dispatchCall,
  parseMethodName,
  streamOf,
  type CallContext,
  type DispatchErrorReason,
  type DispatchOptions,
  type DispatchTable,
  type Handler,
  type HandlerResult,
  type LookupResult,
  type MethodEntry,
  type ValidateReplies,
} from "./dispatch.ts";
export { DEFAULT_MAX_MESSAGE_SIZE, Framer, frameMessage, type FramerOptions } from "./framer.ts";
export {
  decodeCall,
  decodeReply,
  encodeCall,
  encodeReply,
  type Call,
  type CallInit,
  type Reply,
  type ReplyInit,
} from "./messages.ts";
export {
  DEFAULT_MAX_QUEUED_CALLS,
  ServerSession,
  type ServerEvent,
  type ServerSessionOptions,
} from "./server-session.ts";
