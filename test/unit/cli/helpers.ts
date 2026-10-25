// Shared helpers for the CLI unit tests (DESIGN.md §4.14): a fake CliIo, an in-process run(), and a test service
// served over a unix socket (in a temp dir) and tcp:127.0.0.1:0. Runtime-agnostic (Node, Bun, Deno).
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokenPipeError, type CliIo } from "../../../src/cli/io.ts";
import { run } from "../../../src/cli/run.ts";
import { createServer, VarlinkError, type CallContext, type Server } from "../../../src/index.ts";
import { listen, type NodeListener } from "../../../src/node/index.ts";

export const RS = "\x1e";
export const ESC: string = String.fromCharCode(0x1b);

export const IDL = `# A test service for the CLI.
interface org.example.cli

# Returns its input.
method Echo(value: any) -> (value: any)

# Replies i = 0 … n-1, each with value.
# [Supports 'more' flag]
method Count(n: int, value: ?any) -> (i: int, value: ?any)

# Endless: one reply every few ms until the client goes.
# [Requires 'more' flag]
method Monitor() -> (i: int)

# Never answers.
method Hang() -> ()

# Fails with the given error.
method Fail(error: string, parameters: ?object) -> ()

# Records its parameters (a oneway target).
method Log(text: string) -> ()

# [Experimental]
method Preview() -> ()
`;

export const EXPERIMENTAL_IDL = `# [Experimental]
interface org.example.preview

method Try() -> ()
`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A running test service. */
export interface Fixture {
  readonly server: Server;
  readonly unix: string;
  readonly tcp: string;
  /** Texts received by Log (oneway). */
  readonly logged: string[];
  /** Number of Monitor calls whose connection went away (their signal aborted). */
  monitorsEnded: number;
  close(): Promise<void>;
}

export async function startFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "vj-cli-"));
  const logged: string[] = [];
  const server = createServer({
    vendor: "varlink-js tests",
    product: "cli fixture",
    version: "1",
    url: "https://example.org/",
    onError: () => undefined,
  });
  const fixture: Fixture = {
    server,
    unix: `unix:${join(dir, "s")}`,
    tcp: "",
    logged,
    monitorsEnded: 0,
    close: async () => {
      await server.shutdown({ graceful: false });
      await rm(dir, { recursive: true, force: true });
    },
  };
  server.addInterface(IDL, {
    Echo: (p: Record<string, unknown>) => ({ value: p["value"] }),
    Count: async (p: Record<string, unknown>, ctx: CallContext) => {
      const n = Number(p["n"]);
      const extra = p["value"] === undefined || p["value"] === null ? {} : { value: p["value"] };
      for (let i = 0; i < n - 1; i++) await ctx.notify({ i, ...extra });
      return { i: n - 1, ...extra };
    },
    Monitor: async (_p: Record<string, unknown>, ctx: CallContext) => {
      try {
        for (let i = 0; !ctx.signal.aborted; i++) {
          await ctx.notify({ i });
          await sleep(5);
        }
      } finally {
        fixture.monitorsEnded++;
      }
      return { i: -1 };
    },
    Hang: (_p: Record<string, unknown>, ctx: CallContext) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          resolve({});
        });
      }),
    Fail: (p: Record<string, unknown>) => {
      throw new VarlinkError(String(p["error"]), (p["parameters"] as Record<string, unknown> | null) ?? {});
    },
    Log: (p: Record<string, unknown>) => {
      logged.push(String(p["text"]));
    },
    Preview: () => ({}),
  });
  server.addInterface(EXPERIMENTAL_IDL, { Try: () => ({}) });
  const unixListener: NodeListener = await listen(fixture.unix);
  const tcpListener: NodeListener = await listen("tcp:127.0.0.1:0");
  server.serve(unixListener);
  server.serve(tcpListener);
  (fixture as { tcp: string }).tcp = tcpListener.address;
  return fixture;
}

/** Options of a fake CliIo. */
export interface FakeIoOptions {
  stdin?: string | Uint8Array | AsyncIterable<Uint8Array>;
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  env?: Record<string, string>;
  /** stdout writes accepted before every further write rejects with BrokenPipeError. */
  stdoutBreaksAfter?: number;
  signal?: AbortSignal;
  /** Called with stdout's text so far after each write. */
  onStdout?: (text: string) => void;
}

/** A fake CliIo recording stdout and stderr. */
export interface FakeIo extends CliIo {
  readonly stdoutChunks: Uint8Array[];
  stdoutText(): string;
  stderrText(): string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesOf(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  if (bytes.length > 0) yield bytes;
}

export function fakeIo(options: FakeIoOptions = {}): FakeIo {
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const stdinSource =
    options.stdin === undefined
      ? once(new Uint8Array())
      : typeof options.stdin === "string" || options.stdin instanceof Uint8Array
        ? once(bytesOf(options.stdin))
        : options.stdin;
  let writes = 0;
  return {
    stdin: {
      isTTY: options.stdinTTY ?? false,
      [Symbol.asyncIterator]: () => stdinSource[Symbol.asyncIterator](),
    },
    stdout: {
      isTTY: options.stdoutTTY ?? false,
      write: async (data) => {
        await Promise.resolve();
        if (options.stdoutBreaksAfter !== undefined && writes >= options.stdoutBreaksAfter)
          throw new BrokenPipeError("write EPIPE");
        writes++;
        stdoutChunks.push(bytesOf(data));
        options.onStdout?.(decoder.decode(concat(stdoutChunks)));
      },
    },
    stderr: {
      isTTY: false,
      write: async (data) => {
        await Promise.resolve();
        stderrChunks.push(bytesOf(data));
      },
    },
    env: options.env ?? {},
    signal: options.signal,
    stdoutChunks,
    stdoutText: () => decoder.decode(concat(stdoutChunks)),
    stderrText: () => decoder.decode(concat(stderrChunks)),
  };
}

/** The result of an in-process run. */
export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly io: FakeIo;
}

/** Runs the CLI in-process with a fake CliIo. */
export async function runCli(argv: readonly string[], options: FakeIoOptions = {}): Promise<CliResult> {
  const io = fakeIo(options);
  const code = await run(argv, io);
  return { code, stdout: io.stdoutText(), stderr: io.stderrText(), io };
}

/** A temp dir for one test file. */
export async function tempDir(): Promise<{ path: string; remove(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "vj-cli-"));
  return { path, remove: () => rm(path, { recursive: true, force: true }) };
}

/**
 * A raw socket server on tcp:127.0.0.1:0 that answers every NUL-terminated message with the next of `replies`
 * (verbatim JSON texts, NUL appended). For peer-controlled bytes the library's own server would refuse to send.
 */
export async function rawServer(replies: readonly string[]): Promise<{ address: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: NetServer = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let next = 0;
    socket.on("data", (chunk: Uint8Array) => {
      for (const byte of chunk) {
        if (byte !== 0) continue;
        const reply = replies[next++];
        if (reply !== undefined) socket.write(`${reply}\0`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no tcp address");
  return {
    address: `tcp:127.0.0.1:${String(addr.port)}`,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** A stdin that yields the pushed chunks and ends on `end()`. */
export function controlledStdin(): AsyncIterable<Uint8Array> & { push(data: string | Uint8Array): void; end(): void } {
  const queue: (Uint8Array | null)[] = [];
  let wake: (() => void) | undefined;
  return {
    push(data) {
      queue.push(bytesOf(data));
      wake?.();
    },
    end() {
      queue.push(null);
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
        const item = queue.shift();
        if (item === null || item === undefined) return;
        yield item;
      }
    },
  };
}

/** Polls `predicate` every 5 ms until it holds (or `ms` passed: throws). */
export async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waitFor: timed out");
    await sleep(5);
  }
}
