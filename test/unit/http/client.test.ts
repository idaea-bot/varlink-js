// Simple HTTP mode client (DESIGN.md §4.12) end to end against the bridge fixture, with the runtime's own fetch:
// endpoints, URL forms, headers, status and error mapping, json-seq streams, limits, timeouts, abort, validation.
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { after, afterEach, before, describe, test } from "node:test";
import { parseAddress } from "../../../src/core/address/index.ts";
import { createHttpClient, HttpBridgeError, type FetchLike } from "../../../src/http/index.ts";
import {
  CallTimeoutError,
  ConnectionClosedError,
  IntegerRangeError,
  InterfaceNotFoundError,
  InvalidParameterError,
  isVarlinkLocalError,
  MessageTooLargeError,
  MethodNotFoundError,
  OperationNotSupportedError,
  ProtocolError,
  ValidationError,
  VarlinkError,
} from "../../../src/index.ts";
import { fromNodeSocket, listen } from "../../../src/node/index.ts";
import { openSocket } from "../../../src/node/connect.ts";
import { startBridge, type Bridge, type RequestLog } from "../websocket/bridge.ts";
import {
  createService,
  DESC,
  Echo,
  IDL,
  OopsError,
  SERVICE,
  startBackend,
  type Backend,
} from "../websocket/service.ts";

const RS = "\x1e";
const ESC = String.fromCharCode(0x1b);
/** U+202E RIGHT-TO-LEFT OVERRIDE. */
const RLO = String.fromCharCode(0x202e);
let backend: Backend;
let bridge: Bridge;

before(async () => {
  backend = startBackend();
  bridge = await startBridge({ backend: () => backend.connect(), services: [SERVICE, "org.varlink.service"] });
});

after(async () => {
  await bridge.close();
  await backend.stop();
});

afterEach(() => {
  bridge.reset();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Scripts the response to the next call (any `call/…` request): status, content type and body chunks. */
function script(
  chunks: (string | Uint8Array)[],
  options: { status?: number; contentType?: string; end?: boolean; delayMs?: number } = {},
): void {
  bridge.knobs.respond = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    if (!path.startsWith("call/") && !path.startsWith("services")) return false;
    req.resume();
    res.writeHead(options.status ?? 200, { "content-type": options.contentType ?? "application/json-seq" });
    res.flushHeaders();
    for (const c of chunks) {
      if (res.destroyed) return true;
      res.write(c);
      await sleep(options.delayMs ?? 1);
    }
    if (options.end ?? true) res.end();
    return true;
  };
}

async function drain(it: AsyncIterable<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const r of it) out.push(r);
  return out;
}

const quiet = { onError: () => undefined };

/** The i-th request the bridge received. */
function request(i: number): RequestLog {
  const r = bridge.requests[i];
  assert.ok(r !== undefined, `request ${String(i)}`);
  return r;
}

describe("HTTP client: calls", () => {
  test("call/{method}: the bridge derives the service; JSON body and headers", async () => {
    const client = createHttpClient(bridge.base);
    assert.deepEqual(await client.call("org.example.ws.Echo", { text: "hi" }), { text: "hi" });
    assert.deepEqual(await client.call("org.example.ws.Ping"), {});
    const first = request(0);
    assert.equal(first.method, "POST");
    assert.equal(first.path, "/waldo/call/org.example.ws.Echo");
    assert.equal(first.query, "");
    assert.equal(first.service, SERVICE);
    assert.equal(first.headers["content-type"], "application/json");
    assert.equal(first.headers.accept, "application/json");
    assert.equal(first.body, '{"text":"hi"}');
    assert.equal(request(1).body, "{}");
  });

  test("call/{service}/{method}: the client's service, overridden per call; a cross-interface call", async () => {
    const client = createHttpClient(bridge.base, { service: SERVICE });
    await client.call("org.example.ws.Ping");
    const info = await client.call("org.varlink.service.GetInfo");
    assert.ok((info.interfaces as string[]).includes(SERVICE));
    await client.call("org.varlink.service.GetInfo", {}, { service: "org.varlink.service" });
    assert.deepEqual(
      bridge.requests.map((r) => [r.path, r.service]),
      [
        [`/waldo/call/${SERVICE}/org.example.ws.Ping`, SERVICE],
        [`/waldo/call/${SERVICE}/org.varlink.service.GetInfo`, SERVICE],
        ["/waldo/call/org.varlink.service/org.varlink.service.GetInfo", "org.varlink.service"],
      ],
    );
  });

  test("the fixture's ?service= override (UAPI URL schema)", async () => {
    const res = await fetch(`${bridge.base}call/org.varlink.service.GetInfo?service=${SERVICE}`, {
      method: "POST",
      body: "",
    });
    assert.equal(res.status, 200);
    assert.equal(bridge.requests[0]?.service, SERVICE);
    await res.arrayBuffer();
  });

  test("headers are forwarded (401 without them); the client's Content-Type and Accept win", async () => {
    bridge.knobs.requiredHeader = { name: "Authorization", value: "Bearer t" };
    await assert.rejects(createHttpClient(bridge.base).call("org.example.ws.Ping"), (e: unknown) => {
      assert.ok(e instanceof HttpBridgeError);
      assert.equal(e.status, 401);
      assert.equal(e.bridgeMessage, "authentication required");
      assert.equal(e.localName, "varlink-js.HttpBridge");
      assert.ok(isVarlinkLocalError(e));
      return true;
    });
    const client = createHttpClient(bridge.base, {
      headers: { Authorization: "Bearer t", accept: "text/plain", "CONTENT-TYPE": "text/plain", "X-Trace": "7" },
    });
    assert.deepEqual(await client.call("org.example.ws.Ping"), {});
    assert.deepEqual(await client.listServices(), [SERVICE, "org.varlink.service"]);
    const h = request(1).headers;
    assert.equal(h["content-type"], "application/json");
    assert.equal(h.accept, "application/json");
    assert.equal(h["x-trace"], "7");
    for (const headers of [{ "bad name": "x" }, { ok: "a\r\nb" }, { ok: 1 as unknown as string }])
      assert.throws(() => createHttpClient(bridge.base, { headers }), TypeError);
  });

  test("varlink errors from any status: standard classes, interface errors (typed when registered)", async () => {
    const client = createHttpClient(bridge.base, quiet);
    await assert.rejects(client.call("org.example.ws.Nope"), (e: unknown) => {
      assert.ok(e instanceof MethodNotFoundError);
      assert.deepEqual(e.parameters, { method: "org.example.ws.Nope" });
      return true;
    });
    await assert.rejects(client.call("org.example.ws.Echo", { text: 5 }), (e: unknown) => {
      assert.ok(e instanceof InvalidParameterError);
      assert.equal(e.parameters.parameter, "text");
      return true;
    });
    await assert.rejects(
      client.call("org.example.other.X", {}, { service: SERVICE }),
      (e: unknown) => e instanceof InterfaceNotFoundError,
    );
    await assert.rejects(client.call("org.example.ws.Fail", { code: 3 }), (e: unknown) => {
      assert.ok(e instanceof VarlinkError && !(e instanceof OopsError));
      assert.equal(e.error, "org.example.ws.Oops");
      assert.deepEqual(e.parameters, { code: 3 });
      return true;
    });
    const typed = createHttpClient(bridge.base, { interfaces: [DESC] });
    await assert.rejects(typed.call("org.example.ws.Fail", { code: 4 }), (e: unknown) => {
      assert.ok(e instanceof OopsError);
      assert.deepEqual(e.parameters, { code: 4 });
      return true;
    });
  });

  test("an error reply that does not match its registered interface: plain VarlinkError + onError", async () => {
    const reports: string[] = [];
    const client = createHttpClient(bridge.base, {
      interfaces: [IDL],
      onError: (_e, info) => reports.push(`${info.reason} ${info.method}`),
    });
    for (const body of [
      '{"error":"org.example.ws.Oops","parameters":{"code":"x"}}',
      '{"error":"org.example.ws.Undeclared"}',
    ]) {
      script([body], { status: 500, contentType: "application/json" });
      await assert.rejects(
        client.call("org.example.ws.Fail", { code: 1 }),
        (e: unknown) => e instanceof VarlinkError && e.constructor === VarlinkError,
      );
    }
    assert.deepEqual(reports, ["invalid-error org.example.ws.Fail", "invalid-error org.example.ws.Fail"]);
  });

  test("HttpBridgeError: 502 unreachable service, 404 unknown service, non-JSON 500, odd bodies; quoted messages", async () => {
    const down = await startBridge({ backend: () => Promise.reject(new Error("refused")), services: [SERVICE] });
    try {
      await assert.rejects(createHttpClient(down.base).call("org.example.ws.Ping"), (e: unknown) => {
        assert.ok(e instanceof HttpBridgeError);
        assert.equal(e.status, 502);
        assert.equal(e.bridgeMessage, "cannot connect to the service");
        assert.equal(e.message, 'HTTP bridge error (status 502): "cannot connect to the service"');
        return true;
      });
    } finally {
      await down.close();
    }
    const client = createHttpClient(bridge.base);
    await assert.rejects(
      client.call("org.example.unknown.Ping"),
      (e: unknown) => e instanceof HttpBridgeError && e.status === 404 && e.bridgeMessage === "unknown service",
    );
    for (const [body, status, message] of [
      ["<html>oops</html>", 500, undefined],
      ['{"error":"not a valid name"}', 500, undefined],
      ['{"error":"org.example.ws.Oops","parameters":[1]}', 400, undefined],
      ["[]", 500, undefined],
      ['{"message":"evil\\u001b[31m\\u202e"}', 503, `evil${ESC}[31m${RLO}`],
      ['{"message":"' + "m".repeat(2000) + '"}', 500, "m".repeat(2000)],
    ] as const) {
      script([body], { status, contentType: "text/plain" });
      await assert.rejects(client.call("org.example.ws.Ping"), (e: unknown) => {
        assert.ok(e instanceof HttpBridgeError, body);
        assert.equal(e.status, status);
        assert.equal(e.bridgeMessage, message);
        assert.ok(e.message.length < 300, "the message is cut");
        assert.ok(!e.message.includes(ESC) && !e.message.includes(RLO), "the message is log-safe");
        return true;
      });
    }
  });

  test("a success body must be one JSON object in UTF-8", async () => {
    const client = createHttpClient(bridge.base);
    for (const body of ["[1]", "nope", "", new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])]) {
      script([body], { contentType: "application/json" });
      await assert.rejects(client.call("org.example.ws.Ping"), ProtocolError);
    }
  });

  test("lossless integers: bigint where untyped; ints mode and validateReplies for registered interfaces", async () => {
    const big = 2n ** 60n + 1n;
    assert.deepEqual(await createHttpClient(bridge.base).call("org.example.ws.Big"), { n: big });
    const bigint = createHttpClient(bridge.base, { ints: "bigint", interfaces: [IDL], validateReplies: "throw" });
    assert.deepEqual(await bigint.call("org.example.ws.Big"), { n: big });
    const number = createHttpClient(bridge.base, { interfaces: [IDL], validateReplies: "warn" });
    await assert.rejects(number.call("org.example.ws.Big"), IntegerRangeError);
    assert.deepEqual(await createHttpClient(bridge.base, { interfaces: [IDL] }).call("org.example.ws.Big"), { n: big });
  });

  test("validateReplies off/warn/throw; parameters are validated before any request", async () => {
    const reports: string[] = [];
    const make = (mode: "off" | "warn" | "throw") =>
      createHttpClient(bridge.base, {
        interfaces: [IDL],
        validateReplies: mode,
        onError: (_e, info) => reports.push(info.reason),
      });
    for (const mode of ["off", "warn", "throw"] as const) {
      script(['{"text":5,"extra":true}'], { contentType: "application/json" });
      const p = make(mode).call("org.example.ws.Echo", { text: "x" });
      if (mode === "throw") await assert.rejects(p, ValidationError);
      else assert.deepEqual(await p, { text: 5, extra: true });
    }
    assert.deepEqual(reports, ["invalid-reply"]);
    bridge.reset();
    script(['{"text":"ok","extra":true}'], { contentType: "application/json" });
    assert.deepEqual(await make("warn").call("org.example.ws.Echo", { text: "x" }), { text: "ok" });
    bridge.reset();
    await assert.rejects(make("off").call("org.example.ws.Echo", { text: 5 }), ValidationError);
    await assert.rejects(make("off").call("org.example.ws.Echo", { text: "x", extra: 1 }), ValidationError);
    assert.equal(bridge.requests.length, 0);
  });

  test("typed calls need a registered descriptor", async () => {
    const typed = createHttpClient(bridge.base, { interfaces: [DESC] });
    assert.deepEqual(await typed.call(Echo, { text: "t" }), { text: "t" });
    assert.deepEqual(
      await typed.collect(DESC.methods.Count as typeof Echo, { text: "" } as never).catch(() => "x"),
      "x",
    );
    await assert.rejects(createHttpClient(bridge.base).call(Echo, { text: "t" }), TypeError);
  });

  test("invalid method and service names, bad parameters and bad options are rejected before any request", async () => {
    const client = createHttpClient(bridge.base);
    for (const method of ["Ping", "org.example.ws.ping", "org.example.ws.", ".Ping", "org..ws.Ping", "a/b.C"])
      await assert.rejects(client.call(method), TypeError, method);
    await assert.rejects(client.call("org.example.ws.Ping", {}, { service: "not valid" }), TypeError);
    await assert.rejects(client.call("org.example.ws.Ping", [] as unknown as Record<string, unknown>), TypeError);
    await assert.rejects(client.call("org.example.ws.Ping", { n: NaN }), TypeError);
    await assert.rejects(client.call("org.example.ws.Ping", {}, { timeout: -1 }), RangeError);
    await assert.rejects(client.getInfo("bad name"), TypeError);
    await assert.rejects(client.listMethods(SERVICE, "x"), TypeError);
    assert.throws(() => createHttpClient(bridge.base, { service: "x" }), TypeError);
    assert.throws(() => createHttpClient(bridge.base, { maxMessageSize: 0 }), RangeError);
    assert.throws(() => createHttpClient(bridge.base, { validateReplies: "loud" as "off" }), TypeError);
    const it = client.stream("nope");
    await assert.rejects(it.next(), TypeError);
    assert.deepEqual(await it.next(), { value: undefined, done: true });
    await assert.rejects(client.collect("org.example.ws.Count", { n: 1 }, { max: 0 }), RangeError);
    assert.equal(bridge.requests.length, 0);
  });

  test("oneway is not supported in simple mode", async () => {
    await assert.rejects(
      createHttpClient(bridge.base).oneway("org.example.ws.Log", { text: "x" }),
      OperationNotSupportedError,
    );
  });

  test("maxMessageSize bounds the whole body: the request is aborted", async () => {
    const client = createHttpClient(bridge.base, { maxMessageSize: 1024 });
    assert.deepEqual(await client.call("org.example.ws.Echo", { text: "x".repeat(1000) }), { text: "x".repeat(1000) });
    await assert.rejects(client.call("org.example.ws.Echo", { text: "x".repeat(1100) }), MessageTooLargeError);
    script(
      Array.from({ length: 200 }, () => "x".repeat(100)),
      { contentType: "application/json" },
    );
    const aborted = bridge.nextAbortedResponse();
    await assert.rejects(client.call("org.example.ws.Ping"), MessageTooLargeError);
    await aborted;
  });

  test("timeout covers the whole call, body included; 0 = none", async () => {
    const client = createHttpClient(bridge.base, { timeout: 100 });
    const aborted = bridge.nextAbortedResponse();
    await assert.rejects(
      client.call("org.example.ws.Hang"),
      (e: unknown) => e instanceof CallTimeoutError && /org\.example\.ws\.Hang: timed out after 100 ms/.test(e.message),
    );
    await aborted;
    script(['{"partial":'], { contentType: "application/json", end: false });
    await assert.rejects(client.call("org.example.ws.Ping"), CallTimeoutError);
    bridge.reset();
    bridge.knobs.delayMs = 150;
    assert.deepEqual(await client.call("org.example.ws.Ping", {}, { timeout: 0 }), {});
  });

  test("abort: before the request (nothing sent) and during it (rejects with the reason)", async () => {
    const client = createHttpClient(bridge.base);
    const reason = new Error("stop");
    await assert.rejects(
      client.call("org.example.ws.Ping", {}, { signal: AbortSignal.abort(reason) }),
      (e) => e === reason,
    );
    assert.equal(bridge.requests.length, 0);
    const ac = new AbortController();
    const p = client.call("org.example.ws.Hang", {}, { signal: ac.signal });
    const aborted = bridge.nextAbortedResponse();
    setTimeout(() => {
      ac.abort(reason);
    }, 50);
    await assert.rejects(p, (e) => e === reason);
    await aborted;
  });

  test("fetch failures reject with ConnectionClosedError; options.fetch replaces the global one; no fetch at all", async () => {
    const gone = await startBridge({ backend: () => backend.connect(), services: [SERVICE] });
    await gone.close();
    await assert.rejects(createHttpClient(gone.base).call("org.example.ws.Ping"), (e: unknown) => {
      assert.ok(e instanceof ConnectionClosedError);
      assert.equal(e.message, "http request failed");
      assert.ok(e.cause !== undefined);
      return true;
    });
    let calls = 0;
    const counting: FetchLike = (url, init) => {
      calls++;
      return fetch(url, init);
    };
    assert.deepEqual(await createHttpClient(bridge.base, { fetch: counting }).call("org.example.ws.Ping"), {});
    assert.equal(calls, 1);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    Object.defineProperty(globalThis, "fetch", { value: undefined, configurable: true, writable: true });
    try {
      const client = createHttpClient(bridge.base);
      await assert.rejects(client.call("org.example.ws.Ping"), OperationNotSupportedError);
      await assert.rejects(client.stream("org.example.ws.Count", { n: 1 }).next(), OperationNotSupportedError);
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "fetch");
      else Object.defineProperty(globalThis, "fetch", descriptor);
    }
  });

  test("a backend over a real tcp listener (varlink-js/node)", async () => {
    const { server } = createService();
    const listener = await listen("tcp:127.0.0.1:0");
    server.serve(listener);
    const tcpBridge = await startBridge({
      backend: async () => fromNodeSocket(await openSocket(parseAddress(listener.address), 0, undefined)),
      services: [SERVICE],
    });
    try {
      const client = createHttpClient(tcpBridge.base);
      assert.deepEqual(await client.call("org.example.ws.Echo", { text: "tcp" }), { text: "tcp" });
      assert.deepEqual(await client.collect("org.example.ws.Count", { n: 2 }), [{ i: 0 }, { i: 1 }]);
    } finally {
      await tcpBridge.close();
      await server.shutdown({ graceful: false });
    }
  });
});

describe("HTTP client: streams", () => {
  test("?more=true, Accept application/json-seq; every reply yielded; collect", async () => {
    const client = createHttpClient(bridge.base);
    assert.deepEqual(
      await drain(client.stream("org.example.ws.Count", { n: 5 })),
      [0, 1, 2, 3, 4].map((i) => ({ i })),
    );
    const req = request(0);
    assert.equal(req.path, "/waldo/call/org.example.ws.Count");
    assert.equal(req.query, "?more=true");
    assert.equal(req.headers.accept, "application/json-seq, application/json;q=0.9");
    assert.deepEqual(await client.collect("org.example.ws.Count", { n: 3 }), [{ i: 0 }, { i: 1 }, { i: 2 }]);
    await assert.rejects(client.collect("org.example.ws.Count", { n: 5 }, { max: 3 }), RangeError);
  });

  test("an error before the first reply maps the status; an error record at the end rejects after the replies", async () => {
    const client = createHttpClient(bridge.base, { interfaces: [DESC] });
    await assert.rejects(drain(client.stream("org.example.ws.Fail", { code: 2 })), OopsError);
    bridge.knobs.earlyStreamHeaders = true;
    const it = client.stream("org.example.ws.Fail", { code: 3 });
    await assert.rejects(it.next(), (e: unknown) => e instanceof OopsError && e.parameters.code === 3);
    assert.deepEqual(await it.next(), { value: undefined, done: true });
  });

  test("a reply with a field named error is a reply unless it is the last record (the documented ambiguity)", async () => {
    const client = createHttpClient(bridge.base);
    assert.deepEqual(await drain(client.stream("org.example.ws.Tricky", { last: false })), [
      { error: "org.example.ws.NotAnError" },
      { i: 1 },
      { i: 2 },
    ]);
    const seen: Record<string, unknown>[] = [];
    await assert.rejects(
      (async () => {
        for await (const r of client.stream("org.example.ws.Tricky", { last: true })) seen.push(r);
      })(),
      (e: unknown) => e instanceof VarlinkError && e.error === "org.example.ws.Oops",
    );
    assert.deepEqual(seen, [{ error: "org.example.ws.NotAnError" }, { i: 1 }]);
  });

  test("json-seq parsing: records split into tiny chunks, CRLF, empty records, no final LF, leading whitespace", async () => {
    const client = createHttpClient(bridge.base);
    const body = ` \r\n${RS}{"a":1}\r\n${RS}\n${RS}${RS}{"b":"x}\\"y"}\n${RS}{"c":[1,2]}`;
    script(body.split(""));
    assert.deepEqual(await drain(client.stream("org.example.ws.Count", { n: 1 })), [
      { a: 1 },
      { b: 'x}"y' },
      { c: [1, 2] },
    ]);
  });

  test("error and transport-failure records; a non-object record; a truncated record; an empty body", async () => {
    const client = createHttpClient(bridge.base);
    script([`${RS}{"i":0}\n${RS}{"error":"org.varlink.service.PermissionDenied"}\n`]);
    const seen: unknown[] = [];
    await assert.rejects(
      (async () => {
        for await (const r of client.stream("org.example.ws.Count", { n: 1 })) seen.push(r);
      })(),
      (e: unknown) => e instanceof VarlinkError && e.error === "org.varlink.service.PermissionDenied",
    );
    assert.deepEqual(seen, [{ i: 0 }]);
    script([`${RS}{"i":0}\n${RS}{"error":"the service went away\\n"}\n`]);
    await assert.rejects(drain(client.stream("org.example.ws.Count", { n: 1 })), (e: unknown) => {
      assert.ok(e instanceof HttpBridgeError);
      assert.equal(e.status, 200);
      assert.equal(e.bridgeMessage, "the service went away\n");
      return true;
    });
    for (const body of [`${RS}[1]\n`, `${RS}{"i":0}\n${RS}{"i":`, "", " \n"]) {
      script([body]);
      await assert.rejects(drain(client.stream("org.example.ws.Count", { n: 1 })), ProtocolError, JSON.stringify(body));
    }
  });

  test("an application/json body answers a stream with one reply (an error-shaped one included)", async () => {
    const client = createHttpClient(bridge.base);
    bridge.knobs.streamAsJson = true;
    assert.deepEqual(await drain(client.stream("org.example.ws.Count", { n: 1 })), [{ i: 0 }]);
    script(['{"error":"org.example.ws.Oops"}'], { contentType: "application/json" });
    assert.deepEqual(await drain(client.stream("org.example.ws.Count", { n: 1 })), [{ error: "org.example.ws.Oops" }]);
  });

  test("maxMessageSize bounds each record and an application/json body", async () => {
    const client = createHttpClient(bridge.base, { maxMessageSize: 64 });
    const small = `{"i":"${"x".repeat(50)}"}`;
    script([`${RS}${small}\n`.repeat(20)]);
    assert.equal((await drain(client.stream("org.example.ws.Count", { n: 1 }))).length, 20);
    script([`${RS}{"i":0}\n`, `${RS}{"i":"${"x".repeat(100)}"}\n`]);
    const it = client.stream("org.example.ws.Count", { n: 1 });
    assert.deepEqual(await it.next(), { value: { i: 0 }, done: false });
    await assert.rejects(it.next(), MessageTooLargeError);
    script([`{"i":"${"x".repeat(100)}"}`], { contentType: "application/json" });
    await assert.rejects(drain(client.stream("org.example.ws.Count", { n: 1 })), MessageTooLargeError);
  });

  test("timeouts: to the first record, then idle while next() waits (not while the consumer is busy)", async () => {
    const client = createHttpClient(bridge.base);
    await assert.rejects(
      drain(client.stream("org.example.ws.Count", { n: 1, firstDelayMs: 300 }, { timeout: 100 })),
      CallTimeoutError,
    );
    const it = client.stream("org.example.ws.Count", { n: 3, delayMs: 300 }, { timeout: 1000, idleTimeout: 100 });
    assert.deepEqual(await it.next(), { value: { i: 0 }, done: false });
    await assert.rejects(
      it.next(),
      (e: unknown) => e instanceof CallTimeoutError && /no reply for 100 ms/.test(e.message),
    );
    assert.deepEqual(await it.next(), { value: undefined, done: true });
    const busy = client.stream("org.example.ws.Count", { n: 3 }, { idleTimeout: 50 });
    const seen: unknown[] = [];
    for await (const r of busy) {
      seen.push(r.i);
      await sleep(120);
    }
    assert.deepEqual(seen, [0, 1, 2]);
  });

  test("return() cancels the body and aborts the request (the bridge sees the response closed)", async () => {
    const client = createHttpClient(bridge.base);
    const aborted = bridge.nextAbortedResponse();
    const seen: unknown[] = [];
    for await (const r of client.stream("org.example.ws.Monitor")) {
      seen.push(r.i);
      if (seen.length === 3) break;
    }
    assert.deepEqual(seen, [0, 1, 2]);
    await aborted;
    assert.ok(bridge.abortedResponses >= 1);
  });

  test("abort mid-stream rejects with the reason; a dropped response rejects with ConnectionClosedError", async () => {
    const client = createHttpClient(bridge.base);
    const ac = new AbortController();
    const reason = new Error("enough");
    const it = client.stream("org.example.ws.Monitor", {}, { signal: ac.signal });
    assert.deepEqual(await it.next(), { value: { i: 0 }, done: false });
    ac.abort(reason);
    await assert.rejects(
      (async () => {
        for (;;) if ((await it.next()).done === true) break;
      })(),
      (e) => e === reason,
    );
    bridge.knobs.dropAfterRecords = 2;
    const seen: unknown[] = [];
    await assert.rejects(
      (async () => {
        for await (const r of client.stream("org.example.ws.Count", { n: 10, delayMs: 5 })) seen.push(r.i);
      })(),
      ConnectionClosedError,
    );
    assert.deepEqual(seen, [0, 1]);
  });

  test("validation applies to every record; a failure aborts the stream", async () => {
    const client = createHttpClient(bridge.base, { interfaces: [IDL], validateReplies: "throw" });
    script([`${RS}{"i":0}\n`, `${RS}{"i":"no"}\n`, `${RS}{"i":2}\n`]);
    const it = client.stream("org.example.ws.Count", { n: 1 });
    assert.deepEqual(await it.next(), { value: { i: 0 }, done: false });
    await assert.rejects(it.next(), ValidationError);
    assert.deepEqual(await it.next(), { value: undefined, done: true });
  });
});

describe("HTTP client: introspection", () => {
  test("services, service info, methods, health", async () => {
    const client = createHttpClient(bridge.base);
    assert.deepEqual(await client.listServices(), [SERVICE, "org.varlink.service"]);
    const info = await client.getInfo(SERVICE);
    assert.equal(info.vendor, "varlink-js");
    assert.ok(info.interfaces.includes(SERVICE));
    assert.deepEqual(await client.listMethods(SERVICE, SERVICE), [
      "Echo",
      "Ping",
      "Log",
      "Count",
      "Hang",
      "Fail",
      "Big",
      "Tricky",
      "Monitor",
    ]);
    await assert.rejects(client.listMethods(SERVICE, "org.example.missing"), InterfaceNotFoundError);
    await assert.rejects(
      client.getInfo("org.example.unknown"),
      (e: unknown) => e instanceof HttpBridgeError && e.status === 404,
    );
    assert.equal(await client.health(), true);
    bridge.knobs.healthy = false;
    assert.equal(await client.health(), false);
    assert.deepEqual(
      bridge.requests.map((r) => `${r.method} ${r.path}`),
      [
        "GET /waldo/services",
        `GET /waldo/services/${SERVICE}`,
        `GET /waldo/services/${SERVICE}/${SERVICE}`,
        `GET /waldo/services/${SERVICE}/org.example.missing`,
        "GET /waldo/services/org.example.unknown",
        "GET /waldo/health",
        "GET /waldo/health",
      ],
    );
    assert.equal(bridge.requests[0]?.headers.accept, "application/json");
  });

  test("reply shapes are checked: GetInfo validated, {services}/{methods} string arrays", async () => {
    const client = createHttpClient(bridge.base);
    script(['{"vendor":"v","product":"p","version":"1","url":"u"}'], { contentType: "application/json" });
    await assert.rejects(client.getInfo(SERVICE), ValidationError);
    script(['{"vendor":"v","product":"p","version":"1","url":"u","interfaces":[],"extra":1}'], {
      contentType: "application/json",
    });
    assert.deepEqual(await client.getInfo(SERVICE), {
      vendor: "v",
      product: "p",
      version: "1",
      url: "u",
      interfaces: [],
    });
    for (const body of ['{"services":[1]}', '{"services":"x"}', "[]"]) {
      script([body], { contentType: "application/json" });
      await assert.rejects(client.listServices(), ProtocolError);
    }
    script(['{"methods":{}}'], { contentType: "application/json" });
    await assert.rejects(client.listMethods(SERVICE, SERVICE), ProtocolError);
  });

  test("health: a network failure rejects; timeout and abort apply", async () => {
    const gone = await startBridge({ backend: () => backend.connect(), services: [SERVICE] });
    await gone.close();
    await assert.rejects(createHttpClient(gone.base).health(), ConnectionClosedError);
    bridge.knobs.delayMs = 300;
    bridge.knobs.respond = async (_req, res, path) => {
      if (path !== "health") return false;
      await sleep(300);
      if (!res.destroyed) res.end();
      return true;
    };
    await assert.rejects(createHttpClient(bridge.base).health({ timeout: 50 }), CallTimeoutError);
    const reason = new Error("x");
    await assert.rejects(
      createHttpClient(bridge.base).health({ signal: AbortSignal.abort(reason) }),
      (e) => e === reason,
    );
  });
});

describe("HTTP client: base URL", () => {
  test("a trailing / is added; query and fragment are dropped; AddressSpec input", () => {
    for (const [base, expected] of [
      ["https://h/waldo", "https://h/waldo/"],
      ["https://h/waldo/", "https://h/waldo/"],
      ["HTTP://H:80/a/b?x=1#f", "http://h/a/b/"],
      ["http://h", "http://h/"],
    ] as const) {
      assert.equal(createHttpClient(base).baseUrl, expected);
      assert.equal(createHttpClient(parseAddress(base)).baseUrl, expected);
    }
  });

  test("WebSocket-mode and socket addresses, and credentials in the URL, are TypeErrors", () => {
    assert.throws(
      () => createHttpClient("ws://h/x"),
      (e: unknown) => e instanceof TypeError && /varlink-js\/websocket/.test(e.message),
    );
    assert.throws(() => createHttpClient("https://h/a/ws/services/x"), /varlink-js\/websocket/);
    assert.throws(() => createHttpClient("unix:/run/x"), TypeError);
    assert.throws(() => createHttpClient("https://u:p@h/"), TypeError);
    assert.throws(() => createHttpClient("nonsense"), TypeError);
  });
});

describe("createHttpClient(): address errors never quote credentials", () => {
  test("a WebSocket-mode URL with user:password is a TypeError without the password", () => {
    assert.throws(
      () => createHttpClient("wss://user:s3cret@bridge.example/ws/services/org.example.ws"),
      (e: unknown) =>
        e instanceof TypeError && /varlink-js\/websocket/.test(e.message) && !e.message.includes("s3cret"),
    );
  });
});
