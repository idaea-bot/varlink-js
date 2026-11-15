// Protocol upgrade in the RPC layer (DESIGN.md §5.6, M9) over pair(): the client's remainder path, typed clients,
// proxies and pools, backpressure on the upgraded channel, exit-on-idle, and the upgraded channel wrapper itself.
// The transport matrix (pair, unix, tcp) is in test/regression/upgrade.test.ts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ConnectionClosedError,
  OperationNotSupportedError,
  UpgradePendingError,
  ValidationError,
  type ByteChannel,
  type CallContext,
  type InterfaceDescriptor,
  type MethodDescriptor,
} from "../../../src/index.ts";
import {
  createClient,
  createConnection,
  createPool,
  createServer,
  freezeDescriptor,
  type Server,
  type ServerErrorReason,
} from "../../../src/rpc/index.ts";
import { UpgradedChannel } from "../../../src/rpc/upgrade.ts";
import { pair } from "../../../src/testing/index.ts";
import { concat, connectRaw, isPending, MemoryListener, msg, settle, utf8 } from "./helpers.ts";

const T = { timeout: 30_000 };
const decoder = new TextDecoder();

const IDL = `interface org.example.up

# [Requires 'upgrade' flag]
method Cat() -> (ready: bool)

# [Requires 'upgrade' flag]
method Sink() -> ()

method Ping() -> ()
`;
const I = "org.example.up";

type Empty = Record<string, never>;
const Cat: MethodDescriptor<Empty, { ready: boolean }> = {
  interface: I,
  name: "Cat",
  method: `${I}.Cat`,
  upgrade: "requires",
};
const Sink: MethodDescriptor<Empty, Empty> = { interface: I, name: "Sink", method: `${I}.Sink`, upgrade: "requires" };
const Ping: MethodDescriptor<Empty, Empty> = { interface: I, name: "Ping", method: `${I}.Ping` };
const UP = freezeDescriptor({
  name: I,
  idl: IDL,
  ints: "number",
  methods: { Cat, Sink, Ping },
  errors: {},
} satisfies InterfaceDescriptor);

async function readToEof(channel: ByteChannel): Promise<string> {
  let out = "";
  for (let c = await channel.read(); c !== null; c = await channel.read()) out += decoder.decode(c.bytes);
  return out;
}

async function readAtLeast(channel: ByteChannel, n: number): Promise<string> {
  let out = "";
  while (out.length < n) {
    const c = await channel.read();
    if (c === null) break;
    out += decoder.decode(c.bytes);
  }
  return out;
}

interface Fixture {
  server: Server;
  reported: ServerErrorReason[];
  /** The server ends of Sink upgrades (never read). */
  sinks: ByteChannel[];
}

function makeServer(options: { exitOnIdle?: number } = {}): Fixture {
  const reported: ServerErrorReason[] = [];
  const sinks: ByteChannel[] = [];
  const server = createServer({ ...options, onError: (_e, info) => reported.push(info.reason) });
  server.implement(UP, {
    Cat: async (_p, ctx: CallContext) => {
      const ch = await ctx.upgrade({ ready: true });
      for (let c = await ch.read(); c !== null; c = await ch.read()) await ch.write(c.bytes);
      await ch.end();
    },
    Sink: async (_p, ctx: CallContext) => {
      sinks.push(await ctx.upgrade());
    },
    Ping: () => ({}),
  });
  return { server, reported, sinks };
}

function serveOnPair(server: Server, highWaterMark?: number): ByteChannel {
  const [client, end] = pair(highWaterMark === undefined ? {} : { highWaterMark });
  void server.handle(end);
  return client;
}

describe("client: the upgraded channel", () => {
  test("bytes after the confirming reply in the SAME chunk come first, then the transport's", T, async () => {
    const { conn, peer, reader } = connectRaw();
    const upgrading = conn.upgrade("org.example.raw.Up", { a: 1 });
    assert.deepEqual(await reader.next(), { method: "org.example.raw.Up", parameters: { a: 1 }, upgrade: true });
    // One write: the reply and the first upgraded bytes (pair() delivers it as one chunk).
    await peer.write(concat([msg({ parameters: { ok: true } }), utf8("FIRST\0not-json")]));
    const { parameters, channel } = await upgrading;
    assert.deepEqual(parameters, { ok: true });
    assert.equal(decoder.decode((await channel.read())?.bytes), "FIRST\0not-json");
    await peer.write(utf8("second"));
    assert.equal(decoder.decode((await channel.read())?.bytes), "second");
    // Client → service goes straight to the transport.
    await channel.write(utf8("from-client"));
    assert.equal(decoder.decode((await peer.read())?.bytes), "from-client");
    await peer.end();
    assert.equal(await channel.read(), null);
    channel.close();
  });

  test("the reply alone: nothing buffered, the first read waits for the transport", T, async () => {
    const { conn, peer, reader } = connectRaw();
    const upgrading = conn.upgrade("org.example.raw.Up");
    await reader.next();
    await peer.write(msg({ parameters: {} }));
    const { channel } = await upgrading;
    const first = channel.read();
    assert.equal(await isPending(first), true);
    await peer.write(utf8("x"));
    assert.equal(decoder.decode((await first)?.bytes), "x");
    channel.close();
  });

  test("after the upgrade: isClosed, closed resolves, calls reject, close() leaves the transport open", T, async () => {
    const { conn, peer, reader } = connectRaw();
    const upgrading = conn.upgrade("org.example.raw.Up");
    await reader.next();
    await peer.write(msg({ parameters: {} }));
    const { channel } = await upgrading;
    assert.equal(conn.isClosed, true);
    assert.equal(conn.closeReason, undefined);
    await conn.closed;
    await conn.close();
    await assert.rejects(conn.call("org.example.raw.Ping"), (e: unknown) => {
      assert.ok(e instanceof ConnectionClosedError);
      assert.match(e.message, /upgraded/);
      return true;
    });
    await channel.write(utf8("still open"));
    assert.equal(decoder.decode((await peer.read())?.bytes), "still open");
    channel.close();
    await channel.closed;
    assert.equal(await peer.read(), null);
  });

  test(
    "a call queued behind a pending upgrade rejects with UpgradePendingError, nothing written for it",
    T,
    async () => {
      const { conn, peer, reader } = connectRaw();
      const upgrading = conn.upgrade("org.example.raw.Up");
      const later = conn.call("org.example.raw.Ping");
      await assert.rejects(later, UpgradePendingError);
      await reader.next();
      await peer.write(msg({ parameters: {} }));
      const { channel } = await upgrading;
      channel.close();
      // Only the upgrade call reached the wire.
      assert.equal(decoder.decode(concat(reader.raw)).split("\0").filter(Boolean).length, 1);
    },
  );

  test("validateReplies 'throw' and an invalid confirming reply: rejects and releases the transport", T, async () => {
    const { conn, peer, reader } = connectRaw({ validateReplies: "throw", interfaces: [IDL] });
    const upgrading = conn.upgrade(`${I}.Cat`);
    await reader.next();
    await peer.write(msg({ parameters: { ready: "yes" } }));
    await assert.rejects(upgrading, ValidationError);
    assert.equal(await peer.read(), null);
  });
});

describe("typed client, proxy, pool", () => {
  test(
    "X.client(conn).Cat.upgrade() works; a method without the flag rejects with a TypeError, nothing sent",
    T,
    async () => {
      const f = makeServer();
      const conn = createConnection(serveOnPair(f.server));
      const client = createClient(UP, conn);
      await assert.rejects(
        client.Ping.upgrade(),
        (e: unknown) => e instanceof TypeError && /upgrade flag/.test(e.message),
      );
      await assert.rejects(conn.upgrade(Ping, {}), TypeError);
      assert.equal(conn.isClosed, false);
      assert.deepEqual(await client.Ping(), {});
      const { parameters, channel } = await client.Cat.upgrade();
      const ready: boolean = parameters.ready;
      assert.equal(ready, true);
      await channel.write(utf8("typed"));
      await channel.end();
      assert.equal(await readToEof(channel), "typed");
      channel.close();
      await f.server.shutdown({ graceful: false });
    },
  );

  test("conn.proxy(): .upgrade() on a method with the flag; TypeError on one without", T, async () => {
    const f = makeServer();
    const conn = createConnection(serveOnPair(f.server));
    const px = await conn.proxy(I);
    await assert.rejects(px.Ping?.upgrade() ?? Promise.resolve(), TypeError);
    const up = await px.Cat?.upgrade();
    assert.ok(up !== undefined);
    assert.deepEqual(up.parameters, { ready: true });
    await up.channel.write(utf8("proxied"));
    await up.channel.end();
    assert.equal(await readToEof(up.channel), "proxied");
    up.channel.close();
    await f.server.shutdown({ graceful: false });
  });

  test("a Pool has no upgrade: a typed client over one rejects with OperationNotSupportedError", T, async () => {
    const f = makeServer();
    const pool = createPool(() => Promise.resolve(createConnection(serveOnPair(f.server))));
    assert.equal((pool as unknown as Record<string, unknown>)["upgrade"], undefined);
    const client = createClient(UP, pool);
    await assert.rejects(client.Cat.upgrade(), OperationNotSupportedError);
    assert.deepEqual(await client.Ping(), {});
    await pool.close();
    await f.server.shutdown({ graceful: false });
  });
});

describe("server: the upgraded channel", () => {
  test(
    "backpressure: a handler that does not read makes the client's writes wait (no unbounded buffering)",
    T,
    async () => {
      const f = makeServer();
      const conn = createConnection(serveOnPair(f.server, 1024));
      const { channel } = await conn.upgrade(`${I}.Sink`);
      await settle();
      let written = 0;
      let stalled: Promise<void> | undefined;
      for (let i = 0; i < 64; i++) {
        const w = channel.write(new Uint8Array(1024));
        if (await isPending(w)) {
          stalled = w;
          break;
        }
        written += 1024;
      }
      assert.ok(stalled !== undefined, "a write waits once the peer's buffer is full");
      assert.ok(written <= 4096, `at most a few KiB were accepted (${String(written)})`);
      // The handler reads: the write completes.
      const sink = f.sinks[0];
      assert.ok(sink !== undefined);
      for (let got = 0; got < written + 1024;) got += (await sink.read())?.bytes.length ?? Infinity;
      await stalled;
      channel.close();
      sink.close();
      await f.server.shutdown({ graceful: false });
    },
  );

  test("the handler's channel: half-close from the client is an EOF on the server side", T, async () => {
    const f = makeServer();
    const conn = createConnection(serveOnPair(f.server));
    const { channel } = await conn.upgrade(`${I}.Sink`);
    await settle();
    const sink = f.sinks[0];
    assert.ok(sink !== undefined);
    await channel.write(utf8("bye"));
    await channel.end();
    assert.equal(await readToEof(sink), "bye");
    await sink.write(utf8("server still writes"));
    await sink.end();
    assert.equal(await readToEof(channel), "server still writes");
    await Promise.all([channel.closed, sink.closed]);
    assert.deepEqual(f.reported, []);
  });

  test("exit-on-idle counts an upgraded connection until its channel closes", T, async () => {
    const f = makeServer({ exitOnIdle: 0 });
    const listener = new MemoryListener();
    f.server.serve(listener);
    const conn = createConnection(listener.dial());
    const { channel } = await conn.upgrade(`${I}.Cat`);
    await settle(10);
    assert.equal(f.server.connections, 1);
    assert.equal(await isPending(f.server.closed), true, "the upgraded connection keeps the server up");
    await channel.write(utf8("x"));
    assert.equal(await readAtLeast(channel, 1), "x");
    await channel.end();
    assert.equal(await readToEof(channel), "");
    await f.server.closed;
    assert.equal(f.server.connections, 0);
  });
});

describe("UpgradedChannel", () => {
  test("head, then a pending read's outcome, then the transport; close() makes reads null", T, async () => {
    const [a, b] = pair();
    const pending = a.read();
    const ch = new UpgradedChannel(a, utf8("head"), { pending });
    await b.write(utf8("pending"));
    await b.write(utf8("later"));
    assert.equal(decoder.decode((await ch.read())?.bytes), "head");
    assert.equal(decoder.decode((await ch.read())?.bytes), "pending");
    assert.equal(decoder.decode((await ch.read())?.bytes), "later");
    ch.close();
    assert.equal(await ch.read(), null);
    await ch.closed;
  });

  test(
    "an end already read by the previous owner: head, then null; an error is reported once, then null",
    T,
    async () => {
      const [a] = pair();
      const eof = new UpgradedChannel(a, utf8("h"), { ended: {} });
      assert.equal(decoder.decode((await eof.read())?.bytes), "h");
      assert.equal(await eof.read(), null);
      const boom = new Error("reset");
      const failed = new UpgradedChannel(a, new Uint8Array(0), { ended: { error: boom } });
      await assert.rejects(failed.read(), (e: unknown) => e === boom);
      assert.equal(await failed.read(), null);
      a.close();
    },
  );

  test("writes, end() and capabilities are the transport's", T, async () => {
    const [a, b] = pair();
    const ch = new UpgradedChannel(a, new Uint8Array(0));
    assert.equal(ch.capabilities, a.capabilities);
    await ch.write(utf8("w"));
    assert.equal(decoder.decode((await b.read())?.bytes), "w");
    await ch.end();
    assert.equal(await b.read(), null);
    await assert.rejects(ch.write(utf8("after end")), ConnectionClosedError);
    b.close();
  });
});
