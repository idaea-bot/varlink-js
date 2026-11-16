# varlink-js

[Varlink](https://varlink.org/) ([UAPI.20](https://uapi-group.org/specifications/specs/varlink/)) for JavaScript
runtimes: a client, a server (with `org.varlink.service` built in), an IDL parser, validator and formatter, a
TypeScript code generator and a `varlink-js` CLI modelled on systemd's `varlinkctl`. Zero runtime dependencies, ESM
only, Node.js ≥ 22.12 (Bun and Deno run the unit and regression tests in CI; see [Runtimes](#runtimes)).

**Status: `1.0.0-alpha.0`, not published to npm yet.** This is a rewrite; the 0.1.x API is gone (see
[docs/MIGRATION.md](docs/MIGRATION.md)). The design, with the reasons behind every rule, is in
[docs/DESIGN.md](docs/DESIGN.md).

- [Install](#install) · [Quick start](#quick-start) · [Codegen](#codegen) · [CLI](#cli) · [Addresses](#addresses)
- [Limits and defaults](#limits-and-defaults) · [Cancellation and timeouts](#cancellation-and-timeouts) ·
  [Errors](#errors) · [Integers](#integers) · [Socket activation and friends](#socket-activation-and-friends)
- [Runtimes](#runtimes) · [What is tested where](#what-is-tested-where) · [Not yet implemented](#not-yet-implemented)
  · [Certification](#certification)

## Install

The package is not on npm yet, and `npm install github:…` does not work either: npm 12 refuses git dependencies by
default (`EALLOWGIT`), and with `--allow-git=all` it installs the package without `dist/`, because `dist/` is built by
the `prepack` script, which npm does not run for a git dependency. Build a tarball instead (the same steps CI runs before
its consumer test, `test/fixtures/consumer/run.js`):

```sh
git clone --branch rewrite https://github.com/idaea-bot/varlink-js.git
cd varlink-js
npm ci        # development needs Node.js >= 22.18 (TypeScript type stripping); users need >= 22.12
npm pack      # prepack builds dist/ -> varlink-js-1.0.0-alpha.0.tgz
cd /path/to/your/project
npm install /path/to/varlink-js/varlink-js-1.0.0-alpha.0.tgz
```

Entry points (the `exports` map; there are no deep imports):

| Import | What |
|---|---|
| `varlink-js` | `createServer`, `createConnection` (over any `ByteChannel`), `createPool`, `createClient`, errors, `parseAddress`, `streamOf`, types. No Node imports. |
| `varlink-js/node` | `connect`, `listen`, `createPool(address)`, `connectExec`, `connectBridge`, `listenFromEnv`, `listenAuto`, `listenStdio`, registry and resolver helpers. |
| `varlink-js/websocket` | WebSocket mode client: `connect`, `createPool`, `fromWebSocket`. |
| `varlink-js/http` | Simple HTTP mode client: `createHttpClient`. |
| `varlink-js/idl` | `parseInterface`, `validateInterface`, `formatInterface`, the AST types. |
| `varlink-js/codegen` | `generate`, `generateFromService`. |
| `varlink-js/testing` | `pair()` (in-memory channel pair), `faulty()` (fault injection). |
| `varlink-js` (bin) | The CLI, see [CLI](#cli). |

## Quick start

The code blocks below are copies of files under [`examples/`](examples/), which CI runs end to end
(`test/docs/examples.test.ts`). In this repository the examples import `../src/…`; the blocks show the package
specifiers you use (`varlink-js`, `varlink-js/node`, …). `test/docs/snippets.test.ts` checks every block against its
file with exactly that substitution.

### Client: `org.varlink.service.GetInfo`

<!-- snippet: examples/client.ts -->
```ts
// Calls org.varlink.service.GetInfo: `node examples/client.ts ADDRESS`, e.g. unix:/run/org.example.sock.
import { connect } from "varlink-js/node";

const address = process.argv[2] ?? "unix:./org.example.reference.sock";
const conn = await connect(address); // unix:/path, unix:@name (Linux), tcp:host:port, exec:/path, ssh-unix:…
try {
  const info = await conn.getInfo(); // org.varlink.service.GetInfo, reply validated
  console.log(`${info.vendor} ${info.product} ${info.version} (${info.url})`);
  for (const name of info.interfaces) console.log(`  ${name}`);
} finally {
  await conn.close();
}
```

### Server: an interface from IDL text, a streaming method, a typed error

<!-- snippet: examples/server.ts -->
```ts
// A small server from IDL text: `node examples/server.ts [ADDRESS]` (default tcp:127.0.0.1:0, a free port).
import { createServer, streamOf, VarlinkError } from "varlink-js";
import { listen } from "varlink-js/node";

const IDL = `# A demo interface.
interface org.example.demo

# Greets someone.
method Hello(name: string) -> (greeting: string)

# Counts from 1 to n, one reply per number.
# [Requires 'more' flag]
method Count(n: int) -> (i: int)

# n is not between 1 and max.
error OutOfRange (n: int, max: int)
`;

const server = createServer({ vendor: "Example", product: "demo", version: "1.0", url: "https://example.org" });
server.addInterface(IDL, {
  // Parameters are validated against the IDL before a handler runs.
  Hello: (p: { name: string }) => ({ greeting: `Hello, ${p.name}!` }),
  // An async generator streams: each `yield` is a reply with `continues`, the `return` value is the final reply.
  // streamOf() re-yields items but returns the last one, so it goes out as the final reply.
  Count: async function* (p: { n: number }) {
    if (p.n < 1 || p.n > 100) throw new VarlinkError("org.example.demo.OutOfRange", { n: p.n, max: 100 });
    return yield* streamOf(Array.from({ length: p.n }, (_, k) => ({ i: k + 1 })));
  },
});

// unix:/path (mode applies only there), unix:@name (Linux; no permissions) or tcp:127.0.0.1:PORT
const listener = await listen(process.argv[2] ?? "tcp:127.0.0.1:0", { mode: 0o644 });
server.serve(listener);
const stop = (): void => {
  void server.shutdown().then(() => process.exit(0)); // graceful: running calls may finish (5 s deadline)
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

// Handlers first, then the line the caller waits for, so an early signal still shuts down cleanly.
console.log(`Listening on ${listener.address}`);
```

`listen()` binds exactly the address you pass. For a unix socket path, `mode` is applied before the socket appears at
its path; 0644 means only the owner can connect (connecting needs write permission), and root, which ignores file
permissions. Caveats: on a file system without hard links, or when the private directory's path would not fit in
`sun_path`, the mode is applied right after `bind` (a short window with the umask's mode); and `mode` is silently
ignored for `tcp:`, `unix:@` (abstract sockets have no permissions: any local user in the network namespace can
connect) and `{ fd }` listeners.

### Calling it: `call`, `stream`, `collect`, a typed error

<!-- snippet: examples/demo-client.ts -->
```ts
// Calls examples/server.ts: `node examples/demo-client.ts ADDRESS` (the address the server printed).
import { isVarlinkError } from "varlink-js";
import { connect } from "varlink-js/node";

const address = process.argv[2];
if (address === undefined) throw new Error("usage: node examples/demo-client.ts ADDRESS");

const conn = await connect(address);
try {
  const { greeting } = await conn.call("org.example.demo.Hello", { name: "world" });
  console.log(greeting); // Hello, world!

  // `more`: one iteration per reply, the final one included.
  for await (const reply of conn.stream("org.example.demo.Count", { n: 3 })) console.log(reply.i); // 1 2 3

  try {
    await conn.collect("org.example.demo.Count", { n: 1000 }); // collect(): all replies as an array
  } catch (e) {
    if (!isVarlinkError(e, "org.example.demo.OutOfRange")) throw e;
    console.log(`${e.error}: max is ${String(e.parameters.max)}`);
  }
} finally {
  await conn.close();
}
```

```sh
node examples/server.ts                                 # Listening on tcp:127.0.0.1:<port>
node examples/demo-client.ts tcp:127.0.0.1:<port>
node examples/client.ts tcp:127.0.0.1:<port>            # GetInfo
```

Untyped calls give `Record<string, unknown>`. `conn.oneway(method, params)` sends a oneway call and resolves once it
is written. `conn.proxy("org.example.demo")` fetches the interface and returns an object with one function per method
(runtime validation, no codegen).

### Typed client (codegen)

Generate a module from the IDL (see [Codegen](#codegen)), then:

<!-- snippet: examples/codegen/client.ts -->
```ts
// A typed client from the generated module: `node examples/codegen/client.ts ADDRESS`.
import { connect } from "varlink-js/node";
import { NoSuchNote, OrgExampleNotes } from "./org.example.notes.ts";

const address = process.argv[2];
if (address === undefined) throw new Error("usage: node examples/codegen/client.ts ADDRESS");

const conn = await connect(address);
try {
  const notes = OrgExampleNotes.client(conn); // also works with a Pool
  const { id } = await notes.Add({ text: "buy milk", tags: ["shopping"] });
  const { note } = await notes.Get({ id });
  console.log(`note ${String(note.id)}: ${note.text} [${note.tags.join(", ")}]`);

  for await (const reply of notes.List.stream()) console.log(`listed: ${reply.note?.text ?? "(none)"}`);

  try {
    await notes.Get({ id: 999 });
  } catch (e) {
    if (!NoSuchNote.is(e)) throw e;
    console.log(`no note ${String(e.parameters.id)}`); // e.parameters is typed { id: number }
  }
} finally {
  await conn.close();
}
```

Each method of a typed client is callable (one reply) and has `.stream()`, `.collect()` and `.oneway()`. Typed calls
decode their replies against the IDL as far as the connection's `validateReplies` allows: under the default `"off"`
(which typed calls treat as `"warn"`) a valid reply is decoded to its type, but an invalid one is delivered raw and
only reported to `onError` (reason `invalid-reply`); only an out-of-range integer still rejects. Use
`connect(address, { validateReplies: "throw" })` if every reply must match its type.

### Reference server

[`examples/reference-server.ts`](examples/reference-server.ts) is a small, safe server to point clients at:

```sh
node examples/reference-server.ts                                    # unix:./org.example.reference.sock, mode 0644
node examples/reference-server.ts --varlink=tcp:127.0.0.1:0          # prints the real port
node examples/client.ts unix:./org.example.reference.sock
```

It implements `org.example.reference` (a plain method, a streaming method, typed errors, a method safe to call as
oneway that keeps at most 16 messages of at most 1 KiB), refuses TCP hosts other than loopback (it never binds
`0.0.0.0` or `::`), refuses `unix:@` addresses (abstract sockets have no file permissions, so any local user could
connect), answers `GetInterfaceDescription` only from its registered interfaces (never from the file system), prints
`Listening on <address>` and shuts down gracefully on SIGINT/SIGTERM with exit code 0. A loopback TCP port is still open
to every local user; use the default unix socket for owner-only access. Refused addresses exit with 2
before anything is bound. All of that is checked by `test/docs/examples.test.ts`.

## Codegen

`generate(idl, options)` from `varlink-js/codegen` turns one interface into one TypeScript module:

<!-- snippet: examples/codegen/generate.ts#generate -->
```ts
const idl = readFileSync(new URL("org.example.notes.varlink", import.meta.url), "utf8");
const { fileName, code, constName } = generate(idl, options); // options: { ints?: "number" | "bigint", importPath? }
// fileName: "org.example.notes.ts", constName: "OrgExampleNotes"
```

The CLI does the same, from files or from a running service:

```sh
varlink-js codegen org.example.notes.varlink -o generated            # writes generated/org.example.notes.ts
varlink-js codegen --address unix:/run/org.example.sock org.example.notes -o generated
varlink-js codegen org.example.notes.varlink > notes.ts              # one input without -o: stdout
```

Options: `--ints=number|bigint` (default `number`), `--import-path=SPEC` (the module the generated code imports,
default `varlink-js`). `generateFromService(connOrPool, name)` is the API form of `--address`.

What a generated module exports, for an interface `org.example.notes` (descriptor name `OrgExampleNotes`):

| Export | What |
|---|---|
| `OrgExampleNotes_IDL` | The IDL text, verbatim (served by `GetInterfaceDescription`). |
| `Note`, … | One `type` per IDL `type`; named enums also get `<Name>_Values` (a const array). |
| `Add_Input`, `Add_Output`, … | Parameters and result of each method. |
| `NoSuchNote` (+ `NoSuchNote_Parameters`) | One class per IDL error, extending `VarlinkError`, with `errorName` and a static `is(e)` guard. |
| `OrgExampleNotes` | The descriptor: `name`, `idl`, `ints`, `methods`, `errors`, and `client(connOrPool)`. |
| `OrgExampleNotes_Client`, `OrgExampleNotes_Handlers`, `OrgExampleNotes_Descriptor` | The typed client, the handlers object for `server.implement()`, the descriptor type. |

The output is deterministic and starts with a header naming the generator version and the source's SHA-256, so it can
be committed; `examples/codegen/org.example.notes.ts` is, and a test regenerates it and fails if it is stale. The
`ints` mode is recorded in the descriptor and must match the connection's or server's (a `TypeError` otherwise, for
interfaces that use `int`). A typed server:

<!-- snippet: examples/codegen/server.ts -->
```ts
// A typed server from the generated module: `node examples/codegen/server.ts [ADDRESS]` (default tcp:127.0.0.1:0).
import { createServer, streamOf } from "varlink-js";
import { listen } from "varlink-js/node";
import { NoSuchNote, OrgExampleNotes, type Note } from "./org.example.notes.ts";

const notes = new Map<number, Note>();
let nextId = 1;

const server = createServer({ vendor: "Example", product: "notes", version: "1.0", url: "https://example.org" });
// Handlers are typed from the IDL: parameters, results and yielded replies.
server.implement(OrgExampleNotes, {
  Add({ text, tags }) {
    const id = nextId++;
    notes.set(id, { id, text, tags: tags ?? [] });
    return { id };
  },
  Get({ id }) {
    const note = notes.get(id);
    if (note === undefined) throw new NoSuchNote({ id }); // a generated error class
    return { note };
  },
  // streamOf() holds one item back so the last note goes out as the final reply.
  async *List() {
    return yield* streamOf([...notes.values()].map((note) => ({ note })));
  },
});

const listener = await listen(process.argv[2] ?? "tcp:127.0.0.1:0", { mode: 0o644 });
server.serve(listener);
const stop = (): void => {
  void server.shutdown().then(() => process.exit(0));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

// Handlers first, then the line the caller waits for, so an early signal still shuts down cleanly.
console.log(`Listening on ${listener.address}`);
```

## CLI

`varlink-js [OPTIONS…] COMMAND …` (`npx varlink-js` once installed; `node src/cli/main.ts` from a checkout).
`varlink-js --help` prints the full usage.

| Command | Does | varlinkctl |
|---|---|---|
| `info ADDRESS` | Service information (GetInfo) | `varlinkctl info` |
| `list-interfaces ADDRESS` | Interfaces of the service | `varlinkctl list-interfaces` |
| `list-methods ADDRESS [INTERFACE…]` | Methods of the service or of the given interfaces | `varlinkctl list-methods` (newer systemd; not in 255) |
| `introspect ADDRESS [INTERFACE…]` | Interface definitions (all when none given) | `varlinkctl introspect` |
| `call ADDRESS METHOD [PARAMETERS]` | Calls a method; parameters as a JSON object, or stdin | `varlinkctl call` |
| `validate-idl [FILE]` | Validates an interface definition | `varlinkctl validate-idl` |
| `format [FILE…]` | Canonical formatting (`--check`, `-i`) | libvarlink's `varlink format` |
| `codegen FILE…`, `codegen --address ADDRESS INTERFACE…` | TypeScript, see [Codegen](#codegen) | — |
| `bridge ADDRESS` | Raw bytes between stdin/stdout and ADDRESS, for `--bridge` style use (unix, `unix:@`, tcp only) | — |
| `certify server ADDRESS`, `certify client ADDRESS` | `org.varlink.certification` server / client | python/rust certification |

- `call --more` prints the replies as JSON-SEQ (RFC 7464) as they arrive, like varlinkctl; `-E` is
  `--more --timeout=infinity`; `--collect` prints one array; `--oneway` exits once the call is written;
  `--graceful=ERROR` treats that error reply as success.
- Global options: `--json=pretty|short|off`, `-j`, `-q`. `--timeout=SECS` (a systemd time span, default 45 s,
  `infinity` for none) is accepted by the commands that talk to a service: `info`, `list-interfaces`, `list-methods`,
  `introspect`, `call`, `codegen`, `bridge` and `certify` (not by `validate-idl` or `format`). Unlike the library's
  stream timeout, the CLI's timeout covers the connect and the whole call, `--more` included, as in varlinkctl.
- Exit status: 0 on success, 1 on any failure, 130/143 after SIGINT/SIGTERM; `call --exec` returns the command's
  exit status (128 + the signal number if a signal ended it); `certify server` exits 0 after a signal (it stops
  gracefully).
- `call --upgrade ADDRESS METHOD [PARAMS]` (as varlinkctl): after the confirming reply, stdin goes to the service and
  its bytes to stdout until both sides are done; parameters come from the command line only. `--upgrade --exec` is
  not supported.
- `call --push-fd=FD|PATH` and `call --exec ADDRESS METHOD PARAMS -- CMD…` (as varlinkctl; PARAMS is required) need the optional
  `varlink-js-native` addon (Linux; see `native/README.md`; `VARLINK_JS_NATIVE=<path to native/index.js>` points the
  CLI at a local build). Not available yet: `serve` and `list-registry`.
- Integers are lossless in the CLI (it uses `ints: "bigint"` internally): 2⁶³−1 and 2⁶⁴−1 round-trip.

## Addresses

`parseAddress()` (from `varlink-js`) parses every kind below; which function dials or listens depends on the kind.

| Kind | Example | Client | Server | Notes |
|---|---|---|---|---|
| unix path | `unix:/run/org.example.sock`, `/run/x.sock`, `./x.sock` | `connect` (`varlink-js/node`) | `listen` | `listen(address, { mode })` sets the socket's mode; an existing live socket is never replaced (`EADDRINUSE`). |
| abstract unix | `unix:@org.example` | `connect` | `listen` | Linux only; elsewhere `OperationNotSupportedError`. No file permissions: `mode` is ignored and any local user in the network namespace can connect. |
| tcp | `tcp:127.0.0.1:12345`, `tcp:[::1]:12345` | `connect` (`TCP_NODELAY`) | `listen` | Port 0 picks a free port (`listener.address` has the real one). Binds exactly the host given. |
| exec | `exec:/usr/libexec/org.example.service` | `connect`, `connectExec` | the child: `listenFromEnv()` / `listenAuto()` | Spawns the service with a connected socket as fd 3 (`LISTEN_FDS=1`). Tested on Node, Bun and Deno. |
| ssh | `ssh-unix:host:/run/x.sock` (alias `ssh:`), `ssh-exec:host:command` | `connect` | the remote side: `listenAuto()` with `SYSTEMD_VARLINK_LISTEN=-` | Runs `ssh` (or `$SYSTEMD_SSH`). CI uses a fake ssh (on Node, Bun and Deno); real ssh is not tested in CI. |
| inherited socket | fd from systemd | — | `listen({ fd })`, `listenFromEnv()` | Socket activation, see below. |
| stdio | a command line | `connectBridge(argv)` | `listenStdio()` | Speaks varlink over a child's stdin/stdout / our own. Tested on Node, Bun and Deno. |
| WebSocket | `ws://host/…`, `wss://…`, `https://host/ws/services/<service>` | `connect`, `createPool` (`varlink-js/websocket`) | — | Needs `globalThis.WebSocket` or the `WebSocket` option. No server side. |
| HTTP | `https://host/…` (a varlink HTTP bridge) | `createHttpClient` (`varlink-js/http`) | — | No oneway (rejects), no upgrade, one request per call. No server side. |
| any `ByteChannel` | your own transport | `createConnection(channel)` | `server.handle(channel)`, `server.serve(listener)` | `varlink-js/testing` `pair()` gives an in-memory pair. |

`connect()` from `varlink-js/node` rejects WebSocket and HTTP addresses with `OperationNotSupportedError`; use the
subpaths above.

## Limits and defaults

| Limit | Default | Option | Checked by |
|---|---|---|---|
| Largest message (client, server, HTTP client) | 16 MiB | `maxMessageSize` | `test/docs/defaults.test.ts`, `test/unit/protocol/framer.test.ts` |
| Complete calls buffered per server connection (then reading stops) | 64 | `maxQueuedCalls` (server) | `test/docs/defaults.test.ts`, `test/unit/protocol/server-session.test.ts` |
| Received fds held by buffered, not yet dispatched calls per server connection (then reading stops; one message carrying more is still accepted). The framer holds at most `maxQueuedFds` − 1 + one read's fds, plus the fds of the call being handled: about 758 per connection in the worst case at the default (sd-varlink holds 253) | 253 (`SCM_MAX_FD`) | `maxQueuedFds` (server, with `allowFdPassingInput`) | `test/unit/protocol/server-session.test.ts`, `test/unit/rpc/server.test.ts`; `test/docs/defaults.test.ts` checks the constant's value only |
| Open server connections (more are closed at once) | 4096 | `maxConnections` (server) | `test/docs/defaults.test.ts` |
| Connections per UID | off (opt-in, as sd-varlink's `SD_VARLINK_SERVER_ACCOUNT_UID`; needs the native addon) | `maxConnectionsPerUid` (server) | `test/unit/rpc/server-peer.test.ts` |
| Call timeout (clock starts at the head of the reply queue) | 45 s, 0 = none | `timeout` (connection, or per call) | `test/docs/defaults.test.ts`, `test/unit/rpc/connection.test.ts` |
| Connect phase (`connect()`) | the same `timeout` (45 s) | `timeout`, `signal` | `test/docs/defaults.test.ts`, `test/unit/node/connect.test.ts` |
| Stream replies buffered unread (then reading pauses) | 64 | `highWaterMark` (connection) | `test/docs/defaults.test.ts`, `test/unit/rpc/connection.test.ts` |
| `collect()` replies (more: `RangeError`, connection closed) | 1024 | `max` (per call) | `test/unit/rpc/connection.test.ts`; `test/docs/defaults.test.ts` checks the constant's value only |
| Pool connections | 8 | `max` (pool) | `test/docs/defaults.test.ts` |
| Pool idle connection lifetime | 30 s, 0 = forever | `idleTimeout` (pool) | `test/docs/defaults.test.ts` |
| Pool wait for a connection | 45 s, 0 = forever | `timeout` (pool, or per call) | `test/docs/defaults.test.ts` |
| Graceful shutdown deadline | 5 s, 0 = none | `server.shutdown({ timeout })` | `test/docs/defaults.test.ts`, `test/unit/rpc/server.test.ts` |
| Idle timeout of server connections | none (an idle client is never dropped) | — | `test/regression/e2e.test.ts` |
| JSON nesting when decoding | 2048 levels | fixed | `test/unit/types/codec.test.ts` |
| Value nesting when validating | 1024 levels (`MAX_VALUE_DEPTH`) | fixed | `test/unit/types/validators.test.ts`; `test/docs/defaults.test.ts` checks the constant's value only |
| IDL type nesting | 64 levels (`MAX_TYPE_DEPTH`) | fixed | `test/unit/idl/errors.test.ts`; `test/docs/defaults.test.ts` checks the constant's value only |
| WebSocket bytes received but unread (then the socket is closed) | 64 MiB | `maxBufferedBytes` | `test/docs/defaults.test.ts` |
| WebSocket `write()` resolves while `bufferedAmount` is at most | 1 MiB | `writeHighWaterMark` | `test/docs/defaults.test.ts` |
| `LISTEN_FDS` accepted by `listenFromEnv()` | 1 … 1024 | — | `test/unit/node/activation.test.ts` |

`test/docs/defaults.test.ts` creates each object without the option and checks that it enforces the default (for
the sizes: exactly the default is accepted, one byte more is not), with a mocked clock for the times.

Options go to `connect()`/`createConnection()` (connection), `createServer()` (server), `createPool()` (pool),
`createHttpClient()` and `varlink-js/websocket` `connect()`. Each server connection handles one call at a time;
pipelined calls wait in its queue.

## Cancellation and timeouts

Varlink has no cancel message: a client that loses interest closes the connection (UAPI). So:

- **`signal` on a call** (`conn.call(m, p, { signal })`): the call rejects with `signal.reason`. If the call was not
  written yet (already aborted, or still queued behind others) it is just dropped and the connection stays open. If it
  was written, the connection is **closed**, and every other pending call on it rejects with `ConnectionClosedError`
  (its `cause` is the reason).
- **`timeout`** (default 45 s): the clock starts when the call reaches the head of the reply queue, not when it is
  queued, so a call waiting behind a long stream cannot time out. Expiry rejects with `CallTimeoutError` and closes the
  connection.
- **Streams**: for `stream()`, `timeout` covers only the time to the first reply (subscriptions may run forever);
  `idleTimeout` (default none) limits the gap between replies. Leaving a `for await` early (`break`, `return`, a throw)
  closes the connection if the call was already written. A stream nobody reads stops the connection from reading
  after `highWaterMark` replies, so later calls on that connection wait behind it.
- **Independent cancellation**: use a `Pool`; each operation leases its own connection, so closing one does not affect
  the others.
- **`conn.close(reason)`** rejects every pending call with `ConnectionClosedError` (`cause` = reason).
- **Server side**: a handler's `ctx.signal` aborts when the client disconnects or the server shuts down; check it in
  long-running work. `ctx.notify(params)` (a `continues` reply from a plain async handler) rejects with
  `ConnectionClosedError` once the connection is gone. A oneway call to a generator handler runs only up to its first
  `yield`.
- **Graceful shutdown**: `server.shutdown()` closes the listeners, aborts every active call's signal but still writes
  its reply, drops calls that were buffered but not started, and closes what is left after `timeout` (5 s; `0` waits
  for every handler). `shutdown({ graceful: false })` closes everything at once. `server.closed` resolves after any
  shutdown.
- **HTTP mode**: a call's `signal` aborts its request; there is no connection to close.

## Errors

```text
Error
├─ VarlinkError                 an error reply on the wire: .error (name), .parameters; isVarlinkError(e, name?)
│   ├─ InterfaceNotFoundError, MethodNotFoundError, MethodNotImplementedError, InvalidParameterError,
│   │  PermissionDeniedError, ExpectedMoreError, ExpectedUpgradeError      (org.varlink.service)
│   ├─ InternalError            io.github.pzmarzly.varlinkjs.InternalError
│   └─ generated error classes  (codegen)
├─ VarlinkLocalError            never on the wire: .localName; isVarlinkLocalError(e, name?)
│   ├─ ConnectionClosedError, CallTimeoutError, UpgradePendingError, OperationNotSupportedError
│   ├─ ProtocolError ── MessageTooLargeError
│   ├─ ValidationError ── IntegerRangeError      (.parameter: dotted path of the bad value)
│   └─ HttpBridgeError          (varlink-js/http)
└─ IdlSyntaxError (a SyntaxError, varlink-js/idl)
```

- An aborted call rejects with the signal's own reason (whatever was passed to `abort(reason)`; by default an
  `AbortError` `DOMException`, a `TimeoutError` one for `AbortSignal.timeout()`), not a wrapper.
- `isVarlinkError(e, name?)` and `isVarlinkLocalError(e, localName?)` are brand checks, so they work even with two
  copies of the library loaded. The standard error classes, `InternalError` and generated error classes also have a
  static `is(e)` (e.g. `MethodNotFoundError.is(e)`); the local error classes, `HttpBridgeError` and `IdlSyntaxError`
  do not. Check a local error by its `localName`: `io.systemd.Disconnected` (`ConnectionClosedError`),
  `io.systemd.TimedOut` (`CallTimeoutError`), `io.systemd.Protocol` (`ProtocolError`, `MessageTooLargeError`),
  `org.varlink.service.InvalidParameter` (`ValidationError`, `IntegerRangeError`), `varlink-js.UpgradePending`,
  `varlink-js.OperationNotSupported`, `varlink-js.HttpBridge`.
- Clients map error replies to classes: the standard errors and `InternalError` always, generated classes once their
  interface is registered (`X.client(conn)` does that). Unknown names give a plain `VarlinkError` with the name and
  parameters intact.
- Servers send standard errors per the UAPI dispatch rules: an unknown interface gives `InterfaceNotFound`, an unknown
  method of a known interface `MethodNotFound`, a method without a handler `MethodNotImplemented`, parameters that fail
  validation `InvalidParameter` (with the dotted path), a method marked `[Requires 'more' flag]` called without `more`
  `ExpectedMore`. Nothing at all is sent for a oneway call, errors included.
- **Typed errors**: throw a `VarlinkError` (`new VarlinkError("org.example.demo.OutOfRange", { n, max })`) or a
  generated class (`new NoSuchNote({ id })`). When the error's interface is registered on the server, the error must be
  declared there and its parameters must match; otherwise the client gets `InternalError` instead and `onError` is
  called with reason `invalid-error`. Errors of interfaces the server does not know are sent unchecked.
- **Unexpected exceptions**: a handler that throws anything that is not a `VarlinkError` makes the server reply
  `io.github.pzmarzly.varlinkjs.InternalError` with no parameters. The details (message, stack) go only to the
  server's `onError(error, { method, reason })` hook (default: a one-line `console.warn` with the reason), never to
  the client. Every server registers the interface `io.github.pzmarzly.varlinkjs` (the constant
  `INTERNAL_ERROR_INTERFACE`), so the error is introspectable. The interface name is provisional (DESIGN §9 Q2) and may
  change before 1.0.

## Integers

| `ints` | `int` is | Notes |
|---|---|---|
| `"number"` (default) | `number` | A validated value outside ±(2⁵³−1) fails with `IntegerRangeError` instead of losing precision: a server answers `InvalidParameter`, a typed call rejects. Unvalidated replies (untyped calls, `validateReplies: "off"`) keep such values as `bigint`. |
| `"bigint"` (opt-in) | `bigint` | Exact 64-bit values. Needs `JSON.parse` revivers with `context.source` and `JSON.rawJSON` (Node.js ≥ 22.12 has both; the CI `floor` job checks 22.12.0); without them `OperationNotSupportedError`. |

Set it on `connect()`/`createConnection()`, `createServer()`, `createHttpClient()` and `generate()`/`--ints`; a
generated descriptor must match its target's mode when the interface uses `int`.

## Socket activation and friends

All from `varlink-js/node`:

- `await listenFromEnv()`: the sockets systemd passed (`LISTEN_FDS`, `LISTEN_PID`, the fds named `varlink` in
  `LISTEN_FDNAMES`, or another name with `{ name }`), or `null` if the process was not socket-activated or no fd has
  that name. systemd names an fd after its socket unit unless the unit sets `FileDescriptorName=varlink`, so without
  that line you get `null`. Only when `LISTEN_FDNAMES` is absent is a single fd used whatever its name. Unsets the
  variables.
- `listenAuto()`: `listenFromEnv()` plus `$SYSTEMD_VARLINK_LISTEN` (an address, or `-` for stdio), merged into one
  listener, or `null`.
- `listenStdio()`: one connection over stdin/stdout. A stdio-served process must exit when that connection ends
  (`exitOnIdle` plus `await server.closed`).
- `createServer({ exitOnIdle: ms })`: once serving, the server shuts down after `ms` without any open connection;
  `await server.closed` then exit.
- Registry (`/run/varlink/registry`, systemd ≥ 260): `server.serve(listener, { registry: true })` publishes a unix
  socket listener under its interface names and removes the entries at shutdown (except for a socket-activated
  `{ fd }` listener: the socket belongs to the service manager and outlives us, so its entries stay); `listRegistry()`,
  `resolveInterface(name)` (registry first, then `org.varlink.resolver`).

Activation fds are close-on-exec only when `listenFromEnv` gets the native addon (`{ native }`); without it, children
you spawn yourself inherit them.
`LISTEN_PIDFDID` is ignored.

## Runtimes

| Runtime | CI | What runs |
|---|---|---|
| Node.js 22, 24, 26 (latest of each) | `ci.yml` `test` | everything (`npm test`), plus `npm pack` and the consumer fixture |
| Node.js 22.12.0 (the `engines` floor) | `ci.yml` `floor` | compiled `runtime-features` and `exports` tests, the packed tarball |
| Bun (latest) | `runtimes.yml` `bun` | `test/unit` and `test/regression` (on Linux), the spawn (`exec:`, fake ssh, bridge) and activation tests included. Skipped on Bun: the three abort/timeout-during-spawn tests of `test/unit/node/spawn.test.ts` (no `child_process` diagnostics channel), its bridge test that needs EOF from a still-running stdio server (`process.stdout.end()` sends no FIN), the "no timers once shut down" test of `test/unit/rpc/exit-on-idle.test.ts`, and the cross-copy `isVarlinkError` test of `test/regression/tooling.test.ts` (Bun's module cache ignores the query). The `listen({ fd })` tests of `test/unit/node/fd.test.ts` skip themselves on any runtime whose `net.Server` exposes no fd |
| Deno 2 | `runtimes.yml` `deno` | the same suites. Skipped on Deno: the same stdio-EOF bridge test, and the "nonblocking" connected activation fd tests of `test/unit/node/connected-fd.test.ts` (a `net.Socket` has no real fd) |
| Browsers | — | `varlink-js`, `varlink-js/websocket`, `varlink-js/http` and `varlink-js/idl` import nothing from Node (a lint rule and a typecheck without `@types/node` enforce it), but no browser test runs in CI |

## What is tested where

| Feature | Tests | CI job |
|---|---|---|
| Regressions of the 0.1.x bugs (F1–F17: crashes, oneway replies, wrong standard errors, timeouts, unbounded buffers, …) | `test/regression/e2e.test.ts`, `test/regression/session.test.ts`, `test/regression/sockets.test.ts` | `ci.yml` test; `runtimes.yml` bun, deno |
| Protocol: framing, message rules, dispatch table | `test/unit/protocol/` | `ci.yml` test; bun, deno |
| Connection: timeouts, abort, streams, collect, backpressure | `test/unit/rpc/connection.test.ts` | `ci.yml` test; bun, deno |
| Server: registration, limits, shutdown, InternalError | `test/unit/rpc/server.test.ts`, `test/fuzz/server.test.ts` | `ci.yml` test; bun, deno (fuzz: `ci.yml` only) |
| Pool | `test/unit/rpc/pool.test.ts` | `ci.yml` test; bun, deno |
| The defaults in this README | `test/docs/defaults.test.ts` | `ci.yml` test |
| unix and tcp `connect`/`listen`, socket mode | `test/unit/node/connect.test.ts`, `test/unit/node/listen.test.ts` | `ci.yml` test; bun, deno |
| `unix:@` (Linux) | `test/unit/node/abstract.test.ts` | `ci.yml` test; bun, deno |
| `exec:`, ssh (fake ssh), bridge | `test/unit/node/spawn.test.ts`, `test/unit/node/spawn-channel.test.ts`, `test/unit/cli/call.test.ts` | `ci.yml` test; bun, deno (a few tests skipped, see [Runtimes](#runtimes)) |
| Socket activation, `listenAuto`, stdio, `listen({ fd })` | `test/unit/node/activation.test.ts`, `test/unit/node/connected-fd.test.ts`, `test/unit/node/fd.test.ts` | `ci.yml` test; bun, deno (Deno skips the nonblocking connected-fd tests; the `listen({ fd })` tests skip themselves on a runtime whose `net.Server` exposes no fd) |
| Real `systemd-socket-activate`, `varlinkctl exec:`, the registry via `varlinkctl` (each runs only when its tool is on `PATH` and skips silently otherwise; nothing makes CI fail if the runner lacks it) | `test/interop/vm/socket-activate.test.ts`, `test/interop/vm/varlinkctl-exec.test.ts`, `test/interop/vm/registry.test.ts` | `ci.yml` test |
| `exitOnIdle` | `test/unit/rpc/exit-on-idle.test.ts` | `ci.yml` test; bun, deno (one test skipped on Bun) |
| Registry, resolver | `test/unit/node/registry.test.ts`, `test/unit/node/registry-serve.test.ts`, `test/unit/node/resolver.test.ts` | `ci.yml` test; bun, deno |
| WebSocket and HTTP clients | `test/unit/websocket/`, `test/unit/http/` | `ci.yml` test; bun, deno |
| IDL parser, validator, formatter (corpus incl. systemd interfaces) | `test/unit/idl/` | `ci.yml` test; bun, deno |
| Codegen | `test/unit/codegen/` | `ci.yml` test; bun, deno |
| CLI, in-process | `test/unit/cli/` | `ci.yml` test; bun, deno |
| CLI as a process (signals, EPIPE, bridge, certify) | `test/e2e/cli/cli.test.ts` | `ci.yml` test |
| Certification, JS client ↔ JS server | `test/interop/certification.test.ts` | `ci.yml` test; `interop.yml` python |
| python-varlink certification both ways, unix and tcp | `test/interop/python.test.ts` | `interop.yml` python (ubuntu, macOS) |
| rust varlink certification both ways, unix and tcp | `test/interop/rust.test.ts` | `interop.yml` rust |
| `varlinkctl` against our server, `validate-idl`, the userdb Multiplexer | `test/interop/varlinkctl.test.ts` | `interop.yml` varlinkctl (systemd 255 and 259) |
| `exports` map, the packed package in a consumer project | `test/unit/exports.test.ts`, `test/fixtures/consumer/run.js` | `ci.yml` test, floor |
| Examples, README/MIGRATION code blocks, release workflow guards | `test/docs/examples.test.ts`, `test/docs/snippets.test.ts`, `test/docs/release-workflow.test.ts` | `ci.yml` test |
| Runtime layering (no Node imports in the portable entry points) | `test/tooling/lint-boundaries.test.ts` | `ci.yml` test |

**Not covered by CI:**

- Real ssh (`test/interop/vm/ssh.test.ts` needs `VARLINK_SSH_*` variables) and `systemd-pcrextend` as root
  (`test/interop/vm/pcrextend.test.ts`).
- The non-Linux rejection of `unix:@` (`test/unit/node/connect.test.ts`, `test/unit/node/listen.test.ts`): every
  `ci.yml` job runs on Linux.
- Byte-for-byte comparison of the CLI's output with varlinkctl: done by hand against systemd 255
  (`test/e2e/cli/varlinkctl/`).
- Windows and browsers. On Bun and Deno: everything outside `test/unit` and `test/regression` (the CLI as a process
  in `test/e2e`, the examples and docs checks in `test/docs`, `test/fuzz`, `test/interop`), plus the skips listed
  under [Runtimes](#runtimes).

## Not yet implemented

- **No prebuilt binaries for `varlink-js-native`** (fd passing, peer credentials, per-UID limits, `user.varlink`
  xattr): it is built from source with a C compiler, Linux only, and not published. Without it those features are
  absent and fd-using calls fail with `OperationNotSupportedError`.
- **No WebSocket or HTTP server**: those subpaths are clients only.
- **HTTP mode has no oneway calls** (`HttpClient.oneway()` rejects with `OperationNotSupportedError`).
- The `org.varlink.resolver` client does `Resolve` and `GetInfo` only, untyped; there is no resolver server.

## Certification

[`examples/certification/`](examples/certification/) has an `org.varlink.certification` server and client:

```sh
node examples/certification/server.ts --varlink=tcp:127.0.0.1:0       # prints the port
python -m varlink.tests.test_certification --client --varlink=tcp:127.0.0.1:<port>

python -u -m varlink.tests.test_certification --varlink=tcp:127.0.0.1:12345 &
node examples/certification/client.ts --varlink=tcp:127.0.0.1:12345
```

The rust `varlink-certification` binary works the same way (`--varlink=…` / `--client --varlink=…`); see
[examples/certification/README.md](examples/certification/README.md). CI runs python-varlink 31.0.0 (ubuntu and
macOS) and rust varlink (a pinned commit) both ways over unix and tcp (`interop.yml`).

## License

MIT, see [LICENSE](LICENSE).
