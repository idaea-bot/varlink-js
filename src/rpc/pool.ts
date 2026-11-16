// A pool of client connections (DESIGN.md §5.2, §4.11): each operation leases one connection exclusively until it
// settles; closed connections are never handed out (F4); at `max`, operations wait FIFO.
import { CallTimeoutError, ConnectionClosedError } from "../core/errors/local.ts";
import { INTERNAL_ERROR_INTERFACE, ORG_VARLINK_SERVICE } from "../core/errors/standard.ts";
import type { Interface } from "../core/idl/ast.ts";
import { compileInterfaceText } from "../core/types/compile.ts";
import {
  compileDescriptor,
  type InterfaceDescriptor,
  type MethodDescriptor,
  type MethodInput,
  type MethodOutput,
} from "../core/types/descriptors.ts";
import {
  connectionInternals,
  DEFAULT_TIMEOUT,
  type CallOptions,
  type CallSpec,
  type CollectOptions,
  type Connection,
  type ServiceInfo,
  type StreamIterator,
  type StreamOptions,
} from "./connection.ts";
import { assertBuiltinCompatible } from "./service.ts";
import { checkPositiveInt, checkTimeout, splitName } from "./util.ts";

/** Options for {@link createPool}. */
export interface PoolOptions {
  /** Most connections open at once (leased + idle + being opened); default 8. */
  max?: number;
  /** Idle connections are closed after this many ms; default 30 000; 0 = keep forever. */
  idleTimeout?: number;
  /**
   * How long an operation without its own `timeout` waits for a connection (ms; default 45 000, the connection
   * default; 0 = forever). Expiry rejects with `CallTimeoutError`.
   */
  timeout?: number;
}

/** Opens a connection; `signal` aborts when nobody wants it any more (operation aborted, pool closed). */
export type ConnectionFactory = (signal: AbortSignal) => Promise<Connection>;

interface Waiter {
  resolve(conn: Connection): void;
  reject(error: unknown): void;
  readonly signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The open (#open) of this waiter's connection, while in progress. */
  opening: AbortController | undefined;
  /** Settled (served, aborted or rejected). */
  done: boolean;
}

/** An interface registered with {@link Pool.addInterface}. */
interface PoolInterface {
  readonly name: string;
  readonly idl: string;
  readonly value: InterfaceDescriptor | string;
}

type AnyMethod = MethodDescriptor<object, object>;

/** Registered on every connection at construction; a compatible text is accepted again (Connection.addInterface). */
const BUILTIN_NAMES: ReadonlySet<string> = new Set([ORG_VARLINK_SERVICE, INTERNAL_ERROR_INTERFACE]);

/** The interface an operation's method belongs to (a descriptor's, or the interface part of a name). */
function interfaceOf(method: string | AnyMethod): string | undefined {
  if (typeof method !== "string") return (method as Partial<AnyMethod> | null)?.interface;
  return splitName(method)?.interface;
}

interface Idle {
  readonly conn: Connection;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Connections from `factory`, leased per operation (DESIGN.md §5.2): `call`/`oneway`/`collect` hold their lease
 * until they settle, `stream` until its final reply, an error, or `return()`. A connection that closed is dropped
 * and never handed out again; a factory failure rejects only that operation. Waiting for a lease is bounded by the
 * operation's `signal` and `timeout` (else the pool's `timeout`; `CallTimeoutError` on expiry). Create it with
 * {@link createPool}.
 */
export class Pool {
  readonly #factory: ConnectionFactory;
  readonly #max: number;
  readonly #idleTimeout: number;
  readonly #timeout: number;
  readonly #all = new Set<Connection>();
  /** Most recently released last. */
  readonly #idle: Idle[] = [];
  readonly #waiters: Waiter[] = [];
  readonly #opening = new Set<AbortController>();
  /** Registered with addInterface(), in order. */
  readonly #interfaces: PoolInterface[] = [];
  /**
   * Per connection: how many of #interfaces it has applied (a lease does not recompile them), the errors of the
   * entries it rejected, by name and by the rejected descriptors' methods, and the methods of the descriptors it
   * accepted.
   */
  readonly #applied = new WeakMap<
    Connection,
    {
      count: number;
      failed: Map<string, unknown>;
      failedMethods: WeakMap<object, unknown>;
      acceptedMethods: WeakSet<object>;
    }
  >();
  #closed = false;

  /** Use {@link createPool}. */
  constructor(factory: ConnectionFactory, options?: PoolOptions) {
    if (typeof factory !== "function") throw new TypeError("factory must be a function");
    this.#factory = factory;
    this.#max = checkPositiveInt(options?.max, "max", 8);
    this.#idleTimeout = checkTimeout(options?.idleTimeout, "idleTimeout", 30_000);
    this.#timeout = checkTimeout(options?.timeout, "timeout", DEFAULT_TIMEOUT);
  }

  /** Open connections (leased and idle; not counting ones being opened). */
  get size(): number {
    return this.#all.size;
  }

  /** Idle connections. */
  get idle(): number {
    return this.#idle.length;
  }

  /**
   * Registers an interface on every connection the pool hands out (idle ones and new ones), just before an
   * operation uses it; each connection registers each interface once. Checked now: IDL text is parsed and
   * validated, a descriptor is checked against its IDL (`compileDescriptor`). The same value again is a no-op, a
   * different IDL under a registered name a TypeError (the built-ins accept a compatible one: see
   * {@link Connection.addInterface}). The `ints` match is checked per connection
   * ({@link Connection.addInterface}): if a connection rejects an entry, the operations on that connection that use
   * it reject with that error (the connection is released): the rejected descriptor's methods unless the
   * connection accepted another descriptor with the same method objects (a spread copy; same name, so same IDL
   * text), other descriptors and method names of the interface while the connection has no registration of that name
   * (from another entry or its own `interfaces` option). Other operations are not affected.
   *
   * @throws {TypeError} for a different IDL under a registered name, a built-in text incompatible with the
   *   built-in definition, or a descriptor mismatch.
   * @throws {IdlSyntaxError} for invalid IDL.
   */
  addInterface(descriptorOrIdl: InterfaceDescriptor | string): void {
    let entry: PoolInterface;
    let ast: Interface;
    if (typeof descriptorOrIdl === "string") {
      ast = compileInterfaceText(descriptorOrIdl).ast;
      entry = { name: ast.name, idl: descriptorOrIdl, value: descriptorOrIdl };
    } else {
      if (typeof descriptorOrIdl !== "object" || (descriptorOrIdl as unknown) === null)
        throw new TypeError("addInterface expects a descriptor or IDL text");
      // The pool has no ints mode: check the descriptor against its IDL in "number" mode (no lossless codec
      // needed); each connection checks the ints match when the interface is applied.
      ast = compileDescriptor({ ...descriptorOrIdl, ints: "number" }).ast;
      entry = { name: descriptorOrIdl.name, idl: descriptorOrIdl.idl, value: descriptorOrIdl };
    }
    // Every connection would reject an incompatible built-in text: fail here, like a different IDL.
    if (BUILTIN_NAMES.has(entry.name)) assertBuiltinCompatible(ast);
    for (const e of this.#interfaces) {
      if (e.value === entry.value) return;
      if (e.name === entry.name && e.idl !== entry.idl && !BUILTIN_NAMES.has(entry.name))
        throw new TypeError(`interface ${entry.name} is already registered with a different IDL`);
    }
    this.#interfaces.push(entry);
  }

  /** {@link Connection.call} on a leased connection. */
  call<M extends AnyMethod>(method: M, parameters: MethodInput<M>, options?: CallOptions): Promise<MethodOutput<M>>;
  call(method: string, parameters?: Record<string, unknown>, options?: CallOptions): Promise<Record<string, unknown>>;
  call(method: string | AnyMethod, parameters?: object, options?: CallOptions): Promise<object> {
    return this.#with(options, method, (c) =>
      typeof method === "string"
        ? c.call(method, parameters as Record<string, unknown> | undefined, options)
        : c.call(method, parameters as MethodInput<AnyMethod>, options),
    );
  }

  /** {@link Connection.oneway} on a leased connection. */
  oneway<M extends AnyMethod>(method: M, parameters: MethodInput<M>, options?: CallOptions): Promise<void>;
  oneway(method: string, parameters?: Record<string, unknown>, options?: CallOptions): Promise<void>;
  oneway(method: string | AnyMethod, parameters?: object, options?: CallOptions): Promise<void> {
    return this.#with(options, method, (c) =>
      typeof method === "string"
        ? c.oneway(method, parameters as Record<string, unknown> | undefined, options)
        : c.oneway(method, parameters as MethodInput<AnyMethod>, options),
    );
  }

  /** {@link Connection.collect} on a leased connection. */
  collect<M extends AnyMethod>(
    method: M,
    parameters: MethodInput<M>,
    options?: CollectOptions,
  ): Promise<MethodOutput<M>[]>;
  collect(
    method: string,
    parameters?: Record<string, unknown>,
    options?: CollectOptions,
  ): Promise<Record<string, unknown>[]>;
  collect(method: string | AnyMethod, parameters?: object, options?: CollectOptions): Promise<object[]> {
    return this.#with(options, method, (c) =>
      typeof method === "string"
        ? c.collect(method, parameters as Record<string, unknown> | undefined, options)
        : c.collect(method, parameters as MethodInput<AnyMethod>, options),
    );
  }

  /** {@link Connection.getInfo} on a leased connection. */
  getInfo(options?: CallOptions): Promise<ServiceInfo> {
    return this.#with(options, undefined, (c) => c.getInfo(options));
  }

  /** {@link Connection.getInterfaceDescription} on a leased connection. */
  getInterfaceDescription(name: string, options?: CallOptions): Promise<string> {
    return this.#with(options, undefined, (c) => c.getInterfaceDescription(name, options));
  }

  /** {@link Connection.getInterface} on a leased connection. */
  getInterface(name: string, options?: CallOptions): Promise<Interface> {
    return this.#with(options, undefined, (c) => c.getInterface(name, options));
  }

  /**
   * {@link Connection.stream} on a leased connection; the lease is acquired at once and held until the final
   * reply, an error, or `return()` (which closes that connection if the call was written, like on a Connection).
   * If no lease is obtained (timeout, abort, factory failure, closed pool), `next()` rejects once, then is done.
   */
  stream<M extends AnyMethod>(
    method: M,
    parameters: MethodInput<M>,
    options?: StreamOptions,
  ): StreamIterator<MethodOutput<M>>;
  stream(method: string, parameters?: Record<string, unknown>, options?: StreamOptions): StreamIterator;
  stream(method: string | AnyMethod, parameters?: object, options?: StreamOptions): StreamIterator {
    let inner: StreamIterator | undefined;
    let returned = false;
    /** The acquire failed and next() already rejected with it: later calls are done. */
    let failed = false;
    const ready = this.#acquire(options).then((conn) => {
      if (returned) {
        this.#release(conn);
        return undefined;
      }
      const internals = connectionInternals(conn);
      let resolved: [string, CallSpec | undefined];
      try {
        this.#apply(conn, method);
        // Resolved like Connection.stream() does: a name of a registered interface (pool or connection
        // `interfaces`) is validated too, exactly as pool.call(name) is.
        resolved = internals.resolve(method);
      } catch (e) {
        this.#release(conn);
        throw e;
      }
      let released = false;
      const params = parameters as Record<string, unknown> | undefined;
      inner = internals.stream(resolved[0], params, options, resolved[1], () => {
        if (released) return;
        released = true;
        this.#release(conn);
      });
      return inner;
    });
    // Rejections reach the consumer through next(); never an unhandled rejection if it never calls it.
    ready.catch(() => undefined);
    const it: StreamIterator = {
      next: async () => {
        let s: StreamIterator | undefined;
        try {
          s = await ready;
        } catch (e) {
          if (failed) return { value: undefined, done: true };
          failed = true;
          throw e;
        }
        if (s === undefined) return { value: undefined, done: true };
        return s.next();
      },
      return: async () => {
        returned = true;
        const s = inner;
        if (s !== undefined) await s.return();
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return it;
      },
    };
    return it;
  }

  /**
   * Closes the pool: waiting operations reject with ConnectionClosedError, every connection (leased ones too) is
   * closed, later operations reject at once. Resolves when the connections are closed. Idempotent.
   */
  async close(): Promise<void> {
    this.#closed = true;
    const error = new ConnectionClosedError("pool closed");
    for (const w of this.#waiters.splice(0)) this.#settleWaiter(w, undefined, error);
    for (const ac of this.#opening) ac.abort(error);
    for (const idle of this.#idle.splice(0)) if (idle.timer !== undefined) clearTimeout(idle.timer);
    await Promise.all([...this.#all].map((c) => c.close()));
  }

  async #with<T>(
    options: CallOptions | undefined,
    method: string | AnyMethod | undefined,
    op: (conn: Connection) => Promise<T>,
  ): Promise<T> {
    const conn = await this.#acquire(options);
    try {
      this.#apply(conn, method);
      return await op(conn);
    } finally {
      this.#release(conn);
    }
  }

  /**
   * Registers the interfaces added since this connection was last leased, each on its own: what addInterface
   * throws is recorded for that entry. Then throws the recorded error for the operation's `method` (undefined:
   * none, e.g. getInfo): a method descriptor of a rejected descriptor (unless it is also one of an accepted
   * descriptor), or a name (or descriptor) of an interface the connection has no registration of (from no entry,
   * nor its own `interfaces` option).
   */
  #apply(conn: Connection, method: string | AnyMethod | undefined): void {
    let state = this.#applied.get(conn);
    if (state === undefined) {
      state = { count: 0, failed: new Map(), failedMethods: new WeakMap(), acceptedMethods: new WeakSet() };
      this.#applied.set(conn, state);
    }
    for (; state.count < this.#interfaces.length; state.count++) {
      const entry = this.#interfaces[state.count];
      if (entry === undefined) break;
      const methods = typeof entry.value === "string" ? [] : Object.values(entry.value.methods);
      try {
        conn.addInterface(entry.value);
        for (const md of methods) state.acceptedMethods.add(md);
      } catch (e) {
        if (!state.failed.has(entry.name)) state.failed.set(entry.name, e);
        for (const md of methods) state.failedMethods.set(md, e);
      }
    }
    if (method === undefined) return;
    // Spread copies of a descriptor share its method objects: one the connection accepted (same name, so the same
    // IDL text) registered what they need, as on a Connection given the same sequence.
    if (typeof method === "object" && state.failedMethods.has(method) && !state.acceptedMethods.has(method))
      throw state.failedMethods.get(method);
    const iface = interfaceOf(method);
    if (iface !== undefined && state.failed.has(iface) && !connectionInternals(conn).has(iface))
      throw state.failed.get(iface);
  }

  /** Waits for a lease, bounded by the operation's `signal` and `timeout` (the pool's `timeout` if absent). */
  #acquire(options: CallOptions | undefined): Promise<Connection> {
    if (this.#closed) return Promise.reject(new ConnectionClosedError("pool closed"));
    const signal = options?.signal;
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the abort reason as is
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      // A RangeError here rejects the operation.
      const timeout = checkTimeout(options?.timeout, "timeout", this.#timeout);
      const w: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: undefined,
        timer: undefined,
        opening: undefined,
        done: false,
      };
      if (timeout > 0)
        w.timer = setTimeout(() => {
          const i = this.#waiters.indexOf(w);
          if (i >= 0) this.#waiters.splice(i, 1);
          const error = new CallTimeoutError("timed out waiting for a pool connection");
          // Its connection is being opened: stop wanting it, so a factory that would hang frees the slot.
          w.opening?.abort(error);
          this.#settleWaiter(w, undefined, error);
        }, timeout);
      if (signal !== undefined) {
        w.onAbort = () => {
          const i = this.#waiters.indexOf(w);
          if (i >= 0) this.#waiters.splice(i, 1);
          this.#settleWaiter(w, undefined, signal.reason);
        };
        signal.addEventListener("abort", w.onAbort, { once: true });
      }
      this.#waiters.push(w);
      this.#serve();
    });
  }

  #settleWaiter(w: Waiter, conn: Connection | undefined, error?: unknown): void {
    if (w.done) return;
    w.done = true;
    if (w.timer !== undefined) clearTimeout(w.timer);
    if (w.onAbort !== undefined) w.signal?.removeEventListener("abort", w.onAbort);
    if (conn !== undefined) w.resolve(conn);
    else w.reject(error);
  }

  /** Hands idle connections, or new ones while under `max`, to waiters in FIFO order. */
  #serve(): void {
    while (!this.#closed && this.#waiters.length > 0) {
      const conn = this.#takeIdle();
      if (conn !== undefined) {
        const w = this.#waiters.shift();
        if (w !== undefined) this.#settleWaiter(w, conn);
        continue;
      }
      if (this.#all.size + this.#opening.size >= this.#max) return;
      const w = this.#waiters.shift();
      if (w !== undefined) this.#open(w);
    }
  }

  #takeIdle(): Connection | undefined {
    for (;;) {
      const idle = this.#idle.pop();
      if (idle === undefined) return undefined;
      if (idle.timer !== undefined) clearTimeout(idle.timer);
      if (!idle.conn.isClosed) return idle.conn;
      this.#all.delete(idle.conn);
    }
  }

  #open(w: Waiter): void {
    const ac = new AbortController();
    this.#opening.add(ac);
    w.opening = ac;
    // The waiter gave up while the connection was being opened: stop wanting it (it goes idle if it arrives).
    const onWaiterAbort = (): void => {
      ac.abort(w.signal?.reason);
    };
    w.signal?.addEventListener("abort", onWaiterAbort, { once: true });
    const opened = (async () => this.#factory(ac.signal))();
    opened.then(
      (conn) => {
        this.#opening.delete(ac);
        w.opening = undefined;
        w.signal?.removeEventListener("abort", onWaiterAbort);
        if (this.#closed) {
          void conn.close();
          this.#settleWaiter(w, undefined, new ConnectionClosedError("pool closed"));
          return;
        }
        this.#all.add(conn);
        void conn.closed.then(() => {
          this.#drop(conn);
        });
        if (w.done || conn.isClosed) {
          this.#release(conn);
          return;
        }
        this.#settleWaiter(w, conn);
      },
      (error: unknown) => {
        this.#opening.delete(ac);
        w.opening = undefined;
        w.signal?.removeEventListener("abort", onWaiterAbort);
        this.#settleWaiter(w, undefined, error);
        this.#serve();
      },
    );
  }

  #release(conn: Connection): void {
    if (this.#closed) return;
    if (conn.isClosed) {
      this.#drop(conn);
      return;
    }
    const w = this.#waiters.shift();
    if (w !== undefined) {
      this.#settleWaiter(w, conn);
      return;
    }
    const idle: Idle = { conn, timer: undefined };
    if (this.#idleTimeout > 0)
      idle.timer = setTimeout(() => {
        const i = this.#idle.indexOf(idle);
        if (i >= 0) this.#idle.splice(i, 1);
        void conn.close();
      }, this.#idleTimeout);
    this.#idle.push(idle);
  }

  /** A connection closed: forget it; its slot may serve a waiter. */
  #drop(conn: Connection): void {
    if (!this.#all.delete(conn)) return;
    const i = this.#idle.findIndex((x) => x.conn === conn);
    if (i >= 0) {
      const [idle] = this.#idle.splice(i, 1);
      if (idle?.timer !== undefined) clearTimeout(idle.timer);
    }
    this.#serve();
  }
}

/**
 * A pool over `factory` (runtime-agnostic; `varlink-js/node`'s `createPool(address)` wraps it).
 *
 * @throws {RangeError|TypeError} for invalid options.
 */
export function createPool(factory: ConnectionFactory, options?: PoolOptions): Pool {
  return new Pool(factory, options);
}
