// A varlink server (DESIGN.md §5.4, §4.11): interface registration, the dispatch table, a per-connection driver
// over ServerSession + dispatchCall (DESIGN.md §4.10 contract), accept loops, limits and shutdown.
import { ConnectionClosedError, OperationNotSupportedError, safeQuote } from "../core/errors/local.ts";
import { INTERNAL_ERROR_INTERFACE, ORG_VARLINK_SERVICE } from "../core/errors/standard.ts";
import type { ByteChannel } from "../core/protocol/channel.ts";
import {
  dispatchCall,
  type CallContext,
  type DispatchErrorReason,
  type DispatchOptions,
  type DispatchTable,
  type Handler,
  type ValidateReplies,
} from "../core/protocol/dispatch.ts";
import { checkMaxMessageSize } from "../core/protocol/framer.ts";
import { isPlainObject } from "../core/protocol/messages.ts";
import { DEFAULT_MAX_QUEUED_CALLS, ServerSession } from "../core/protocol/server-session.ts";
import { jsonCodec, type Codec } from "../core/types/codec.ts";
import { compileInterfaceText, type CompiledInterface, type IntsMode } from "../core/types/compile.ts";
import {
  bindDescriptor,
  type InterfaceDescriptor,
  type MethodInput,
  type MethodOutput,
} from "../core/types/descriptors.ts";
import { builtinInterfaces, entriesOf, type MethodImplementation, type RegisteredInterface } from "./service.ts";
import { checkMode, checkPositiveInt, checkTimeout, splitName, Wakeup } from "./util.ts";

/** Why {@link ServerOptions.onError} was called: a dispatch reason (§4.10) or a connection-level one. */
export type ServerErrorReason =
  | DispatchErrorReason
  /** The peer broke the protocol (malformed message, message too large); its connection was closed. */
  | "protocol-error"
  /** `read()` rejected (e.g. a reset); the connection was closed. */
  | "transport-error"
  /** A channel arrived while `maxConnections` were open; it was closed at once. */
  | "connection-limit"
  /** A served listener's iteration failed; that accept loop ended and the listener was closed. */
  | "accept-failed"
  /** Removing a listener's registry entries failed (shutdown, or its accept loop ended); the rest carried on. */
  | "registry-failed";

/** Options for {@link createServer}. */
export interface ServerOptions {
  /** GetInfo fields; default `""`. */
  vendor?: string;
  product?: string;
  version?: string;
  url?: string;
  /**
   * Handler bugs, invalid replies, protocol and transport errors (never thrown, never a crash). Default: a one-line
   * `console.warn` with the reason and method. Exceptions from it are swallowed.
   */
  onError?: (error: unknown, info: { method?: string; reason: ServerErrorReason }) => void;
  /** Reply validation against the IDL; default `"warn"` (§5.4). */
  validateReplies?: ValidateReplies;
  /** `int` representation for handlers (§4.3); default `"number"`. Descriptors must match. */
  ints?: IntsMode;
  /** Default {@link jsonCodec}. */
  codec?: Codec;
  /** Largest call in bytes; default 16 MiB. */
  maxMessageSize?: number;
  /** Complete calls buffered per connection before reading stops; default 64. */
  maxQueuedCalls?: number;
  /** Open connections; more are closed at once (`connection-limit`); default 4096. */
  maxConnections?: number;
  /**
   * Exit-on-idle for socket-activated services (§5.8), in ms: once serving started (the first `serve()` or
   * `handle()`), the server shuts down (graceful defaults) when it had no open connection for this long; a new
   * connection cancels the timer. `0` = as soon as the last connection closed (and at once if none arrives). The
   * expiry is confirmed one timer turn later, so a connection already pending on a listener is accepted first.
   * Default: off. Await {@link Server.closed} to exit the process afterwards.
   */
  exitOnIdle?: number;
}

/** Flags a registration may raise over the IDL's (never lower). */
export interface HandlerOptions {
  /** Calls without `more` get ExpectedMore. */
  readonly requiresMore?: true;
  /** Calls without `upgrade` get ExpectedUpgrade. */
  readonly requiresUpgrade?: true;
}

/** A handler, or a handler with {@link HandlerOptions}. */
export type HandlerRegistration<H> = H | ({ readonly handler: H } & HandlerOptions);

// `void` in the result types lets handlers without a return statement type-check (as in Handler).
/* eslint-disable @typescript-eslint/no-invalid-void-type */
/** A handler typed by a method descriptor's input and output. */
export type TypedHandler<In, Out> = (
  parameters: In,
  ctx: CallContext,
) => Out | undefined | void | Promise<Out | undefined | void> | AsyncIterator<Out, Out | undefined | void, undefined>;
/* eslint-enable @typescript-eslint/no-invalid-void-type */

/** Handlers for a descriptor's methods, by short name; missing ones answer MethodNotImplemented. */
export type Handlers<D extends InterfaceDescriptor> = {
  readonly [K in keyof D["methods"]]?: HandlerRegistration<
    TypedHandler<MethodInput<D["methods"][K]>, MethodOutput<D["methods"][K]>>
  >;
};

/**
 * An untyped handler: parameters are `Record<string, unknown>`, but (method-style bivariance) a handler may also
 * annotate them more precisely, e.g. `(p: { text: string }) => p`; the IDL validated them before the call.
 */
export type UntypedHandler = {
  handle(parameters: Record<string, unknown>, ctx: CallContext): ReturnType<Handler>;
}["handle"];

/** Handlers for `addInterface(idlText, handlers)`, by short method name. */
export type UntypedHandlers = Readonly<Record<string, HandlerRegistration<UntypedHandler>>>;

/** Where {@link ServeListener.bindRegistry} publishes: a directory, else the scope's registry directory. */
export interface RegistryBindOptions {
  directory?: string;
  /** Default `"system"`. */
  scope?: "system" | "user";
}

/** Registry entries published for a listener (DESIGN.md §4.6, §5.4). */
export interface RegistryBinding {
  /** The entry paths (created or adopted). */
  readonly entries: readonly string[];
  /** Removes the entries that still point at the listener's socket; idempotent. */
  unbind(): Promise<void>;
}

/** What `serve()` accepts: a stream of accepted channels, optionally closable (a Listener is one). */
export interface ServeListener extends AsyncIterable<ByteChannel> {
  close?(): Promise<void>;
  /**
   * Publishes the listener in a service registry directory under each interface name, all or nothing (a Node
   * unix-path listener has it, see `varlink-js/node` `bindRegistry`). Used by `serve(listener, {registry})`.
   */
  bindRegistry?(interfaces: readonly string[], options: RegistryBindOptions): Promise<RegistryBinding>;
}

/** Options for {@link Server.serve}. */
export interface ServeOptions {
  /**
   * Publish the listener in the service registry (UAPI.20; the listener must have `bindRegistry`): `true` = every
   * interface registered now except `org.varlink.service` and the varlink-js InternalError interface, or a list of
   * registered names, or `{interfaces, directory, scope}` (`interfaces` default `true`). The entries are removed at
   * {@link Server.shutdown} (before the listeners close) and when the accept loop ends.
   */
  registry?:
    true | readonly string[] | { interfaces?: true | readonly string[]; directory?: string; scope?: "system" | "user" };
}

/** A registry binding of one `serve()` call: `ready` never rejects (undefined if binding failed). */
interface BindState {
  readonly ready: Promise<RegistryBinding | undefined>;
  unbound: Promise<void> | undefined;
}

/** Options for {@link Server.shutdown}. */
export interface ShutdownOptions {
  /** Default true: active calls may finish (their signal aborts); false: close everything at once. */
  graceful?: boolean;
  /** ms until the rest is closed hard; default 5000; 0 = no deadline (waits for every active handler). */
  timeout?: number;
}

const DEFAULT_MAX_CONNECTIONS = 4096;

/** Graceful close: how long input is discarded after our FIN before the connection is closed hard (ms). */
const GRACEFUL_LINGER_MS = 2000;

function defaultOnError(_error: unknown, info: { method?: string; reason: ServerErrorReason }): void {
  const where = info.method === undefined ? "" : ` in ${safeQuote(info.method)}`;
  console.warn(`varlink-js server: ${info.reason}${where} (set the server's onError to handle it)`);
}

function infoString(value: unknown, name: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

/** Checks a handlers object against the interface: every key a method, every value a handler registration. */
function implementations(compiled: CompiledInterface, handlers: unknown): Map<string, MethodImplementation> {
  const impls = new Map<string, MethodImplementation>();
  if (handlers === undefined) return impls;
  if (!isPlainObject(handlers)) throw new TypeError("handlers must be a plain object");
  for (const key of Object.keys(handlers)) {
    if (!compiled.methods.has(key))
      throw new TypeError(`${safeQuote(key)} is not a method of interface ${compiled.name}`);
    const value = handlers[key];
    if (typeof value === "function") {
      impls.set(key, { handler: value as Handler<never> });
      continue;
    }
    if (typeof value !== "object" || value === null || typeof (value as { handler?: unknown }).handler !== "function")
      throw new TypeError(`handler for ${compiled.name}.${key} must be a function or { handler, … }`);
    const reg = value as { handler: Handler<never>; requiresMore?: unknown; requiresUpgrade?: unknown };
    for (const flag of ["requiresMore", "requiresUpgrade"] as const)
      if (reg[flag] !== undefined && reg[flag] !== true)
        throw new TypeError(`${flag} for ${compiled.name}.${key} must be true or absent`);
    impls.set(key, {
      handler: reg.handler,
      requiresMore: reg.requiresMore === true,
      requiresUpgrade: reg.requiresUpgrade === true,
    });
  }
  return impls;
}

interface ConnectionHost {
  readonly table: DispatchTable;
  readonly dispatchOptions: Omit<DispatchOptions, "signal">;
  report(error: unknown, reason: ServerErrorReason, method?: string): void;
}

/** One served connection: a reader task and a dispatcher task over one ServerSession (DESIGN.md §4.10). */
class ServerConnection {
  readonly #channel: ByteChannel;
  readonly #session: ServerSession;
  readonly #host: ConnectionHost;
  readonly #readerWake = new Wakeup();
  readonly #dispatcherWake = new Wakeup();
  /** The driver signal of the active call. */
  #active: AbortController | undefined;
  /** Graceful shutdown: start no new call, close once the active one finished. */
  #draining = false;
  /** The connection is being closed by the driver: no more reads, no transport-error reports. */
  #closing = false;
  /** Graceful close in progress: the channel is being ended; the reader discards input until EOF. */
  #finishing: Promise<void> | undefined;
  /** Graceful close: closes the connection GRACEFUL_LINGER_MS after the channel was ended. */
  #linger: ReturnType<typeof setTimeout> | undefined;

  constructor(channel: ByteChannel, session: ServerSession, host: ConnectionHost) {
    this.#channel = channel;
    this.#session = session;
    this.#host = host;
  }

  /** Serves until the channel is closed. Never rejects. */
  async run(): Promise<void> {
    void this.#channel.closed.then(() => {
      // The channel closed under us (not by the driver): like a disconnect, but not a transport error.
      if (!this.#closing) this.#gone(undefined);
    });
    const reader = this.#reader();
    void this.#dispatcher();
    await reader;
    await this.#channel.closed;
  }

  /** Graceful shutdown: abort the active call's signal (its replies are still written), start no new calls. */
  drain(): void {
    this.#draining = true;
    this.#active?.abort(new ConnectionClosedError("the server is shutting down"));
    this.#dispatcherWake.notify();
  }

  /** Hard close (shutdown deadline, non-graceful shutdown). */
  force(): void {
    this.#gone(new ConnectionClosedError("the server is shutting down"));
  }

  async #reader(): Promise<void> {
    const session = this.#session;
    try {
      for (;;) {
        if (this.#closing) return;
        if (this.#finishing !== undefined) {
          await this.#discard(this.#finishing);
          return;
        }
        if (session.state !== "open") return;
        if (!session.wantsInput) {
          await this.#readerWake.wait();
          continue;
        }
        const chunk = await this.#channel.read();
        // Closing, finishing or no longer open: the top of the loop decides (the chunk is dropped).
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- may change during the await
        if (this.#closing || this.#finishing !== undefined || session.state !== "open") continue;
        if (chunk === null) session.receiveEnd();
        else session.receive(chunk.bytes);
        this.#dispatcherWake.notify();
      }
    } catch (e) {
      if (this.#closing) return;
      // A graceful finish was in progress: the peer is gone, nothing left to protect (no report).
      if (this.#finishing !== undefined) {
        this.#close();
        return;
      }
      this.#host.report(e, "transport-error");
      this.#gone(e);
    }
  }

  /**
   * Graceful close, second half: once the channel is ended (our FIN after the last reply), read and drop input
   * until EOF or an error, then close. Unread input at close makes a TCP stack send RST, which can destroy the
   * reply still in flight. Bounded by the linger (see #finish); the shutdown deadline (force()) still closes at once.
   */
  async #discard(ended: Promise<void>): Promise<void> {
    await ended;
    try {
      while (!this.#closing && (await this.#channel.read()) !== null) {
        // dropped
      }
    } catch {
      // The peer is gone: nothing left to protect.
    }
    this.#close();
  }

  async #dispatcher(): Promise<void> {
    const session = this.#session;
    /** Ended by a graceful shutdown (not a protocol error, upgrade or close): the last reply must arrive. */
    let graceful = false;
    try {
      for (;;) {
        const ev = session.nextEvent();
        if (ev === null) {
          if (session.state !== "open") break;
          if (this.#draining) {
            graceful = true;
            break;
          }
          await this.#dispatcherWake.wait();
          continue;
        }
        if (ev.type === "close") {
          if (ev.error !== undefined) this.#host.report(ev.error, "protocol-error");
          break;
        }
        // Graceful shutdown: buffered calls are dropped unanswered.
        if (this.#draining) {
          graceful = true;
          break;
        }
        // The queue just shrank: a reader parked on a full queue reads again (and so notices a reset).
        this.#readerWake.notify();
        const ac = new AbortController();
        this.#active = ac;
        await dispatchCall(session, ev.id, ev.call, this.#host.table, (bytes) => this.#channel.write(bytes), {
          ...this.#host.dispatchOptions,
          signal: ac.signal,
        });
        this.#active = undefined;
        this.#readerWake.notify();
        // An upgrade nobody claimed (M3 reported upgrade-unclaimed): the stream is not varlink any more.
        if (session.state === "upgraded") break;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- drain() may run during the await
        if (this.#draining) {
          graceful = true;
          break;
        }
      }
    } catch (e) {
      // Not reachable by design (dispatchCall never rejects); never an unhandled rejection.
      this.#host.report(e, "transport-error");
    }
    if (graceful) this.#finish();
    else this.#close();
  }

  /** The peer is gone or the server forces a close: abort the active call and close the session and channel. */
  #gone(cause: unknown): void {
    if (this.#closing) return;
    this.#active?.abort(
      new ConnectionClosedError("the connection was closed", cause === undefined ? undefined : { cause }),
    );
    this.#close();
  }

  /**
   * Graceful close (shutdown drain): no more calls; end the channel after the replies written so far, then the
   * reader discards input until EOF and closes (see #discard). Once ended, the discarding lasts at most
   * {@link GRACEFUL_LINGER_MS}: a peer that never closes (or never sends anything, leaving the reader in read())
   * must not hold the shutdown; the shutdown deadline still applies if it comes sooner.
   */
  #finish(): void {
    if (this.#closing || this.#finishing !== undefined) return;
    this.#session.close();
    const finishing = Promise.resolve()
      .then(() => this.#channel.end())
      .catch(() => undefined);
    this.#finishing = finishing;
    void finishing.then(() => {
      if (!this.#closing)
        this.#linger = setTimeout(() => {
          this.#close();
        }, GRACEFUL_LINGER_MS);
    });
    this.#readerWake.notify();
  }

  #close(): void {
    if (this.#linger !== undefined) clearTimeout(this.#linger);
    this.#linger = undefined;
    this.#closing = true;
    this.#session.close();
    this.#channel.close();
    this.#readerWake.notify();
    this.#dispatcherWake.notify();
  }
}

/**
 * A varlink server (DESIGN.md §5.4). Register interfaces with {@link implement} / {@link addInterface}, then
 * {@link serve} listeners or {@link handle} single channels. `org.varlink.service` and the InternalError
 * interface are built in. Create it with {@link createServer}.
 */
export class Server {
  readonly #info: { vendor: string; product: string; version: string; url: string };
  readonly #onError: (error: unknown, info: { method?: string; reason: ServerErrorReason }) => void;
  readonly #ints: IntsMode;
  readonly #codec: Codec;
  readonly #maxMessageSize: number;
  readonly #maxQueuedCalls: number;
  readonly #maxConnections: number;
  readonly #interfaces = new Map<string, RegisteredInterface>();
  readonly #service: RegisteredInterface;
  readonly #internal: RegisteredInterface;
  readonly #host: ConnectionHost;
  readonly #connections = new Set<ServerConnection>();
  readonly #done = new Map<ServerConnection, Promise<void>>();
  readonly #listeners = new Set<ServeListener>();
  readonly #bindings = new Set<BindState>();
  #shutdown: Promise<void> | undefined;
  readonly #exitOnIdle: number | undefined;
  /** `serve()` or `handle()` was called: exit-on-idle applies from now on. */
  #serving = false;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #resolveClosed: () => void = () => undefined;
  /** Resolves once a shutdown (by any trigger: {@link shutdown}, exit-on-idle) completed. Never rejects. */
  readonly closed: Promise<void>;

  /** Use {@link createServer}. */
  constructor(options?: ServerOptions) {
    this.#info = {
      vendor: infoString(options?.vendor, "vendor"),
      product: infoString(options?.product, "product"),
      version: infoString(options?.version, "version"),
      url: infoString(options?.url, "url"),
    };
    const onError = options?.onError ?? defaultOnError;
    if (typeof onError !== "function") throw new TypeError("onError must be a function");
    this.#onError = onError;
    this.#ints = checkMode(options?.ints, "ints", ["number", "bigint"], "number");
    this.#codec = options?.codec ?? jsonCodec;
    this.#maxMessageSize = checkMaxMessageSize(options?.maxMessageSize);
    this.#maxQueuedCalls = checkPositiveInt(options?.maxQueuedCalls, "maxQueuedCalls", DEFAULT_MAX_QUEUED_CALLS);
    this.#maxConnections = checkPositiveInt(options?.maxConnections, "maxConnections", DEFAULT_MAX_CONNECTIONS);
    const exitOnIdle = options?.exitOnIdle;
    if (exitOnIdle !== undefined && (typeof exitOnIdle !== "number" || !Number.isFinite(exitOnIdle) || exitOnIdle < 0))
      throw new RangeError("exitOnIdle must be a finite non-negative number of milliseconds");
    this.#exitOnIdle = exitOnIdle === undefined ? undefined : checkTimeout(exitOnIdle, "exitOnIdle", 0);
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    const validateReplies = checkMode(options?.validateReplies, "validateReplies", ["off", "warn", "throw"], "warn");
    const builtins = builtinInterfaces(
      {
        info: () => ({ ...this.#info }),
        interfaceNames: () => [ORG_VARLINK_SERVICE, ...this.#interfaces.keys(), INTERNAL_ERROR_INTERFACE],
        description: (name) => this.#find(name)?.idl,
      },
      { ints: this.#ints, codec: this.#codec },
    );
    this.#service = builtins.service;
    this.#internal = builtins.internal;
    const table: DispatchTable = {
      lookup: (interfaceName, methodName) => {
        const r = this.#find(interfaceName);
        if (r === undefined) return { kind: "interface-not-found" };
        const entry = r.entries.get(methodName);
        return entry === undefined ? { kind: "method-not-found" } : { kind: "method", entry };
      },
      errorValidator: (errorName) => {
        const parts = splitName(errorName);
        const r = parts === null ? undefined : this.#find(parts.interface);
        if (parts === null || r === undefined) return undefined;
        return r.compiled.errors.get(parts.member) ?? null;
      },
    };
    this.#host = {
      table,
      dispatchOptions: {
        validateReplies,
        onError: (error, info) => {
          this.#report(error, info.reason, info.method);
        },
      },
      report: (error, reason, method) => {
        this.#report(error, reason, method);
      },
    };
  }

  /** Open connections. */
  get connections(): number {
    return this.#connections.size;
  }

  /**
   * Registers a generated interface (codegen descriptor) with typed handlers. Missing handlers answer
   * MethodNotImplemented. Allowed while serving (new calls see it).
   *
   * @throws {TypeError} for a built-in or already registered name, an unknown handler key, a bad handler value,
   *   a descriptor that does not match its IDL, or an `ints` mismatch (only for an interface that uses `int`: one
   *   without binds in either mode).
   */
  // NoInfer: D comes from the descriptor alone; inferring it from inline handlers too would widen their results'
  // literals (`kind: "large"` → string) before the contextual type is known.
  implement<D extends InterfaceDescriptor>(descriptor: D, handlers: NoInfer<Handlers<D>>): void {
    const compiled = bindDescriptor(descriptor, this.#ints, { codec: this.#codec });
    this.#register(compiled, descriptor.idl, handlers);
  }

  /**
   * Registers an interface from IDL text (parsed, validated and compiled now; served verbatim by
   * GetInterfaceDescription) with untyped handlers. Allowed while serving.
   *
   * @throws {IdlSyntaxError} for invalid IDL.
   * @throws {TypeError} as for {@link implement}.
   */
  addInterface(idl: string, handlers?: UntypedHandlers): void {
    if (typeof idl !== "string") throw new TypeError("addInterface expects IDL text");
    const compiled = compileInterfaceText(idl, { ints: this.#ints, codec: this.#codec });
    this.#register(compiled, idl, handlers);
  }

  /**
   * Serves one connection; resolves when it is closed, never rejects. After {@link shutdown}, or at
   * `maxConnections`, the channel is closed at once (the latter reported as `connection-limit`).
   */
  async handle(channel: ByteChannel): Promise<void> {
    if (this.#shutdown !== undefined) {
      channel.close();
      return;
    }
    this.#serving = true;
    if (this.#connections.size >= this.#maxConnections) {
      this.#report(new Error(`connection limit (${String(this.#maxConnections)}) reached`), "connection-limit");
      channel.close();
      return;
    }
    let session: ServerSession;
    try {
      session = new ServerSession({
        codec: this.#codec,
        maxMessageSize: this.#maxMessageSize,
        maxQueuedCalls: this.#maxQueuedCalls,
      });
    } catch (e) {
      // Options were checked at construction; keep the "never rejects" promise anyway.
      this.#report(e, "transport-error");
      channel.close();
      this.#updateIdle();
      return;
    }
    const conn = new ServerConnection(channel, session, this.#host);
    this.#connections.add(conn);
    this.#updateIdle();
    const done = conn.run().catch((e: unknown) => {
      this.#report(e, "transport-error");
    });
    this.#done.set(conn, done);
    await done;
    this.#connections.delete(conn);
    this.#done.delete(conn);
    this.#updateIdle();
  }

  /** Exit-on-idle: arms the timer while serving with no open connection, cancels it otherwise (and once shut down). */
  #updateIdle(): void {
    const ms = this.#exitOnIdle;
    if (ms === undefined) return;
    if (this.#shutdown !== undefined || this.#connections.size > 0) {
      if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
      return;
    }
    if (!this.#serving || this.#idleTimer !== undefined) return;
    this.#idleTimer = setTimeout(() => {
      // Confirmed one turn later: a connection the runtime is about to accept from a listener cancels it.
      this.#idleTimer = setTimeout(() => {
        this.#idleTimer = undefined;
        if (this.#shutdown === undefined && this.#connections.size === 0) void this.shutdown();
      }, 0);
    }, ms);
  }

  /**
   * Accepts channels from `listener` in the background (returns at once) and serves each with {@link handle}. An
   * error from the iteration is reported as `accept-failed`, ends that loop and closes the listener (its errors
   * swallowed). Several listeners may be served; {@link shutdown} closes them. While the server runs, the
   * iterator is obtained synchronously: a listener that is already being iterated (served by this or another
   * Server) makes `serve()` throw (TypeError for this Server's own listeners and for a Node listener) and is left
   * untouched. After {@link shutdown}, `serve()` just closes the listener.
   *
   * Without `options` it returns nothing (the M4 signature, so existing fire-and-forget calls stay lint-clean). With
   * `options` it returns a promise: without `options.registry` it is resolved at once and never rejects. With it, the
   * listener's {@link ServeListener.bindRegistry} publishes the entries while accepting already runs; the promise
   * resolves once they all exist and rejects if binding failed: then no entry is left, the listener stops being
   * served and is closed (connections accepted meanwhile are served on). Await or handle it when using `registry`
   * (an unhandled rejection ends a Node process).
   *
   * @throws {TypeError} if `listener` is already being served by this server (it is left alone), or for invalid
   *   `options` (an unknown or unregistered interface, a built-in one, a bad `directory`/`scope`).
   * @throws {OperationNotSupportedError} if `registry` is requested and the listener has no `bindRegistry` (a TCP,
   *   abstract or stdio listener); it is left alone.
   * @throws whatever `listener[Symbol.asyncIterator]()` throws (a Node listener: TypeError when another Server
   *   iterates it); the listener is not closed then.
   */
  serve(listener: ServeListener): void;
  serve(listener: ServeListener, options: ServeOptions): Promise<void>;
  serve(listener: ServeListener, options?: ServeOptions): Promise<void> | void {
    if (this.#listeners.has(listener)) throw new TypeError("this listener is already being served");
    const registry = this.#registryRequest(options);
    if (registry !== undefined && typeof listener.bindRegistry !== "function")
      throw new OperationNotSupportedError("this listener cannot be published in a registry (not a unix path socket)");
    if (this.#shutdown !== undefined) {
      void this.#closeListener(listener);
      return Promise.resolve();
    }
    // Obtained synchronously: a listener that refuses a second iteration (served by another Server) throws here,
    // and that must not close it under its first user.
    const iterator = listener[Symbol.asyncIterator]();
    this.#listeners.add(listener);
    this.#serving = true;
    this.#updateIdle();
    let state: BindState | undefined;
    let bound: Promise<void> = Promise.resolve();
    if (registry !== undefined) {
      const binding = (async () => listener.bindRegistry?.(registry.interfaces, registry.options))();
      state = { ready: binding.catch(() => undefined), unbound: undefined };
      this.#bindings.add(state);
      bound = binding.then(
        () => undefined,
        async (e: unknown) => {
          // All or nothing: bindRegistry rolled its entries back; stop serving the listener and release it.
          try {
            await iterator.return?.();
          } catch {
            // The binding error is the one to report.
          }
          await this.#closeListener(listener, false);
          throw e;
        },
      );
    }
    const loop = async (): Promise<void> => {
      try {
        for (;;) {
          const r = await iterator.next();
          if (r.done === true) break;
          const channel = r.value;
          if (this.#shutdown !== undefined) channel.close();
          else void this.handle(channel);
        }
      } catch (e) {
        this.#report(e, "accept-failed");
        // Release the address: nothing accepts on it any more, and shutdown() will not see it.
        try {
          await listener.close?.();
        } catch {
          // Already reported the cause; a failing close adds nothing.
        }
      } finally {
        this.#listeners.delete(listener);
        if (state !== undefined) await this.#unbind(state);
      }
    };
    void loop();
    return bound;
  }

  /** `serve()`'s registry option checked against the registered interfaces, or undefined if not requested. */
  #registryRequest(
    options: ServeOptions | undefined,
  ): { interfaces: readonly string[]; options: RegistryBindOptions } | undefined {
    if (options === undefined) return undefined;
    if (typeof options !== "object" || (options as unknown) === null)
      throw new TypeError("serve options must be an object");
    const registry: unknown = options.registry;
    if (registry === undefined) return undefined;
    let requested: unknown = registry;
    const bindOptions: RegistryBindOptions = {};
    if (registry !== true && !Array.isArray(registry)) {
      if (typeof registry !== "object" || registry === null)
        throw new TypeError("registry must be true, a list of interface names or an object");
      const { interfaces, directory, scope } = registry as {
        interfaces?: unknown;
        directory?: unknown;
        scope?: unknown;
      };
      requested = interfaces ?? true;
      if (directory !== undefined) {
        if (typeof directory !== "string" || directory === "")
          throw new TypeError("registry.directory must be a non-empty string");
        bindOptions.directory = directory;
      }
      if (scope !== undefined) bindOptions.scope = checkMode(scope, "registry.scope", ["system", "user"], "system");
    }
    if (requested === true) return { interfaces: [...this.#interfaces.keys()], options: bindOptions };
    if (!Array.isArray(requested)) throw new TypeError("registry interfaces must be true or a list of interface names");
    const names: string[] = [];
    for (const name of requested as unknown[]) {
      if (typeof name !== "string") throw new TypeError("registry interfaces must be strings");
      if (name === ORG_VARLINK_SERVICE || name === INTERNAL_ERROR_INTERFACE)
        throw new TypeError(`interface ${name} is built in and is not published in a registry`);
      if (!this.#interfaces.has(name)) throw new TypeError(`interface ${safeQuote(name)} is not registered`);
      if (names.includes(name)) throw new TypeError(`interface ${name} is listed twice`);
      names.push(name);
    }
    return { interfaces: names, options: bindOptions };
  }

  /** Removes a serve() call's registry entries once (after its binding settled); failures go to onError. */
  #unbind(state: BindState): Promise<void> {
    state.unbound ??= state.ready
      .then((binding) => binding?.unbind())
      .catch((e: unknown) => {
        this.#report(e, "registry-failed");
      })
      .finally(() => {
        this.#bindings.delete(state);
      });
    return state.unbound;
  }

  /**
   * Stops the server (idempotent): removes the registry entries of served listeners (`serve(…, {registry})`;
   * failures go to `onError` as `registry-failed`), closes the served listeners, then — graceful (default) — aborts every active
   * call's signal (replies are still written), drops buffered calls and, once its active call finished, ends each
   * connection (FIN after the last reply) and discards its input until the peer closes, for at most 2000 ms; at the
   * `timeout` deadline (default 5000 ms; 0 = none), or at once when not graceful, the rest is closed hard. Resolves
   * when every connection is closed. With `timeout: 0` it waits for every active handler to finish and for its
   * replies to be written: a handler that ignores its signal, or a peer that stops reading while a reply is being
   * written, holds it forever (use a deadline).
   *
   * @throws {RangeError|TypeError} for invalid options (synchronously; nothing is stopped then).
   */
  shutdown(options?: ShutdownOptions): Promise<void> {
    if (this.#shutdown !== undefined) return this.#shutdown;
    // Checked before anything is memoized: an invalid call throws and leaves the server running.
    const graceful = options?.graceful ?? true;
    if (typeof graceful !== "boolean") throw new TypeError("graceful must be a boolean");
    const timeout = checkTimeout(options?.timeout, "timeout", 5000);
    this.#shutdown = this.#stop(graceful, timeout).then(() => {
      this.#resolveClosed();
    });
    this.#updateIdle();
    return this.#shutdown;
  }

  async #stop(graceful: boolean, timeout: number): Promise<void> {
    // Registry entries first: none may point at a socket we are about to close.
    await Promise.all([...this.#bindings].map((s) => this.#unbind(s)));
    await Promise.all([...this.#listeners].map((l) => this.#closeListener(l)));
    const conns = [...this.#connections];
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!graceful) {
      for (const c of conns) c.force();
    } else {
      for (const c of conns) c.drain();
      if (timeout > 0)
        timer = setTimeout(() => {
          for (const c of this.#connections) c.force();
        }, timeout);
    }
    await Promise.all(conns.map(async (c) => this.#done.get(c)));
    if (timer !== undefined) clearTimeout(timer);
  }

  async #closeListener(listener: ServeListener, report = true): Promise<void> {
    try {
      await listener.close?.();
    } catch (e) {
      if (report) this.#report(e, "accept-failed");
    }
  }

  #find(name: string): RegisteredInterface | undefined {
    if (name === ORG_VARLINK_SERVICE) return this.#service;
    if (name === INTERNAL_ERROR_INTERFACE) return this.#internal;
    return this.#interfaces.get(name);
  }

  #register(compiled: CompiledInterface, idl: string, handlers: unknown): void {
    const name = compiled.name;
    if (name === ORG_VARLINK_SERVICE || name === INTERNAL_ERROR_INTERFACE)
      throw new TypeError(`interface ${name} is built in`);
    if (this.#interfaces.has(name)) throw new TypeError(`interface ${name} is already registered`);
    const entries = entriesOf(compiled, implementations(compiled, handlers));
    this.#interfaces.set(name, { name, idl, compiled, entries });
  }

  #report(error: unknown, reason: ServerErrorReason, method?: string): void {
    try {
      this.#onError(error, method === undefined ? { reason } : { method, reason });
    } catch {
      // onError must not throw; if it does, the server carries on.
    }
  }
}

/** A server (DESIGN.md §5.4). @throws {RangeError|TypeError} for invalid options. */
export function createServer(options?: ServerOptions): Server {
  return new Server(options);
}
