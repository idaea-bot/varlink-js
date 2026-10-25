// A varlink server (DESIGN.md §5.4, §4.11): interface registration, the dispatch table, a per-connection driver
// over ServerSession + dispatchCall (DESIGN.md §4.10 contract), accept loops, limits and shutdown.
import { ConnectionClosedError, safeQuote } from "../core/errors/local.ts";
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
  assertIntsMode,
  compileDescriptor,
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
  | "accept-failed";

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

/** What `serve()` accepts: a stream of accepted channels, optionally closable (a Listener is one). */
export interface ServeListener extends AsyncIterable<ByteChannel> {
  close?(): Promise<void>;
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
  #shutdown: Promise<void> | undefined;

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
   *   a descriptor that does not match its IDL, or an `ints` mismatch.
   */
  implement<D extends InterfaceDescriptor>(descriptor: D, handlers: Handlers<D>): void {
    assertIntsMode(descriptor, this.#ints);
    const compiled = compileDescriptor(descriptor, { codec: this.#codec });
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
      return;
    }
    const conn = new ServerConnection(channel, session, this.#host);
    this.#connections.add(conn);
    const done = conn.run().catch((e: unknown) => {
      this.#report(e, "transport-error");
    });
    this.#done.set(conn, done);
    await done;
    this.#connections.delete(conn);
    this.#done.delete(conn);
  }

  /**
   * Accepts channels from `listener` in the background (returns at once) and serves each with {@link handle}. An
   * error from the iteration is reported as `accept-failed`, ends that loop and closes the listener (its errors
   * swallowed). Several listeners may be served; {@link shutdown} closes them. The iterator is obtained
   * synchronously: a listener that is already being iterated (served by this or another Server) makes `serve()`
   * throw (TypeError for this Server's own listeners and for a Node listener) and is left untouched.
   *
   * @throws {TypeError} if `listener` is already being served (it is left alone).
   */
  serve(listener: ServeListener): void {
    if (this.#listeners.has(listener)) throw new TypeError("this listener is already being served");
    if (this.#shutdown !== undefined) {
      void this.#closeListener(listener);
      return;
    }
    // Obtained synchronously: a listener that refuses a second iteration (served by another Server) throws here,
    // and that must not close it under its first user.
    const iterator = listener[Symbol.asyncIterator]();
    this.#listeners.add(listener);
    void (async () => {
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
      }
    })();
  }

  /**
   * Stops the server (idempotent): closes the served listeners, then — graceful (default) — aborts every active
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
    this.#shutdown = this.#stop(graceful, timeout);
    return this.#shutdown;
  }

  async #stop(graceful: boolean, timeout: number): Promise<void> {
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

  async #closeListener(listener: ServeListener): Promise<void> {
    try {
      await listener.close?.();
    } catch (e) {
      this.#report(e, "accept-failed");
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
