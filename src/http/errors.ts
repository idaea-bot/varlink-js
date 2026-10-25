// The local error of the simple HTTP mode client (DESIGN.md §4.12): the bridge failed, not the varlink service.
import { safeQuote, VarlinkLocalError } from "../core/errors/local.ts";

/**
 * The HTTP bridge answered with something other than a varlink reply: a non-2xx status without a varlink error
 * body (502 service unreachable, 401, 404 unknown service, a non-JSON 500, …), or a streamed transport-failure
 * record `{"error": "<message>"}` (status 200). `localName` is `"varlink-js.HttpBridge"`.
 */
export class HttpBridgeError extends VarlinkLocalError {
  /** The HTTP status (200 for a transport-failure record in a stream). */
  readonly status: number;
  /** The bridge's `message` (or the transport-failure record's `error`), as sent; undefined if there was none. */
  readonly bridgeMessage: string | undefined;

  constructor(status: number, bridgeMessage: string | undefined, options?: ErrorOptions) {
    const detail = bridgeMessage === undefined ? "" : `: ${safeQuote(bridgeMessage)}`;
    super("varlink-js.HttpBridge", `HTTP bridge error (status ${String(status)})${detail}`, options);
    this.status = status;
    this.bridgeMessage = bridgeMessage;
  }
}
