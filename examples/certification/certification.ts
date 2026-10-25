// The org.varlink.certification service and client (DESIGN.md §7.4, M5), shared by server.ts, client.ts and the
// interop tests. Untyped: the IDL is registered from text (`addInterface`), no codegen. The semantics follow the
// reference implementations: python-varlink `varlink/tests/test_certification.py` and rust
// `varlink-certification/src/main.rs` (github.com/varlink/rust 2041093d).
import { readFile } from "node:fs/promises";
import {
  createServer,
  isVarlinkError,
  VarlinkError,
  type CallContext,
  type Connection,
  type Server,
  type ServerOptions,
  type UntypedHandlers,
} from "../../src/index.ts";

export const CERTIFICATION_INTERFACE = "org.varlink.certification";
export const CLIENT_ID_ERROR = "org.varlink.certification.ClientIdError";
export const CERTIFICATION_ERROR = "org.varlink.certification.CertificationError";

/** The interface text, verbatim (a copy of python-varlink's file, Apache-2.0). */
export function readCertificationIdl(): Promise<string> {
  return readFile(new URL("../../interfaces/org.varlink.certification.varlink", import.meta.url), "utf8");
}

type Params = Record<string, unknown>;

/** Deep-freezes the reference values: they are shared by every client and every reply. */
function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) frozen(v);
    Object.freeze(value);
  }
  return value;
}

const STRUCT = { bool: false, int: 2, float: Math.PI, string: "a lot of string" };
const MAP = { foo: "Foo", bar: "Bar" };
const SET = { one: {}, two: {}, three: {} };

/**
 * The MyType value of Test09 (and the parameter of Test10). The nullable fields `nullable` and
 * `nullable_array_struct` are omitted (python sends them as null; for a `?` field absent and null mean the same,
 * so both sides drop null ones before comparing: {@link withoutNullOptionals}).
 */
export const MYTYPE: Readonly<Params> = frozen({
  object: { method: "org.varlink.certification.Test09", parameters: { map: { foo: "Foo", bar: "Bar" } } },
  enum: "two",
  struct: { first: 1, second: "2" },
  array: ["one", "two", "three"],
  dictionary: { foo: "Foo", bar: "Bar" },
  stringset: { one: {}, two: {}, three: {} },
  interface: {
    foo: [null, { foo: "foo", bar: "bar" }, null, { one: "foo", two: "bar" }],
    anon: { foo: true, bar: false },
  },
});

/** The ten Test10 replies, which are Test11's `last_more_replies`. */
export const MORE_REPLIES: readonly string[] = frozen(
  Array.from({ length: 10 }, (_, i) => `Reply number ${String(i + 1)}`),
);

/** One certification call after Start: how it must be called and what it answers. */
export interface CertificationStep {
  /** Short method name. */
  readonly method: string;
  /** `more`: called with `more`, answers `replies` (all but the last with `continues`); `oneway`: no reply. */
  readonly kind: "single" | "more" | "oneway";
  /** The exact parameters expected, besides `client_id`. */
  readonly parameters: Readonly<Params>;
  readonly replies: readonly Readonly<Params>[];
}

/** Test01 … Test11 and End, in the order a client must call them (after Start). */
export const CERTIFICATION_STEPS: readonly CertificationStep[] = frozen([
  { method: "Test01", kind: "single", parameters: {}, replies: [{ bool: true }] },
  { method: "Test02", kind: "single", parameters: { bool: true }, replies: [{ int: 1 }] },
  { method: "Test03", kind: "single", parameters: { int: 1 }, replies: [{ float: 1.0 }] },
  { method: "Test04", kind: "single", parameters: { float: 1.0 }, replies: [{ string: "ping" }] },
  { method: "Test05", kind: "single", parameters: { string: "ping" }, replies: [{ ...STRUCT }] },
  { method: "Test06", kind: "single", parameters: { ...STRUCT }, replies: [{ struct: { ...STRUCT } }] },
  { method: "Test07", kind: "single", parameters: { struct: { ...STRUCT } }, replies: [{ map: { ...MAP } }] },
  { method: "Test08", kind: "single", parameters: { map: { ...MAP } }, replies: [{ set: { ...SET } }] },
  { method: "Test09", kind: "single", parameters: { set: { ...SET } }, replies: [{ mytype: MYTYPE }] },
  {
    method: "Test10",
    kind: "more",
    parameters: { mytype: MYTYPE },
    replies: MORE_REPLIES.map((string) => ({ string })),
  },
  { method: "Test11", kind: "oneway", parameters: { last_more_replies: MORE_REPLIES }, replies: [] },
  { method: "End", kind: "single", parameters: {}, replies: [{ all_ok: true }] },
]);

/**
 * Strict deep equality of JSON values: object key order is ignored (so maps and string sets compare
 * order-insensitively), array order is not, only own keys count (an own `__proto__` key is a key like any other),
 * and null is a value, not "absent". The nullable fields of MyType are normalized by {@link withoutNullOptionals}.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b; // -0 and 0 are the same JSON number
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.hasOwn(a, i) || !Object.hasOwn(b, i)) return false;
      if (!jsonEqual(a[i] as unknown, b[i] as unknown)) return false;
    }
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const key of ak) {
    if (!Object.hasOwn(b, key)) return false;
    if (!jsonEqual((a as Params)[key], (b as Params)[key])) return false;
  }
  return true;
}

/** MyType's `?` fields: absent and null mean the same (UAPI), so a null one is dropped before comparing. */
const MYTYPE_OPTIONALS = ["nullable", "nullable_array_struct"] as const;

/** A copy of a MyType value without its null optional fields; anything that is not a plain object as is. */
export function withoutNullOptionals(mytype: unknown): unknown {
  if (typeof mytype !== "object" || mytype === null || Array.isArray(mytype)) return mytype;
  const optionals: readonly string[] = MYTYPE_OPTIONALS;
  return Object.fromEntries(Object.entries(mytype).filter(([k, v]) => !(v === null && optionals.includes(k))));
}

/** Parameters or a reply with a `mytype` field normalized by {@link withoutNullOptionals}. */
function normalized(value: Readonly<Params>): Readonly<Params> {
  return Object.hasOwn(value, "mytype") ? { ...value, mytype: withoutNullOptionals(value["mytype"]) } : value;
}

/** Options for {@link createCertificationService}; the defaults are the reference servers'. */
export interface CertificationServiceOptions {
  /** Live clients kept; the oldest is forgotten when a Start would exceed it. Default 1024. */
  maxClients?: number;
  /** A client is forgotten this many ms after its Start (checked on access, no timers). Default 12 h. */
  lifetimeMs?: number;
  /** Clock (ms); default `Date.now`. */
  now?: () => number;
}

interface ClientState {
  readonly started: number;
  /** Index into CERTIFICATION_STEPS of the next expected call. */
  next: number;
  /** A failed oneway call (it could not reply): the client's next call fails with this. */
  failure?: { wants: Params; got: Params };
}

/** The certification service: its handlers plus the number of clients it currently remembers. */
export interface CertificationService {
  readonly handlers: UntypedHandlers;
  readonly clients: number;
}

function newClientId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The call as received, for CertificationError's `got`. */
function received(ctx: CallContext, parameters: Params): Params {
  return {
    method: ctx.method,
    parameters,
    ...(ctx.more ? { more: true } : {}),
    ...(ctx.oneway ? { oneway: true } : {}),
    ...(ctx.upgrade ? { upgrade: true } : {}),
  };
}

/** What a step's call must look like, for CertificationError's `wants`. */
function wanted(step: CertificationStep, clientId: string): Params {
  return {
    method: `${CERTIFICATION_INTERFACE}.${step.method}`,
    parameters: { client_id: clientId, ...step.parameters },
    ...(step.kind === "more" ? { more: true } : {}),
    ...(step.kind === "oneway" ? { oneway: true } : {}),
  };
}

function certificationError(wants: Params, got: Params): VarlinkError {
  return new VarlinkError(CERTIFICATION_ERROR, { wants, got });
}

/**
 * The org.varlink.certification handlers with per-client state: Start hands out a random client_id; every later
 * call must name a known client_id (else ClientIdError), be the next method in {@link CERTIFICATION_STEPS}, be
 * called the right way (`more` for Test10, `oneway` for Test11, neither otherwise) and carry exactly the reference
 * parameters. Any mismatch forgets the client and fails with CertificationError {wants, got} (both objects). A
 * failed oneway Test11 cannot answer, so it is recorded and the client's next call (End) fails with it.
 */
export function createCertificationService(options: CertificationServiceOptions = {}): CertificationService {
  const maxClients = options.maxClients ?? 1024;
  const lifetimeMs = options.lifetimeMs ?? 12 * 60 * 60 * 1000;
  const now = options.now ?? Date.now;
  /** Insertion order is Start order: expiry and eviction pop from the front. */
  const clients = new Map<string, ClientState>();

  const expire = (): void => {
    const t = now();
    for (const [id, state] of clients) {
      if (t - state.started < lifetimeMs) break;
      clients.delete(id);
    }
  };

  const start = (parameters: Params, ctx: CallContext): Params => {
    expire();
    const wants = { method: `${CERTIFICATION_INTERFACE}.Start` };
    if (ctx.more || ctx.oneway || ctx.upgrade) throw certificationError(wants, received(ctx, parameters));
    while (clients.size >= maxClients) {
      const oldest = clients.keys().next();
      if (oldest.done === true) break;
      clients.delete(oldest.value);
    }
    const clientId = newClientId();
    clients.set(clientId, { started: now(), next: 0 });
    return { client_id: clientId };
  };

  /** Checks one call of step `index`; returns the step to answer, or throws (forgetting the client). */
  const check = (index: number, parameters: Params, ctx: CallContext): CertificationStep => {
    expire();
    const step = CERTIFICATION_STEPS[index];
    const clientId = parameters["client_id"];
    const state = typeof clientId === "string" ? clients.get(clientId) : undefined;
    if (step === undefined || typeof clientId !== "string" || state === undefined)
      throw new VarlinkError(CLIENT_ID_ERROR, {});
    const got = received(ctx, parameters);
    const fail = (wants: Params): never => {
      // A oneway call cannot reply: keep the client so that its next call reports the failure.
      if (ctx.oneway) state.failure = { wants, got };
      else clients.delete(clientId);
      throw certificationError(wants, got);
    };
    if (state.failure !== undefined) {
      clients.delete(clientId);
      throw certificationError(state.failure.wants, state.failure.got);
    }
    const expected = CERTIFICATION_STEPS[state.next];
    if (state.next !== index && expected !== undefined)
      fail({ method: `${CERTIFICATION_INTERFACE}.${expected.method}` });
    const wants = wanted(step, clientId);
    const shapeOk = !ctx.upgrade && ctx.more === (step.kind === "more") && ctx.oneway === (step.kind === "oneway");
    if (!shapeOk || !jsonEqual(normalized(parameters), wants["parameters"])) fail(wants);
    state.next = index + 1;
    if (state.next === CERTIFICATION_STEPS.length) clients.delete(clientId);
    return step;
  };

  const handlers: Record<string, UntypedHandlers[string]> = { Start: start };
  CERTIFICATION_STEPS.forEach((s, index) => {
    if (s.kind === "more") {
      handlers[s.method] = async (parameters: Params, ctx: CallContext): Promise<Params | undefined> => {
        const step = check(index, parameters, ctx);
        const last = step.replies.length - 1;
        for (const reply of step.replies.slice(0, last)) await ctx.notify({ ...reply });
        return { ...step.replies[last] };
      };
    } else {
      handlers[s.method] = (parameters: Params, ctx: CallContext): Params | undefined => {
        const step = check(index, parameters, ctx);
        const reply = step.replies[0];
        return reply === undefined ? undefined : { ...reply };
      };
    }
  });

  return {
    handlers,
    get clients() {
      expire();
      return clients.size;
    },
  };
}

/** Options for {@link createCertificationServer}. */
export interface CertificationServerOptions extends CertificationServiceOptions {
  /** Server error hook; default: one line on stderr. */
  onError?: ServerOptions["onError"];
}

async function packageVersion(): Promise<string> {
  const text = await readFile(new URL("../../package.json", import.meta.url), "utf8");
  const version = (JSON.parse(text) as { version?: unknown }).version;
  return typeof version === "string" ? version : "";
}

/** A Server with org.varlink.certification registered; our own replies are validated against the IDL ("throw"). */
export async function createCertificationServer(
  options: CertificationServerOptions = {},
): Promise<{ server: Server; service: CertificationService }> {
  const { onError, ...serviceOptions } = options;
  const [idl, version] = await Promise.all([readCertificationIdl(), packageVersion()]);
  const server = createServer({
    vendor: "varlink-js",
    product: "certification",
    version,
    url: "https://github.com/pzmarzly/varlink-js",
    validateReplies: "throw",
    onError:
      onError ??
      ((error, info) => {
        const where = info.method === undefined ? "" : ` in ${info.method}`;
        console.error(`certification server: ${info.reason}${where}: ${describeError(error)}`);
      }),
  });
  const service = createCertificationService(serviceOptions);
  server.addInterface(idl, service.handlers);
  return { server, service };
}

/** A one-line description of an error (a VarlinkError with its name and parameters). */
export function describeError(error: unknown): string {
  if (isVarlinkError(error)) return `${error.error} ${JSON.stringify(error.parameters)}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function expectReply(method: string, got: Params, want: Readonly<Params>): void {
  // Unknown reply fields are ignored (python adds `client_id` to Test09's reply); only the declared ones count.
  const gotN = normalized(got);
  for (const key of Object.keys(want))
    if (!Object.hasOwn(gotN, key) || !jsonEqual(gotN[key], want[key]))
      throw new Error(`${method}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

function step(method: string): CertificationStep {
  const s = CERTIFICATION_STEPS.find((x) => x.method === method);
  if (s === undefined) throw new Error(`no step ${method}`);
  return s;
}

/**
 * Runs the certification client on `conn` (registers the interface on it first, so its replies are validated per
 * the connection's `validateReplies`): Start, Test01 … Test09, Test10 via `stream()`, Test11 via `oneway()`, End.
 * Like the python client it passes each reply on as the next call's parameters, and it checks every reply against
 * the reference value. `log` gets one line per step. Throws on the first failure.
 */
export async function runCertificationClient(
  conn: Connection,
  log: (line: string) => void = () => undefined,
): Promise<void> {
  conn.addInterface(await readCertificationIdl());
  const method = (name: string): string => `${CERTIFICATION_INTERFACE}.${name}`;
  const call = async (name: string, parameters: Params): Promise<Params> => {
    const reply = await conn.call(method(name), parameters);
    log(`${name}: ${JSON.stringify(reply)}`);
    const want = step(name).replies[0];
    if (want !== undefined) expectReply(name, reply, want);
    return reply;
  };

  const started = await conn.call(method("Start"), {});
  const clientId = started["client_id"];
  if (typeof clientId !== "string" || clientId === "")
    throw new Error(`Start: expected a client_id string, got ${JSON.stringify(started)}`);
  log(`client_id: ${clientId}`);
  const id = { client_id: clientId };

  let r = await call("Test01", id);
  r = await call("Test02", { ...id, bool: r["bool"] });
  r = await call("Test03", { ...id, int: r["int"] });
  r = await call("Test04", { ...id, float: r["float"] });
  r = await call("Test05", { ...id, string: r["string"] });
  r = await call("Test06", { ...id, bool: r["bool"], int: r["int"], float: r["float"], string: r["string"] });
  r = await call("Test07", { ...id, struct: r["struct"] });
  r = await call("Test08", { ...id, map: r["map"] });
  r = await call("Test09", { ...id, set: r["set"] });

  const strings: unknown[] = [];
  const want10 = step("Test10").replies;
  for await (const reply of conn.stream(method("Test10"), { ...id, mytype: r["mytype"] })) {
    log(`Test10: ${JSON.stringify(reply)}`);
    const want = want10[strings.length];
    if (want === undefined) throw new Error(`Test10: more than ${String(want10.length)} replies`);
    expectReply("Test10", reply, want);
    strings.push(reply["string"]);
  }
  if (strings.length !== want10.length)
    throw new Error(`Test10: expected ${String(want10.length)} replies, got ${String(strings.length)}`);

  await conn.oneway(method("Test11"), { ...id, last_more_replies: strings });
  log("Test11: (oneway)");

  await call("End", id);
}
