// Simple HTTP mode client (DESIGN.md §4.12; UAPI "Simple HTTP Mode"): one fetch() per call against a UAPI HTTP
// bridge, json-seq streams, introspection endpoints. Validation and error mapping as on a Connection (§4.11).
import { parseAddress, type AddressSpec } from "../core/address/parse.ts";
import {
  CallTimeoutError,
  ConnectionClosedError,
  isVarlinkLocalError,
  MessageTooLargeError,
  OperationNotSupportedError,
  ProtocolError,
  safeQuote,
} from "../core/errors/local.ts";
import { createErrorRegistry, type ErrorRegistry } from "../core/errors/registry.ts";
import { INTERNAL_ERROR_INTERFACE_IDL, ORG_VARLINK_SERVICE, ORG_VARLINK_SERVICE_IDL } from "../core/errors/standard.ts";
import { isErrorName, VarlinkError, type ErrorClass } from "../core/errors/varlink-error.ts";
import { isInterfaceName } from "../core/idl/names.ts";
import { parseMethodName, type ValidateReplies } from "../core/protocol/dispatch.ts";
import { checkMaxMessageSize } from "../core/protocol/framer.ts";
import { jsonCodec, type Codec } from "../core/types/codec.ts";
import { compileInterfaceText, type CompiledInterface, type IntsMode, type Validator } from "../core/types/compile.ts";
import {
  assertIntsMode,
  compileDescriptor,
  type InterfaceDescriptor,
  type MethodDescriptor,
  type MethodInput,
  type MethodOutput,
} from "../core/types/descriptors.ts";
import {
  DEFAULT_COLLECT_MAX,
  DEFAULT_TIMEOUT,
  type ConnectionErrorReason,
  type ServiceInfo,
  type StreamIterator,
} from "../rpc/connection.ts";
import { checkMode, checkPositiveInt, checkTimeout, splitName } from "../rpc/util.ts";
import { HttpBridgeError } from "./errors.ts";
import { isJsonWhitespace, JsonSeqSplitter } from "./jsonseq.ts";

/** What {@link FetchLike} is called with. */
export interface FetchInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

/** A reader of a response body (`ReadableStreamDefaultReader<Uint8Array>`). */
export interface ReadableStreamReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  cancel(reason?: unknown): Promise<void>;
}

/** A response body (`ReadableStream<Uint8Array>`). */
export interface ReadableStreamLike {
  getReader(): ReadableStreamReaderLike;
}

/** The members of a fetch `Response` this client uses. */
export interface ResponseLike {
  readonly status: number;
  readonly body: ReadableStreamLike | null;
}

/** A WHATWG `fetch` (structurally typed, so the public types compile without lib `dom`). */
export type FetchLike = (url: string, init: FetchInitLike) => Promise<ResponseLike>;

/** Options for {@link createHttpClient}. */
export interface HttpClientOptions {
  /** Default `globalThis.fetch` (looked up per request; absent: calls reject with OperationNotSupportedError). */
  fetch?: FetchLike;
  /** Sent with every request (e.g. `Authorization`); the client's `Content-Type` and `Accept` win. */
  headers?: Record<string, string>;
  /** Default service: requests go to `call/{service}/{method}`; without it `call/{method}` (the bridge derives it). */
  service?: string;
  /** Per-request timeout in ms (see {@link HttpCallOptions.timeout}); default 45 000; 0 = none. */
  timeout?: number;
  /** `int` representation for registered interfaces (§4.3); default `"number"`. */
  ints?: IntsMode;
  /** Reply validation for registered interfaces, as on a Connection; default `"off"`. */
  validateReplies?: ValidateReplies;
  /** Default {@link jsonCodec}. */
  codec?: Codec;
  /** Maps error replies to classes; default `createErrorRegistry()`. Descriptor error classes are added to it. */
  errors?: ErrorRegistry;
  /** Interfaces registered for validation at construction (descriptors or IDL text). */
  interfaces?: readonly (InterfaceDescriptor | string)[];
  /** Largest non-streaming response body, and largest json-seq record, in bytes; default 16 MiB. */
  maxMessageSize?: number;
  /**
   * Invalid replies (`"warn"`) and error replies whose parameters do not match their interface. Default: a one-line
   * `console.warn` naming the method and reason (never parameter values). Exceptions from it are swallowed.
   */
  onError?: (error: unknown, info: { method: string; reason: ConnectionErrorReason }) => void;
}

/** Options of a request without a method (introspection, health). */
export interface HttpRequestOptions {
  /** Overrides the client's timeout (ms, 0 = none); covers the whole request, body included. */
  timeout?: number;
  /** Aborting rejects with `signal.reason` and aborts the request. */
  signal?: AbortSignal;
}

/** Per-call options. */
export interface HttpCallOptions extends HttpRequestOptions {
  /** The service to call (overrides the client's `service`). */
  service?: string;
}

/** Options for `stream()`: `timeout` covers the time to the first record. */
export interface HttpStreamOptions extends HttpCallOptions {
  /** Longest wait for the next record while `next()` is pending, in ms (default none). */
  idleTimeout?: number;
}

/** Options for `collect()`. */
export interface HttpCollectOptions extends HttpCallOptions {
  /** Most replies accepted (default 1024); more rejects with RangeError and aborts the request. */
  max?: number;
}

interface Registered {
  readonly idl: string;
  readonly compiled: CompiledInterface;
}

interface CallSpec {
  readonly input?: Validator | undefined;
  readonly output?: Validator | undefined;
  readonly mode: ValidateReplies;
}

/** A prepared call: everything checked and encoded before any request is made. */
interface Prepared {
  readonly method: string;
  readonly url: string;
  readonly body: string;
  readonly spec: CallSpec | undefined;
}

/** A reply-shaped error record: an object whose own keys are within {error, parameters}, `error` a string. */
interface ErrorRecord {
  readonly error: string;
  readonly parameters: Record<string, unknown> | undefined;
}

/** RFC 9110 token: a valid header name. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Header values must not contain CR, LF or NUL. */
const HEADER_VALUE_FORBIDDEN = /[\r\n\0]/;
/** Header names the client sets itself (they replace the user's). */
const OWN_HEADERS = new Set(["content-type", "accept"]);

/** Streams take json-seq, or one JSON reply (a single-reply method; bridge error bodies are JSON too). */
const STREAM_ACCEPT = "application/json-seq, application/json;q=0.9";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorRecord(value: Record<string, unknown>): ErrorRecord | undefined {
  const keys = Object.keys(value);
  if (!keys.includes("error") || keys.some((k) => k !== "error" && k !== "parameters")) return undefined;
  const error = value.error;
  const parameters = value.parameters;
  if (typeof error !== "string") return undefined;
  if (parameters !== undefined && parameters !== null && !isObject(parameters)) return undefined;
  return { error, parameters: parameters ?? undefined };
}

function defaultOnError(_error: unknown, info: { method: string; reason: ConnectionErrorReason }): void {
  console.warn(`varlink-js: ${info.reason} for ${safeQuote(info.method)} (set the HTTP client's onError to handle it)`);
}

function isIntRange(e: unknown): boolean {
  return (
    isVarlinkLocalError(e, "org.varlink.service.InvalidParameter") && (e as { reason?: unknown }).reason === "int-range"
  );
}

function checkHeaders(headers: unknown): Record<string, string> {
  if (headers === undefined) return {};
  if (!isObject(headers)) throw new TypeError("headers must be an object of strings");
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) throw new TypeError(`invalid header name ${safeQuote(name)}`);
    if (typeof value !== "string" || HEADER_VALUE_FORBIDDEN.test(value))
      throw new TypeError(`header ${safeQuote(name)} must be a string without CR, LF or NUL`);
    if (!OWN_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

/** A name for an error message: quoted if it is a string, else its type. */
function describeName(value: unknown): string {
  return typeof value === "string" ? safeQuote(value) : `a ${typeof value}`;
}

function checkService(service: unknown): string | undefined {
  if (service === undefined) return undefined;
  if (typeof service !== "string" || !isInterfaceName(service))
    throw new TypeError(`service must be a valid interface name, not ${describeName(service)}`);
  return service;
}

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

/** The bridge base URL: an `http` address, fragment and query dropped, with a trailing `/`. */
function baseUrl(base: string | AddressSpec): string {
  const spec = typeof base === "string" ? parseAddress(base) : base;
  if (spec.kind === "websocket")
    throw new TypeError(
      `${safeQuote(redactUrl(spec.url))} is a WebSocket mode address: use connect() from varlink-js/websocket`,
    );
  if (spec.kind !== "http")
    throw new TypeError(`createHttpClient() needs an http(s):// bridge base URL, not a ${spec.kind} address`);
  const url = new URL(spec.url);
  if (url.username !== "" || url.password !== "")
    throw new TypeError("credentials in the base URL are not supported (fetch refuses them): use headers");
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

/**
 * One HTTP request: an AbortController linked to the caller's signal and a timer, the response body's reader, and
 * the reason the request was aborted (rejections after an abort report that reason, whatever fetch says).
 */
class Exchange {
  readonly #controller = new AbortController();
  readonly #signal: AbortSignal | undefined;
  readonly #onAbort = (): void => {
    this.abort(this.#signal?.reason);
  };
  #timer: ReturnType<typeof setTimeout> | undefined;
  #failure: { error: unknown } | undefined;
  #reader: ReadableStreamReaderLike | undefined;
  #settled = false;

  constructor(signal: AbortSignal | undefined) {
    this.#signal = signal;
    signal?.addEventListener("abort", this.#onAbort, { once: true });
  }

  /** Sends the request; resolves with the response once its headers arrived. */
  async fetch(fetchFn: FetchLike, url: string, init: Omit<FetchInitLike, "signal">): Promise<ResponseLike> {
    let response: ResponseLike;
    try {
      response = await fetchFn(url, { ...init, signal: this.#controller.signal });
    } catch (e) {
      throw this.#failure === undefined
        ? new ConnectionClosedError("http request failed", { cause: e })
        : this.#failure.error;
    }
    const body = response.body;
    this.#reader = body === null ? undefined : body.getReader();
    if (this.#failure !== undefined) {
      this.#cancelReader(this.#failure.error);
      throw this.#failure.error;
    }
    return response;
  }

  /** The next body chunk, or null at its end. */
  async read(): Promise<Uint8Array | null> {
    this.#throwIfAborted();
    const reader = this.#reader;
    if (reader === undefined) return null;
    let result: { done: boolean; value?: Uint8Array | undefined };
    try {
      result = await reader.read();
    } catch (e) {
      this.#throwIfAborted();
      throw new ConnectionClosedError("http response body failed", { cause: e });
    }
    // Aborted while the read was pending (a cancelled reader reports a plain end).
    this.#throwIfAborted();
    if (result.done) {
      this.#reader = undefined;
      return null;
    }
    const value: unknown = result.value;
    if (!ArrayBuffer.isView(value)) throw new ProtocolError("the response body is not a byte stream");
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  /** (Re)starts the timer: expiry aborts the request with `error()`. 0 = no timer. */
  arm(ms: number, error: () => unknown): void {
    this.disarm();
    if (ms > 0 && !this.#settled)
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.abort(error());
      }, ms);
  }

  disarm(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Ends the request early: the body is cancelled and the fetch aborted. No-op once settled. */
  abort(error: unknown): void {
    if (this.#settled) return;
    this.#failure = { error };
    this.#release();
    this.#cancelReader(error);
    this.#controller.abort(error);
  }

  /** The request is over (body consumed or not needed): timer and listener go; an unread body is cancelled. */
  finish(): void {
    if (this.#settled) return;
    this.#release();
    if (this.#reader !== undefined) this.#cancelReader(undefined);
  }

  /** Throws why the request was aborted, if it was. */
  #throwIfAborted(): void {
    if (this.#failure !== undefined) throw this.#failure.error;
  }

  #release(): void {
    this.#settled = true;
    this.disarm();
    this.#signal?.removeEventListener("abort", this.#onAbort);
  }

  #cancelReader(reason: unknown): void {
    const reader = this.#reader;
    this.#reader = undefined;
    if (reader === undefined) return;
    try {
      reader.cancel(reason).catch(() => undefined);
    } catch {
      // A reader that throws synchronously: nothing more to do.
    }
  }
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lenientUtf8 = new TextDecoder("utf-8");

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * A client for a UAPI HTTP bridge in simple HTTP mode (DESIGN.md §4.12): every call is its own POST request (no
 * connection, no pipelining, no oneway, no upgrade; nothing orders concurrent calls). Create it with
 * {@link createHttpClient}. A call is cancelled with its `signal`; there is nothing to close.
 */
export class HttpClient {
  readonly #base: string;
  readonly #fetch: FetchLike | undefined;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #service: string | undefined;
  readonly #timeout: number;
  readonly #ints: IntsMode;
  readonly #mode: ValidateReplies;
  readonly #codec: Codec;
  readonly #errors: ErrorRegistry;
  readonly #max: number;
  readonly #onError: (error: unknown, info: { method: string; reason: ConnectionErrorReason }) => void;
  readonly #interfaces = new Map<string, Registered>();

  /** Use {@link createHttpClient}. */
  constructor(base: string | AddressSpec, options?: HttpClientOptions) {
    this.#base = baseUrl(base);
    const fetchFn = options?.fetch;
    if (fetchFn !== undefined && typeof fetchFn !== "function") throw new TypeError("fetch must be a function");
    this.#fetch = fetchFn;
    this.#headers = Object.freeze(checkHeaders(options?.headers));
    this.#service = checkService(options?.service);
    this.#timeout = checkTimeout(options?.timeout, "timeout", DEFAULT_TIMEOUT);
    this.#ints = checkMode(options?.ints, "ints", ["number", "bigint"], "number");
    this.#mode = checkMode(options?.validateReplies, "validateReplies", ["off", "warn", "throw"], "off");
    this.#codec = options?.codec ?? jsonCodec;
    this.#errors = options?.errors ?? createErrorRegistry();
    this.#max = checkMaxMessageSize(options?.maxMessageSize);
    const onError = options?.onError ?? defaultOnError;
    if (typeof onError !== "function") throw new TypeError("onError must be a function");
    this.#onError = onError;
    this.addInterface(ORG_VARLINK_SERVICE_IDL);
    this.addInterface(INTERNAL_ERROR_INTERFACE_IDL);
    for (const i of options?.interfaces ?? []) this.addInterface(i);
  }

  /** The bridge base URL requests are relative to (normalized: no query or fragment, trailing `/`). */
  get baseUrl(): string {
    return this.#base;
  }

  /**
   * Registers an interface for validation, as `Connection.addInterface` does: compiled with this client's `ints`
   * and codec; a descriptor's error classes are added to the error registry; the same name again is a no-op for the
   * same IDL text and a TypeError for a different one.
   *
   * @throws {TypeError} on a different IDL under a taken name, a descriptor mismatch or an `ints` mismatch.
   * @throws {IdlSyntaxError} for invalid IDL.
   */
  addInterface(descriptorOrIdl: InterfaceDescriptor | string): void {
    let idl: string;
    let compiled: CompiledInterface;
    let classes: ErrorClass[] = [];
    if (typeof descriptorOrIdl === "string") {
      idl = descriptorOrIdl;
      compiled = compileInterfaceText(idl, { ints: this.#ints, codec: this.#codec });
    } else {
      assertIntsMode(descriptorOrIdl, this.#ints);
      idl = descriptorOrIdl.idl;
      compiled = compileDescriptor(descriptorOrIdl, { codec: this.#codec });
      classes = Object.values(descriptorOrIdl.errors);
    }
    const existing = this.#interfaces.get(compiled.name);
    if (existing !== undefined && existing.idl !== idl)
      throw new TypeError(`interface ${compiled.name} is already registered with a different IDL`);
    this.#errors.register(...classes);
    if (existing === undefined) this.#interfaces.set(compiled.name, { idl, compiled });
  }

  /**
   * One call, one request: `POST {base}call/{method}` (or `call/{service}/{method}`). Resolves with the reply
   * parameters. Rejects with the error reply (a VarlinkError), `HttpBridgeError` (the bridge failed),
   * `ConnectionClosedError` (fetch failed), `CallTimeoutError`, `ProtocolError`/`MessageTooLargeError`, a
   * `ValidationError`, or the abort reason. `timeout` covers the whole request, body included.
   */
  call<M extends MethodDescriptor<object, object>>(
    method: M,
    parameters: MethodInput<M>,
    options?: HttpCallOptions,
  ): Promise<MethodOutput<M>>;
  call(
    method: string,
    parameters?: Record<string, unknown>,
    options?: HttpCallOptions,
  ): Promise<Record<string, unknown>>;
  async call(
    method: string | MethodDescriptor<object, object>,
    parameters?: object,
    options?: HttpCallOptions,
  ): Promise<Record<string, unknown>> {
    const p = this.#prepare(method, parameters, options, false);
    const timeout = checkTimeout(options?.timeout, "timeout", this.#timeout);
    const signal = this.#checkSignal(options?.signal);
    const ex = new Exchange(signal);
    try {
      ex.arm(timeout, () => new CallTimeoutError(`${p.method}: timed out after ${String(timeout)} ms`));
      const response = await ex.fetch(this.#fetchFn(), p.url, this.#post(p.body, "application/json"));
      const bytes = await this.#readAll(ex);
      if (!isSuccess(response.status)) throw this.#failure(response.status, bytes, p.method);
      const value = this.#decodeJson(bytes, p.method);
      const reply = this.#reply(value, p.spec, p.method);
      ex.finish();
      return reply;
    } catch (e) {
      ex.abort(e);
      throw e;
    }
  }

  /** Simple HTTP mode has no oneway calls (UAPI "Limitations"): always rejects with OperationNotSupportedError. */
  oneway(
    method: string | MethodDescriptor<object, object>,
    parameters?: object,
    options?: HttpCallOptions,
  ): Promise<void>;
  oneway(): Promise<void> {
    return Promise.reject(
      new OperationNotSupportedError("simple HTTP mode has no oneway calls: use WebSocket mode (varlink-js/websocket)"),
    );
  }

  /**
   * A call with `more`: `POST …?more=true`, the replies streamed as `application/json-seq` (or one
   * `application/json` reply). The request starts at once. Yields every reply; an error record at the end of the
   * body rejects `next()` (a VarlinkError, or `HttpBridgeError` for a transport-failure record). A record shaped like
   * an error (`{error: string, parameters?}`) is held back until the next record arrives (then it was a reply) or the
   * body ends (then it is the error). Records are read from the body only while `next()` is pending (backpressure).
   * `timeout` covers the time to the first record (counted from the call), `idleTimeout` the gaps between later
   * records while `next()` waits. `return()` (leaving a `for await`) cancels the body and aborts the request.
   */
  stream<M extends MethodDescriptor<object, object>>(
    method: M,
    parameters: MethodInput<M>,
    options?: HttpStreamOptions,
  ): StreamIterator<MethodOutput<M>>;
  stream(method: string, parameters?: Record<string, unknown>, options?: HttpStreamOptions): StreamIterator;
  stream(
    method: string | MethodDescriptor<object, object>,
    parameters?: object,
    options?: HttpStreamOptions,
  ): StreamIterator {
    let source: RecordSource;
    try {
      const p = this.#prepare(method, parameters, options, true);
      const timeout = checkTimeout(options?.timeout, "timeout", this.#timeout);
      const idleTimeout = checkTimeout(options?.idleTimeout, "idleTimeout", 0);
      source = new RecordSource(this.#records(), p, this.#checkSignal(options?.signal), {
        first: timeout,
        idle: idleTimeout,
        whole: false,
      });
    } catch (e) {
      return failedStream(e);
    }
    return new HttpReplyStream(source);
  }

  /** A call with `more`, collecting every reply (at most `options.max`, default 1024); `timeout` covers it all. */
  collect<M extends MethodDescriptor<object, object>>(
    method: M,
    parameters: MethodInput<M>,
    options?: HttpCollectOptions,
  ): Promise<MethodOutput<M>[]>;
  collect(
    method: string,
    parameters?: Record<string, unknown>,
    options?: HttpCollectOptions,
  ): Promise<Record<string, unknown>[]>;
  async collect(
    method: string | MethodDescriptor<object, object>,
    parameters?: object,
    options?: HttpCollectOptions,
  ): Promise<Record<string, unknown>[]> {
    const p = this.#prepare(method, parameters, options, true);
    const timeout = checkTimeout(options?.timeout, "timeout", this.#timeout);
    const max = checkPositiveInt(options?.max, "max", DEFAULT_COLLECT_MAX);
    const source = new RecordSource(this.#records(), p, this.#checkSignal(options?.signal), {
      first: timeout,
      idle: 0,
      whole: true,
    });
    const all: Record<string, unknown>[] = [];
    for (;;) {
      const r = await source.next();
      if (r.done) return all;
      if (all.length >= max) {
        const error = new RangeError(`${p.method}: more than ${String(max)} replies`);
        source.abort(error);
        throw error;
      }
      all.push(r.value);
    }
  }

  /** `GET {base}services`: the names of the services the bridge serves. */
  async listServices(options?: HttpRequestOptions): Promise<string[]> {
    const value = await this.#get("services", options);
    const services = value.services;
    if (!Array.isArray(services) || !services.every((s) => typeof s === "string"))
      throw new ProtocolError("GET services: the reply is not {services: string[]}");
    return [...services];
  }

  /** `GET {base}services/{service}`: the service's `org.varlink.service.GetInfo` reply, validated. */
  async getInfo(service: string, options?: HttpRequestOptions): Promise<ServiceInfo> {
    const name = this.#requireName(service, "service");
    const value = await this.#get(`services/${encodeURIComponent(name)}`, options);
    const output = this.#interfaces.get(ORG_VARLINK_SERVICE)?.compiled.methods.get("GetInfo")?.output;
    return (output === undefined ? value : output.decode(value, { unknownFields: "drop" })) as ServiceInfo;
  }

  /** `GET {base}services/{service}/{interface}`: the unqualified method names of one interface. */
  async listMethods(service: string, iface: string, options?: HttpRequestOptions): Promise<string[]> {
    const s = this.#requireName(service, "service");
    const i = this.#requireName(iface, "interface");
    const value = await this.#get(`services/${encodeURIComponent(s)}/${encodeURIComponent(i)}`, options);
    const methods = value.methods;
    if (!Array.isArray(methods) || !methods.every((m) => typeof m === "string"))
      throw new ProtocolError(`GET services/${s}/${i}: the reply is not {methods: string[]}`);
    return [...methods];
  }

  /** `GET {base}health`: true iff the bridge answers 200. A network failure rejects (ConnectionClosedError). */
  async health(options?: HttpRequestOptions): Promise<boolean> {
    const timeout = checkTimeout(options?.timeout, "timeout", this.#timeout);
    const signal = this.#checkSignal(options?.signal);
    const ex = new Exchange(signal);
    try {
      ex.arm(timeout, () => new CallTimeoutError(`GET health: timed out after ${String(timeout)} ms`));
      const response = await ex.fetch(this.#fetchFn(), `${this.#base}health`, this.#getInit());
      ex.finish();
      return response.status === 200;
    } catch (e) {
      ex.abort(e);
      throw e;
    }
  }

  /** A GET returning a JSON object (errors mapped like a call's). */
  async #get(path: string, options: HttpRequestOptions | undefined): Promise<Record<string, unknown>> {
    const timeout = checkTimeout(options?.timeout, "timeout", this.#timeout);
    const signal = this.#checkSignal(options?.signal);
    const label = `GET ${path}`;
    const ex = new Exchange(signal);
    try {
      ex.arm(timeout, () => new CallTimeoutError(`${label}: timed out after ${String(timeout)} ms`));
      const response = await ex.fetch(this.#fetchFn(), this.#base + path, this.#getInit());
      const bytes = await this.#readAll(ex);
      if (!isSuccess(response.status)) throw this.#failure(response.status, bytes, label);
      const value = this.#decodeJson(bytes, label);
      if (!isObject(value)) throw new ProtocolError(`${label}: the reply is not a JSON object`);
      ex.finish();
      return value;
    } catch (e) {
      ex.abort(e);
      throw e;
    }
  }

  /** What a RecordSource needs from the client. */
  #records(): RecordContext {
    return {
      fetch: () => this.#fetchFn(),
      max: this.#max,
      post: (body) => this.#post(body, STREAM_ACCEPT),
      readAll: (ex) => this.#readAll(ex),
      decodeRecord: (bytes, method) => this.#decodeJson(bytes, method),
      reply: (value, spec, method) => this.#reply(value, spec, method),
      failure: (status, bytes, method) => this.#failure(status, bytes, method),
      errorRecord: (record, method) =>
        isErrorName(record.error)
          ? this.#mapError(record.error, record.parameters ?? {}, method)
          : new HttpBridgeError(200, record.error),
    };
  }

  /** Checks and encodes a call; every failure here happens before any request. */
  #prepare(
    method: string | MethodDescriptor<object, object>,
    parameters: object | undefined,
    options: HttpCallOptions | undefined,
    more: boolean,
  ): Prepared {
    let name: string;
    if (typeof method === "string") {
      name = method;
    } else {
      if (typeof method !== "object" || typeof method.method !== "string")
        throw new TypeError("method must be a name or a MethodDescriptor");
      if (!this.#interfaces.has(method.interface))
        throw new TypeError(`interface ${safeQuote(method.interface)} is not registered on this client`);
      name = method.method;
    }
    if (parseMethodName(name) === null)
      throw new TypeError(`method must be a fully qualified interface.Method name, not ${safeQuote(name)}`);
    const service = options?.service === undefined ? this.#service : checkService(options.service);
    const spec = this.#specFor(name);
    const raw: unknown = parameters ?? {};
    const encoded: unknown = spec?.input === undefined ? raw : spec.input.encode(raw);
    if (!isObject(encoded)) throw new TypeError("parameters must be an object");
    const body = this.#codec.encode(encoded);
    let url = `${this.#base}call/`;
    if (service !== undefined) url += `${encodeURIComponent(service)}/`;
    url += encodeURIComponent(name);
    if (more) url += "?more=true";
    return { method: name, url, body, spec };
  }

  #specFor(method: string): CallSpec | undefined {
    const parts = splitName(method);
    if (parts === null) return undefined;
    const m = this.#interfaces.get(parts.interface)?.compiled.methods.get(parts.member);
    return m === undefined ? undefined : { input: m.input, output: m.output, mode: this.#mode };
  }

  #requireName(value: unknown, what: string): string {
    if (typeof value !== "string" || !isInterfaceName(value))
      throw new TypeError(`${what} must be a valid interface name, not ${describeName(value)}`);
    return value;
  }

  #checkSignal(signal: AbortSignal | undefined): AbortSignal | undefined {
    if (signal?.aborted === true) throw signal.reason;
    return signal;
  }

  #fetchFn(): FetchLike {
    if (this.#fetch !== undefined) return this.#fetch;
    // Typed by lib dom or @types/node depending on the consumer: only `typeof … === "function"` is relied on.
    const global: unknown = globalThis.fetch;
    if (typeof global !== "function")
      throw new OperationNotSupportedError("this runtime has no global fetch: pass options.fetch");
    return global as FetchLike;
  }

  #post(body: string, accept: string): Omit<FetchInitLike, "signal"> {
    return {
      method: "POST",
      headers: { ...this.#headers, "Content-Type": "application/json", Accept: accept },
      body,
    };
  }

  #getInit(): Omit<FetchInitLike, "signal"> {
    return { method: "GET", headers: { ...this.#headers, Accept: "application/json" } };
  }

  /** The whole body, at most maxMessageSize bytes (else the request is aborted with MessageTooLargeError). */
  async #readAll(ex: Exchange): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = await ex.read();
      if (chunk === null) return concatChunks(chunks, total);
      total += chunk.length;
      if (total > this.#max)
        throw new MessageTooLargeError(`response body larger than maxMessageSize (${String(this.#max)} bytes)`);
      chunks.push(chunk);
    }
  }

  /** A body that must be one JSON value (strict UTF-8, the client's codec). */
  #decodeJson(bytes: Uint8Array, label: string): unknown {
    let text: string;
    try {
      text = strictUtf8.decode(bytes);
    } catch (e) {
      throw new ProtocolError(`${label}: the response is not valid UTF-8`, { cause: e });
    }
    return this.#codec.decode(text);
  }

  /** A success reply checked and validated (per `validateReplies` for registered interfaces). */
  #reply(value: unknown, spec: CallSpec | undefined, method: string): Record<string, unknown> {
    if (!isObject(value)) throw new ProtocolError(`${method}: the reply is not a JSON object`);
    const output = spec?.output;
    if (output === undefined || spec === undefined || spec.mode === "off") return value;
    try {
      return output.decode(value, { unknownFields: "drop" }) as Record<string, unknown>;
    } catch (e) {
      if (spec.mode === "throw" || (this.#ints === "number" && isIntRange(e))) throw e;
      this.#report(e, method, "invalid-reply");
      return value;
    }
  }

  /** The error for a non-2xx response: the varlink error in its body, else HttpBridgeError. */
  #failure(status: number, bytes: Uint8Array, method: string): unknown {
    let body: unknown;
    try {
      body = this.#codec.decode(lenientUtf8.decode(bytes));
    } catch {
      return new HttpBridgeError(status, undefined);
    }
    if (!isObject(body)) return new HttpBridgeError(status, undefined);
    const error = body.error;
    const parameters = body.parameters;
    if (isErrorName(error) && (parameters === undefined || parameters === null || isObject(parameters)))
      return this.#mapError(error, parameters ?? {}, method);
    const message = body.message;
    return new HttpBridgeError(status, typeof message === "string" ? message : undefined);
  }

  /** An error reply as the most specific error, validating its parameters where the interface is registered. */
  #mapError(name: string, parameters: Record<string, unknown>, method: string): VarlinkError {
    const parts = splitName(name);
    const compiled = parts === null ? undefined : this.#interfaces.get(parts.interface)?.compiled;
    if (parts === null || compiled === undefined) return new VarlinkError(name, parameters);
    const validator = compiled.errors.get(parts.member);
    if (validator === undefined) {
      this.#report(new TypeError(`${name} is not an error of interface ${parts.interface}`), method, "invalid-error");
      return new VarlinkError(name, parameters);
    }
    try {
      return this.#errors.create(
        name,
        validator.decode(parameters, { unknownFields: "drop" }) as Record<string, unknown>,
      );
    } catch (e) {
      this.#report(e, method, "invalid-error");
      return new VarlinkError(name, parameters);
    }
  }

  #report(error: unknown, method: string, reason: ConnectionErrorReason): void {
    try {
      this.#onError(error, { method, reason });
    } catch {
      // onError must not throw; if it does, the client carries on.
    }
  }
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** What a {@link RecordSource} uses of its client. */
interface RecordContext {
  fetch(): FetchLike;
  readonly max: number;
  post(body: string): Omit<FetchInitLike, "signal">;
  readAll(ex: Exchange): Promise<Uint8Array>;
  decodeRecord(bytes: Uint8Array, method: string): unknown;
  reply(value: unknown, spec: CallSpec | undefined, method: string): Record<string, unknown>;
  failure(status: number, bytes: Uint8Array, method: string): unknown;
  errorRecord(record: ErrorRecord, method: string): unknown;
}

/**
 * The replies of one `?more=true` request, pulled from the body on demand. `times.first` covers the time to the
 * first record (or, with `whole`, the whole request); `times.idle` the wait for each later record.
 */
class RecordSource {
  readonly #ctx: RecordContext;
  readonly #p: Prepared;
  readonly #ex: Exchange;
  readonly #idle: number;
  readonly #whole: boolean;
  readonly #response: Promise<ResponseLike>;
  #started = false;
  /** How the body is parsed once its first non-whitespace byte arrived. */
  #mode: "sniff" | "seq" | "json" = "sniff";
  readonly #splitter: JsonSeqSplitter;
  readonly #jsonChunks: Uint8Array[] = [];
  #jsonSize = 0;
  /** Records parsed and not yet handed out. */
  readonly #ready: unknown[] = [];
  /** An error-shaped record held back until the next record or the end of the body. */
  #held: { value: Record<string, unknown>; record: ErrorRecord } | undefined;
  #records = 0;
  /** A record error found after good records of the same chunk, thrown once those are delivered. */
  #deferred: { error: unknown } | undefined;
  /** The idle timer is running: armed once per wait for the next record, never re-armed per body chunk. */
  #idleArmed = false;
  #ended = false;
  #done = false;

  constructor(
    ctx: RecordContext,
    p: Prepared,
    signal: AbortSignal | undefined,
    times: { first: number; idle: number; whole: boolean },
  ) {
    this.#ctx = ctx;
    this.#p = p;
    this.#idle = times.idle;
    this.#whole = times.whole;
    this.#splitter = new JsonSeqSplitter(ctx.max);
    const ex = new Exchange(signal);
    this.#ex = ex;
    const first = times.first;
    ex.arm(first, () => new CallTimeoutError(`${p.method}: timed out after ${String(first)} ms`));
    this.#response = (async () => ex.fetch(ctx.fetch(), p.url, ctx.post(p.body)))();
    // Rejections reach the consumer through next(); never an unhandled rejection if it never calls it.
    this.#response.catch(() => undefined);
  }

  /** The next reply; `done` after the last. Rejects once with the stream's error, then is done. */
  async next(): Promise<IteratorResult<Record<string, unknown>, undefined>> {
    if (this.#done) return { value: undefined, done: true };
    try {
      if (!this.#started) {
        this.#started = true;
        const response = await this.#response;
        if (!isSuccess(response.status)) {
          const bytes = await this.#ctx.readAll(this.#ex);
          throw this.#ctx.failure(response.status, bytes, this.#p.method);
        }
      }
      for (;;) {
        if (this.#ready.length > 0) {
          const value = this.#ready.shift();
          return { value: this.#ctx.reply(value, this.#p.spec, this.#p.method), done: false };
        }
        if (this.#deferred !== undefined) throw this.#deferred.error;
        if (this.#ended) {
          const held = this.#held;
          this.#held = undefined;
          if (held !== undefined) throw this.#ctx.errorRecord(held.record, this.#p.method);
          if (this.#records === 0) throw new ProtocolError(`${this.#p.method}: the response ended without a reply`);
          this.#done = true;
          this.#ex.finish();
          return { value: undefined, done: true };
        }
        if (!this.#whole && this.#records > 0 && !this.#idleArmed) {
          // Armed per record, not per chunk: a peer trickling whitespace or a partial record must not reset it.
          const idle = this.#idle;
          this.#idleArmed = true;
          this.#ex.arm(idle, () => new CallTimeoutError(`${this.#p.method}: no reply for ${String(idle)} ms`));
        }
        await this.#pull();
      }
    } catch (e) {
      this.abort(e);
      throw e;
    }
  }

  /** Stops early: the body is cancelled and the request aborted (with `reason` as the recorded failure). */
  abort(reason: unknown): void {
    this.#done = true;
    this.#ready.length = 0;
    this.#held = undefined;
    this.#ex.abort(reason);
  }

  get done(): boolean {
    return this.#done;
  }

  /** Reads one body chunk and parses the records it completes. */
  async #pull(): Promise<void> {
    // Records completed before an error in the same chunk were delivered first; now the error.
    this.#splitter.throwIfFailed();
    const chunk = await this.#ex.read();
    if (chunk === null) {
      this.#ended = true;
      if (this.#mode === "seq") this.#accept(this.#splitter.end());
      else if (this.#mode === "json") this.#record(concatChunks(this.#jsonChunks, this.#jsonSize), true);
      return;
    }
    let bytes = chunk;
    if (this.#mode === "sniff") {
      let i = 0;
      while (i < bytes.length && isJsonWhitespace(bytes[i] ?? 0)) i++;
      if (i === bytes.length) return;
      bytes = bytes.subarray(i);
      this.#mode = bytes[0] === 0x1e ? "seq" : "json";
    }
    if (this.#mode === "seq") {
      this.#accept(this.#splitter.push(bytes));
      return;
    }
    this.#jsonSize += bytes.length;
    if (this.#jsonSize > this.#ctx.max)
      throw new MessageTooLargeError(`response body larger than maxMessageSize (${String(this.#ctx.max)} bytes)`);
    this.#jsonChunks.push(bytes.slice());
  }

  /**
   * Decodes the records of one chunk in order. A record that fails to decode after good ones of the same chunk is
   * deferred: the good ones are delivered first, the next pull throws.
   */
  #accept(records: Uint8Array[]): void {
    for (const r of records) {
      try {
        this.#record(r);
      } catch (e) {
        if (this.#ready.length === 0) throw e;
        this.#deferred = { error: e };
        return;
      }
    }
  }

  /** A complete record: decoded, then held back if it is shaped like an error record (json-seq only). */
  #record(bytes: Uint8Array, single = false): void {
    const value = this.#ctx.decodeRecord(bytes, this.#p.method);
    this.#records++;
    if (!this.#whole) {
      this.#ex.disarm();
      this.#idleArmed = false;
    }
    const held = this.#held;
    if (held !== undefined) {
      // Another record followed: the held one was a reply after all.
      this.#held = undefined;
      this.#ready.push(held.value);
    }
    const record = !single && isObject(value) ? errorRecord(value) : undefined;
    if (record !== undefined && isObject(value)) this.#held = { value, record };
    else this.#ready.push(value);
  }
}

/** A stream whose call could not even be prepared: next() rejects once, then is done. */
function failedStream(error: unknown): StreamIterator {
  let failed = false;
  const it: StreamIterator = {
    next: () => {
      if (failed) return Promise.resolve({ value: undefined, done: true });
      failed = true;
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the failure as is
      return Promise.reject(error);
    },
    return: () => {
      failed = true;
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return it;
    },
  };
  return it;
}

/** The iterator `stream()` returns: next() calls are served one after another. */
class HttpReplyStream implements StreamIterator {
  readonly #source: RecordSource;
  #chain: Promise<unknown> = Promise.resolve();
  #returned = false;

  constructor(source: RecordSource) {
    this.#source = source;
  }

  next(): Promise<IteratorResult<Record<string, unknown>, undefined>> {
    const p = this.#chain.then(async () => {
      if (this.#returned) return { value: undefined, done: true } as const;
      try {
        return await this.#source.next();
      } catch (e) {
        // return() while this next() was reading: the stream simply ends.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- return() may run during the await
        if (this.#returned) return { value: undefined, done: true } as const;
        throw e;
      }
    });
    this.#chain = p.catch(() => undefined);
    return p;
  }

  return(): Promise<IteratorResult<Record<string, unknown>, undefined>> {
    this.#returned = true;
    if (!this.#source.done) this.#source.abort(new ConnectionClosedError("the stream was closed by return()"));
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
}

/**
 * A client for a UAPI HTTP bridge in simple HTTP mode (DESIGN.md §4.12). `base` is the bridge base URL (an `http`
 * address: `http(s)://host/prefix`; a trailing `/` is added, query and fragment are dropped).
 *
 * @throws {TypeError} for a WebSocket-mode or non-http address, credentials in the URL, or invalid options.
 * @throws {RangeError} for invalid numeric options.
 */
export function createHttpClient(base: string | AddressSpec, options?: HttpClientOptions): HttpClient {
  return new HttpClient(base, options);
}
