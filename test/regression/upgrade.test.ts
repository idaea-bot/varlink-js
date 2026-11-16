// Protocol upgrade end to end (DESIGN.md §5.6, M9) over every transport in harness.ts (pair, unix, tcp): a real
// Server with ctx.upgrade() handlers and a Connection's upgrade(), or a raw byte-level peer on either side.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  CallTimeoutError,
  ConnectionClosedError,
  PermissionDeniedError,
  UpgradePendingError,
  type ByteChannel,
  type CallContext,
} from "../../src/index.ts";
import { PassThrough } from "node:stream";
import { connect, fromNodeStreams, listen } from "../../src/node/index.ts";
import { createServer, type Server, type ServerErrorReason } from "../../src/rpc/index.ts";
import {
  rawPeerOf,
  tcpTransport,
  transports,
  unixTransport,
  waitFor,
  type Endpoint,
  type RawPeer,
  type Transport,
} from "./harness.ts";

const IDL = `interface org.example.upgrade

# Upper-cases every byte it reads and writes it back; ends its side at the client's EOF.
# [Requires 'upgrade' flag]
method Upper() -> (ready: bool)

# Writes "server says bye" and ends its side at once, then reads until the client's EOF and writes nothing more.
# [Requires 'upgrade' flag]
method EndFirst() -> ()

# Reads exactly 5 bytes (the client's early data), replies "got:" + them on the channel, then ends.
# [Requires 'upgrade' flag]
method Early() -> ()

# fail: an error reply instead; unclaimed: return without ctx.upgrade(); wait: wait for the test's gate first.
# [Supports 'upgrade' flag]
method Maybe(fail: ?bool, unclaimed: ?bool, wait: ?bool) -> (hello: ?string)

method Ping(n: ?int) -> (n: ?int)

# Ignores its signal: answers only when the test opens its gate (holds a graceful shutdown until the deadline).
method Stubborn() -> ()

# Waits for the test's late gate before ctx.upgrade(), then reads to EOF, writes "got:" + it, and ends.
# [Requires 'upgrade' flag]
method Late() -> ()

# Reads up to the first newline, writes that line back and closes, the rest unread (like \`head -n1\`).
# [Requires 'upgrade' flag]
method Head() -> ()
`;
const I = "org.example.upgrade";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const wire = (v: unknown): Uint8Array => encoder.encode(`${JSON.stringify(v)}\0`);
const T = { timeout: 60_000 };

function upper(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    out[i] = b >= 0x61 && b <= 0x7a ? b - 0x20 : b;
  }
  return out;
}

/** Every byte until EOF. */
async function readToEof(channel: ByteChannel): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (let c = await channel.read(); c !== null; c = await channel.read()) chunks.push(c.bytes);
  return join(chunks);
}

/** At least `n` bytes (fewer only at EOF). */
async function readAtLeast(channel: ByteChannel, n: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let have = 0;
  while (have < n) {
    const c = await channel.read();
    if (c === null) break;
    chunks.push(c.bytes);
    have += c.bytes.length;
  }
  return join(chunks);
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** `total` bytes of a lower-case pattern, written in `size` chunks (each write awaited: backpressure). */
async function writePattern(channel: ByteChannel, total: number, size = 64 * 1024): Promise<void> {
  const chunk = new Uint8Array(size);
  for (let i = 0; i < size; i++) chunk[i] = 0x61 + (i % 26);
  for (let sent = 0; sent < total; sent += size) await channel.write(chunk.subarray(0, Math.min(size, total - sent)));
}

interface Fixture {
  server: Server;
  reported: { error: unknown; reason: ServerErrorReason; method?: string | undefined }[];
  /** Maybe({wait}) handlers wait for this. */
  gate: { open: () => void; wait: Promise<void> };
  /** Channels handed to handlers, in order. */
  channels: ByteChannel[];
  /** Maybe({wait}) calls that reached their handler. */
  waiting: number;
  /** Stubborn handlers wait for this (and ignore their signal). */
  stubborn: { open: () => void; wait: Promise<void> };
  /** Stubborn calls that reached their handler. */
  stubborns: number;
  /** Late handlers wait for this before ctx.upgrade(). */
  late: { open: () => void; wait: Promise<void> };
  /** Late calls that reached their handler. */
  lates: number;
}

function newGate(): Fixture["gate"] {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

function makeServer(): Fixture {
  const reported: Fixture["reported"] = [];
  const channels: ByteChannel[] = [];
  const fixture: Fixture = {
    server: createServer({ onError: (error, info) => reported.push({ error, ...info }) }),
    reported,
    gate: newGate(),
    channels,
    waiting: 0,
    stubborn: newGate(),
    stubborns: 0,
    late: newGate(),
    lates: 0,
  };
  fixture.server.addInterface(IDL, {
    Upper: async (_p, ctx: CallContext) => {
      const ch = await ctx.upgrade({ ready: true });
      channels.push(ch);
      for (let c = await ch.read(); c !== null; c = await ch.read()) await ch.write(upper(c.bytes));
      await ch.end();
    },
    EndFirst: async (_p, ctx: CallContext) => {
      const ch = await ctx.upgrade();
      channels.push(ch);
      await ch.write(encoder.encode("server says bye"));
      await ch.end();
      const got = await readToEof(ch);
      // What the client wrote after our end() still arrived.
      if (decoder.decode(got) !== "client keeps talking") throw new Error(`EndFirst got ${decoder.decode(got)}`);
    },
    Early: async (_p, ctx: CallContext) => {
      const ch = await ctx.upgrade();
      channels.push(ch);
      const early = await readAtLeast(ch, 5);
      await ch.write(join([encoder.encode("got:"), early]));
      await ch.end();
    },
    Maybe: async (
      p: { fail?: boolean | null; unclaimed?: boolean | null; wait?: boolean | null },
      ctx: CallContext,
    ) => {
      if (p.wait === true) {
        fixture.waiting++;
        await fixture.gate.wait;
      }
      if (p.fail === true) throw new PermissionDeniedError();
      if (p.unclaimed === true || !ctx.upgradeRequested) return { hello: "plain" };
      const ch = await ctx.upgrade({ hello: "upgraded" });
      channels.push(ch);
      for (let c = await ch.read(); c !== null; c = await ch.read()) await ch.write(c.bytes);
      await ch.end();
      return undefined;
    },
    Ping: (p: { n?: number | null }) => ({ n: p.n ?? null }),
    Stubborn: async () => {
      fixture.stubborns++;
      await fixture.stubborn.wait;
      return {};
    },
    Late: async (_p, ctx: CallContext) => {
      fixture.lates++;
      await fixture.late.wait;
      const ch = await ctx.upgrade();
      channels.push(ch);
      const got = await readToEof(ch);
      await ch.write(join([encoder.encode("got:"), got]));
      await ch.end();
    },
    Head: async (_p, ctx: CallContext) => {
      const ch = await ctx.upgrade();
      const line: Uint8Array[] = [];
      for (let c = await ch.read(); c !== null; c = await ch.read()) {
        const nl = c.bytes.indexOf(0x0a);
        line.push(nl < 0 ? c.bytes : c.bytes.subarray(0, nl + 1));
        if (nl >= 0) break;
      }
      await ch.write(join(line));
      ch.close();
      await ch.closed;
    },
  });
  return fixture;
}

for (const transport of transports) {
  describe(`upgrade over ${transport.name}`, () => {
    let f: Fixture;
    let ep: Endpoint;
    before(async () => {
      f = makeServer();
      ep = await transport.start(f.server);
    });
    after(async () => {
      await ep.close();
      await f.server.shutdown({ graceful: false });
    });

    test("bytes go through both ways; the client's EOF ends the service's side; nothing reported", T, async () => {
      const conn = await ep.connect();
      const { parameters, channel } = await conn.upgrade(`${I}.Upper`);
      assert.deepEqual(parameters, { ready: true });
      assert.equal(conn.isClosed, true);
      await channel.write(encoder.encode("hello, "));
      assert.equal(decoder.decode(await readAtLeast(channel, 7)), "HELLO, ");
      await channel.write(encoder.encode("world"));
      await channel.end();
      assert.equal(decoder.decode(await readToEof(channel)), "WORLD");
      channel.close();
      await channel.closed;
      await waitFor(() => f.server.connections === 0);
      assert.deepEqual(
        f.reported.filter((r) => r.reason !== "transport-error"),
        [],
      );
    });

    test("8 MiB each way at once, with backpressure, arrive intact and in order", T, async () => {
      const conn = await ep.connect();
      const { channel } = await conn.upgrade(`${I}.Upper`);
      const total = 8 * 1024 * 1024;
      const writing = writePattern(channel, total).then(() => channel.end());
      const got = await readToEof(channel);
      await writing;
      assert.equal(got.length, total);
      const expected = new Uint8Array(64 * 1024);
      for (let i = 0; i < expected.length; i++) expected[i] = 0x41 + (i % 26);
      for (let at = 0; at < total; at += expected.length)
        assert.deepEqual(got.subarray(at, at + expected.length), expected, `at ${String(at)}`);
      channel.close();
    });

    test("half-close by the service first: the client reads its EOF and can still write", T, async () => {
      const conn = await ep.connect();
      const { channel } = await conn.upgrade(`${I}.EndFirst`);
      assert.equal(decoder.decode(await readToEof(channel)), "server says bye");
      await channel.write(encoder.encode("client keeps talking"));
      await channel.end();
      await channel.closed;
      await waitFor(() => f.server.connections === 0);
      assert.deepEqual(
        f.reported.filter((r) => r.method === `${I}.EndFirst`),
        [],
      );
    });

    // M9 VM interop (`yes | call --upgrade` against a head -n1 service): the client's writes fail once the service
    // closed; the line it sent before closing must still be read (Node's socket used to destroy itself and drop it).
    test(
      "the service answers one line and closes while the client keeps writing: the answer is read",
      {
        ...T,
        skip:
          process.versions.bun !== undefined && transport.name !== "pair"
            ? "Bun: its net.Socket drops received bytes once a write fails (test/unit/node/socket.test.ts)"
            : false,
      },
      async () => {
        const conn = await ep.connect();
        const { channel } = await conn.upgrade(`${I}.Head`);
        let failure: unknown;
        const writing = (async () => {
          const chunk = encoder.encode("y\n".repeat(32768));
          for (let i = 0; i < 10_000 && failure === undefined; i++)
            await channel.write(chunk).catch((e: unknown) => (failure = e));
        })();
        const chunks: Uint8Array[] = [];
        try {
          for (let c = await channel.read(); c !== null; c = await channel.read()) chunks.push(c.bytes);
        } catch {
          // A reset after the answer (tcp) is fine; the answer is what counts.
        }
        await writing;
        assert.equal(decoder.decode(join(chunks)), "y\n");
        assert.notEqual(failure, undefined, "a write failed once the service was gone");
        channel.close();
        await channel.closed;
      },
    );

    test("early data: bytes the client sends right after its call reach the handler first", T, async () => {
      const raw = await ep.raw();
      await raw.write(join([wire({ method: `${I}.Early`, upgrade: true }), encoder.encode("abcde")]));
      assert.deepEqual(JSON.parse((await raw.readMessage()) ?? "null"), { parameters: {} });
      assert.equal(await raw.readMessage(), null); // EOF: the handler ended its side
      assert.ok(decoder.decode(raw.received()).endsWith("\0got:abcde"));
      raw.close();
    });

    test("early data in a separate write, before the reply, also reaches the handler", T, async () => {
      const raw = await ep.raw();
      await raw.write(wire({ method: `${I}.Early`, upgrade: true }));
      await raw.write(encoder.encode("ab"));
      await raw.write(encoder.encode("cde"));
      assert.deepEqual(JSON.parse((await raw.readMessage()) ?? "null"), { parameters: {} });
      assert.equal(await raw.readMessage(), null);
      assert.ok(decoder.decode(raw.received()).endsWith("\0got:abcde"));
      raw.close();
    });

    test("an error reply rejects; the connection stays usable for a normal call and another upgrade", T, async () => {
      const conn = await ep.connect();
      await assert.rejects(conn.upgrade(`${I}.Maybe`, { fail: true }), PermissionDeniedError);
      assert.equal(conn.isClosed, false);
      assert.deepEqual(await conn.call(`${I}.Ping`, { n: 7 }), { n: 7 });
      const { parameters, channel } = await conn.upgrade(`${I}.Maybe`, {});
      assert.deepEqual(parameters, { hello: "upgraded" });
      await channel.write(encoder.encode("echo"));
      await channel.end();
      assert.equal(decoder.decode(await readToEof(channel)), "echo");
      channel.close();
    });

    test(
      "calls made while the upgrade is pending reject with UpgradePendingError; earlier calls are answered",
      T,
      async () => {
        f.gate = newGate();
        const conn = await ep.connect();
        const before = conn.call(`${I}.Ping`, { n: 1 });
        const upgrading = conn.upgrade(`${I}.Maybe`, { wait: true });
        const during = conn.call(`${I}.Ping`, { n: 2 });
        await assert.rejects(during, UpgradePendingError);
        assert.deepEqual(await before, { n: 1 });
        f.gate.open();
        const { channel } = await upgrading;
        await assert.rejects(conn.call(`${I}.Ping`), (e: unknown) => e instanceof ConnectionClosedError);
        await channel.end();
        assert.equal((await readToEof(channel)).length, 0);
        channel.close();
      },
    );

    test("a timeout of a pending upgrade closes the connection", T, async () => {
      f.gate = newGate();
      const conn = await ep.connect();
      await assert.rejects(conn.upgrade(`${I}.Maybe`, { wait: true }, { timeout: 30 }), CallTimeoutError);
      assert.equal(conn.isClosed, true);
      assert.ok(conn.closeReason instanceof CallTimeoutError);
      f.gate.open();
      await conn.closed;
    });

    test("an abort of a pending upgrade closes the connection and rejects with the reason", T, async () => {
      f.gate = newGate();
      const conn = await ep.connect();
      const controller = new AbortController();
      const waiting = f.waiting;
      const upgrading = conn.upgrade(`${I}.Maybe`, { wait: true }, { signal: controller.signal });
      // Written and being handled: an abort now cannot just drop it.
      await waitFor(() => f.waiting > waiting);
      const reason = new Error("not interested");
      controller.abort(reason);
      await assert.rejects(upgrading, (e: unknown) => e === reason);
      assert.equal(conn.isClosed, true);
      f.gate.open();
    });

    test("unclaimed: the return value confirms, then the server closes and reports upgrade-unclaimed", T, async () => {
      const conn = await ep.connect();
      const { parameters, channel } = await conn.upgrade(`${I}.Maybe`, { unclaimed: true });
      assert.deepEqual(parameters, { hello: "plain" });
      assert.equal((await readToEof(channel).catch(() => new Uint8Array(0))).length, 0);
      await waitFor(() => f.reported.some((r) => r.reason === "upgrade-unclaimed"));
      channel.close();
    });

    test("conn.close() after the upgrade leaves the channel working", T, async () => {
      const conn = await ep.connect();
      const { channel } = await conn.upgrade(`${I}.Upper`);
      await conn.close();
      await conn.closed;
      await channel.write(encoder.encode("still here"));
      assert.equal(decoder.decode(await readAtLeast(channel, 10)), "STILL HERE");
      await channel.end();
      assert.equal((await readToEof(channel)).length, 0);
      channel.close();
    });

    test(
      "Q4 on the wire: the upgrade flag on a plain method gets a plain reply, then the next call is answered",
      T,
      async () => {
        const raw = await ep.raw();
        await raw.write(
          join([
            wire({ method: `${I}.Ping`, parameters: { n: 1 }, upgrade: true }),
            wire({ method: `${I}.Ping`, parameters: { n: 2 } }),
          ]),
        );
        assert.deepEqual(JSON.parse((await raw.readMessage()) ?? "null"), { parameters: { n: 1 } });
        assert.deepEqual(JSON.parse((await raw.readMessage()) ?? "null"), { parameters: { n: 2 } });
        raw.close();
      },
    );

    test("L4a: an error reply to an upgrade call, then a plain call pipelined in the same chunk", T, async () => {
      const raw = await ep.raw();
      await raw.write(
        join([
          wire({ method: `${I}.Maybe`, parameters: { fail: true }, upgrade: true }),
          wire({ method: `${I}.Ping`, parameters: { n: 3 } }),
        ]),
      );
      assert.deepEqual(JSON.parse((await raw.readMessage()) ?? "null"), {
        error: "org.varlink.service.PermissionDenied",
        parameters: {},
      });
      assert.deepEqual(JSON.parse((await raw.readMessage()) ?? "null"), { parameters: { n: 3 } });
      // Still a varlink connection: our EOF ends it cleanly.
      await raw.end();
      assert.equal(await raw.readMessage(), null);
      raw.close();
    });

    test(
      "L4b: call + early data + half-close before the handler's ctx.upgrade(): the channel yields the data, then EOF",
      { timeout: 15_000 },
      async () => {
        f.late = newGate();
        const lates = f.lates;
        const raw = await ep.raw();
        await raw.write(join([wire({ method: `${I}.Late`, upgrade: true }), encoder.encode("early")]));
        await raw.end();
        await waitFor(() => f.lates > lates);
        // Let the server read on (the data and the EOF) while the handler has not upgraded yet.
        await new Promise((resolve) => setTimeout(resolve, 50));
        f.late.open();
        assert.deepEqual(JSON.parse((await raw.readMessage()) ?? "null"), { parameters: {} });
        assert.equal(await raw.readMessage(), null); // the handler saw our EOF, answered and ended its side
        assert.ok(decoder.decode(raw.received()).endsWith("\0got:early"));
        raw.close();
      },
    );

    test(
      "L4b: call, then (handler running, reading paused) half-close: the channel yields EOF at once",
      { timeout: 15_000 },
      async () => {
        f.late = newGate();
        const lates = f.lates;
        const raw = await ep.raw();
        await raw.write(wire({ method: `${I}.Late`, upgrade: true }));
        await waitFor(() => f.lates > lates);
        await raw.end();
        // The server's read-ahead takes the EOF while the handler has not upgraded yet.
        await new Promise((resolve) => setTimeout(resolve, 50));
        f.late.open();
        assert.deepEqual(JSON.parse((await raw.readMessage()) ?? "null"), { parameters: {} });
        assert.equal(await raw.readMessage(), null);
        assert.ok(decoder.decode(raw.received()).endsWith("\0got:"));
        raw.close();
      },
    );

    test(
      "L4d: a read in flight at hand-over (nothing sent before ctx.upgrade()): its bytes reach the channel",
      { timeout: 15_000 },
      async () => {
        f.late = newGate();
        const lates = f.lates;
        const raw = await ep.raw();
        await raw.write(wire({ method: `${I}.Late`, upgrade: true }));
        await waitFor(() => f.lates > lates);
        await new Promise((resolve) => setTimeout(resolve, 20));
        // The server's read-ahead is pending now; the hand-over passes it to the upgraded channel.
        f.late.open();
        assert.deepEqual(JSON.parse((await raw.readMessage()) ?? "null"), { parameters: {} });
        await raw.write(encoder.encode("into the pending read"));
        await raw.end();
        assert.equal(await raw.readMessage(), null);
        assert.ok(decoder.decode(raw.received()).endsWith("\0got:into the pending read"));
        raw.close();
      },
    );

    test(
      "L4d: data arriving after the handler started but before ctx.upgrade() (settles the read-ahead first)",
      { timeout: 15_000 },
      async () => {
        f.late = newGate();
        const lates = f.lates;
        const raw = await ep.raw();
        await raw.write(wire({ method: `${I}.Late`, upgrade: true }));
        await waitFor(() => f.lates > lates);
        // The server reads on while the handler runs: these bytes land in that read (or the next one).
        await new Promise((resolve) => setTimeout(resolve, 20));
        await raw.write(encoder.encode("in-"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        await raw.write(encoder.encode("flight"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        f.late.open();
        assert.deepEqual(JSON.parse((await raw.readMessage()) ?? "null"), { parameters: {} });
        // After the hand-over, more bytes; then our EOF.
        await raw.write(encoder.encode("+after"));
        await raw.end();
        assert.equal(await raw.readMessage(), null);
        assert.ok(decoder.decode(raw.received()).endsWith("\0got:in-flight+after"), decoder.decode(raw.received()));
        raw.close();
      },
    );
  });

  describe(`upgrade and shutdown over ${transport.name}`, () => {
    test(
      "a graceful shutdown neither waits for nor closes an upgraded connection; graceful: false closes it",
      T,
      async () => {
        const f = makeServer();
        const ep = await transport.start(f.server);
        try {
          const conn = await ep.connect();
          const { channel } = await conn.upgrade(`${I}.Upper`);
          await channel.write(encoder.encode("a"));
          assert.equal(decoder.decode(await readAtLeast(channel, 1)), "A");
          // M3: a second, plain connection whose handler ignores its signal holds the shutdown until the deadline,
          // so the deadline really fires (and must force-close that one, not the upgraded one).
          const plain = await ep.connect();
          const stubborn = plain.call(`${I}.Stubborn`);
          const stubbornOutcome = stubborn.then(
            () => "answered",
            (e: unknown) => e,
          );
          await waitFor(() => f.stubborns === 1);
          const started = Date.now();
          await f.server.shutdown({ graceful: true, timeout: 50 });
          await f.server.closed;
          assert.ok(Date.now() - started >= 45, "the shutdown waited for the deadline");
          // The plain connection was force-closed at the deadline: its call failed, the connection is gone.
          const outcome = await stubbornOutcome;
          assert.ok(outcome instanceof ConnectionClosedError, `the stubborn call: ${String(outcome)}`);
          await plain.closed;
          // The upgraded connection, past the deadline too: still served by its handler.
          await new Promise((resolve) => setTimeout(resolve, 100));
          await channel.write(encoder.encode("b"));
          assert.equal(decoder.decode(await readAtLeast(channel, 1)), "B");
          assert.equal(f.server.connections, 1);
          f.stubborn.open();
          // A second server whose hard shutdown destroys its upgraded channel.
          const g = makeServer();
          const ep2 = await transport.start(g.server);
          try {
            const conn2 = await ep2.connect();
            const up = await conn2.upgrade(`${I}.Upper`);
            await g.server.shutdown({ graceful: false });
            assert.equal(g.server.connections, 0);
            // The service side is gone: EOF or an error, never more data.
            const end = await readToEof(up.channel).catch(() => new Uint8Array(0));
            assert.equal(end.length, 0);
            up.channel.close();
          } finally {
            await ep2.close();
          }
          await channel.end();
          await readToEof(channel);
          channel.close();
        } finally {
          await ep.close();
        }
      },
    );
  });
}

/**
 * A raw service on a real socket that answers the first call with the confirming reply and the first upgraded bytes
 * in ONE write, then echoes. Exercises the client's remainder path (bytes after the reply's NUL in the same chunk).
 */
function rawUpgradeService(transport: Transport): void {
  test(`client remainder over ${transport.name}: reply and first raw bytes in one write`, T, async () => {
    const dir = await mkdtemp(joinPath(tmpdir(), "vj-up-"));
    const address = transport === unixTransport ? `unix:${joinPath(dir, "s")}` : "tcp:127.0.0.1:0";
    const listener = await listen(address);
    const served = (async () => {
      for await (const ch of listener) {
        const call = await readAtLeastNul(ch);
        assert.ok(call.includes('"upgrade":true'));
        await ch.write(join([wire({ parameters: { x: 1 } }), encoder.encode("RAW-FIRST")]));
        for (let c = await ch.read(); c !== null; c = await ch.read()) await ch.write(c.bytes);
        await ch.end();
        ch.close();
        return;
      }
    })();
    try {
      const conn = await connect(listener.address);
      const { parameters, channel } = await conn.upgrade("org.example.raw.Up");
      assert.deepEqual(parameters, { x: 1 });
      assert.equal(decoder.decode(await readAtLeast(channel, 9)), "RAW-FIRST");
      await channel.write(encoder.encode("ping"));
      await channel.end();
      assert.equal(decoder.decode(await readToEof(channel)), "ping");
      channel.close();
      await served;
    } finally {
      await listener.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

async function readAtLeastNul(channel: ByteChannel): Promise<string> {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const c = await channel.read();
    if (c === null) throw new Error("EOF before the call");
    chunks.push(c.bytes);
    if (c.bytes.includes(0)) return decoder.decode(join(chunks));
  }
}

// L4b over the Node-streams channel (fromNodeStreams: what spawn-based stdio/ssh transports and a server on its own
// stdin/stdout use): the server's channel reads one PassThrough and writes another; the raw client the reverse.
describe("upgrade over a Node-streams channel (spawn/stdio)", () => {
  async function streamsPeer(f: Fixture): Promise<RawPeer> {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    void f.server.handle(fromNodeStreams(toServer, toClient));
    const client = fromNodeStreams(toClient, toServer);
    return Promise.resolve(
      rawPeerOf(client, () => {
        client.close();
      }),
    );
  }

  for (const early of ["", "early"])
    test(
      `L4b: call${early === "" ? "" : " + early data"}, half-close before ctx.upgrade(): data${early === "" ? " (none)" : ""} then EOF`,
      { timeout: 15_000 },
      async () => {
        const f = makeServer();
        try {
          const raw = await streamsPeer(f);
          await raw.write(join([wire({ method: `${I}.Late`, upgrade: true }), encoder.encode(early)]));
          await waitFor(() => f.lates === 1);
          await raw.end();
          await new Promise((resolve) => setTimeout(resolve, 50));
          f.late.open();
          assert.deepEqual(JSON.parse((await raw.readMessage()) ?? "null"), { parameters: {} });
          assert.equal(await raw.readMessage(), null);
          assert.ok(decoder.decode(raw.received()).endsWith(`\0got:${early}`));
          raw.close();
        } finally {
          await f.server.shutdown({ graceful: false });
        }
      },
    );

  test("L4d: a read in flight at hand-over: its bytes reach the channel", { timeout: 15_000 }, async () => {
    const f = makeServer();
    try {
      const raw = await streamsPeer(f);
      await raw.write(wire({ method: `${I}.Late`, upgrade: true }));
      await waitFor(() => f.lates === 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      f.late.open();
      assert.deepEqual(JSON.parse((await raw.readMessage()) ?? "null"), { parameters: {} });
      await raw.write(encoder.encode("late bytes"));
      await raw.end();
      assert.equal(await raw.readMessage(), null);
      assert.ok(decoder.decode(raw.received()).endsWith("\0got:late bytes"));
      raw.close();
    } finally {
      await f.server.shutdown({ graceful: false });
    }
  });
});

describe("client remainder path over real sockets", () => {
  rawUpgradeService(unixTransport);
  rawUpgradeService(tcpTransport);
});
