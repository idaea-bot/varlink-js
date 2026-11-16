// serve(listener, {registry}) semantics with fake listeners (DESIGN.md §5.4): which interfaces, synchronous
// checks, all-or-nothing binding, unbind before the listeners close, registry-failed.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OperationNotSupportedError } from "../../../src/core/errors/index.ts";
import {
  createConnection,
  createServer,
  type RegistryBindOptions,
  type RegistryBinding,
  type Server,
  type ServerErrorReason,
} from "../../../src/rpc/index.ts";
import { isPending, MemoryListener, settle } from "../rpc/helpers.ts";

const A = "interface org.example.a\n\nmethod Ping() -> ()\n";
const B = "interface org.example.b\n\nmethod Ping() -> ()\n";

/** A MemoryListener with a scripted bindRegistry; `events` records bind/unbind/close in order. */
class BindableListener extends MemoryListener {
  readonly events: string[] = [];
  readonly calls: { interfaces: readonly string[]; options: RegistryBindOptions }[] = [];
  bindResult: () => Promise<RegistryBinding>;
  unbindError: Error | undefined;

  constructor() {
    super();
    this.bindResult = () =>
      Promise.resolve({
        entries: this.calls.at(-1)?.interfaces.map((i) => `/reg/${i}`) ?? [],
        unbind: () => {
          this.events.push("unbind");
          return this.unbindError === undefined ? Promise.resolve() : Promise.reject(this.unbindError);
        },
      });
  }

  bindRegistry(interfaces: readonly string[], options: RegistryBindOptions): Promise<RegistryBinding> {
    this.events.push("bind");
    this.calls.push({ interfaces, options });
    return this.bindResult();
  }

  override close(): Promise<void> {
    this.events.push("close");
    return super.close();
  }
}

function makeServer(options?: { exitOnIdle?: number }): { server: Server; reported: ServerErrorReason[] } {
  const reported: ServerErrorReason[] = [];
  const server = createServer({ onError: (_e, info) => reported.push(info.reason), ...options });
  server.addInterface(A, { Ping: () => ({}) });
  server.addInterface(B, { Ping: () => ({}) });
  return { server, reported };
}

describe("serve(listener, {registry})", () => {
  test("true: every registered interface except org.varlink.service and the InternalError interface", async () => {
    const { server } = makeServer();
    const l = new BindableListener();
    await server.serve(l, { registry: true });
    assert.deepEqual(l.calls, [{ interfaces: ["org.example.a", "org.example.b"], options: {} }]);
    await server.shutdown();
  });

  test("a list, and the object form with directory and scope", async () => {
    const { server } = makeServer();
    const l1 = new BindableListener();
    const l2 = new BindableListener();
    const l3 = new BindableListener();
    await server.serve(l1, { registry: ["org.example.b"] });
    await server.serve(l2, { registry: { interfaces: ["org.example.a"], directory: "/tmp/r", scope: "user" } });
    await server.serve(l3, { registry: { directory: "/tmp/r" } });
    assert.deepEqual(l1.calls[0], { interfaces: ["org.example.b"], options: {} });
    assert.deepEqual(l2.calls[0], { interfaces: ["org.example.a"], options: { directory: "/tmp/r", scope: "user" } });
    assert.deepEqual(l3.calls[0]?.interfaces, ["org.example.a", "org.example.b"]);
    await server.shutdown();
  });

  test("invalid requests throw synchronously and leave the listener untouched", async () => {
    const { server } = makeServer();
    const l = new BindableListener();
    const bad: unknown[] = [
      ["org.example.nope"],
      ["org.varlink.service"],
      ["io.github.pzmarzly.varlinkjs"],
      ["org.example.a", "org.example.a"],
      [1],
      "org.example.a",
      false,
      { interfaces: "all" },
      { directory: "" },
      { directory: 5 },
      { scope: "global" },
    ];
    for (const registry of bad)
      assert.throws(() => server.serve(l, { registry } as never), TypeError, JSON.stringify(registry));
    assert.throws(() => server.serve(l, null as never), TypeError);
    assert.deepEqual(l.events, []);
    // Still servable afterwards: nothing was iterated.
    server.serve(l);
    const c = createConnection(l.dial());
    assert.deepEqual(await c.call("org.example.a.Ping"), {});
    await server.shutdown();
  });

  test("a listener without bindRegistry: OperationNotSupportedError, synchronously, listener untouched", async () => {
    const { server } = makeServer();
    const l = new MemoryListener();
    assert.throws(() => server.serve(l, { registry: true }), OperationNotSupportedError);
    assert.equal(l.closeCalls, 0);
    server.serve(l); // not being iterated
    await server.shutdown();
  });

  test("without registry the promise is already resolved; with it, it waits for the binding", async () => {
    const { server } = makeServer();
    assert.equal(await isPending(server.serve(new MemoryListener(), {})), false);
    const l = new BindableListener();
    let release: () => void = () => undefined;
    const inner = l.bindResult;
    l.bindResult = () =>
      new Promise((resolve) => {
        release = () => {
          resolve(inner());
        };
      });
    const served = server.serve(l, { registry: true });
    // Accepting already runs while binding.
    const c = createConnection(l.dial());
    assert.deepEqual(await c.call("org.example.a.Ping"), {});
    assert.equal(await isPending(served), true);
    release();
    await served;
    await server.shutdown();
  });

  test("binding fails: serve() rejects, the listener is closed and no longer served (all or nothing)", async () => {
    const { server, reported } = makeServer();
    const l = new BindableListener();
    const failure = Object.assign(new Error("registry entry in use"), { code: "EEXIST" });
    l.bindResult = () => Promise.reject(failure);
    await assert.rejects(server.serve(l, { registry: true }), (e) => e === failure);
    assert.deepEqual(l.events, ["bind", "close"]);
    // A closed MemoryListener closes new channels: the call fails.
    const c = createConnection(l.dial());
    await assert.rejects(c.call("org.example.a.Ping"));
    await server.shutdown();
    assert.deepEqual(l.events, ["bind", "close"], "nothing left to unbind or close");
    assert.deepEqual(reported, []);
  });

  test("a synchronous throw from bindRegistry is a rejection too", async () => {
    const { server } = makeServer();
    const l = new BindableListener();
    l.bindResult = () => {
      throw new Error("sync");
    };
    await assert.rejects(server.serve(l, { registry: true }), /sync/);
    assert.equal(l.closeCalls, 1);
    await server.shutdown();
  });

  test("shutdown() unbinds before it closes the listener", async () => {
    const { server } = makeServer();
    const l = new BindableListener();
    await server.serve(l, { registry: true });
    await server.shutdown();
    assert.deepEqual(l.events, ["bind", "unbind", "close"]);
  });

  test("shutdown while binding: waits for it, then unbinds and closes", async () => {
    const { server } = makeServer();
    const l = new BindableListener();
    let release: () => void = () => undefined;
    const inner = l.bindResult;
    l.bindResult = () =>
      new Promise((resolve) => {
        release = () => {
          resolve(inner());
        };
      });
    const served = server.serve(l, { registry: true });
    const stopped = server.shutdown();
    await settle();
    assert.equal(await isPending(stopped), true);
    release();
    await served;
    await stopped;
    assert.deepEqual(l.events, ["bind", "unbind", "close"]);
  });

  test("the accept loop ending by itself unbinds", async () => {
    const { server } = makeServer();
    const l = new BindableListener();
    await server.serve(l, { registry: true });
    await l.close(); // not through the server
    await settle();
    assert.deepEqual(l.events, ["bind", "close", "unbind"]);
    await server.shutdown();
    assert.deepEqual(l.events, ["bind", "close", "unbind"], "unbound once");
  });

  test("unbind failures go to onError as registry-failed; shutdown completes", async () => {
    const { server, reported } = makeServer();
    const l = new BindableListener();
    l.unbindError = new Error("EACCES");
    await server.serve(l, { registry: true });
    await server.shutdown();
    assert.deepEqual(reported, ["registry-failed"]);
    assert.deepEqual(l.events, ["bind", "unbind", "close"]);
  });

  test("an exit-on-idle shutdown unbinds the same way", async () => {
    const { server } = makeServer({ exitOnIdle: 0 });
    const l = new BindableListener();
    await server.serve(l, { registry: true });
    await server.closed;
    assert.deepEqual(l.events, ["bind", "unbind", "close"]);
  });

  test("after shutdown: the listener is closed, nothing is bound", async () => {
    const { server } = makeServer();
    await server.shutdown();
    const l = new BindableListener();
    await server.serve(l, { registry: true });
    assert.deepEqual(l.events, ["close"]);
  });
});
