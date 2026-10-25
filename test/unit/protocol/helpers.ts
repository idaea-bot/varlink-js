// Test-only helpers for the protocol tests: byte helpers, a dispatch table builder, a server driver that runs
// dispatchCall for each call, and the in-memory script driver used by the property tests.
import { INTERNAL_ERROR_INTERFACE_IDL, ORG_VARLINK_SERVICE_IDL } from "../../../src/core/errors/index.ts";
import {
  ClientSession,
  dispatchCall,
  ServerSession,
  type ClientEvent,
  type DispatchOptions,
  type DispatchTable,
  type Handler,
  type MethodEntry,
  type ServerEvent,
} from "../../../src/core/protocol/index.ts";
import { compileInterfaceText, type CompiledInterface } from "../../../src/core/types/index.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 bytes of `s`. */
export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

/** `text` + NUL as bytes. */
export function frame(text: string): Uint8Array {
  return concat([utf8(text), new Uint8Array([0])]);
}

/** JSON of `value` + NUL. */
export function msg(value: unknown): Uint8Array {
  return frame(JSON.stringify(value));
}

/** The chunks joined. */
export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** The NUL-terminated messages in `bytes` as text (a trailing partial message is ignored). */
export function texts(bytes: Uint8Array): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      out.push(decoder.decode(bytes.subarray(start, i)));
      start = i + 1;
    }
  }
  return out;
}

/** The NUL-terminated messages in `bytes`, JSON-parsed. */
export function messages(bytes: Uint8Array): unknown[] {
  return texts(bytes).map((t) => JSON.parse(t) as unknown);
}

/** The compiled org.varlink.service and InternalError interfaces (every server knows them). */
export const BUILTINS: readonly CompiledInterface[] = [
  compileInterfaceText(ORG_VARLINK_SERVICE_IDL),
  compileInterfaceText(INTERNAL_ERROR_INTERFACE_IDL),
];

/**
 * A dispatch table over compiled interfaces (plus {@link BUILTINS}), with handlers keyed by fully qualified method
 * name. `extra` adds hand-built entries (their interface becomes known).
 */
export function tableOf(
  ifaces: readonly CompiledInterface[],
  handlers: Record<string, Handler<never>>,
  extra: Record<string, MethodEntry> = {},
): DispatchTable {
  const all = new Map<string, CompiledInterface>();
  for (const i of [...BUILTINS, ...ifaces]) all.set(i.name, i);
  const extraIfaces = new Set(Object.keys(extra).map((m) => m.slice(0, m.lastIndexOf("."))));
  return {
    lookup(interfaceName, methodName) {
      const full = `${interfaceName}.${methodName}`;
      const hand = extra[full];
      if (hand !== undefined) return { kind: "method", entry: hand };
      const iface = all.get(interfaceName);
      if (iface === undefined)
        return extraIfaces.has(interfaceName) ? { kind: "method-not-found" } : { kind: "interface-not-found" };
      const m = iface.methods.get(methodName);
      if (m === undefined) return { kind: "method-not-found" };
      const entry: {
        input: typeof m.input;
        output: typeof m.output;
        more?: "supports" | "requires";
        upgrade?: "supports" | "requires";
        handler?: Handler<never>;
      } = { input: m.input, output: m.output };
      if (m.member.more !== undefined) entry.more = m.member.more;
      if (m.member.upgrade !== undefined) entry.upgrade = m.member.upgrade;
      const h = handlers[full];
      if (h !== undefined) entry.handler = h;
      return { kind: "method", entry };
    },
    errorValidator(errorName) {
      const dot = errorName.lastIndexOf(".");
      const iface = all.get(errorName.slice(0, dot));
      if (iface === undefined) return undefined;
      return iface.errors.get(errorName.slice(dot + 1)) ?? null;
    },
  };
}

/** What {@link serve} saw. */
export interface Served {
  /** Everything written, in order. */
  output: Uint8Array;
  /** The parsed reply messages. */
  replies: unknown[];
  /** The close event, if the session produced one. */
  close: ServerEvent | undefined;
  /** Call events, in order. */
  calls: ServerEvent[];
}

/** Feeds `input` (then EOF unless `eof: false`) to a server session and dispatches every call in order. */
export async function serve(
  input: Uint8Array | readonly Uint8Array[],
  table: DispatchTable,
  options: DispatchOptions & { eof?: boolean; session?: ServerSession } = {},
): Promise<Served> {
  const session = options.session ?? new ServerSession();
  for (const chunk of input instanceof Uint8Array ? [input] : input) session.receive(chunk);
  if (options.eof !== false) session.receiveEnd();
  const out: Uint8Array[] = [];
  const calls: ServerEvent[] = [];
  let close: ServerEvent | undefined;
  for (;;) {
    const ev = session.nextEvent();
    if (ev === null) break;
    if (ev.type === "close") {
      close = ev;
      break;
    }
    calls.push(ev);
    await dispatchCall(
      session,
      ev.id,
      ev.call,
      table,
      (bytes) => {
        out.push(bytes);
        return Promise.resolve();
      },
      options,
    );
  }
  const output = concat(out);
  return { output, replies: messages(output), close, calls };
}

// --- script driver (property tests) --------------------------------------------------------------------

/**
 * One pipelined call of a script; the server's responder reads `kind`/`n`/`rest` from the parameters. `upgrade`
 * may only be the last step: after it the client sends `rest` as raw upgraded bytes, and the server answers the
 * confirmation followed by `rest` reversed as its own raw bytes. `pad` only makes the call bigger.
 */
export type Step = (
  | { kind: "single" }
  | { kind: "more"; n: number }
  | { kind: "oneway" }
  | { kind: "error" }
  | { kind: "upgrade"; rest: readonly number[] }
) & { pad?: string };

/**
 * Delivery plan, cycled: each step feeds `size` bytes client→server (`toServer`, only while the server wants
 * input) or server→client; a call the server picks up during a step is answered `defer` steps later.
 */
export type Schedule = readonly { toServer: boolean; size: number; defer: number }[];

/** What a script run produced. */
export interface ScriptResult {
  clientEvents: ClientEvent[];
  serverEvents: ServerEvent[];
  /** Upgraded bytes the server session handed over (every takeUpgradeRemainder() joined), or null. */
  serverRemainder: Uint8Array | null;
  /** Same for the client session. */
  clientRemainder: Uint8Array | null;
}

/** Answers one call as its parameters say. */
function answer(server: ServerSession, ev: ServerEvent & { type: "call" }, out: Uint8Array[]): void {
  const { id, call } = ev;
  const kind = call.parameters.kind;
  const push = (b: Uint8Array | null): void => {
    if (b !== null) out.push(b);
  };
  if (kind === "oneway") {
    server.finish(id);
  } else if (kind === "error") {
    push(server.error(id, "org.example.test.Failed", { step: call.parameters.step }));
  } else if (kind === "more") {
    const n = Number(call.parameters.n);
    for (let i = 0; i < n; i++) push(server.reply(id, { step: call.parameters.step, i }, { continues: true }));
    push(server.reply(id, { step: call.parameters.step, last: true }));
  } else if (kind === "upgrade") {
    push(server.reply(id, { step: call.parameters.step, upgraded: true }));
    const rest = call.parameters.rest as number[];
    if (server.state === "upgraded") out.push(Uint8Array.from(rest.toReversed()));
  } else {
    push(server.reply(id, { step: call.parameters.step }));
  }
}

/** Upper bound on driver iterations (a hang is a test failure, not a timeout). */
const MAX_ITERATIONS = 100_000;

/**
 * Runs `steps` as pipelined calls from a ClientSession to a ServerSession with a scripted responder. Bytes move
 * in both directions per `schedule` (cycled), honouring `wantsInput`; without a schedule everything is delivered
 * unsplit and answered at once.
 */
export function runScript(
  steps: readonly Step[],
  schedule?: Schedule,
  limits: { maxQueuedCalls?: number; maxMessageSize?: number } = {},
): ScriptResult {
  const client = new ClientSession();
  const server = new ServerSession(limits);
  const clientEvents: ClientEvent[] = [];
  const serverEvents: ServerEvent[] = [];
  const serverRest: Uint8Array[] = [];
  const clientRest: Uint8Array[] = [];
  const toServer = concat(
    steps.flatMap((s, step) => {
      const parameters = { ...s, step };
      const { bytes } = client.call({
        method: "org.example.test.Run",
        parameters,
        oneway: s.kind === "oneway",
        more: s.kind === "more",
        upgrade: s.kind === "upgrade",
      });
      return s.kind === "upgrade" ? [bytes, Uint8Array.from(s.rest)] : [bytes];
    }),
  );
  const fromServer: Uint8Array[] = [];
  let sentToServer = 0;
  let sentToClient = 0;
  let serverStream: Uint8Array = new Uint8Array(0);
  let active: { ev: ServerEvent & { type: "call" }; wait: number } | null = null;

  /** Whether the driver may read for the server: it wants input, or the stream was handed over (upgraded). */
  const canFeedServer = (): boolean =>
    sentToServer < toServer.length && (server.wantsInput || server.state === "upgraded");
  const feedServer = (n: number): void => {
    server.receive(toServer.subarray(sentToServer, sentToServer + n));
    sentToServer = Math.min(toServer.length, sentToServer + n);
  };
  /** Takes calls and answers them after `defer` pump steps. True if anything happened. */
  const pump = (defer: number): boolean => {
    let progressed = false;
    for (;;) {
      if (active === null) {
        const ev = server.nextEvent();
        if (ev === null) break;
        serverEvents.push(ev);
        progressed = true;
        if (ev.type === "close") break;
        active = { ev, wait: defer };
      }
      if (active.wait > 0) {
        active.wait--;
        progressed = true;
        break;
      }
      answer(server, active.ev, fromServer);
      active = null;
      progressed = true;
    }
    if (server.state === "upgraded") serverRest.push(server.takeUpgradeRemainder());
    return progressed;
  };
  const serverPending = (): number =>
    serverStream.length - sentToClient + fromServer.reduce((sum, b) => sum + b.length, 0);
  const feedClient = (n: number): void => {
    if (fromServer.length > 0) serverStream = concat([serverStream, ...fromServer.splice(0)]);
    const piece = serverStream.subarray(sentToClient, sentToClient + n);
    sentToClient += piece.length;
    clientEvents.push(...client.receive(piece));
    if (client.state === "upgraded") clientRest.push(client.takeUpgradeRemainder());
  };

  let iterations = 0;
  const guard = (): void => {
    if (++iterations > MAX_ITERATIONS) throw new Error("runScript: no progress (driver hang)");
  };
  if (schedule !== undefined && schedule.length > 0) {
    let i = 0;
    let idle = 0;
    while (idle < schedule.length) {
      guard();
      const s = schedule[i % schedule.length] ?? { toServer: true, size: 1, defer: 0 };
      i++;
      let progressed = false;
      if (s.toServer && canFeedServer()) {
        feedServer(s.size);
        progressed = true;
      } else if (!s.toServer && serverPending() > 0) {
        feedClient(s.size);
        progressed = true;
      }
      if (pump(s.defer)) progressed = true;
      idle = progressed ? 0 : idle + 1;
    }
  }
  for (;;) {
    guard();
    let progressed = false;
    if (canFeedServer()) {
      feedServer(toServer.length);
      progressed = true;
    }
    if (pump(0)) progressed = true;
    if (serverPending() > 0) {
      feedClient(Number.MAX_SAFE_INTEGER);
      progressed = true;
    }
    if (!progressed) break;
  }
  if (sentToServer < toServer.length) throw new Error("runScript: the server stopped wanting input for good");
  server.receiveEnd();
  pump(0);
  feedClient(Number.MAX_SAFE_INTEGER);
  clientEvents.push(...client.receiveEnd());
  return {
    clientEvents,
    serverEvents,
    serverRemainder: server.state === "upgraded" ? concat(serverRest) : null,
    clientRemainder: client.state === "upgraded" ? concat(clientRest) : null,
  };
}
