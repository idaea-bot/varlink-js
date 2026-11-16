// Runs one call's handler and produces its replies through a ServerSession (DESIGN.md §5.4, §4.10): the
// dispatch table, the streaming handler contract, error mapping and reply validation. No timers, no I/O except
// through `send`.
import { ConnectionClosedError, isVarlinkLocalError, OperationNotSupportedError } from "../errors/local.ts";
import {
  ExpectedMoreError,
  ExpectedUpgradeError,
  InterfaceNotFoundError,
  InternalError,
  InvalidParameterError,
  MethodNotFoundError,
  MethodNotImplementedError,
} from "../errors/standard.ts";
import { isErrorName, isVarlinkError, type VarlinkError } from "../errors/varlink-error.ts";
import { isInterfaceName, isMemberName } from "../idl/names.ts";
import type { Validator } from "../types/compile.ts";
import { SCM_MAX_FD, type ByteChannel, type FdHandle, type PeerCredentials } from "./channel.ts";
import { closeFds, handOver } from "./framer.ts";
import { isPlainObject, type Call } from "./messages.ts";
import type { ServerSession } from "./server-session.ts";

/** What a handler sees besides its parameters. */
export interface CallContext {
  /**
   * Aborts when `DispatchOptions.signal` aborts (client gone, server shutting down), a write fails, the session
   * is closed while the call is unanswered, or dispatch closes the session because not even InternalError could
   * be encoded.
   */
  readonly signal: AbortSignal;
  /** Fully qualified method name. */
  readonly method: string;
  readonly more: boolean;
  readonly oneway: boolean;
  /**
   * The call's `upgrade` flag as sent. Also set for a method without upgrade support: such a call runs as a plain
   * call (Q4, like sd-varlink) and {@link upgrade} rejects.
   */
  readonly upgradeRequested: boolean;
  /**
   * Protocol upgrade (§5.6): sends `parameters` (default `{}`, validated like any reply per `validateReplies`) as the
   * confirming reply and resolves, once it was written, with the connection's transport as a {@link ByteChannel}
   * that first yields the bytes the client sent after its call (already buffered), then reads from the transport.
   * The channel belongs to the handler from then on (close or end it when done); the handler's return value and
   * later throws no longer reach the wire (a throw goes to `onError` as `handler-threw`), and {@link notify} rejects.
   *
   * Rejects with a TypeError, with nothing written, unless the call has the `upgrade` flag and its method supports
   * or requires upgrade (on a server that can hand over its transport), when called a second time, or after the
   * call's final reply; with the validation error (the call then ends with InternalError) for an invalid reply in
   * `validateReplies: "throw"` mode or a value that is not a plain object; with a `ConnectionClosedError` when the
   * connection is gone before the reply was written. A handler that returns without calling it confirms the upgrade
   * with its return value and the server closes the connection (`upgrade-unclaimed`).
   */
  upgrade(parameters?: Record<string, unknown>): Promise<ByteChannel>;
  /** Vendor extension keys of the call. */
  readonly ext: Readonly<Record<string, unknown>>;
  /**
   * Sends a `continues` reply from a plain async handler (sd_varlink_notify style). With `more`: resolves when the
   * reply was written. Without `more`: the first value becomes the single final reply (resolves when written);
   * later values (and the handler's return value) are dropped and resolve immediately. Oneway: nothing is sent,
   * resolves immediately. After the call's final reply: resolves without sending.
   *
   * Rejects with a `ConnectionClosedError` (`cause`: `signal.reason`) once the connection is gone, for every kind
   * of call: a send of this call failed (also this notify's own), or the session was closed while the call was
   * unanswered (both also abort `signal`). An aborted `signal` alone is not gone (a graceful shutdown still writes
   * replies), nor is a peer that merely half-closed (EOF after its calls). Also rejects, ending the call with
   * InternalError, when the value is not a plain object (any `validateReplies` mode) or fails the method's output
   * type in `validateReplies: "throw"` mode; and when called re-entrantly from a reply's `toJSON` or getter. A
   * fire-and-forget call never becomes an unhandled rejection.
   *
   * Dropped notifies resolve immediately, so wait on real events between notifies (`for await (const c of
   * changes({ signal: ctx.signal })) await ctx.notify(c)`), never a bare `for (;;) await ctx.notify(x)`, which
   * busy-loops for a oneway or non-`more` call. Methods meant to stream should declare `more: "requires"`.
   */
  notify(parameters: Record<string, unknown>): Promise<void>;
  /**
   * The client's credentials (M11): set on connections that have them (unix sockets through the native addon,
   * §4.15), read once when the connection was accepted. Its `pidfd` (fetched on first access, Linux ≥ 6.5) is a view:
   * the connection owns and closes it, its `close()` does nothing, and its `fd` is -1 once the connection closed.
   */
  readonly peer: PeerCredentials | undefined;
  /**
   * The fds that came with this call (M11; empty unless the server allows fd passing input), as views: they belong to
   * the library and are closed when the call is finished, unless claimed with {@link takeFd}. A view's `close()` does
   * nothing (use takeFd to own one), and its `fd` is -1 once the fd was claimed or closed, so a stale number is never
   * used after the call or the claim.
   */
  readonly fds: readonly FdHandle[];
  /**
   * Claims fd number `index` of {@link fds}: the handle is the caller's from now on (close it when done), and it is
   * not closed when the call ends. Throws `InvalidParameterError({parameter})` (default parameter name `"fds"`) if
   * there is no such fd or it was claimed already, so a handler can let it propagate as the call's error.
   */
  takeFd(index: number, parameter?: string): FdHandle;
  /**
   * Attaches fds to the next reply of this call (a `notify`, a yielded or returned value, or an error), like
   * sd_varlink_push_fd (sd-varlink.c:3258-3277). Each fd (a number or an FdHandle) is duplicated at once
   * (close-on-exec): the caller keeps its own fd and may close it right away; the duplicates are closed once the
   * reply was written or dropped. Throws OperationNotSupportedError unless the server allows fd passing output on
   * this connection, RangeError past 253 fds per reply (SCM_MAX_FD; sd-varlink.c:3268 refuses early too) and
   * TypeError for anything but a non-negative integer fd.
   */
  pushFds(...fds: readonly (FdHandle | number)[]): void;
}

// `void` in the result types lets handlers without a return statement (`async () => {}`) type-check.
/* eslint-disable @typescript-eslint/no-invalid-void-type */

/** A plain handler's result: the final reply's parameters (`undefined` ⇒ `{}`). */
export type HandlerResult = Record<string, unknown> | undefined | void;

/**
 * A method implementation. An async iterator (async generator) result streams: each yielded value is a
 * `continues` reply, the return value the final one (§5.4). For a oneway call (no reply wanted) a generator runs
 * only up to its first `yield` and is then closed with `return()`, so an endless monitor cannot run forever; side
 * effects after the first `yield` do not happen.
 */
export type Handler<In = Record<string, unknown>, Out extends Record<string, unknown> = Record<string, unknown>> = (
  parameters: In,
  ctx: CallContext,
) => Out | undefined | void | Promise<Out | undefined | void> | AsyncIterator<Out, Out | undefined | void, undefined>;

/* eslint-enable @typescript-eslint/no-invalid-void-type */

/** A method as dispatch sees it. */
export interface MethodEntry {
  /** Absent: parameters are passed through unvalidated (untyped servers). */
  readonly input?: Validator;
  /** Absent: replies are not validated. */
  readonly output?: Validator;
  readonly more?: "supports" | "requires";
  readonly upgrade?: "supports" | "requires";
  /** Absent ⇒ MethodNotImplemented. */
  readonly handler?: Handler<never> | undefined;
}

/** Result of {@link DispatchTable.lookup}. */
export type LookupResult =
  { kind: "interface-not-found" } | { kind: "method-not-found" } | { kind: "method"; entry: MethodEntry };

/** The server's registered interfaces, as dispatch needs them. */
export interface DispatchTable {
  lookup(interfaceName: string, methodName: string): LookupResult;
  /**
   * Validator for an outgoing error's parameters: `undefined` = the error's interface is unknown to this server
   * (sent unchecked), `null` = the interface is known but declares no such error, else its validator.
   */
  errorValidator(errorName: string): Validator | null | undefined;
}

/** Reply validation against `MethodEntry.output`. */
export type ValidateReplies = "off" | "warn" | "throw";

/** Why {@link DispatchOptions.onError} was called. */
export type DispatchErrorReason =
  | "handler-threw"
  | "invalid-reply"
  | "invalid-error"
  | "bad-result"
  | "late-notify"
  | "cleanup-threw"
  | "upgrade-unclaimed"
  | "send-failed";

/** Options for {@link dispatchCall}. */
export interface DispatchOptions {
  /** Default `"warn"`: an invalid reply is sent anyway and reported. */
  validateReplies?: ValidateReplies;
  /** Handler bugs and invalid replies. Must not throw (exceptions from it are swallowed). */
  onError?: (error: unknown, info: { method: string; reason: DispatchErrorReason }) => void;
  /**
   * Driver: client disconnected / server shutting down. Aborts `ctx.signal`, which tells the handler to stop; it
   * does not by itself discard replies or make `notify` reject (a graceful shutdown still writes replies). On a
   * disconnect, and at a shutdown deadline, the driver also calls `session.close()`: that makes the call gone
   * (later replies are dropped, `notify` rejects, `ctx.signal` aborts at once via `session.closedSignal`).
   */
  signal?: AbortSignal;
  /**
   * Driver: hands over the transport once the confirming reply of `ctx.upgrade()` was written (the session is
   * `upgraded` then), as a ByteChannel that first yields `session.takeUpgradeRemainder()`. Absent: `ctx.upgrade()`
   * rejects (unavailable), and a confirmed upgrade is `upgrade-unclaimed`.
   */
  upgrade?: () => ByteChannel;
  /** M11: fds received with the call (`ctx.fds`); dispatch owns them and closes those not claimed at the end. */
  fds?: readonly FdHandle[] | undefined;
  /** M11: the client's credentials (`ctx.peer`). */
  peer?: PeerCredentials | undefined;
  /**
   * M11: duplicates an fd for `ctx.pushFds` (the channel's `fdPassing.duplicate`); absent unless the server allows fd
   * passing output on this connection (then `pushFds` throws OperationNotSupportedError).
   */
  duplicateFd?: ((fd: number) => FdHandle) | undefined;
}

/** A caller's fd (a number or an FdHandle) as a number. @throws {TypeError} unless a non-negative integer. */
export function fdNumber(fd: unknown): number {
  const n = typeof fd === "object" && fd !== null ? (fd as { fd?: unknown }).fd : fd;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > 0x7fffffff)
    throw new TypeError("an fd must be a non-negative integer or an object with one in `fd`");
  return n;
}

/**
 * Splits a fully qualified method name at its last dot. Null unless the parts are a valid interface name and
 * member name.
 */
export function parseMethodName(method: string): { interface: string; name: string } | null {
  const dot = method.lastIndexOf(".");
  if (dot <= 0) return null;
  const iface = method.slice(0, dot);
  const name = method.slice(dot + 1);
  return isInterfaceName(iface) && isMemberName(name) ? { interface: iface, name } : null;
}

/**
 * Re-yields `items` but holds back one item and returns the last one, so `return yield* streamOf(x)` in a
 * streaming handler sends the last item as the final reply. An empty iterable returns `undefined` (final `{}`).
 * Closes the source when the consumer stops early.
 */
export async function* streamOf<T>(items: Iterable<T> | AsyncIterable<T>): AsyncGenerator<T, T | undefined, undefined> {
  let held: { value: T } | undefined;
  for await (const item of items) {
    if (held !== undefined) yield held.value;
    held = { value: item };
  }
  return held?.value;
}

/** `v` as an async iterator (a callable `next` and a `Symbol.asyncIterator` method), or null. Never throws. */
function asAsyncIterator(v: unknown): AsyncIterator<unknown, unknown, undefined> | null {
  if (typeof v !== "object" || v === null) return null;
  try {
    const r = v as Record<PropertyKey, unknown>;
    if (typeof r.next === "function" && typeof r[Symbol.asyncIterator] === "function")
      return v as AsyncIterator<unknown, unknown, undefined>;
  } catch {
    // A Proxy whose traps throw is not an iterator.
  }
  return null;
}

/** {@link isPlainObject} for handler values: false (never a throw) for a Proxy whose getPrototypeOf trap throws. */
function isPlainReply(v: unknown): v is Record<string, unknown> {
  try {
    return isPlainObject(v);
  } catch {
    return false;
  }
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "object") return "a non-plain object";
  return `a ${typeof v}`;
}

/** `p` with a no-op rejection handler attached: never an unhandled rejection; callers that await still see it. */
function quiet<T>(p: Promise<T>): Promise<T> {
  p.catch(() => undefined);
  return p;
}

/** Outcome of producing a reply: written to the session, dropped (call over), or unusable (end with InternalError). */
type Outcome = "sent" | "dropped" | "invalid";

class Dispatch {
  readonly #session: ServerSession;
  readonly #id: number;
  readonly #call: Call;
  readonly #table: DispatchTable;
  readonly #send: (bytes: Uint8Array, fds?: readonly FdHandle[]) => Promise<void>;
  readonly #options: DispatchOptions;
  /** The call's received fds (M11); a claimed slot (takeFd) is undefined. Unclaimed ones are closed at the end. */
  readonly #received: (FdHandle | undefined)[];
  readonly #receivedView: readonly FdHandle[];
  /** Duplicates made by ctx.pushFds for the next reply (M11): owned here, closed once written or at the end. */
  #pushed: FdHandle[] = [];
  readonly #mode: ValidateReplies;
  readonly #controller = new AbortController();
  #entry: MethodEntry | undefined;
  /** The final reply was produced (or the call can produce nothing more). */
  #done = false;
  /** A write failed: drop everything. */
  #dead = false;
  /** The session was closed while this call was unanswered (by the driver, or by dispatch on the L6 path). */
  #closedUnder = false;
  /** The handler (or iterator) settled: notify() after the end is late. */
  #settled = false;
  #chain: Promise<void> = Promise.resolve();
  /** The validation or encoding error behind the last "invalid" outcome (notify rejects with it). */
  #lastProblem: unknown;
  /** #produce is running the session's encoder (which may call back into user code: toJSON, getters). */
  #producing = false;
  /** ctx.upgrade() was called (it may still be writing the confirming reply). */
  #upgradeCalled = false;
  /** ctx.upgrade() handed the transport to the handler. */
  #claimed = false;

  constructor(
    session: ServerSession,
    id: number,
    call: Call,
    table: DispatchTable,
    send: (bytes: Uint8Array, fds?: readonly FdHandle[]) => Promise<void>,
    options: DispatchOptions,
  ) {
    this.#session = session;
    this.#id = id;
    this.#call = call;
    this.#table = table;
    this.#send = send;
    this.#options = options;
    this.#received = [...(options.fds ?? [])];
    // What handlers see (DESIGN.md §5.4): views that cannot close our fd and report -1 once it is no longer ours to
    // lend (claimed with takeFd, or closed when the call finished), so a stale number is never used.
    const received = this.#received;
    this.#receivedView = Object.freeze(
      received.map((owned, i): FdHandle => {
        const n = owned?.fd ?? -1;
        return Object.freeze({
          get fd() {
            return received[i] === undefined ? -1 : n;
          },
          close: () => undefined,
        });
      }),
    );
    // Untyped callers may pass anything; dispatch never rejects, so an unknown mode means the default.
    const mode = options.validateReplies;
    this.#mode = mode === "off" || mode === "throw" ? mode : "warn";
  }

  async run(): Promise<void> {
    const signal = this.#options.signal;
    const onAbort = (): void => {
      this.#controller.abort(signal?.reason);
    };
    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    // A session closed under the unanswered call (driver close(), protocol error) aborts ctx.signal at once, even
    // if the driver does not abort its own signal.
    const closedSignal = this.#session.closedSignal;
    const onClosed = (): void => {
      if (!this.#done) this.#markClosedUnder();
    };
    if (closedSignal.aborted) onClosed();
    else closedSignal.addEventListener("abort", onClosed, { once: true });
    try {
      await this.#dispatch();
    } catch (e) {
      // Not reachable by design (every step catches); keep the "never rejects" promise anyway.
      this.#report("handler-threw", e);
    }
    this.#settled = true;
    signal?.removeEventListener("abort", onAbort);
    if (this.#call.oneway) {
      try {
        this.#session.finish(this.#id);
      } catch (e) {
        this.#report("handler-threw", e);
      }
      // The oneway call is over: a later session close must not touch it (a detached notify still resolves).
      this.#done = true;
    } else if (!this.#done) {
      this.#sendError(InternalError.errorName, {});
    }
    await this.#chain;
    // The call is finished: fds nobody claimed, and pushed ones no reply took, are closed (DESIGN.md §4.1).
    closeFds(this.#received.filter((fd) => fd !== undefined));
    this.#received.length = 0;
    closeFds(this.#pushed.splice(0));
    closedSignal.removeEventListener("abort", onClosed);
    if (this.#call.upgrade && this.#session.state === "upgraded" && !this.#claimed)
      this.#report(
        "upgrade-unclaimed",
        new Error(`${this.#call.method}: upgrade confirmed but nobody took the upgraded stream`),
      );
  }

  /**
   * Checks 1–6 of the dispatch order (§5.4): the first failing check's error, or the handler and its validated
   * parameters. An `upgrade` call to a method without upgrade support is not an error (Q4): it runs as a plain call.
   */
  #check(): { error: VarlinkError } | { handler: (p: unknown, ctx: CallContext) => unknown; parameters: unknown } {
    const call = this.#call;
    const parsed = parseMethodName(call.method);
    if (parsed === null) return { error: new InvalidParameterError({ parameter: "method" }) };
    const found = this.#table.lookup(parsed.interface, parsed.name);
    if (found.kind === "interface-not-found")
      return { error: new InterfaceNotFoundError({ interface: parsed.interface }) };
    if (found.kind === "method-not-found") return { error: new MethodNotFoundError({ method: call.method }) };
    const entry = found.entry;
    this.#entry = entry;
    if (entry.more === "requires" && !call.more) return { error: new ExpectedMoreError() };
    if (entry.upgrade === "requires" && !call.upgrade) return { error: new ExpectedUpgradeError() };
    // Q4 (sd-varlink, varlink_dispatch_method): the flag on a method without upgrade support is not checked; the
    // call is answered like a plain one and the session keeps speaking varlink afterwards.
    if (call.upgrade && entry.upgrade === undefined && this.#session.state === "open")
      this.#session.ignoreUpgrade(this.#id);
    const handler = entry.handler as ((p: unknown, ctx: CallContext) => unknown) | undefined;
    if (handler === undefined) return { error: new MethodNotImplementedError({ method: call.method }) };
    if (entry.input === undefined) return { handler, parameters: call.parameters };
    try {
      return { handler, parameters: entry.input.decode(call.parameters, { unknownFields: "reject" }) };
    } catch (e) {
      if (isVarlinkLocalError(e, "org.varlink.service.InvalidParameter")) {
        const parameter = (e as { parameter?: unknown }).parameter;
        if (typeof parameter === "string") return { error: new InvalidParameterError({ parameter }) };
      }
      this.#report("handler-threw", e);
      return { error: new InternalError() };
    }
  }

  async #dispatch(): Promise<void> {
    const call = this.#call;
    const checked = this.#check();
    if ("error" in checked) {
      this.#sendError(checked.error.error, checked.error.parameters);
      return;
    }
    const { handler, parameters } = checked;
    let result: unknown;
    try {
      result = handler(parameters, this.#context());
    } catch (e) {
      this.#handleThrow(e);
      return;
    }
    const iterator = asAsyncIterator(result);
    if (iterator !== null) {
      await this.#runIterator(iterator);
      return;
    }
    let value: unknown;
    try {
      value = await result;
    } catch (e) {
      this.#settled = true;
      this.#handleThrow(e);
      return;
    }
    this.#settled = true;
    if (call.oneway || this.#done) return;
    const outcome = this.#reply(value, false);
    if (outcome === "invalid") this.#sendError(InternalError.errorName, {});
  }

  async #runIterator(it: AsyncIterator<unknown, unknown, undefined>): Promise<void> {
    const streaming = this.#call.more;
    for (;;) {
      let step: unknown;
      try {
        step = await it.next();
      } catch (e) {
        this.#settled = true;
        this.#handleThrow(e);
        return;
      }
      // A hand-written iterator may resolve to anything, with throwing getters: like a throw (rule 9), but the
      // iterator is closed since it did not fail itself.
      let done: boolean;
      let value: unknown;
      try {
        if (typeof step !== "object" || step === null)
          throw new TypeError(`${this.#call.method}: iterator result is ${describe(step)}, not an object`);
        const result = step as IteratorResult<unknown, unknown>;
        done = result.done === true;
        value = result.value;
      } catch (e) {
        await this.#closeIterator(it);
        this.#settled = true;
        this.#handleThrow(e);
        return;
      }
      if (this.#call.oneway) {
        this.#settled = true;
        if (!done) await this.#closeIterator(it);
        return;
      }
      if (this.#done) {
        // The call ended meanwhile (a notify without more, a failed write, a closed session).
        if (!done) await this.#closeIterator(it);
        this.#settled = true;
        return;
      }
      if (done || !streaming) {
        const outcome = this.#reply(value, false);
        if (!done) await this.#closeIterator(it);
        this.#settled = true;
        if (outcome === "invalid") this.#sendError(InternalError.errorName, {});
        return;
      }
      const outcome = this.#reply(value, true);
      if (outcome === "invalid") {
        await this.#closeIterator(it);
        this.#settled = true;
        this.#sendError(InternalError.errorName, {});
        return;
      }
      await this.#chain; // backpressure: the reply is written before the next value is pulled
      // The call may have ended while the write was pending (a failed write, a closed session, a notify() from
      // the generator that ended it with InternalError): never pull another value then.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- #done can change during the await
      if (this.#dead || this.#done || this.#session.state !== "open") {
        this.#done = true;
        await this.#closeIterator(it);
        this.#settled = true;
        return;
      }
    }
  }

  async #closeIterator(it: AsyncIterator<unknown, unknown, undefined>): Promise<void> {
    try {
      if (typeof it.return === "function") await it.return();
    } catch (e) {
      this.#report("cleanup-threw", e);
    }
  }

  #context(): CallContext {
    const call = this.#call;
    return {
      signal: this.#controller.signal,
      method: call.method,
      more: call.more,
      oneway: call.oneway,
      upgradeRequested: call.upgrade,
      upgrade: (parameters) => quiet(this.#upgrade(parameters)),
      ext: call.ext,
      notify: (parameters) => this.#notify(parameters),
      peer: this.#options.peer,
      fds: this.#receivedView,
      takeFd: (index, parameter) => this.#takeFd(index, parameter),
      pushFds: (...fds) => {
        this.#pushFds(fds);
      },
    };
  }

  #takeFd(index: unknown, parameter: unknown): FdHandle {
    const name = typeof parameter === "string" ? parameter : "fds";
    const fd = typeof index === "number" && Number.isSafeInteger(index) ? this.#received[index] : undefined;
    if (fd === undefined) throw new InvalidParameterError({ parameter: name });
    this.#received[index as number] = undefined;
    handOver([fd]);
    return fd;
  }

  #pushFds(fds: readonly unknown[]): void {
    const duplicate = this.#options.duplicateFd;
    if (duplicate === undefined)
      throw new OperationNotSupportedError("fd passing output is not enabled on this connection");
    const numbers = fds.map(fdNumber);
    if (this.#pushed.length + numbers.length > SCM_MAX_FD)
      throw new RangeError(`at most ${String(SCM_MAX_FD)} fds per message (SCM_MAX_FD)`);
    const copies: FdHandle[] = [];
    try {
      for (const n of numbers) copies.push(duplicate(n));
    } catch (e) {
      closeFds(copies);
      throw e;
    }
    // A reply after the call is over takes nothing: close them now rather than at the end.
    if (this.#done && this.#settled) closeFds(copies);
    else this.#pushed.push(...copies);
  }

  /** Why ctx.upgrade() cannot be used for this call, or undefined if it can. */
  #upgradeUnavailable(): string | undefined {
    if (!this.#call.upgrade) return "the call does not have the upgrade flag";
    if (this.#entry?.upgrade === undefined) return "the method does not support upgrade";
    if (this.#options.upgrade === undefined) return "this server cannot hand over its transport";
    return undefined;
  }

  async #upgrade(parameters: unknown): Promise<ByteChannel> {
    const method = this.#call.method;
    const unavailable = this.#upgradeUnavailable();
    if (unavailable !== undefined) throw new TypeError(`${method}: ctx.upgrade() is unavailable: ${unavailable}`);
    if (this.#upgradeCalled) throw new TypeError(`${method}: ctx.upgrade() was already called`);
    if (this.#gone()) throw this.#goneError();
    if (this.#done) throw new TypeError(`${method}: ctx.upgrade() after the call's final reply`);
    this.#upgradeCalled = true;
    let outcome: Outcome;
    try {
      outcome = this.#reply(parameters, false);
    } catch (e) {
      // A re-entrant ctx.upgrade() from a reply's toJSON or getter (#produce refuses it); the outer reply goes on.
      this.#report("invalid-reply", e);
      throw e;
    }
    if (outcome === "invalid") {
      const problem = this.#lastProblem;
      this.#sendError(InternalError.errorName, {});
      // Already reported through onError.
      throw problem instanceof Error ? problem : new TypeError("invalid ctx.upgrade() value");
    }
    if (outcome === "dropped") throw this.#goneError();
    await this.#chain;
    if (this.#dead || this.#session.state !== "upgraded") throw this.#goneError();
    let channel: ByteChannel;
    try {
      channel = (this.#options.upgrade as () => ByteChannel)();
    } catch (e) {
      throw new ConnectionClosedError(`${method}: the connection is closed`, { cause: e });
    }
    this.#claimed = true;
    return channel;
  }

  #notify(parameters: unknown): Promise<void> {
    if (this.#upgradeCalled)
      return quiet(Promise.reject(new TypeError(`${this.#call.method}: notify() after ctx.upgrade()`)));
    if (this.#gone()) return quiet(Promise.reject(this.#goneError()));
    if (this.#call.oneway) return Promise.resolve();
    if (this.#done) {
      if (this.#settled)
        this.#report("late-notify", new Error(`${this.#call.method}: notify() after the call's final reply`));
      return Promise.resolve();
    }
    let outcome: Outcome;
    try {
      outcome = this.#reply(parameters, this.#call.more);
    } catch (e) {
      // A re-entrant notify() from a reply's toJSON or getter (#produce refuses it); the outer reply goes on.
      this.#report("invalid-reply", e);
      return quiet(Promise.reject(e instanceof Error ? e : new TypeError("re-entrant notify()")));
    }
    if (outcome === "invalid") {
      const problem = this.#lastProblem;
      this.#sendError(InternalError.errorName, {});
      // Already reported through onError. Callers that await still see it.
      return quiet(Promise.reject(problem instanceof Error ? problem : new TypeError("invalid notify() value")));
    }
    if (outcome === "dropped") return this.#gone() ? quiet(Promise.reject(this.#goneError())) : Promise.resolve();
    // This reply's send is the last link of the chain: reject if it (or one before it) failed.
    return quiet(
      this.#chain.then(() => {
        if (this.#dead) throw this.#goneError();
      }),
    );
  }

  /**
   * The connection can no longer carry this call's replies: a send of this call failed, or the session was closed
   * while the call was still unanswered (by the driver or by dispatch itself). An aborted `ctx.signal` alone is not
   * gone (a graceful shutdown aborts it but still writes replies), and neither is a session closed by a clean peer
   * EOF after the final reply (the peer may half-close after sending its calls and still read the replies).
   */
  #gone(): boolean {
    // Belt and braces: onClosed (session.closedSignal) normally marked the call gone already.
    if (!this.#done && this.#session.state === "closed") this.#markClosedUnder();
    return this.#dead || this.#closedUnder;
  }

  /** The session was closed under this unanswered call: end it and abort ctx.signal (if not aborted yet). */
  #markClosedUnder(): void {
    this.#closedUnder = true;
    this.#done = true;
    if (!this.#controller.signal.aborted)
      this.#controller.abort(new ConnectionClosedError(`${this.#call.method}: the session was closed`));
  }

  #goneError(): ConnectionClosedError {
    // A failed send and a close under us both abort the controller, so its reason is the cause.
    const signal = this.#controller.signal;
    const cause: unknown = signal.aborted ? signal.reason : undefined;
    return new ConnectionClosedError(
      `${this.#call.method}: the connection is closed`,
      cause === undefined ? undefined : { cause },
    );
  }

  /**
   * Validates and produces one reply value (rules 8, 10, 11). "invalid": nothing was produced and the call must
   * end with InternalError (after stopping a generator).
   */
  #reply(value: unknown, continues: boolean): Outcome {
    if (this.#done || this.#dead) return "dropped";
    if (value === undefined) value = {};
    if (!isPlainReply(value)) {
      const problem = new TypeError(`${this.#call.method}: a reply must be a plain object, not ${describe(value)}`);
      this.#lastProblem = problem;
      this.#report("bad-result", problem);
      return "invalid";
    }
    let out: Record<string, unknown> = value;
    const output = this.#entry?.output;
    if (output !== undefined && this.#mode !== "off") {
      try {
        out = output.encode(value) as Record<string, unknown>;
      } catch (e) {
        this.#lastProblem = e;
        this.#report("invalid-reply", e);
        if (this.#mode === "throw") return "invalid";
        out = value;
      }
    }
    return this.#produce(
      () => this.#session.reply(this.#id, out, continues ? { continues: true } : undefined),
      !continues,
    );
  }

  /** Rules 9 and 13: maps a thrown/rejected value to an error reply. */
  #handleThrow(e: unknown): void {
    if (this.#call.oneway) {
      if (!isVarlinkError(e)) this.#report("handler-threw", e);
      return;
    }
    if (this.#done) {
      this.#report("handler-threw", e);
      return;
    }
    if (!isVarlinkError(e)) {
      this.#report("handler-threw", e);
      this.#sendError(InternalError.errorName, {});
      return;
    }
    let name: unknown;
    let parameters: unknown;
    try {
      name = e.error;
      parameters = e.parameters;
    } catch {
      name = undefined;
    }
    if (!isErrorName(name)) {
      this.#report("invalid-error", e);
      this.#sendError(InternalError.errorName, {});
      return;
    }
    let validator: Validator | null | undefined;
    try {
      validator = this.#table.errorValidator(name);
      if (validator === null) throw new TypeError(`${name} is not an error of its interface`);
      if (validator !== undefined) parameters = validator.encode(parameters);
    } catch {
      this.#report("invalid-error", e);
      this.#sendError(InternalError.errorName, {});
      return;
    }
    const outcome = this.#produce(
      () => this.#session.error(this.#id, name, parameters as Record<string, unknown>),
      true,
      "invalid-error",
    );
    if (outcome === "invalid") this.#sendError(InternalError.errorName, {});
  }

  /**
   * A final error reply; falls back to InternalError if it cannot be produced. If even that fails (a codec that
   * cannot encode it) while the session is open, the session is closed so the connection cannot hang with a call
   * that never ends.
   */
  #sendError(name: string, parameters: Record<string, unknown>): void {
    let outcome = this.#produce(() => this.#session.error(this.#id, name, parameters), true);
    if (outcome === "invalid" && name !== InternalError.errorName)
      outcome = this.#produce(() => this.#session.error(this.#id, InternalError.errorName, {}), true);
    if (outcome !== "invalid") return;
    // #produce reported the failure ("invalid-reply").
    this.#done = true;
    this.#closedUnder = true;
    this.#controller.abort(this.#lastProblem);
    try {
      this.#session.close();
    } catch {
      // close() does not throw; keep dispatch from rejecting regardless.
    }
  }

  /**
   * Runs a session reply/error call and queues its bytes for writing, in order.
   *
   * @throws {TypeError} when called while another reply is being produced (a `toJSON` or getter of the reply
   *   calling `ctx.notify()`): dispatch never queues a reply from inside another one, so never two final replies.
   */
  #produce(make: () => Uint8Array | null, final: boolean, reason: DispatchErrorReason = "invalid-reply"): Outcome {
    if (this.#producing)
      throw new TypeError(`${this.#call.method}: re-entrant reply (a reply's toJSON or getter called notify())`);
    if (this.#done || this.#dead) return "dropped";
    let bytes: Uint8Array | null;
    this.#producing = true;
    try {
      bytes = make();
    } catch (e) {
      if (this.#session.state !== "open") {
        // Closed under us (client gone, shutdown): replies are dropped silently. Belt and braces: onClosed
        // (session.closedSignal) has normally marked the call gone already.
        this.#markClosedUnder();
        return "dropped";
      }
      this.#lastProblem = e;
      this.#report(reason, e);
      return "invalid";
    } finally {
      this.#producing = false;
    }
    // The session closed while producing this reply (a lost upgrade remainder: nothing is confirmed, `make()`
    // returned null and onClosed marked the call gone): report it as dropped so a notify-style reply rejects.
    if (this.#closedUnder) return "dropped";
    if (final) this.#done = true;
    if (bytes !== null) {
      const chunk = bytes;
      // ctx.pushFds' duplicates ride with this message and are closed once it was written (or dropped).
      const fds = this.#pushed.splice(0);
      this.#chain = this.#chain.then(async () => {
        try {
          if (this.#dead) return;
          await (fds.length > 0 ? this.#send(chunk, fds) : this.#send(chunk));
        } catch (e) {
          this.#sendFailed(e);
        } finally {
          closeFds(fds);
        }
      });
    }
    return "sent";
  }

  #sendFailed(e: unknown): void {
    this.#dead = true;
    this.#done = true;
    this.#controller.abort(e);
    this.#report("send-failed", e);
    try {
      this.#session.close();
    } catch {
      // close() does not throw; keep dispatch from rejecting regardless.
    }
  }

  #report(reason: DispatchErrorReason, error: unknown): void {
    const onError = this.#options.onError;
    if (onError === undefined) return;
    try {
      onError(error, { method: this.#call.method, reason });
    } catch {
      // onError must not throw; if it does, dispatch carries on.
    }
  }
}

/**
 * Runs `call` (the session's active call `id`) against `table` and writes its replies with `send`, in order.
 * Never rejects. Resolves when the call is finished in the session (final reply sent, or oneway handler settled).
 */
export async function dispatchCall(
  session: ServerSession,
  id: number,
  call: Call,
  table: DispatchTable,
  send: (bytes: Uint8Array, fds?: readonly FdHandle[]) => Promise<void>,
  options?: DispatchOptions,
): Promise<void> {
  await new Dispatch(session, id, call, table, send, options ?? {}).run();
}
