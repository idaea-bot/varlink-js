// Runs one call's handler and produces its replies through a ServerSession (DESIGN.md §5.4, §4.10): the
// dispatch table, the streaming handler contract, error mapping and reply validation. No timers, no I/O except
// through `send`.
import { isVarlinkLocalError } from "../errors/local.ts";
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
import { isPlainObject, type Call } from "./messages.ts";
import type { ServerSession } from "./server-session.ts";

/** What a handler sees besides its parameters. */
export interface CallContext {
  /** Aborts when `DispatchOptions.signal` aborts or a write fails (the connection is gone). */
  readonly signal: AbortSignal;
  /** Fully qualified method name. */
  readonly method: string;
  readonly more: boolean;
  readonly oneway: boolean;
  readonly upgrade: boolean;
  /** Vendor extension keys of the call. */
  readonly ext: Readonly<Record<string, unknown>>;
  /**
   * Sends a `continues` reply from a plain async handler (sd_varlink_notify style). With `more`: resolves when the
   * reply was written. Without `more`: the first value becomes the single final reply and later values (and the
   * handler's return value) are dropped. Oneway: a no-op. After the call's final reply: resolves without sending.
   */
  notify(parameters: Record<string, unknown>): Promise<void>;
}

// `void` in the result types lets handlers without a return statement (`async () => {}`) type-check.
/* eslint-disable @typescript-eslint/no-invalid-void-type */

/** A plain handler's result: the final reply's parameters (`undefined` ⇒ `{}`). */
export type HandlerResult = Record<string, unknown> | undefined | void;

/**
 * A method implementation. An async iterator (async generator) result streams: each yielded value is a
 * `continues` reply, the return value the final one (§5.4).
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
  /** Driver: client disconnected / server shutting down. Aborts `ctx.signal`. */
  signal?: AbortSignal;
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

/** Outcome of producing a reply: written to the session, dropped (call over), or unusable (end with InternalError). */
type Outcome = "sent" | "dropped" | "invalid";

class Dispatch {
  readonly #session: ServerSession;
  readonly #id: number;
  readonly #call: Call;
  readonly #table: DispatchTable;
  readonly #send: (bytes: Uint8Array) => Promise<void>;
  readonly #options: DispatchOptions;
  readonly #mode: ValidateReplies;
  readonly #controller = new AbortController();
  #entry: MethodEntry | undefined;
  /** The final reply was produced (or the call can produce nothing more). */
  #done = false;
  /** A write failed: drop everything. */
  #dead = false;
  /** The handler (or iterator) settled: notify() after the end is late. */
  #settled = false;
  #chain: Promise<void> = Promise.resolve();
  /** The validation or encoding error behind the last "invalid" outcome (notify rejects with it). */
  #lastProblem: unknown;

  constructor(
    session: ServerSession,
    id: number,
    call: Call,
    table: DispatchTable,
    send: (bytes: Uint8Array) => Promise<void>,
    options: DispatchOptions,
  ) {
    this.#session = session;
    this.#id = id;
    this.#call = call;
    this.#table = table;
    this.#send = send;
    this.#options = options;
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
    } else if (!this.#done) {
      this.#sendError(InternalError.errorName, {});
    }
    await this.#chain;
    if (this.#call.upgrade && this.#session.state === "upgraded")
      this.#report(
        "upgrade-unclaimed",
        new Error(`${this.#call.method}: upgrade confirmed but nobody took the upgraded stream`),
      );
  }

  /**
   * Checks 1–7 of the dispatch order (§5.4): the first failing check's error, or the handler and its validated
   * parameters.
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
    if (call.upgrade && entry.upgrade === undefined)
      return { error: new InvalidParameterError({ parameter: "upgrade" }) };
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
      let step: IteratorResult<unknown, unknown>;
      try {
        step = await it.next();
      } catch (e) {
        this.#settled = true;
        this.#handleThrow(e);
        return;
      }
      if (this.#call.oneway) {
        this.#settled = true;
        if (step.done !== true) await this.#closeIterator(it);
        return;
      }
      if (this.#done) {
        // The call ended meanwhile (a notify without more, a failed write, a closed session).
        if (step.done !== true) await this.#closeIterator(it);
        this.#settled = true;
        return;
      }
      if (step.done === true || !streaming) {
        const outcome = this.#reply(step.value, false);
        if (step.done !== true) await this.#closeIterator(it);
        this.#settled = true;
        if (outcome === "invalid") this.#sendError(InternalError.errorName, {});
        return;
      }
      const outcome = this.#reply(step.value, true);
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
      upgrade: call.upgrade,
      ext: call.ext,
      notify: (parameters) => this.#notify(parameters),
    };
  }

  #notify(parameters: unknown): Promise<void> {
    if (this.#call.oneway) return Promise.resolve();
    if (this.#done) {
      if (this.#settled)
        this.#report("late-notify", new Error(`${this.#call.method}: notify() after the call's final reply`));
      return Promise.resolve();
    }
    const outcome = this.#reply(parameters, this.#call.more);
    if (outcome === "invalid") {
      const problem = this.#lastProblem;
      this.#sendError(InternalError.errorName, {});
      const rejected = Promise.reject(problem instanceof Error ? problem : new TypeError("invalid notify() value"));
      // Already reported through onError: a fire-and-forget notify() must not become an unhandled rejection.
      // Callers that await still see it.
      rejected.catch(() => undefined);
      return rejected;
    }
    return this.#chain;
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
    this.#controller.abort(this.#lastProblem);
    try {
      this.#session.close();
    } catch {
      // close() does not throw; keep dispatch from rejecting regardless.
    }
  }

  /** Runs a session reply/error call and queues its bytes for writing, in order. */
  #produce(make: () => Uint8Array | null, final: boolean, reason: DispatchErrorReason = "invalid-reply"): Outcome {
    if (this.#done || this.#dead) return "dropped";
    let bytes: Uint8Array | null;
    try {
      bytes = make();
    } catch (e) {
      if (this.#session.state !== "open") {
        // Closed under us (client gone, shutdown): replies are dropped silently.
        this.#done = true;
        return "dropped";
      }
      this.#lastProblem = e;
      this.#report(reason, e);
      return "invalid";
    }
    if (final) this.#done = true;
    if (bytes !== null) {
      const chunk = bytes;
      this.#chain = this.#chain.then(async () => {
        if (this.#dead) return;
        try {
          await this.#send(chunk);
        } catch (e) {
          this.#sendFailed(e);
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
  send: (bytes: Uint8Array) => Promise<void>,
  options?: DispatchOptions,
): Promise<void> {
  await new Dispatch(session, id, call, table, send, options ?? {}).run();
}
