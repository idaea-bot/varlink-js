// Protocol upgrade in WebSocket mode (DESIGN.md §5.6, §4.12): a WebSocket-backed Connection upgrades like any other,
// through the bridge fixture relaying bytes.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type ByteChannel, type CallContext } from "../../../src/index.ts";
import { createServer, type Server } from "../../../src/rpc/index.ts";
import { pair } from "../../../src/testing/index.ts";
import { connect } from "../../../src/websocket/index.ts";
import { startBridge, type Bridge, type Framing } from "./bridge.ts";

const SERVICE = "org.example.wsup";
const IDL = `interface org.example.wsup

# [Requires 'upgrade' flag]
method Upper() -> ()

# Records what it reads until EOF, echoing each chunk upper-cased.
# [Requires 'upgrade' flag]
method Record() -> ()
`;

const recorded = { text: "", eof: false };
/** How Record writes its echo (a test may delay it to force the echo past the bridge's close). */
let recordEcho = (ch: ByteChannel, text: string): Promise<void> => ch.write(new TextEncoder().encode(text));
const T30 = { timeout: 30_000 };
let server: Server;
let bridge: Bridge;

before(async () => {
  server = createServer({ onError: () => undefined });
  server.addInterface(IDL, {
    Upper: async (_p, ctx: CallContext) => {
      const ch = await ctx.upgrade();
      // Answer the first bytes at once, before the client wrote anything: they may share a frame with the reply.
      await ch.write(new TextEncoder().encode("ready;"));
      for (let c = await ch.read(); c !== null; c = await ch.read())
        await ch.write(new TextEncoder().encode(new TextDecoder().decode(c.bytes).toUpperCase()));
      ch.close();
    },
    Record: async (_p, ctx: CallContext) => {
      const ch = await ctx.upgrade();
      try {
        for (;;) {
          const c = await ch.read();
          if (c === null) {
            // Noted from the read itself, whatever happened to the echoes.
            recorded.eof = true;
            break;
          }
          const text = new TextDecoder().decode(c.bytes);
          recorded.text += text;
          // The client's end() closes the whole WebSocket, and the bridge then closes this side: an echo may be
          // refused (ConnectionClosedError) and must not stop the reading.
          await recordEcho(ch, text.toUpperCase()).catch(() => undefined);
        }
      } finally {
        ch.close();
      }
    },
  });
  bridge = await startBridge({
    backend: () => {
      const [client, end] = pair();
      void server.handle(end);
      return Promise.resolve(client);
    },
    services: [SERVICE],
  });
});

after(async () => {
  await bridge.close();
  await server.shutdown({ graceful: false });
});

async function readAtLeast(channel: ByteChannel, n: number): Promise<string> {
  let out = "";
  while (out.length < n) {
    const c = await channel.read();
    if (c === null) break;
    out += new TextDecoder().decode(c.bytes);
  }
  return out;
}

describe("upgrade in WebSocket mode", () => {
  // Only a bridge that relays bytes can carry an upgraded stream: the fixture's "message" and "split" framings cut
  // the service's output at NULs, so raw bytes without one would never be sent (a bridge limit, not the client's).
  for (const framing of ["coalesce"] as const satisfies readonly Framing[]) {
    test(`framing "${framing}": the upgraded channel carries raw bytes both ways`, { timeout: 30_000 }, async () => {
      bridge.knobs.framing = framing;
      const conn = await connect(bridge.wsUrl(SERVICE));
      const { parameters, channel } = await conn.upgrade(`${SERVICE}.Upper`);
      assert.deepEqual(parameters, {});
      assert.equal(await readAtLeast(channel, 6), "ready;");
      await channel.write(new TextEncoder().encode("over websocket"));
      assert.equal(await readAtLeast(channel, 14), "OVER WEBSOCKET");
      channel.close();
      await channel.closed;
      bridge.reset();
    });
  }

  // WebSocket has no half-close: end() sends a Close frame (1000), i.e. closes the whole connection (DESIGN.md
  // §4.12, §4.14). The bytes written before end() reach the service, then the service sees EOF; what it writes
  // after that may be lost, and our reads end with null (never hang).
  // "late echo": the service's echo is written only after the bridge has closed the backend (the race the immediate
  // variant can hit by chance), so the echo write is refused; the service must still see everything, then EOF.
  for (const variant of ["immediate echo", "late echo"] as const)
    test(
      `end() after writing (${variant}): the bytes reach the service, then EOF; the reply path is closed too`,
      T30,
      async () => {
        recordEcho =
          variant === "immediate echo"
            ? (ch, text) => ch.write(new TextEncoder().encode(text))
            : async (ch, text) => {
                await new Promise((resolve) => setTimeout(resolve, 200));
                await ch.write(new TextEncoder().encode(text));
              };
        try {
          await endAfterWriting();
        } finally {
          recordEcho = (ch, text) => ch.write(new TextEncoder().encode(text));
        }
      },
    );
});

async function endAfterWriting(): Promise<void> {
  bridge.knobs.framing = "coalesce";
  recorded.text = "";
  recorded.eof = false;
  const conn = await connect(bridge.wsUrl(SERVICE));
  const { channel } = await conn.upgrade(`${SERVICE}.Record`);
  await channel.write(new TextEncoder().encode("hello, "));
  await channel.write(new TextEncoder().encode("half-close"));
  await channel.end();
  let back = "";
  for (let c = await channel.read(); c !== null; c = await channel.read()) back += new TextDecoder().decode(c.bytes);
  await channel.closed;
  // The service got everything written before end(), then its EOF.
  const eofSeen = (): boolean => recorded.eof;
  for (let i = 0; i < 400 && !eofSeen(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(recorded.text, "hello, half-close");
  assert.equal(recorded.eof, true);
  // The echo the service wrote after reading may or may not have made it before the close: at most a prefix.
  assert.ok("HELLO, HALF-CLOSE".startsWith(back), `unexpected reply bytes: ${JSON.stringify(back)}`);
  // And the channel is fully closed: writes reject.
  await assert.rejects(channel.write(new Uint8Array([1])), { name: "ConnectionClosedError" });
  bridge.reset();
}
