// The org.varlink.service errors (UAPI.20) and varlink-js's InternalError (DESIGN.md Q2).
import { isVarlinkError, VarlinkError } from "./varlink-error.ts";

/** Interface of the standard errors. */
export const ORG_VARLINK_SERVICE = "org.varlink.service";

/** `error InterfaceNotFound (interface: string)` */
export class InterfaceNotFoundError extends VarlinkError<{ interface: string }> {
  static readonly errorName: string = `${ORG_VARLINK_SERVICE}.InterfaceNotFound`;
  constructor(parameters: { interface: string }, options?: ErrorOptions) {
    super(InterfaceNotFoundError.errorName, parameters, options);
  }
  static is(e: unknown): e is InterfaceNotFoundError {
    return isVarlinkError(e, InterfaceNotFoundError.errorName);
  }
}

/** `error MethodNotFound (method: string)` */
export class MethodNotFoundError extends VarlinkError<{ method: string }> {
  static readonly errorName: string = `${ORG_VARLINK_SERVICE}.MethodNotFound`;
  constructor(parameters: { method: string }, options?: ErrorOptions) {
    super(MethodNotFoundError.errorName, parameters, options);
  }
  static is(e: unknown): e is MethodNotFoundError {
    return isVarlinkError(e, MethodNotFoundError.errorName);
  }
}

/** `error MethodNotImplemented (method: string)` */
export class MethodNotImplementedError extends VarlinkError<{ method: string }> {
  static readonly errorName: string = `${ORG_VARLINK_SERVICE}.MethodNotImplemented`;
  constructor(parameters: { method: string }, options?: ErrorOptions) {
    super(MethodNotImplementedError.errorName, parameters, options);
  }
  static is(e: unknown): e is MethodNotImplementedError {
    return isVarlinkError(e, MethodNotImplementedError.errorName);
  }
}

/** `error InvalidParameter (parameter: string)`; `parameter` is a dotted path (DESIGN.md §4.9). */
export class InvalidParameterError extends VarlinkError<{ parameter: string }> {
  static readonly errorName: string = `${ORG_VARLINK_SERVICE}.InvalidParameter`;
  constructor(parameters: { parameter: string }, options?: ErrorOptions) {
    super(InvalidParameterError.errorName, parameters, options);
  }
  static is(e: unknown): e is InvalidParameterError {
    return isVarlinkError(e, InvalidParameterError.errorName);
  }
}

/** `error PermissionDenied ()` */
export class PermissionDeniedError extends VarlinkError<Record<string, never>> {
  static readonly errorName: string = `${ORG_VARLINK_SERVICE}.PermissionDenied`;
  constructor(parameters?: Record<string, never>, options?: ErrorOptions) {
    super(PermissionDeniedError.errorName, parameters, options);
  }
  static is(e: unknown): e is PermissionDeniedError {
    return isVarlinkError(e, PermissionDeniedError.errorName);
  }
}

/** `error ExpectedMore ()` */
export class ExpectedMoreError extends VarlinkError<Record<string, never>> {
  static readonly errorName: string = `${ORG_VARLINK_SERVICE}.ExpectedMore`;
  constructor(parameters?: Record<string, never>, options?: ErrorOptions) {
    super(ExpectedMoreError.errorName, parameters, options);
  }
  static is(e: unknown): e is ExpectedMoreError {
    return isVarlinkError(e, ExpectedMoreError.errorName);
  }
}

/** `error ExpectedUpgrade ()` */
export class ExpectedUpgradeError extends VarlinkError<Record<string, never>> {
  static readonly errorName: string = `${ORG_VARLINK_SERVICE}.ExpectedUpgrade`;
  constructor(parameters?: Record<string, never>, options?: ErrorOptions) {
    super(ExpectedUpgradeError.errorName, parameters, options);
  }
  static is(e: unknown): e is ExpectedUpgradeError {
    return isVarlinkError(e, ExpectedUpgradeError.errorName);
  }
}

/** Interface of {@link InternalError}, auto-registered by servers so the error is introspectable (Q2). */
export const INTERNAL_ERROR_INTERFACE = "io.github.pzmarzly.varlinkjs";

/** IDL of {@link INTERNAL_ERROR_INTERFACE}, in canonical format. */
export const INTERNAL_ERROR_INTERFACE_IDL: string = `# Errors of the varlink-js library itself.
interface ${INTERNAL_ERROR_INTERFACE}

# A method handler failed unexpectedly. Details are reported to the server's onError hook, never sent.
error InternalError ()
`;

/** The reply to a call whose handler threw something other than a {@link VarlinkError} (DESIGN.md §5.4). */
export class InternalError extends VarlinkError<Record<string, never>> {
  static readonly errorName: string = `${INTERNAL_ERROR_INTERFACE}.InternalError`;
  constructor(parameters?: Record<string, never>, options?: ErrorOptions) {
    super(InternalError.errorName, parameters, options);
  }
  static is(e: unknown): e is InternalError {
    return isVarlinkError(e, InternalError.errorName);
  }
}
