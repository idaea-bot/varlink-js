// Error model (DESIGN.md §6, §4.9): wire errors, standard errors, local errors and the registry.
export {
  CallTimeoutError,
  ConnectionClosedError,
  IntegerRangeError,
  isVarlinkLocalError,
  MessageTooLargeError,
  OperationNotSupportedError,
  ProtocolError,
  UpgradePendingError,
  ValidationError,
  VARLINK_LOCAL_ERROR_BRAND,
  VarlinkLocalError,
  type ValidationReason,
} from "./local.ts";
export { createErrorRegistry, ErrorRegistry } from "./registry.ts";
export {
  ExpectedMoreError,
  ExpectedUpgradeError,
  INTERNAL_ERROR_INTERFACE,
  INTERNAL_ERROR_INTERFACE_IDL,
  InterfaceNotFoundError,
  InternalError,
  InvalidParameterError,
  MethodNotFoundError,
  MethodNotImplementedError,
  ORG_VARLINK_SERVICE,
  PermissionDeniedError,
} from "./standard.ts";
export { isVarlinkError, VARLINK_ERROR_BRAND, VarlinkError, type ErrorClass } from "./varlink-error.ts";
