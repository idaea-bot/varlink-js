// The client side of one varlink connection over a ByteChannel (DESIGN.md §5.1, §4.11): a serialized write
// queue feeding a ClientSession, one reader loop routing its events, timeouts, abort, read backpressure for
// streams, reply/error validation for registered interfaces.
import { CallTimeoutError, ConnectionClosedError, isVarlinkLocalError, safeQuote } from "../core/errors/local.ts";
import { createErrorRegistry, type ErrorRegistry } from "../core/errors/registry.ts";
import { INTERNAL_ERROR_INTERFACE_IDL, ORG_VARLINK_SERVICE, ORG_VARLINK_SERVICE_IDL } from "../core/errors/standard.ts";
import { VarlinkError, type ErrorClass } from "../core/errors/varlink-error.ts";
import type { Interface } from "../core/idl/ast.ts";
import { parseInterface } from "../core/idl/parser.ts";
import type { ByteChannel } from "../core/protocol/channel.ts";
import { ClientSession, type ClientEvent } from "../core/protocol/client-session.ts";
import type { ValidateReplies } from "../core/protocol/dispatch.ts";
import { checkMaxMessageSize } from "../core/protocol/framer.ts";
import type { CallInit } from "../core/protocol/messages.ts";
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
import { createProxy, type InterfaceProxy, type ProxyOptions } from "./proxy.ts";
import { checkMode, checkPositiveInt, checkTimeout, splitName } from "./util.ts";

/** Default call timeout in ms (sd-varlink's 45 s). */
export const DEFAULT_TIMEOUT: number = 45_000;
/** Default stream replies buffered before reading pauses. */
export const DEFAULT_HIGH_WATER_MARK: number = 64;
/** Default `collect()` maximum (sd-varlink's VARLINK_COLLECT_MAX). */
export const DEFAULT_COLLECT_MAX: number = 1024;

/** Why {@link ConnectionOptions.onError} was called. */
export type ConnectionErrorReason = "invalid-reply" | "invalid-error";

/** Options for {@link createConnection}. */
export interface ConnectionOptions {
  /** Per-call timeout in ms (see {@link CallOptions.timeout}); default 45 000; 0 = none. */
  timeout?: number;
  /** `int` representation for registered interfaces (§4.3); default `"number"`. */
  ints?: IntsMode;
  /** Largest reply in bytes; default 16 MiB. */
  maxMessageSize?: number;
  /**
   * Reply validation for registered interfaces: `"off"` (default) gives the raw parameters (in `"number"` mode
   * they may contain bigints for unsafe integers), `"warn"` decodes them (unknown fields dropped) and on a
   * mismatch delivers the raw value and calls `onError`, `"throw"` rejects the call with the ValidationError.
   */
  validateReplies?: ValidateReplies;
  /** Default {@link jsonCodec}. */
  codec?: Codec;
  /** Maps error replies to classes; default `createErrorRegistry()`. Descriptor error classes are added to it. */
  errors?: ErrorRegistry;
  /** Interfaces registered for validation at construction (descriptors or IDL text). */
  interfaces?: readonly (InterfaceDescriptor | string)[];
  /** Stream replies buffered before the connection stops reading (backpressure); default 64. */
  highWaterMark?: number;
  /**
   * Invalid replies (`"warn"`) and error replies whose parameters do not match their interface. Default: a one-line
   * `console.warn` naming the method and reason (never parameter values). Exceptions from it are swallowed.
   */
  onError?: (error: unknown, info: { method: string; reason: ConnectionErrorReason }) => void;
}

/** Per-call options. */
export interface CallOptions {
  /**
   * Overrides the connection's timeout (ms, 0 = none). The clock starts when the call reaches the head of the reply
   * queue (every call before it finished). Expiry rejects with CallTimeoutError and closes the connection.
   */
  timeout?: number;
  /** Aborting rejects with `signal.reason`; once the call was written, it also closes the connection (UAPI). */
  signal?: AbortSignal;
}

/** Options for `stream()`: `timeout` covers only the time to the first reply. */
export interface StreamOptions extends CallOptions {
  /** Longest gap between replies in ms (default none). Paused while the stream's buffer is full. */
  idleTimeout?: number;
}

/** Options for `collect()`. */
export interface CollectOptions extends CallOptions {
  /** Most replies accepted (default 1024); more rejects with RangeError and closes the connection. */
  max?: number;
}

/** `org.varlink.service.GetInfo` result. */
export interface ServiceInfo {
  vendor: string;
  product: string;
  version: string;
  url: string;
  interfaces: string[];
}

/**
 * What `stream()` returns: an async iterator over every reply, the final one included. `return()` (also called
 * by leaving a `for await`) is always present.
 */
export interface StreamIterator<T = Record<string, unknown>> extends AsyncIterableIterator<T, undefined, undefined> {
  next(): Promise<IteratorResult<T, undefined>>;
  return(): Promise<IteratorResult<T, undefined>>;
  [Symbol.asyncIterator](): StreamIterator<T>;
}

/** How one call's parameters and replies are validated (registered interface, proxy, or none). */
export interface CallSpec {
  readonly input?: Validator | undefined;
  readonly output?: Validator | undefined;
  readonly mode: ValidateReplies;
  /** Errors of this interface are validated with it (proxy: the fetched interface, not registered). */
  readonly errors?: CompiledInterface | undefined;
}

/** Internal: the shape of a call on the wire. */
export type OpKind = "single" | "more" | "oneway";

/** Internal: where a call's outcome goes. */
export interface Sink {
  value(value: Record<string, unknown>, final: boolean): void;
  fail(error: unknown): void;
  /** Undelivered stream replies (backpressure). */
  buffered?(): number;
}

interface Registered {
  readonly idl: string;
  readonly compiled: CompiledInterface;
}

class Op {
  readonly kind: OpKind;
  readonly method: string;
  readonly init: CallInit;
  readonly spec: CallSpec;
  readonly timeout: number;
  readonly idleTimeout: number;
  readonly max: number | undefined;
  readonly signal: AbortSignal | undefined;
  readonly sink: Sink;
  readonly onDone: (() => void) | undefined;
  stage: "queued" | "sent" | "done" = "queued";
  id = 0;
  count = 0;
  gotReply = false;
  headArmed = false;
  timer: ReturnType<typeof setTimeout> | undefined;
  onAbort: (() => void) | undefined;

  constructor(
    kind: OpKind,
    method: string,
    init: CallInit,
    spec: CallSpec,
    times: { timeout: number; idleTimeout: number; max: number | undefined },
    signal: AbortSignal | undefined,
    sink: Sink,
    onDone: (() => void) | undefined,
  ) {
    this.kind = kind;
    this.method = method;
    this.init = init;
    this.spec = spec;
    this.timeout = times.timeout;
    this.idleTimeout = times.idleTimeout;
    this.max = times.max;
    this.signal = signal;
    this.sink = sink;
    this.onDone = onDone;
  }
}

function isDone(op: Op): boolean {
  return op.stage === "done";
}

/** The async iterator `stream()` returns. */
class ReplyStream implements StreamIterator {
  readonly #items: Record<string, unknown>[] = [];
  readonly #waiters: {
    resolve(r: IteratorResult<Record<string, unknown>, undefined>): void;
    reject(e: unknown): void;
  }[] = [];
  #final = false;
  #error: { e: unknown } | undefined;
  #done = false;
  /** Set by the connection: a value was pulled / return() before the final reply. */
  onPull: () => void = () => undefined;
  onReturn: () => void = () => undefined;

  readonly sink: Sink = {
    value: (v, final) => {
      this.#push(v, final);
    },
    fail: (e) => {
      this.#fail(e);
    },
    buffered: () => this.#items.length,
  };

  #push(v: Record<string, unknown>, final: boolean): void {
    if (this.#done) return;
    const w = this.#waiters.shift();
    if (w !== undefined) w.resolve({ value: v, done: false });
    else this.#items.push(v);
    if (final) {
      this.#final = true;
      if (this.#items.length === 0) this.#flushDone();
    }
  }

  #fail(e: unknown): void {
    if (this.#done || this.#final || this.#error !== undefined) return;
    this.#error = { e };
    if (this.#items.length > 0) return;
    const w = this.#waiters.shift();
    if (w === undefined) return;
    this.#error = undefined;
    w.reject(e);
    this.#flushDone();
  }

  #flushDone(): void {
    this.#done = true;
    for (const w of this.#waiters.splice(0)) w.resolve({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<Record<string, unknown>, undefined>> {
    const v = this.#items.shift();
    if (v !== undefined) {
      this.onPull();
      return Promise.resolve({ value: v, done: false });
    }
    if (this.#error !== undefined) {
      const { e } = this.#error;
      this.#error = undefined;
      this.#done = true;
      // Like call(): the error reply, local error or abort reason as is (an abort reason may be any value).
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(e);
    }
    if (this.#final || this.#done) {
      this.#done = true;
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  return(): Promise<IteratorResult<Record<string, unknown>, undefined>> {
    if (!this.#final && !this.#done && this.#error === undefined) this.onReturn();
    this.#items.length = 0;
    this.#error = undefined;
    this.#flushDone();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
}

function defaultOnError(_error: unknown, info: { method: string; reason: ConnectionErrorReason }): void {
  console.warn(`varlink-js: ${info.reason} for ${safeQuote(info.method)} (set the connection's onError to handle it)`);
}

function isIntRange(e: unknown): boolean {
  return (
    isVarlinkLocalError(e, "org.varlink.service.InvalidParameter") && (e as { reason?: unknown }).reason === "int-range"
  );
}

const SERVICE_OPTIONS: CallSpec = { mode: "throw" };

/** Internal entry points for the proxy and the pool (not re-exported). */
export interface ConnectionInternals {
  readonly ints: IntsMode;
  readonly codec: Codec;
  start(
    kind: OpKind,
    method: string,
    parameters: Record<string, unknown> | undefined,
    options: (StreamOptions & CollectOptions) | undefined,
    spec: CallSpec | undefined,
    sink: Sink,
    onDone?: () => void,
  ): void;
  stream(
    method: string,
    parameters: Record<string, unknown> | undefined,
    options: StreamOptions | undefined,
    spec: CallSpec | undefined,
    onDone?: () => void,
  ): StreamIterator;
}

let internalsOf: (conn: Connection) => ConnectionInternals;

/** Internal: the proxy's and pool's access to a connection. */
export function connectionInternals(conn: Connection): ConnectionInternals {
  return internalsOf(conn);
}

/** Promise-based sink for a single reply. */
function promiseSink(resolve: (v: Record<string, unknown>) => void, reject: (e: unknown) => void): Sink {
  return {
    value: (v, final) => {
      if (final) resolve(v);
    },
    fail: reject,
  };
}

/** Promise-based sink collecting every reply. */
function collectSink(resolve: (v: Record<string, unknown>[]) => void, reject: (e: unknown) => void): Sink {
  const all: Record<string, unknown>[] = [];
  return {
    value: (v, final) => {
      all.push(v);
      if (final) resolve(all);
    },
    fail: reject,
  };
}

/**
 * A varlink client connection over a {@link ByteChannel} (DESIGN.md §5.1). Create it with
 * {@link createConnection}. Calls are pipelined in call order; replies are matched in order. A timeout, an abort
 * after the call was written, or leaving a stream early closes the connection (varlink has no cancel message).
 */
export class Connection {
  readonly #channel: ByteChannel;
  readonly #session: ClientSession;
  readonly #codec: Codec;
  readonly #ints: IntsMode;
  readonly #timeout: number;
  readonly #mode: ValidateReplies;
  readonly #errors: ErrorRegistry;
  readonly #hwm: number;
  readonly #onError: (error: unknown, info: { method: string; reason: ConnectionErrorReason }) => void;
  readonly #interfaces = new Map<string, Registered>();
  /** Calls not yet handed to the session (write queue). */
  readonly #queue: Op[] = [];
  /** Calls handed to the session that wait for replies, in reply order. */
  readonly #inflight: Op[] = [];
  readonly #byId = new Map<number, Op>();
  /** The oneway call being written. */
  #writingOneway: Op | undefined;
  #pumping = false;
  #closing = false;
  #closeReason: unknown;
  #resumeRead: (() => void) | undefined;
  #resolveClosed: () => void = () => undefined;
  /** Resolves once the connection is closed and its channel's `closed` settled. Never rejects. */
  readonly closed: Promise<void>;

  static {
    internalsOf = (conn) => ({
      ints: conn.#ints,
      codec: conn.#codec,
      start: (kind, method, parameters, options, spec, sink, onDone) => {
        conn.#start(kind, method, parameters, options, spec, sink, onDone);
      },
      stream: (method, parameters, options, spec, onDone) => conn.#stream(method, parameters, options, spec, onDone),
    });
  }

  /** Use {@link createConnection}. */
  constructor(channel: ByteChannel, options?: ConnectionOptions) {
    this.#channel = channel;
    this.#codec = options?.codec ?? jsonCodec;
    this.#ints = checkMode(options?.ints, "ints", ["number", "bigint"], "number");
    this.#timeout = checkTimeout(options?.timeout, "timeout", DEFAULT_TIMEOUT);
    this.#mode = checkMode(options?.validateReplies, "validateReplies", ["off", "warn", "throw"], "off");
    this.#errors = options?.errors ?? createErrorRegistry();
    this.#hwm = checkPositiveInt(options?.highWaterMark, "highWaterMark", DEFAULT_HIGH_WATER_MARK);
    const onError = options?.onError ?? defaultOnError;
    if (typeof onError !== "function") throw new TypeError("onError must be a function");
    this.#onError = onError;
    this.#session = new ClientSession({
      codec: this.#codec,
      maxMessageSize: checkMaxMessageSize(options?.maxMessageSize),
    });
    this.addInterface(ORG_VARLINK_SERVICE_IDL);
    this.addInterface(INTERNAL_ERROR_INTERFACE_IDL);
    for (const i of options?.interfaces ?? []) this.addInterface(i);
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    void channel.closed.then(() => {
      if (!this.#closing)
        this.#closeWith(new ConnectionClosedError("connection closed: the channel closed"), undefined);
    });
    void this.#readLoop();
  }

  /** True once the connection is closed (or closing); calls then reject at once. */
  get isClosed(): boolean {
    return this.#closing;
  }

  /**
   * Why the connection closed: the ProtocolError, transport error, CallTimeoutError, abort reason or `close()`
   * reason. Undefined while open, after `close()` without a reason, and after a clean EOF from the peer.
   */
  get closeReason(): unknown {
    return this.#closeReason;
  }

  /**
   * Registers an interface for validation (compiled with this connection's `ints` and codec). A descriptor's error
   * classes are added to the error registry. The same name again: no-op for the same IDL text (a descriptor's
   * error classes are still registered), TypeError for a different one.
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
   * A call with a single reply. Rejects with the error reply (a VarlinkError, §6), a local error
   * (ConnectionClosedError, CallTimeoutError, ValidationError) or the abort reason.
   */
  call<M extends MethodDescriptor<object, object>>(
    method: M,
    parameters: MethodInput<M>,
    options?: CallOptions,
  ): Promise<MethodOutput<M>>;
  call(method: string, parameters?: Record<string, unknown>, options?: CallOptions): Promise<Record<string, unknown>>;
  call(
    method: string | MethodDescriptor<object, object>,
    parameters?: object,
    options?: CallOptions,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const [name, spec] = this.#resolve(method);
      this.#start("single", name, parameters as Record<string, unknown>, options, spec, promiseSink(resolve, reject));
    });
  }

  /** A oneway call (no reply); resolves when written. */
  oneway<M extends MethodDescriptor<object, object>>(
    method: M,
    parameters: MethodInput<M>,
    options?: CallOptions,
  ): Promise<void>;
  oneway(method: string, parameters?: Record<string, unknown>, options?: CallOptions): Promise<void>;
  oneway(method: string | MethodDescriptor<object, object>, parameters?: object, options?: CallOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const [name, spec] = this.#resolve(method);
      this.#start("oneway", name, parameters as Record<string, unknown>, options, spec, {
        value: () => {
          resolve();
        },
        fail: reject,
      });
    });
  }

  /**
   * A call with `more`: yields every reply including the final one. The call is enqueued at once. An error reply
   * rejects `next()` after the earlier replies were consumed. `return()` (leaving a `for await`) before the final
   * reply closes the connection if the call was written (UAPI has no cancel), else just drops the call.
   *
   * Consume the stream (or `return()` it): once `highWaterMark` replies are buffered unread, the connection stops
   * reading, so every later call on it waits behind the stream — and since a call's timeout starts only when it
   * reaches the head of the reply queue, awaiting such a call before draining the stream waits forever.
   */
  stream<M extends MethodDescriptor<object, object>>(
    method: M,
    parameters: MethodInput<M>,
    options?: StreamOptions,
  ): StreamIterator<MethodOutput<M>>;
  stream(method: string, parameters?: Record<string, unknown>, options?: StreamOptions): StreamIterator;
  stream(
    method: string | MethodDescriptor<object, object>,
    parameters?: object,
    options?: StreamOptions,
  ): StreamIterator {
    let resolved: [string, CallSpec | undefined];
    try {
      resolved = this.#resolve(method);
    } catch (e) {
      const failed = new ReplyStream();
      failed.sink.fail(e);
      return failed;
    }
    return this.#stream(resolved[0], parameters as Record<string, unknown>, options, resolved[1], undefined);
  }

  /** A call with `more`, collecting every reply (at most `options.max`, default 1024). */
  collect<M extends MethodDescriptor<object, object>>(
    method: M,
    parameters: MethodInput<M>,
    options?: CollectOptions,
  ): Promise<MethodOutput<M>[]>;
  collect(
    method: string,
    parameters?: Record<string, unknown>,
    options?: CollectOptions,
  ): Promise<Record<string, unknown>[]>;
  collect(
    method: string | MethodDescriptor<object, object>,
    parameters?: object,
    options?: CollectOptions,
  ): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      const [name, spec] = this.#resolve(method);
      this.#start("more", name, parameters as Record<string, unknown>, options, spec, collectSink(resolve, reject));
    });
  }

  /** `org.varlink.service.GetInfo`, validated. */
  getInfo(options?: CallOptions): Promise<ServiceInfo> {
    return this.#service("GetInfo", {}, options) as Promise<ServiceInfo>;
  }

  /** `org.varlink.service.GetInterfaceDescription`: the interface's IDL text. */
  async getInterfaceDescription(name: string, options?: CallOptions): Promise<string> {
    const r = (await this.#service("GetInterfaceDescription", { interface: name }, options)) as { description: string };
    return r.description;
  }

  /**
   * The interface's parsed and validated AST (`parseInterface`). Not registered for validation.
   *
   * @throws {IdlSyntaxError} if the description is not valid IDL.
   * @throws {TypeError} if it declares a different interface.
   */
  async getInterface(name: string, options?: CallOptions): Promise<Interface> {
    const iface = parseInterface(await this.getInterfaceDescription(name, options));
    if (iface.name !== name)
      throw new TypeError(`the description of ${safeQuote(name)} declares interface ${safeQuote(iface.name)}`);
    return iface;
  }

  /** Fetches and compiles an interface and returns a frozen object with one function per method (§5.3). */
  proxy(name: string, options?: ProxyOptions): Promise<InterfaceProxy> {
    return createProxy(this, name, options);
  }

  /**
   * Hard close (idempotent): pending calls reject with ConnectionClosedError (`cause` = `reason`). Resolves when the
   * channel's `closed` settled.
   */
  close(reason?: unknown): Promise<void> {
    this.#closeWith(
      new ConnectionClosedError("connection closed", reason === undefined ? undefined : { cause: reason }),
      reason,
    );
    return this.closed;
  }

  #service(member: string, parameters: Record<string, unknown>, options: CallOptions | undefined): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const method = `${ORG_VARLINK_SERVICE}.${member}`;
      const spec = this.#specFor(method, SERVICE_OPTIONS.mode);
      this.#start("single", method, parameters, options, spec, promiseSink(resolve, reject));
    });
  }

  /** The method name and validation spec of an untyped name or a descriptor (which must be registered). */
  #resolve(method: string | MethodDescriptor<object, object>): [string, CallSpec | undefined] {
    if (typeof method === "string") return [method, this.#specFor(method, this.#mode)];
    if (typeof method !== "object" || typeof method.method !== "string")
      throw new TypeError("method must be a name or a MethodDescriptor");
    if (!this.#interfaces.has(method.interface))
      throw new TypeError(`interface ${safeQuote(method.interface)} is not registered on this connection`);
    return [method.method, this.#specFor(method.method, this.#mode)];
  }

  #specFor(method: string, mode: ValidateReplies): CallSpec | undefined {
    const parts = splitName(method);
    if (parts === null) return undefined;
    const m = this.#interfaces.get(parts.interface)?.compiled.methods.get(parts.member);
    return m === undefined ? undefined : { input: m.input, output: m.output, mode };
  }

  #stream(
    method: string,
    parameters: Record<string, unknown> | undefined,
    options: StreamOptions | undefined,
    spec: CallSpec | undefined,
    onDone: (() => void) | undefined,
  ): ReplyStream {
    const stream = new ReplyStream();
    const op = this.#start("more", method, parameters, options, spec, stream.sink, onDone);
    if (op !== undefined) {
      stream.onPull = () => {
        this.#pulled(op);
      };
      stream.onReturn = () => {
        this.#abandon(op);
      };
    }
    return stream;
  }

  /** Validates and enqueues a call. Failures before it is enqueued go to `sink.fail`. */
  #start(
    kind: OpKind,
    method: string,
    parameters: Record<string, unknown> | undefined,
    options: (StreamOptions & CollectOptions) | undefined,
    spec: CallSpec | undefined,
    sink: Sink,
    onDone?: () => void,
  ): Op | undefined {
    const finish = (e: unknown): void => {
      sink.fail(e);
      onDone?.();
    };
    if (this.#closing) {
      finish(new ConnectionClosedError("connection is closed"));
      return undefined;
    }
    let op: Op;
    try {
      const signal = options?.signal;
      if (signal?.aborted === true) {
        finish(signal.reason);
        return undefined;
      }
      const times = {
        timeout: checkTimeout(options?.timeout, "timeout", this.#timeout),
        idleTimeout: kind === "more" ? checkTimeout(options?.idleTimeout, "idleTimeout", 0) : 0,
        max:
          kind === "more" && sink.buffered === undefined
            ? checkPositiveInt(options?.max, "max", DEFAULT_COLLECT_MAX)
            : undefined,
      };
      if (typeof method !== "string") throw new TypeError("method must be a string");
      const input = spec?.input;
      const params =
        input === undefined ? (parameters ?? {}) : (input.encode(parameters ?? {}) as Record<string, unknown>);
      const init: CallInit = { method, parameters: params };
      if (kind === "oneway") init.oneway = true;
      if (kind === "more") init.more = true;
      op = new Op(kind, method, init, spec ?? { mode: "off" }, times, signal, sink, onDone);
    } catch (e) {
      finish(e);
      return undefined;
    }
    const signal = op.signal;
    if (signal !== undefined) {
      const o = op;
      o.onAbort = () => {
        this.#aborted(o);
      };
      signal.addEventListener("abort", o.onAbort, { once: true });
    }
    this.#queue.push(op);
    void this.#pump();
    return op;
  }

  /** Writes queued calls one at a time; a call is handed to the session only when its turn comes. */
  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (;;) {
        if (this.#closing) return;
        const op = this.#queue.shift();
        if (op === undefined) return;
        let bytes: Uint8Array;
        try {
          const handed = this.#session.call(op.init);
          op.id = handed.id;
          bytes = handed.bytes;
        } catch (e) {
          // Encoding failed (codec, bad parameters): nothing was written, the connection is intact.
          this.#settle(op);
          op.sink.fail(e);
          continue;
        }
        op.stage = "sent";
        if (op.kind === "oneway") {
          this.#writingOneway = op;
          if (op.timeout > 0) this.#arm(op, op.timeout);
        } else {
          this.#inflight.push(op);
          this.#byId.set(op.id, op);
          this.#armHead();
        }
        try {
          await this.#channel.write(bytes);
        } catch (e) {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- close() may run during the await
          if (!this.#closing)
            this.#closeWith(new ConnectionClosedError("connection closed: write failed", { cause: e }), e);
          return;
        }
        if (op.kind === "oneway") {
          this.#writingOneway = undefined;
          // A timeout or abort may have ended it during the write.
          if (!isDone(op)) {
            this.#settle(op);
            op.sink.value({}, true);
          }
        }
      }
    } catch (e) {
      // Not reachable by design; never an unhandled rejection.
      if (!this.#closing)
        this.#closeWith(new ConnectionClosedError("connection closed: internal error", { cause: e }), e);
    } finally {
      this.#pumping = false;
    }
  }

  async #readLoop(): Promise<void> {
    try {
      while (!this.#closing) {
        const head = this.#inflight[0];
        if (head !== undefined && this.#paused(head)) {
          await new Promise<void>((resolve) => {
            this.#resumeRead = resolve;
          });
          continue;
        }
        const chunk = await this.#channel.read();
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- close() may run during the await
        if (this.#closing) return;
        if (chunk === null) {
          this.#route(this.#session.receiveEnd());
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- #route() may have closed it
          if (!this.#closing) this.#closeWith(new ConnectionClosedError("connection closed by peer"), undefined);
          return;
        }
        this.#route(this.#session.receive(chunk.bytes));
      }
    } catch (e) {
      if (!this.#closing) this.#closeWith(new ConnectionClosedError("connection lost", { cause: e }), e);
    }
  }

  #route(events: ClientEvent[]): void {
    for (const ev of events) {
      if (this.#closing) return;
      switch (ev.type) {
        case "reply": {
          const op = this.#byId.get(ev.id);
          if (op !== undefined) this.#onReply(op, ev.parameters, ev.continues);
          break;
        }
        case "error": {
          const op = this.#byId.get(ev.id);
          if (op === undefined) break;
          this.#settle(op);
          op.sink.fail(this.#mapError(op, ev.error, ev.parameters));
          break;
        }
        case "failed": {
          const op = this.#byId.get(ev.id);
          if (op === undefined) break;
          this.#settle(op);
          op.sink.fail(ev.error);
          break;
        }
        case "closed":
          if (ev.error !== undefined)
            this.#closeWith(
              new ConnectionClosedError("connection closed: protocol error", { cause: ev.error }),
              ev.error,
            );
          else this.#closeWith(new ConnectionClosedError("connection closed by peer"), undefined);
          return;
        case "upgraded":
          // call() never sets upgrade (M9).
          break;
      }
    }
  }

  #onReply(op: Op, parameters: Record<string, unknown>, continues: boolean): void {
    if (!continues) this.#settle(op);
    if (op.max !== undefined && ++op.count > op.max) {
      this.#reject(op, new RangeError(`${op.method}: more than ${String(op.max)} replies`));
      return;
    }
    let value: Record<string, unknown> = parameters;
    const output = op.spec.output;
    if (output !== undefined && op.spec.mode !== "off") {
      try {
        value = output.decode(parameters, { unknownFields: "drop" }) as Record<string, unknown>;
      } catch (e) {
        if (op.spec.mode === "throw" || (this.#ints === "number" && isIntRange(e))) {
          this.#reject(op, e);
          return;
        }
        this.#report(e, op.method, "invalid-reply");
      }
    }
    op.sink.value(value, !continues);
    if (continues) {
      op.gotReply = true;
      this.#clearTimer(op);
      if (op.idleTimeout > 0 && !this.#paused(op)) this.#arm(op, op.idleTimeout);
    }
  }

  /** An error reply as the most specific error, validating its parameters where the interface is known. */
  #mapError(op: Op, name: string, parameters: Record<string, unknown>): VarlinkError {
    const parts = splitName(name);
    if (parts === null) return new VarlinkError(name, parameters);
    const privateIface = op.spec.errors;
    const compiled =
      privateIface?.name === parts.interface ? privateIface : this.#interfaces.get(parts.interface)?.compiled;
    if (compiled === undefined) return new VarlinkError(name, parameters);
    const validator = compiled.errors.get(parts.member);
    if (validator === undefined) {
      this.#report(
        new TypeError(`${name} is not an error of interface ${parts.interface}`),
        op.method,
        "invalid-error",
      );
      return new VarlinkError(name, parameters);
    }
    try {
      return this.#errors.create(
        name,
        validator.decode(parameters, { unknownFields: "drop" }) as Record<string, unknown>,
      );
    } catch (e) {
      this.#report(e, op.method, "invalid-error");
      return new VarlinkError(name, parameters);
    }
  }

  /** Rejects a call; if replies were still pending for it, the connection must close (UAPI: no cancel). */
  #reject(op: Op, error: unknown): void {
    const pending = op.stage === "sent";
    this.#settle(op);
    op.sink.fail(error);
    if (pending && !this.#closing)
      this.#closeWith(new ConnectionClosedError(`connection closed: ${op.method} failed`, { cause: error }), error);
  }

  #aborted(op: Op): void {
    const reason: unknown = op.signal?.reason;
    if (op.stage === "queued") {
      const i = this.#queue.indexOf(op);
      if (i >= 0) this.#queue.splice(i, 1);
      this.#settle(op);
      op.sink.fail(reason);
      return;
    }
    if (op.stage === "sent") this.#reject(op, reason);
  }

  /** `return()` on a stream before its final reply. */
  #abandon(op: Op): void {
    if (op.stage === "queued") {
      const i = this.#queue.indexOf(op);
      if (i >= 0) this.#queue.splice(i, 1);
      this.#settle(op);
      return;
    }
    if (op.stage !== "sent") return;
    this.#settle(op);
    if (!this.#closing)
      this.#closeWith(new ConnectionClosedError(`connection closed: stream ${op.method} was abandoned`), undefined);
  }

  /** A stream value was consumed: resume reading and the idle timer if the buffer has room again. */
  #pulled(op: Op): void {
    if (op.stage === "sent" && op.gotReply && op.timer === undefined && op.idleTimeout > 0 && !this.#paused(op))
      this.#arm(op, op.idleTimeout);
    this.#maybeResume();
  }

  #paused(op: Op): boolean {
    return (op.sink.buffered?.() ?? 0) >= this.#hwm;
  }

  #maybeResume(): void {
    const resume = this.#resumeRead;
    if (resume === undefined) return;
    const head = this.#inflight[0];
    if (this.#closing || head === undefined || !this.#paused(head)) {
      this.#resumeRead = undefined;
      resume();
    }
  }

  /** Starts the timeout of the call at the head of the reply queue (once). */
  #armHead(): void {
    if (this.#closing) return;
    const head = this.#inflight[0];
    if (head === undefined || head.headArmed) return;
    head.headArmed = true;
    if (head.timeout > 0) this.#arm(head, head.timeout);
  }

  #arm(op: Op, ms: number): void {
    this.#clearTimer(op);
    op.timer = setTimeout(() => {
      op.timer = undefined;
      this.#reject(op, new CallTimeoutError(`${op.method}: timed out after ${String(ms)} ms`));
    }, ms);
  }

  #clearTimer(op: Op): void {
    if (op.timer !== undefined) {
      clearTimeout(op.timer);
      op.timer = undefined;
    }
  }

  /** The call is over for the connection: timers, listeners and bookkeeping go; the next call's clock starts. */
  #settle(op: Op): void {
    if (op.stage === "done") return;
    op.stage = "done";
    this.#clearTimer(op);
    if (op.onAbort !== undefined) op.signal?.removeEventListener("abort", op.onAbort);
    op.onAbort = undefined;
    this.#byId.delete(op.id);
    if (this.#writingOneway === op) this.#writingOneway = undefined;
    const i = this.#inflight.indexOf(op);
    if (i >= 0) this.#inflight.splice(i, 1);
    this.#armHead();
    this.#maybeResume();
    op.onDone?.();
  }

  #closeWith(failure: ConnectionClosedError, reason: unknown): void {
    if (this.#closing) return;
    this.#closing = true;
    this.#closeReason = reason;
    const ops = [...this.#queue.splice(0), ...this.#inflight];
    if (this.#writingOneway !== undefined) ops.push(this.#writingOneway);
    for (const op of ops) {
      if (op.stage === "done") continue;
      this.#settle(op);
      op.sink.fail(failure);
    }
    this.#session.close(reason);
    this.#channel.close(reason);
    this.#maybeResume();
    void this.#channel.closed.then(() => {
      this.#resolveClosed();
    });
  }

  #report(error: unknown, method: string, reason: ConnectionErrorReason): void {
    try {
      this.#onError(error, { method, reason });
    } catch {
      // onError must not throw; if it does, the connection carries on.
    }
  }
}

/**
 * A client connection over `channel` (runtime-agnostic; `varlink-js/node`'s `connect()` wraps it). The reader loop
 * starts at once.
 *
 * @throws {RangeError|TypeError} for invalid options; {@link Connection.addInterface} errors for `interfaces`.
 */
export function createConnection(channel: ByteChannel, options?: ConnectionOptions): Connection {
  return new Connection(channel, options);
}
