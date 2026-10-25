// What the generated built-in interfaces import as `$vjs` (DESIGN.md §4.13): the runtime surface of generated code,
// re-exported from core and rpc by relative path (they cannot import "varlink-js"). Connection, Pool and Handlers
// are type-only and typed-client.ts imports nothing at runtime from rpc, so rpc/connection.ts → src/interfaces →
// here is not an import cycle.
export {
  ExpectedMoreError,
  ExpectedUpgradeError,
  InterfaceNotFoundError,
  InternalError,
  InvalidParameterError,
  isVarlinkError,
  MethodNotFoundError,
  MethodNotImplementedError,
  PermissionDeniedError,
  VarlinkError,
} from "../core/errors/index.ts";
export type { JsonValue, MethodDescriptor } from "../core/types/descriptors.ts";
export type { Connection } from "../rpc/connection.ts";
export type { Pool } from "../rpc/pool.ts";
export type { Handlers } from "../rpc/server.ts";
export { createClient, freezeDescriptor, type TypedClient, type VarlinkErrorOptions } from "../rpc/typed-client.ts";
