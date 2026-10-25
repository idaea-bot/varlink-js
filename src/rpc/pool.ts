// A pool of client connections (DESIGN.md §5.2, §4.11): each operation leases one connection exclusively until it
// settles; closed connections are never handed out (F4); at `max`, operations wait FIFO.
import { ConnectionClosedError } from "../core/errors/local.ts";
import type { Interface } from "../core/idl/ast.ts";
import {
  connectionInternals,
  type CallOptions,
  type CollectOptions,
  type Connection,
  type ServiceInfo,
  type StreamIterator,
  type StreamOptions,
} from "./connection.ts";
import { checkPositiveInt, checkTimeout } from "./util.ts";

/** Options for {@link createPool}. */
export interface PoolOptions {
  /** Most connections open at once (leased + idle + being opened); default 8. */
  max?: number;
  /** Idle connections are closed after this many ms; default 30 000; 0 = keep forever. */
  idleTimeout?: number;
}

/** Opens a connection; `signal` aborts when nobody wants it any more (operation aborted, pool closed). */
export type ConnectionFactory = (signal: AbortSignal) => Promise<Connection>;

interface Waiter {
  resolve(conn: Connection): void;
  reject(error: unknown): void;
  readonly signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  /** Settled (served, aborted or rejected). */
  done: boolean;
}

interface Idle {
  readonly conn: Connection;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Connections from `factory`, leased per operation (DESIGN.md §5.2): `call`/`oneway`/`collect` hold their lease
 * until they settle, `stream` until its final reply, an error, or `return()`. A connection that closed is dropped
 * and never handed out again; a factory failure rejects only that operation. Create it with {@link createPool}.
 */
export class Pool {
  readonly #factory: ConnectionFactory;
  readonly #max: number;
  readonly #idleTimeout: number;
  readonly #all = new Set<Connection>();
  /** Most recently released last. */
  readonly #idle: Idle[] = [];
  readonly #waiters: Waiter[] = [];
  readonly #opening = new Set<AbortController>();
  #closed = false;

  /** Use {@link createPool}. */
  constructor(factory: ConnectionFactory, options?: PoolOptions) {
    if (typeof factory !== "function") throw new TypeError("factory must be a function");
    this.#factory = factory;
    this.#max = checkPositiveInt(options?.max, "max", 8);
    this.#idleTimeout = checkTimeout(options?.idleTimeout, "idleTimeout", 30_000);
  }

  /** Open connections (leased and idle; not counting ones being opened). */
  get size(): number {
    return this.#all.size;
  }

  /** Idle connections. */
  get idle(): number {
    return this.#idle.length;
  }

  /** {@link Connection.call} on a leased connection. */
  call(method: string, parameters?: Record<string, unknown>, options?: CallOptions): Promise<Record<string, unknown>> {
    return this.#with(options?.signal, (c) => c.call(method, parameters, options));
  }

  /** {@link Connection.oneway} on a leased connection. */
  oneway(method: string, parameters?: Record<string, unknown>, options?: CallOptions): Promise<void> {
    return this.#with(options?.signal, (c) => c.oneway(method, parameters, options));
  }

  /** {@link Connection.collect} on a leased connection. */
  collect(
    method: string,
    parameters?: Record<string, unknown>,
    options?: CollectOptions,
  ): Promise<Record<string, unknown>[]> {
    return this.#with(options?.signal, (c) => c.collect(method, parameters, options));
  }

  /** {@link Connection.getInfo} on a leased connection. */
  getInfo(options?: CallOptions): Promise<ServiceInfo> {
    return this.#with(options?.signal, (c) => c.getInfo(options));
  }

  /** {@link Connection.getInterfaceDescription} on a leased connection. */
  getInterfaceDescription(name: string, options?: CallOptions): Promise<string> {
    return this.#with(options?.signal, (c) => c.getInterfaceDescription(name, options));
  }

  /** {@link Connection.getInterface} on a leased connection. */
  getInterface(name: string, options?: CallOptions): Promise<Interface> {
    return this.#with(options?.signal, (c) => c.getInterface(name, options));
  }

  /**
   * {@link Connection.stream} on a leased connection; the lease is acquired at once and held until the final
   * reply, an error, or `return()` (which closes that connection if the call was written, like on a Connection).
   */
  stream(method: string, parameters?: Record<string, unknown>, options?: StreamOptions): StreamIterator {
    let inner: StreamIterator | undefined;
    let returned = false;
    const ready = this.#acquire(options?.signal).then((conn) => {
      if (returned) {
        this.#release(conn);
        return undefined;
      }
      let released = false;
      inner = connectionInternals(conn).stream(method, parameters, options, undefined, () => {
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
        const s = await ready;
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

  async #with<T>(signal: AbortSignal | undefined, op: (conn: Connection) => Promise<T>): Promise<T> {
    const conn = await this.#acquire(signal);
    try {
      return await op(conn);
    } finally {
      this.#release(conn);
    }
  }

  #acquire(signal: AbortSignal | undefined): Promise<Connection> {
    if (this.#closed) return Promise.reject(new ConnectionClosedError("pool closed"));
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the abort reason as is
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const w: Waiter = { resolve, reject, signal, onAbort: undefined, done: false };
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
    // The waiter gave up while the connection was being opened: stop wanting it (it goes idle if it arrives).
    const onWaiterAbort = (): void => {
      ac.abort(w.signal?.reason);
    };
    w.signal?.addEventListener("abort", onWaiterAbort, { once: true });
    const opened = (async () => this.#factory(ac.signal))();
    opened.then(
      (conn) => {
        this.#opening.delete(ac);
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
