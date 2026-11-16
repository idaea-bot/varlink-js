// The HTTP client's request lifecycle against a scripted fetch (DESIGN.md §4.12): on every settle path the timer and
// the abort listener are gone, an unread body is cancelled, and an early exit aborts the request.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  createHttpClient,
  type FetchInitLike,
  type FetchLike,
  type ReadableStreamReaderLike,
  type ResponseLike,
} from "../../../src/http/index.ts";
import { CallTimeoutError, ConnectionClosedError, MessageTooLargeError } from "../../../src/index.ts";
import { abortListeners, trackTimers } from "../rpc/helpers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A response body fed by the test; records cancellation. */
class Body {
  readonly #chunks: (Uint8Array | null)[] = [];
  #waiter: ((r: { done: boolean; value?: Uint8Array }) => void) | undefined;
  cancelled: { reason: unknown } | undefined;

  push(text: string | null): void {
    const item = text === null ? null : enc(text);
    const w = this.#waiter;
    this.#waiter = undefined;
    if (w === undefined) this.#chunks.push(item);
    else w(item === null ? { done: true } : { done: false, value: item });
  }

  reader(): ReadableStreamReaderLike {
    return {
      read: () => {
        if (this.cancelled !== undefined) return Promise.resolve({ done: true });
        const item = this.#chunks.shift();
        if (item === null) return Promise.resolve({ done: true });
        if (item !== undefined) return Promise.resolve({ done: false, value: item });
        return new Promise((resolve) => {
          this.#waiter = resolve;
        });
      },
      cancel: (reason?: unknown) => {
        this.cancelled = { reason };
        const w = this.#waiter;
        this.#waiter = undefined;
        w?.({ done: true });
        return Promise.resolve();
      },
    };
  }
}

interface Request {
  url: string;
  init: FetchInitLike;
  body: Body;
  respond(status: number): void;
}

/** A fetch whose responses the test sends; like a real fetch it rejects with the signal's reason on abort. */
function scriptedFetch(): { fetch: FetchLike; requests: Request[]; next(): Promise<Request> } {
  const requests: Request[] = [];
  let notify: ((r: Request) => void) | undefined;
  const fetch: FetchLike = (url, init) =>
    new Promise<ResponseLike>((resolve, reject) => {
      const body = new Body();
      const req: Request = {
        url,
        init,
        body,
        respond: (status) => {
          resolve({ status, body: { getReader: () => body.reader() } });
        },
      };
      init.signal.addEventListener("abort", () => {
        reject(init.signal.reason as Error);
      });
      requests.push(req);
      notify?.(req);
    });
  return {
    fetch,
    requests,
    next: () =>
      new Promise((resolve) => {
        const pending = requests.at(-1);
        if (pending !== undefined && !seen.has(pending)) {
          seen.add(pending);
          resolve(pending);
          return;
        }
        notify = (r) => {
          seen.add(r);
          notify = undefined;
          resolve(r);
        };
      }),
  };
}
const seen = new WeakSet<Request>();

let timers: ReturnType<typeof trackTimers>;
beforeEach(() => {
  timers = trackTimers();
});
afterEach(() => {
  timers.restore();
});

function clean(signal: AbortSignal): void {
  assert.equal(timers.live(), 0, "no timer left");
  assert.equal(abortListeners(signal), 0, "no abort listener left");
}

describe("HTTP client: request lifecycle", () => {
  test("a call: body read to its end, nothing left; the request is not aborted", async () => {
    const f = scriptedFetch();
    const client = createHttpClient("http://bridge/", { fetch: f.fetch });
    const signal = new AbortController().signal;
    const p = client.call("org.example.ws.Ping", {}, { signal });
    const req = await f.next();
    assert.equal(req.url, "http://bridge/call/org.example.ws.Ping");
    assert.equal(req.init.method, "POST");
    req.respond(200);
    req.body.push("{}");
    req.body.push(null);
    assert.deepEqual(await p, {});
    clean(signal);
    assert.equal(req.init.signal.aborted, false);
  });

  test("a call timing out while the body is read: the body is cancelled, the request aborted", async () => {
    const f = scriptedFetch();
    const client = createHttpClient("http://bridge/", { fetch: f.fetch, timeout: 30 });
    const signal = new AbortController().signal;
    const p = client.call("org.example.ws.Ping", {}, { signal });
    const req = await f.next();
    req.respond(200);
    req.body.push('{"a":');
    await assert.rejects(p, CallTimeoutError);
    assert.ok(req.body.cancelled?.reason instanceof CallTimeoutError);
    assert.ok(req.init.signal.aborted);
    clean(signal);
  });

  test("a call over maxMessageSize: cancelled and aborted with MessageTooLargeError", async () => {
    const f = scriptedFetch();
    const client = createHttpClient("http://bridge/", { fetch: f.fetch, maxMessageSize: 8 });
    const p = client.call("org.example.ws.Ping");
    const req = await f.next();
    req.respond(200);
    req.body.push("12345");
    req.body.push("6789");
    await assert.rejects(p, MessageTooLargeError);
    assert.ok(req.body.cancelled?.reason instanceof MessageTooLargeError);
    assert.ok(req.init.signal.reason instanceof MessageTooLargeError);
    assert.equal(timers.live(), 0);
  });

  test("abort before the response: the fetch rejects with the reason; nothing left", async () => {
    const f = scriptedFetch();
    const client = createHttpClient("http://bridge/", { fetch: f.fetch });
    const ac = new AbortController();
    const reason = new Error("stop");
    const p = client.call("org.example.ws.Ping", {}, { signal: ac.signal });
    const req = await f.next();
    ac.abort(reason);
    await assert.rejects(p, (e) => e === reason);
    assert.equal(req.init.signal.reason, reason);
    clean(ac.signal);
  });

  test("a fetch that ignores the abort and responds later: the body is cancelled, the call rejects with the reason", async () => {
    const reason = new Error("stop");
    const body = new Body();
    let resolveResponse: (r: ResponseLike) => void = () => undefined;
    const fetch: FetchLike = () =>
      new Promise((resolve) => {
        resolveResponse = resolve;
      });
    const ac = new AbortController();
    const p = createHttpClient("http://bridge/", { fetch }).call("org.example.ws.Ping", {}, { signal: ac.signal });
    await Promise.resolve();
    ac.abort(reason);
    resolveResponse({ status: 200, body: { getReader: () => body.reader() } });
    await assert.rejects(p, (e) => e === reason);
    assert.equal(body.cancelled?.reason, reason);
    clean(ac.signal);
  });

  test("a fetch that throws synchronously or rejects: ConnectionClosedError with the cause", async () => {
    const boom = new TypeError("Failed to fetch");
    for (const fetch of [
      (() => {
        throw boom;
      }) as FetchLike,
      (() => Promise.reject(boom)) as FetchLike,
    ]) {
      await assert.rejects(
        createHttpClient("http://bridge/", { fetch }).call("org.example.ws.Ping"),
        (e: unknown) => e instanceof ConnectionClosedError && e.cause === boom,
      );
      assert.equal(timers.live(), 0);
    }
  });

  test("a stream: the first-record timer, then idle timers only while next() waits; normal end leaves nothing", async () => {
    const f = scriptedFetch();
    const client = createHttpClient("http://bridge/", { fetch: f.fetch });
    const signal = new AbortController().signal;
    const it = client.stream("org.example.ws.Count", {}, { signal, timeout: 10_000, idleTimeout: 10_000 });
    const req = await f.next();
    assert.equal(req.url, "http://bridge/call/org.example.ws.Count?more=true");
    assert.equal(timers.live(), 1, "the first-record timer");
    req.respond(200);
    req.body.push('\x1e{"i":0}\n\x1e{"i":1}\n');
    assert.deepEqual(await it.next(), { value: { i: 0 }, done: false });
    assert.equal(timers.live(), 0, "no timer while the consumer holds the reply");
    assert.deepEqual(await it.next(), { value: { i: 1 }, done: false });
    const third = it.next();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timers.live(), 1, "the idle timer while next() waits");
    req.body.push(null);
    assert.deepEqual(await third, { value: undefined, done: true });
    clean(signal);
    assert.equal(req.init.signal.aborted, false);
  });

  test(
    "idleTimeout bounds the gap between records, not between body chunks (a trickling peer times out)",
    { timeout: 5000 },
    async () => {
      timers.restore();
      const f = scriptedFetch();
      const client = createHttpClient("http://bridge/", { fetch: f.fetch });
      const it = client.stream("org.example.ws.Monitor", {}, { idleTimeout: 100 });
      const req = await f.next();
      req.respond(200);
      req.body.push('\x1e{"i":0}\n');
      assert.deepEqual(await it.next(), { value: { i: 0 }, done: false });
      const second = it.next();
      // Whitespace, then an unfinished record, one byte every 30 ms: each chunk would reset a per-chunk timer.
      const trickle = setInterval(() => {
        if (req.body.cancelled === undefined) req.body.push(" ");
      }, 30);
      req.body.push("\x1e{");
      try {
        await assert.rejects(
          second,
          (e: unknown) => e instanceof CallTimeoutError && /no reply for 100 ms/.test(e.message),
        );
      } finally {
        clearInterval(trickle);
      }
      assert.ok(req.body.cancelled !== undefined);
      assert.ok(req.init.signal.aborted);
    },
  );

  test("return() while next() waits: the body is cancelled, the request aborted, next() is done", async () => {
    const f = scriptedFetch();
    const client = createHttpClient("http://bridge/", { fetch: f.fetch });
    const signal = new AbortController().signal;
    const it = client.stream("org.example.ws.Monitor", {}, { signal, idleTimeout: 10_000 });
    const req = await f.next();
    req.respond(200);
    req.body.push('\x1e{"i":0}\n');
    assert.deepEqual(await it.next(), { value: { i: 0 }, done: false });
    const pending = it.next();
    await it.return();
    assert.deepEqual(await pending, { value: undefined, done: true });
    assert.deepEqual(await it.next(), { value: undefined, done: true });
    assert.ok(req.body.cancelled !== undefined);
    assert.ok(req.init.signal.aborted);
    clean(signal);
  });

  test("return() before the response arrived, and a stream never iterated (its timer still bounds it)", async () => {
    const f = scriptedFetch();
    const client = createHttpClient("http://bridge/", { fetch: f.fetch, timeout: 20 });
    const it = client.stream("org.example.ws.Monitor");
    const req = await f.next();
    await it.return();
    assert.ok(req.init.signal.aborted);
    assert.equal(timers.live(), 0);
    const idle = client.stream("org.example.ws.Monitor");
    const req2 = await f.next();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(req2.init.signal.reason instanceof CallTimeoutError);
    assert.equal(timers.live(), 0);
    await assert.rejects(idle.next(), CallTimeoutError);
  });

  test("collect past max: RangeError, body cancelled, request aborted", async () => {
    const f = scriptedFetch();
    const client = createHttpClient("http://bridge/", { fetch: f.fetch });
    const p = client.collect("org.example.ws.Count", {}, { max: 1 });
    const req = await f.next();
    req.respond(200);
    req.body.push('\x1e{"i":0}\n\x1e{"i":1}\n');
    await assert.rejects(p, RangeError);
    assert.ok(req.body.cancelled?.reason instanceof RangeError);
    assert.ok(req.init.signal.aborted);
    assert.equal(timers.live(), 0);
  });

  test("health() does not read the body: it is cancelled", async () => {
    const f = scriptedFetch();
    const p = createHttpClient("http://bridge/", { fetch: f.fetch }).health();
    const req = await f.next();
    assert.equal(req.init.method, "GET");
    assert.equal(req.url, "http://bridge/health");
    req.respond(204);
    assert.equal(await p, false);
    assert.ok(req.body.cancelled !== undefined);
    assert.equal(timers.live(), 0);
  });
});
