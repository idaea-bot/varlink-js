// Shared by the fuzz test and the soak script (DESIGN.md §7.5): hostile input for a server over pair(), and a
// runner checking that every connection replies or closes. Not a test file itself.
/* eslint-disable @typescript-eslint/require-await -- streaming handlers are async generators without awaits */
import fc from "fast-check";
import { Framer } from "../../src/core/protocol/framer.ts";
import { decodeCall } from "../../src/core/protocol/messages.ts";
import { jsonCodec } from "../../src/core/types/codec.ts";
import { createServer, type Server } from "../../src/rpc/index.ts";
import { pair } from "../../src/testing/index.ts";
import { resettable } from "../regression/harness.ts";

export const FUZZ_IDL = `interface org.example.fuzz

type Node (name: string, kids: ?[]Node)

method Ping() -> ()

method Echo(text: string) -> (text: string)

method Tree(root: Node) -> (depth: int)

method Map(m: [string]int, any: ?any, obj: ?object) -> ()

# [Supports 'more' flag]
method Count(n: int) -> (i: int)

method Throw() -> ()

method Later() -> ()

error Failed (why: string)
`;

const FUZZ_MAX_MESSAGE_SIZE = 256 * 1024;

/** A server with handlers for every method of {@link FUZZ_IDL}; onError counts reports. */
export function fuzzServer(): { server: Server; reports: { count: number } } {
  const reports = { count: 0 };
  const server = createServer({
    maxMessageSize: FUZZ_MAX_MESSAGE_SIZE,
    onError: () => {
      reports.count++;
    },
  });
  const depth = (n: { kids?: unknown[] | null }): number =>
    1 + Math.max(0, ...(n.kids ?? []).map((k) => depth(k as { kids?: unknown[] | null })));
  server.addInterface(FUZZ_IDL, {
    Ping: () => ({}),
    Echo: (p: { text: string }) => p,
    Tree: (p: { root: { kids?: unknown[] | null } }) => ({ depth: depth(p.root) }),
    Map: () => ({}),
    Count: async function* (p: { n: number }) {
      const n = Math.min(Math.abs(p.n), 20);
      for (let i = 0; i < n; i++) yield { i };
      return { i: n };
    },
    Throw: () => {
      throw new Error("fuzz");
    },
    Later: () =>
      new Promise((resolve) =>
        setImmediate(() => {
          resolve({});
        }),
      ),
  });
  return { server, reports };
}

const encoder = new TextEncoder();
const METHODS = ["Ping", "Echo", "Tree", "Map", "Count", "Throw", "Later", "Nope"].map((m) => `org.example.fuzz.${m}`);

const nested = (depth: number, open: string, close: string, inner: string): string =>
  open.repeat(depth) + inner + close.repeat(depth);

const hostileText = fc.oneof(
  fc.string(),
  fc.constantFrom("\0", "\ud800", "\udfff", "a\u0000b", "\u202e", "\x7f", "x".repeat(70_000)),
);
const headerValue = fc.oneof(fc.constant(null), fc.boolean(), fc.integer(), hostileText, fc.jsonValue({ maxDepth: 3 }));

/** One frame (without its NUL unless it is raw bytes). */
const frameArb: fc.Arbitrary<Uint8Array> = fc.oneof(
  // Random bytes, NULs included.
  fc.uint8Array({ maxLength: 200 }),
  // Valid calls with odd parameters and flags.
  fc
    .record(
      {
        method: fc.oneof(fc.constantFrom(...METHODS), hostileText),
        parameters: fc.oneof(
          fc.dictionary(fc.string({ maxLength: 8 }), headerValue, { maxKeys: 5 }),
          fc.record({ text: hostileText }),
          fc.record({ n: fc.oneof(fc.integer(), fc.double(), fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n })) }),
          headerValue,
        ),
        oneway: headerValue,
        more: headerValue,
        upgrade: fc.constantFrom(undefined, null, false, true),
        "x.ext": headerValue,
        bogus: fc.constantFrom(undefined, 1),
      },
      { requiredKeys: ["method"] },
    )
    .map((v) => encoder.encode(`${JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? Number(x) : x))}\0`)),
  // Deep nesting up to and past 2048 levels (sd-json DEPTH_MAX) and past MAX_VALUE_DEPTH.
  fc
    .integer({ min: 1, max: 2200 })
    .map((d) =>
      encoder.encode(
        `{"method":"org.example.fuzz.Tree","parameters":{"root":${nested(d, '{"name":"n","kids":[', "]}", '{"name":"leaf"}')}}}\0`,
      ),
    ),
  fc
    .integer({ min: 1, max: 2200 })
    .map((d) =>
      encoder.encode(`{"method":"org.example.fuzz.Map","parameters":{"m":{},"any":${nested(d, "[", "]", "1")}}}\0`),
    ),
  // Big and odd integers and strings.
  fc.constantFrom(
    encoder.encode('{"method":"org.example.fuzz.Count","parameters":{"n":123456789012345678901234567890}}\0'),
    encoder.encode(`{"method":"org.example.fuzz.Echo","parameters":{"text":"${"y".repeat(300_000)}"}}\0`),
    encoder.encode('{"method":"org.example.fuzz.Echo","parameters":{"text":"\\ud800"}}\0'),
    encoder.encode('{"method":"org.example.fuzz.Echo","parameters":{"text":"a\\u0000b"}}\0'),
    encoder.encode(`{"method":"org.example.fuzz.Count","parameters":{"n":${"9".repeat(2000)}},"more":true}\0`),
    new Uint8Array([0xff, 0xfe, 0x00]),
    encoder.encode("\ufeff{}\0"),
  ),
);

/** One fuzz case: frames written in order (pipelined), chunked, then an end or an abrupt reset. */
export interface FuzzCase {
  frames: Uint8Array[];
  /** Repeat the frames this many times (many pipelined calls). */
  repeat: number;
  chunk: number;
  finish: "end" | "reset" | "reset-early";
}

export const caseArb: fc.Arbitrary<FuzzCase> = fc.record({
  frames: fc.array(frameArb, { minLength: 1, maxLength: 8 }),
  repeat: fc.oneof(fc.constant(1), fc.integer({ min: 2, max: 40 })),
  chunk: fc.oneof(fc.constant(1 << 20), fc.integer({ min: 1, max: 64 })),
  finish: fc.constantFrom("end", "reset", "reset-early"),
});

/** What the server must answer for the bytes written: the server's own framing and call decoding, replayed. */
function expectedReplies(written: readonly Uint8Array[]): { max: number; exact: boolean } {
  const framer = new Framer({ maxMessageSize: FUZZ_MAX_MESSAGE_SIZE });
  for (const piece of written) framer.push(piece);
  let max = 0;
  // Exact only if every message is a well-formed non-upgrade call and nothing partial is left: then the server
  // answers each non-oneway call once and never closes early.
  let exact = true;
  for (;;) {
    let text: string | null;
    try {
      text = framer.next();
    } catch {
      exact = false;
      break;
    }
    if (text === null) break;
    let call;
    try {
      call = decodeCall(jsonCodec.decode(text));
    } catch {
      exact = false;
      continue;
    }
    if (call.upgrade) exact = false;
    if (!call.oneway) max++;
  }
  if (framer.buffered > 0) exact = false;
  return { max, exact };
}

/** Final replies (no `continues: true`) in what the server sent. */
function finalReplies(received: readonly Uint8Array[]): number {
  const text = new TextDecoder().decode(concatBytes(received));
  let n = 0;
  for (const message of text.split("\0").slice(0, -1)) {
    const reply = JSON.parse(message) as { continues?: unknown };
    if (reply.continues !== true) n++;
  }
  return n;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Runs one case against `server` over a fresh pair. Resolves once the server's handle() resolved; rejects if the
 * whole case (writing included) takes longer than `deadlineMs` (a hang). The client side reads everything (no
 * backpressure stall). Checks the replies: at most one final reply per non-oneway call written, none for oneway
 * calls, and exactly one per non-oneway call when the input was all valid calls, fully written and ended.
 */
export async function runCase(server: Server, c: FuzzCase, deadlineMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`connection neither replied nor closed within ${String(deadlineMs)} ms`));
    }, deadlineMs);
  });
  const [client, inner] = pair({ highWaterMark: 32 * 1024 });
  const side = resettable(inner);
  const handled = server.handle(side);
  const received: Uint8Array[] = [];
  const drained = (async () => {
    for (let chunk = await client.read(); chunk !== null; chunk = await client.read()) received.push(chunk.bytes);
  })();
  const written: Uint8Array[] = [];
  /** Everything was written (no early close, no early reset). */
  const state = { complete: true };
  const run = async (): Promise<void> => {
    let bytes = 0;
    const total = c.frames.reduce((s, f) => s + f.length, 0) * c.repeat;
    // Tiny chunks only for small inputs (byte-by-byte delivery of a 300 KB frame adds time, not coverage).
    const step = total > 64 * 1024 ? Math.max(c.chunk, 4096) : c.chunk;
    write: for (let r = 0; r < c.repeat; r++) {
      for (const f of c.frames) {
        for (let off = 0; off < f.length; off += step) {
          const piece = f.subarray(off, off + step);
          try {
            await client.write(piece);
          } catch {
            state.complete = false;
            break write; // the server closed the connection
          }
          written.push(piece);
          bytes += piece.length;
          if (c.finish === "reset-early" && bytes >= total / 2) {
            state.complete = false;
            break write;
          }
        }
      }
    }
    if (c.finish === "end") await client.end();
    else {
      side.reset();
      client.close();
    }
    await handled;
  };
  try {
    await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
    client.close();
  }
  await drained;
  const expected = expectedReplies(written);
  const finals = finalReplies(received);
  if (finals > expected.max)
    throw new Error(`${String(finals)} final replies for ${String(expected.max)} non-oneway calls`);
  if (c.finish === "end" && state.complete && expected.exact && finals !== expected.max)
    throw new Error(`${String(finals)} final replies, expected exactly ${String(expected.max)}`);
}

/** A fresh connection still gets a Ping answer. */
export async function stillAnswers(server: Server): Promise<boolean> {
  const [a, b] = pair();
  const handled = server.handle(b);
  await a.write(encoder.encode('{"method":"org.example.fuzz.Ping"}\0'));
  const chunk = await a.read();
  a.close();
  await handled;
  return chunk !== null && new TextDecoder().decode(chunk.bytes) === '{"parameters":{}}\0';
}
