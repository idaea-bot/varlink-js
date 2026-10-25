# varlink-js v1: rewrite design

Status: **draft for review** (Pawel). Branch `rewrite` in `idaea-bot/varlink-js`.
Author: OSS Maintainer bot (Idaea), 2026-10-25.

Pawel's brief: *"varlink-js is a good idea (and pluggable design) but bad execution and it's missing a
lot of features compared to the C version. Create a fork and rewrite the entire thing. Feel free to
change the API."*

This document fixes the goals, the architecture, the public API, the error model, the test strategy,
packaging and the milestone plan. Section 9 lists the open questions that need a decision from Pawel;
everything else is decided here, so implementation cards don't have to re-decide it.

---

## 0. Sources

Normative:

- **UAPI.20 "Varlink IPC"** (<https://uapi-group.org/specifications/specs/varlink/>, v0.1). It
  consolidates varlink.org and adds the parts varlink.org never specified: nullable/absent
  equivalence, unknown-field rules, header validation, connection lifecycle, the `AF_UNIX` binding
  (framing, fd passing, peer credentials, `user.varlink` xattr, `/run/varlink/registry/`), socket
  activation (`LISTEN_FDNAMES=varlink`), and the HTTP and WebSocket transports. **v1 targets UAPI.20.**
- varlink.org (Interface-Definition, Method-Call, Service, Language-Bindings/certification).

Reference implementations read for this design (shallow clones, 2026-10-25):

| Impl | Commit | Files read |
|---|---|---|
| systemd `sd-varlink` + `varlinkctl` (v262 man page) | `systemd/systemd@a48a1f2` | `src/libsystemd/sd-varlink/{sd-varlink.c,sd-varlink-idl.c}`, `src/systemd/sd-varlink*.h`, `src/libsystemd/sd-json/json-stream.c` |
| libvarlink (C, varlink.org reference) | `varlink/libvarlink@2ad4ec7` | `lib/{uri.c,service.c,varlink.h}`, `tool/*` |
| python-varlink | `varlink/python@3556678` | `varlink/{client,server,scanner,cli}.py`, `tests/test_certification.py` |
| rust varlink | `varlink/rust@2041093` | `varlink/src/{client,server,lib}.rs`, `sansio/`, `varlink-cli`, `varlink_generator` |
| varlink-js 0.1.2 (this repo) | `ac28a30` | all of `src/`, plus the review `~/oss/data/review-varlink-js.md` (F1–F18) |

Facts from those sources that shape this design:

- sd-varlink defaults: method-call timeout **45 s** (`VARLINK_DEFAULT_TIMEOUT_USEC`, sd-varlink.c:47);
  max **4096** server connections, **128 per UID** (sd-varlink.c:44-45); input buffer max **16 MiB**
  (`JSON_STREAM_BUFFER_MAX_DEFAULT`, json-stream.c:26); `collect` max 1024 replies (sd-varlink.c:48);
  max 253 fds per message (`SCM_MAX_FD`, sd-varlink.c:3210).
- sd-varlink address schemes: `unix:` (path or `@abstract`), `exec:`, `ssh:`/`ssh-unix:`, `ssh-exec:`,
  plus *bridge helper binaries* for any other scheme (`$SYSTEMD_VARLINK_BRIDGES_DIR/<scheme>`,
  sd-varlink.c:533-575). **systemd has no `tcp:`.** libvarlink has `unix:`, `tcp:`, `device:` (uri.c:72-105);
  python and rust have `unix:`, `unix:@`, `tcp:`, plus `--activate` and `--bridge`.
- systemd encodes per-method flags in the IDL as doc comments `# [Supports 'more' flag]`,
  `# [Requires 'more' flag]`, `# [Supports 'upgrade' flag]`, `# [Requires 'upgrade' flag]`, and
  `# [Experimental]` (sd-varlink-idl.c:88,428-442). They are declared "part of the API" there and used by
  varlink-http-bridge. v1 parses and emits them.
- systemd local (client-side) error names: `io.systemd.Disconnected`, `io.systemd.TimedOut`,
  `io.systemd.Protocol`, `io.systemd.System` (sd-varlink.h:344-349).
- `varlinkctl` commands: `info`, `list-interfaces`, `list-methods`, `introspect`, `call`
  (`--more`, `-E`, `--collect`, `--oneway`, `--upgrade`, `--json=`, `-j`, `-q`, `--graceful=`,
  `--timeout=`, `--exec`, `--push-fd=`), `serve`, `list-registry`, `list-sockets`, `validate-idl`.
  libvarlink/python/rust CLIs: `info`, `help`, `call`, `bridge`, `format` (C, rust), `resolve` (C).
- rust varlink has a **sans-IO** protocol core (`varlink/src/sansio/`), separate sync/async I/O on top.
  v1 copies that idea.
- python-varlink certification: `python -m varlink.tests.test_certification --varlink=ADDR` (server) and
  `--client --varlink=ADDR` (client); Test10 exercises `more`, Test11 `oneway`.
- Node 26.12.1 (this Mac): `JSON.parse` reviver receives `context.source`, and `JSON.rawJSON` exists
  (verified by running). That gives exact 64-bit integers without a custom JSON parser. Node 22.12.0, the
  `engines` floor, has both too (M0: `test/unit/runtime-features.test.ts`, compiled, run on v22.12.0; the CI
  `floor` job repeats it on every push).

---

## 1. Goals and non-goals

### Goals

1. **Spec-correct**: conform to UAPI.20, including the MUST/SHOULD rules the old code breaks (oneway
   silence, header validation, close on malformed input, `MethodNotFound` vs `InterfaceNotFound`,
   `ExpectedMore`, `continues` only with `more`, absent ≡ `null` for `?T`).
2. **Robust**: no input from a peer can crash the process or wedge a connection. Bounded memory
   (message size, queue length, connection count). Every call either settles or fails within its
   timeout/abort. This closes all of F1–F18.
3. **Interoperable with systemd**: `varlinkctl` can introspect and call a varlink-js service, and
   varlink-js can call real `io.systemd.*` services (userdb, resolved, hostnamed), including `more`
   and (Linux, optional native addon) fd passing.
4. **Full IDL support**: parser, validator, canonical formatter, doc comments (incl. field comments and
   systemd annotations), runtime type validation of every type (struct, enum, `?`, `[]`, `[string]`,
   `object`, `any`, named refs), and **codegen** from `.varlink` to TypeScript.
5. **Pluggable** (what Pawel liked about the original): sans-IO core; transports, JSON codec and runtime
   are adapters behind small interfaces. Node first; Bun and Deno via their `node:` compat (native
   adapters only if needed); browsers via the standardised WebSocket mode.
6. **Pleasant API**: one-line connect by address string, typed calls from generated code, streaming as
   async iterators, `AbortSignal` everywhere, servers that implement `org.varlink.service` for you.
7. **CLI** comparable to `varlinkctl` / `varlink` (info, introspect, call, format, validate, codegen, bridge).
8. **Certified**: python-varlink certification in CI, both directions.

### Non-goals (v1)

- CommonJS output. ESM only; Node ≥ 22.12 can `require()` ESM without a flag (fixes F10/F11 by construction).
- Node < 22.12, browsers without a bridge (no raw sockets in browsers).
- Being a varlink *HTTP bridge server* (systemd has `varlink-http-bridge`). v1 ships the **client** side of
  HTTP/WebSocket mode only; a tiny Node WebSocket bridge may come later as an example.
- systemd's bridge-helper directory for arbitrary schemes, `list-sockets` (sock_diag), `serve`
  (fork+exec per connection). Possible later.
- `device:` addresses (libvarlink, kernel varlink module; dead upstream).
- `org.varlink.resolver` as a *server*. v1 has a client-side resolver only (§4.6).
- Compatibility shims for the 0.1.x API. A migration guide replaces them (§8, M12).

---

## 2. Feature matrix

Legend: ✅ supported · ◐ partial · ❌ missing · — not applicable. "C" = libvarlink. "sd" = sd-varlink +
varlinkctl. "Old" = varlink-js 0.1.2. "New" = this design, with the milestone that delivers it.
Cells for C/sd/python/rust come from reading their sources (paths in §0), not from running them. `?` = not checked; filling those in isn't needed for the design.

| Feature | C | sd | py | rust | Old | New |
|---|---|---|---|---|---|---|
| **IDL** parser | ✅ | ✅ | ✅ `scanner.py` | ✅ `varlink_parser` | ❌ | ✅ M1 |
| IDL semantic checks (unique names, refs resolve) | ? | ✅ | ? | ? | ❌ | ✅ M1 |
| Canonical formatter / pretty-print | ✅ `format` | ✅ `validate-idl` | ❌ | ✅ `format` | ❌ | ✅ M1 |
| Doc comments on members / fields | ✅ | ✅ (incl. field comments) | ✅ (members) | ✅ (members) | ❌ | ✅ M1 |
| systemd `[Supports/Requires 'more'/'upgrade']`, `[Experimental]` | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ M1 |
| **Type validation** of call params (server) | ? | ✅ `validate_method_call` | ✅ `scanner.py` | ◐ (serde, via codegen) | ❌ (TODO comments) | ✅ M2 |
| Validation of replies | ? | ✅ `validate_method_reply` | ? | ◐ | ❌ | ✅ M4 (`validateReplies`; server default warn) |
| Unknown input fields → `InvalidParameter` | ? | ? | ✅ | ? | ❌ | ✅ M2 |
| 64-bit ints without precision loss | ✅ | ✅ | ✅ | ✅ | ❌ (silent loss) | ✅ M2 (`bigint` mode / reject unsafe) |
| **org.varlink.service** auto (GetInfo, GetInterfaceDescription) | ✅ | ✅ | ✅ | ✅ | ❌ (hand-written, F9 file read) | ✅ M4 |
| Correct standard errors (`MethodNotFound`, `InterfaceNotFound`, `ExpectedMore`, `ExpectedUpgrade`) | ◐ | ✅ | ◐ | ? | ❌ (F6) | ✅ M3 |
| Typed interface errors | ◐ (by name) | ◐ (by name) | ✅ | ✅ (codegen) | ◐ (broken in CJS, F11) | ✅ M2/M6 |
| `oneway` (never reply) | ✅ | ✅ | ✅ | ✅ | ❌ (F5) | ✅ M3 |
| `more` / streaming | ✅ | ✅ (`observe`, `collect`, `notify`) | ✅ | ✅ | ◐ (callback, no backpressure) | ✅ M3/M4 async iterators |
| `upgrade` | ❌ | ✅ (v261 varlinkctl) | ◐ | ✅ `call_upgraded` | ❌ | ✅ M9 |
| Pipelining several calls on one connection | ? | ✅ (not for `more`) | ? | ? | ❌ | ✅ M3 |
| `unix:` path | ✅ | ✅ | ✅ | ✅ | ✅ (via options obj) | ✅ M4 |
| `unix:@abstract` | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ M4 (Linux; verify in VM) |
| `tcp:` | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ M4 |
| `exec:` / `--activate` (spawn service with `LISTEN_FDS`) | ✅ `--activate` | ✅ (socketpair as fd 3) | ✅ | ✅ | ❌ | ✅ M8 |
| Serve on stdio (`SYSTEMD_VARLINK_LISTEN=-`) | ? | ✅ | ? | ? | ❌ | ✅ M8 |
| `ssh-unix:` / `ssh-exec:` | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ M8 |
| Bridge (spawn command, speak on its stdio) | ✅ `--bridge` | ◐ (bridge helpers) | ✅ | ✅ | ❌ | ✅ M8 |
| HTTP simple mode / WebSocket mode (client) | ❌ | — (separate bridge) | ❌ | ❌ | ❌ | ✅ M10 |
| Socket activation (`LISTEN_FDS`, `LISTEN_FDNAMES=varlink`) | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ M8 |
| `/run/varlink/registry/` lookup | ❌ | ✅ (v260) | ❌ | ❌ | ❌ | ✅ M8 |
| `org.varlink.resolver` client | ✅ | ❌ | ✅ | ✅ | ◐ (schema only) | ◐ M8 |
| fd passing (`SCM_RIGHTS`) | ❌ | ✅ (opt-in per direction) | ❌ | ❌ | ❌ | ✅ M11 (optional native addon, Linux) |
| Peer credentials (`SO_PEERCRED`/pidfd) | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ M11 (native addon) |
| `user.varlink` xattr tagging | ❌ | ✅ | ❌ | ❌ | ❌ | ◐ M11 (best effort, native addon) |
| Per-call timeout | — (caller's event loop) | ✅ (45 s default) | ? | ? | ❌ (socket idle timeout, crashes server, F1/F4) | ✅ M4 |
| Cancellation | — (close) | — (close) | — | — | ❌ | ✅ M4 `AbortSignal` (closes connection, per spec) |
| Write backpressure | ? | ✅ (output queue cap) | ? | ? | ❌ (hangs, F3) | ✅ M4 |
| Read backpressure for streams | ? | ? | ? | ? | ❌ | ✅ M4 |
| Max message size | ? | ✅ 16 MiB | ? | ? | ❌ (F15) | ✅ M3 (16 MiB default) |
| Connection limits (total / per UID) | ? | ✅ 4096 / 128 | ? | ◐ (worker cap) | ❌ | ✅ M4 (per-UID needs M11) |
| Exit-on-idle | ? | ✅ | ? | ✅ (listen idle timeout) | ❌ | ✅ M8 |
| Graceful shutdown | ? | ✅ (SIGINT/SIGTERM flags) | ? | ? | ❌ | ✅ M4 |
| Connection pool | — | — | — | — | ◐ (dead conns, F4) | ✅ M4 |
| **Codegen** `.varlink` → types | ❌ | — (C macros) | — (dynamic) | ✅ `varlink_generator` | ❌ (hand-written) | ✅ M6 |
| Dynamic client from introspection | ✅ (`call` any method) | ✅ | ✅ | ✅ | ◐ (`VarlinkDynamicMethod`) | ✅ M6 |
| **CLI** info / introspect / call / format / validate | ✅ | ✅ | ◐ (no format) | ✅ | ❌ | ✅ M7 |
| CLI `--more`/`--collect`/`--oneway`/`--upgrade`/`--timeout`/`--graceful` | ◐ | ✅ | ◐ | ◐ | ❌ | ✅ M7 (`--upgrade` M9) |
| Certification server + client | ✅ | — | ✅ (reference) | ✅ | ◐ (claimed, not in CI, F14) | ✅ M5 in CI both ways |
| Runtimes | — | — | — | — | Node, Bun (CI only) | Node 22/24/26 (CI), Bun, Deno 2 (M10), browser via WebSocket (M10) |
| Module format | — | — | — | — | CJS+ESM, no `exports` (F10, F11) | ESM only, `exports` map (M0) |

---

## 3. Lessons from 0.1.x (what the rewrite must not repeat)

Every item is from `~/oss/data/review-varlink-js.md` and was reproduced by running (except F15/F16:
read only). Each becomes a regression test (§7.2).

| ID | Bug | Root cause → design rule |
|---|---|---|
| F1 | Server process dies on client RST or idle timeout | Fire-and-forget `void this.#handleClient()`; `socket.destroy(new Error)`. → **Every connection task has a top-level catch; transport errors close that connection only. No socket idle timeout on the server.** |
| F2 | Malformed JSON crashes server | Unguarded `JSON.parse`. → **Decode errors are protocol errors: close the connection (UAPI "Connection Lifecycle").** |
| F3 | `send()` waits for a `flush` event that doesn't exist | → **Writes resolve on the write callback or `drain`, race `close`/`error`; writing to a closed transport throws.** |
| F4 | Pool hands out dead connections; calls hang | No close tracking. → **Connections own a `closed` promise; every pending call is rejected on close; pools evict closed connections.** |
| F5 | Server replies to `oneway` → replies off by one forever | → **The server never writes anything for a oneway call, including errors.** |
| F6 | Wrong standard errors, `more` rejected on plain methods | → **Dispatch table in §5.4 is the spec.** |
| F7 | `throw "x"` → no reply, client hangs | → **Every non-oneway call ends with exactly one final reply, whatever the handler throws.** |
| F8 | `EADDRINUSE` becomes uncaught exception | → **`listen()` rejects; later server errors go to an `onError` hook / event, never `throw` in a listener.** |
| F9 | Reference server reads arbitrary files | → **`GetInterfaceDescription` answers from the registered interface map only.** |
| F10/F11 | No `exports`; CJS duplicates `VarlinkError` | → **ESM only, one module graph, plus a `Symbol.for` brand so `isVarlinkError()` works across copies.** |
| F12/F13/F16 | Unpinned toolchain, EOL Node, `publish` script name | → **Lockfile committed, pinned prettier, Node 22/24/26 CI, `prepack` + `files`, tag-triggered release workflow (manual approval).** |
| F14 | Tests only cover the happy path | → **Regression suite per F-id, fault-injection transport, certification in CI.** |
| F15 | Unbounded buffer, O(n²) concat | → **Framer with `maxMessageSize` and a growable buffer (amortised O(n)).** |
| F17 | `continues:false` always sent | → **Serializer omits default fields.** |
| F18 | README overstates features (pooling, certification) | → **README claims are backed by CI jobs; M12 rewrites the README.** |

What to keep: the transport abstraction idea, typed method descriptors, async-first API, zero runtime deps.

---

## 4. Architecture

```
                  ┌───────────────────────── public API ─────────────────────────┐
                  │ connect()/Client/Pool   createServer()/Server   codegen   CLI │
                  └──────────────┬───────────────────────┬──────────────────────┘
                                 │                       │
        ┌────────── core (runtime-agnostic, no I/O, no node: imports) ─────────────┐
        │  idl/       parse · validate · format · AST                               │
        │  types/     compile AST → validators · JSON codec (int/bigint)           │
        │  protocol/  Framer (NUL, limits) · Call/Reply decode/encode               │
        │             ClientSession / ServerSession  (sans-IO state machines)       │
        │  errors/    VarlinkError + standard errors + registry                     │
        │  address/   parse address strings → AddressSpec                           │
        ├────────── rpc (runtime-agnostic, I/O only through ByteChannel) ───────────┤
        │  Connection · Pool · Server · org.varlink.service · introspection proxy  │
        └───────────────────────────────▲───────────────────────────────────────────┘
                                        │  ByteChannel (read / write / close / closed)
        ┌───────────── adapters ────────┴──────────────────────────────────────────┐
        │  node/       unix, unix:@, tcp, exec:, ssh-*:, stdio bridge, LISTEN_FDS    │
        │  websocket/  WebSocket mode client (browser + any runtime with WebSocket)  │
        │  http/       simple HTTP mode client (fetch)                               │
        │  native/     (optional pkg) SCM_RIGHTS, SO_PEERCRED, xattr — Linux N-API   │
        └───────────────────────────────────────────────────────────────────────────┘
```

Rule: `src/core/**` and `src/rpc/**` (and the browser-facing `src/index.ts`, `src/idl`, `src/websocket`, `src/http`, plus the generated `src/interfaces`, which rpc may import for its built-in `org.varlink.service`) must not import `node:*` or read `process`/`Deno`/`Bun` globals (ESLint layer rules plus a no-`@types/node` typecheck, §8). That is what keeps
the browser/Deno/Bun story honest.

### 4.1 ByteChannel (the transport interface)

The one interface every transport implements. Pull-based, promise-returning, trivially adaptable from
Node sockets, Deno `Conn`, Bun sockets, WebSockets and Web Streams.

```ts
export interface ReadChunk {
  bytes: Uint8Array;
  /** fds that arrived with the first byte of `bytes` (SCM_RIGHTS). Only on fd-capable channels. */
  fds?: FdHandle[];
}

export interface ByteChannel {
  /** Next chunk, or null on orderly EOF. Rejects on transport error. Never called concurrently. */
  read(): Promise<ReadChunk | null>;
  /** Resolves when the chunk is handed to the OS (backpressure). Rejects if closed.
   *  `fds` are attached to the first byte of `chunk`; callers pass one whole message per call when sending fds. */
  write(chunk: Uint8Array, fds?: readonly FdHandle[]): Promise<void>;
  /** Half-close our side if supported, else close. */
  end(): Promise<void>;
  /** Hard close, idempotent. Pending read() resolves null / write() rejects. */
  close(reason?: unknown): void;
  /** Settles once, when the channel is fully closed (never rejects). */
  readonly closed: Promise<void>;
  /** Optional capabilities. Absent ⇒ not supported on this transport. */
  readonly capabilities: {
    fdPassing?: FdPassing;          // M11
    peer?: () => PeerCredentials;   // M11
  };
}

/** Owned file descriptor. Closing is the owner's job; unclaimed fds are closed when their message is done. */
export interface FdHandle { readonly fd: number; close(): void; }

export interface FdPassing {
  /** Receiving is opt-in (UAPI). Off by default; when off, SO_PASSRIGHTS is cleared where the kernel supports it
   *  (Linux ≥ 6.16) and any fds that still arrive are closed and the message rejected (protocol error). */
  setAcceptInput(on: boolean): void;
  setAllowOutput(on: boolean): void;
}

export interface PeerCredentials { uid: number; gid: number; pid: number; pidfd?: FdHandle; }

export interface Listener extends AsyncIterable<ByteChannel> {
  readonly address: string;          // canonical varlink address, e.g. "unix:/run/x" or "tcp:127.0.0.1:41234"
  close(): Promise<void>;
}
```

fd rules implemented above the channel (UAPI "Passing File Descriptors"): fds that arrive with a chunk
are bound to the message that chunk *starts*; fds arriving with a chunk that does not start a new
message are a protocol error (connection closed); handlers get `ctx.fds` and helpers
`ctx.takeFd(index)` which throw `InvalidParameter` on a missing index; senders write the whole message
plus its fds in one `write()`.

Helpers: `fromWebStreams({readable, writable})`, `fromNodeSocket(socket)`, `pair()` (in-memory, for
tests), `faulty(channel, plan)` (fault injection: split chunks at every byte, delay, RST mid-message).

### 4.2 Framer

- Splits on `NUL`, accumulates across reads (UAPI: MUST NOT assume one read = one message).
- `maxMessageSize` default **16 MiB** (sd-varlink default). Exceeded ⇒ `MessageTooLargeError`, connection closed.
- Buffer: single growable `Uint8Array` with read/write offsets (amortised O(n); fixes F15).
- Decodes UTF-8 with `TextDecoder({fatal: true})`: invalid UTF-8 is a protocol error.
- Exposes the unconsumed tail for `upgrade`: the upgraded channel is a wrapper `ByteChannel` that first yields
  the bytes the framer had already read past the confirming `NUL`, then delegates to the underlying channel.
  So no `unshift` is needed on transports.

### 4.3 Codec (JSON) and integers

```ts
export interface Codec {
  decode(text: string): unknown;   // throws ProtocolError on invalid JSON
  encode(value: unknown): string;  // throws on NaN/±Infinity (UAPI: MUST NOT be generated)
  readonly losslessInts: boolean;  // decode never rounds integers and encode can write bigint
}
```

The default codec is `JSON.parse` / `JSON.stringify` with two small additions:

- **Decode is lossless and type-agnostic.** The reviver checks `context.source` (verified on Node 26): an
  integer literal (`/^-?\d+$/`) that is not a safe integer becomes a `bigint` (integer literals of at most
  1024 characters; longer ones become `Infinity`, §4.9). Everything else, including floats like `1e300` and
  `1.5`, stays a `number`.
- **Encode** uses a replacer that throws on non-finite numbers (plain `JSON.stringify` would silently write
  `null`) and emits `bigint` with `JSON.rawJSON`.

Type-dependent integer policy lives in the **validation layer (M2)**, which knows the IDL. It is set per
client/server with `ints`:

- `"number"` (default, Q3): `int` fields are JS `number`s. An unsafe integer in an `int` field is rejected:
  the server replies `InvalidParameter` (UAPI lets implementations "return an error if they cannot handle a
  received number"), and the client rejects *that call* with `IntegerRangeError`, leaving the connection
  intact. Codegen types `int` as `number`.
- `"bigint"`: every `int` field is converted to `bigint` (codegen type `bigint`). This gives the full
  −2⁶³…2⁶⁴−1 range the spec recommends.
- Values inside `object`/`any`, and untyped calls without an IDL: unsafe integers come out as `bigint` (never
  rounded), safe ones as `number`. The decoder only sees the literal, so this also applies to what we send: an
  integer-valued JS `number` beyond ±(2⁵³−1) that we encode inside `object`/`any` (or any untyped value) is
  written as plain digits (`JSON.stringify` does so below 1e21; `2**60` → `1152921504606847000`), and a
  lossless peer, varlink-js included, decodes it as the `bigint` of those digits. Typed `int` slots are
  unaffected (they reject unsafe numbers), and typed `float` slots convert it back to `number`. Use `float`
  fields for approximate large values. Conversely a safe `bigint` in untyped content is written as plain
  digits and comes back as a `number`.
- UAPI allows accepting decimal strings for `int`; v1 does so only with `lenientInts: true`.

- `float` fields accept any finite JSON number; a `bigint` produced by the codec is converted to `number`
  there (floats are approximate by definition).

**Runtimes without `context.source`** (to check for Bun, Deno and browsers in M0/M10): the codec can't
recover the digits or tell `1e300` from a 301-digit integer. Rules there: an `int` field holding a value
that is not a safe integer is rejected (as in `"number"` mode); `float` fields are unaffected; values
inside `object`/`any` and untyped calls are plain (possibly rounded) `number`s, and this is documented.
`"bigint"` mode refuses to start with a clear error (it requires a codec whose `losslessInts` is true:
`context.source` plus `JSON.rawJSON`). With `context.source` (Node, verified), integer *literals* are never
rounded (at most 1024 characters; longer ones become `Infinity`, §4.9); float-syntax numbers such as
`9007199254740993.0` inside `object`/`any` are ordinary (possibly rounded) floats. A float `-0` round-trips
only where `JSON.rawJSON` exists (`JSON.stringify` writes it as `0`).

The codec is pluggable, so a faster or streaming JSON parser can be swapped in. Nothing else in core
parses or serializes messages (error messages may use `JSON.stringify` to quote names).

### 4.4 Protocol messages

```ts
type Call  = { method: string; parameters: Record<string, unknown>; oneway: boolean; more: boolean; upgrade: boolean; ext: Record<string, unknown> };
type Reply = { parameters: Record<string, unknown>; continues: boolean; error?: string; ext: Record<string, unknown> };
// Decoded form: absent/null parameters → {}, absent flags → false. Encoded form omits defaults.
```

Decoding enforces UAPI exactly. Every header is nullable in the spec (`oneway: ?bool`, `error: ?string`, …),
so `null` is treated as absent everywhere. All of these are **protocol errors → close connection**: top
level not an object; `method` missing/not a string; `error` neither string nor null; flags neither boolean nor null;
more than one of `oneway`/`more`/`upgrade` true; unknown **unprefixed** header key (keys containing `.` are
vendor extensions: kept in `ext`, otherwise ignored); `parameters` neither object nor `null`; reply with
`continues: true` and `error` together. `parameters` absent/`null`/`{}` are equivalent.
Rules that need call context (a `continues` reply to a call without `more`, a reply with no pending call)
are enforced in the sessions (§4.5), not in the decoder. A syntactically valid message whose `method`
is not a fully-qualified `interface.Method` gets a reply (§5.4), not a close.
Encoding always writes `parameters` (`{}` when empty, as sd-varlink does: some peers index it directly) and
omits false flags (no `continues:false`, `oneway:false`, …) and an absent `error` (F17).

### 4.5 Sessions (sans-IO state machines)

`ClientSession` and `ServerSession` are pure: they consume decoded messages and produce messages to
write plus events, with no timers and no I/O. The I/O drivers (`Connection` on top of a `ByteChannel`)
are thin. This makes the protocol logic unit-testable without sockets, and the same sessions serve
Node, Deno, Bun and WebSocket.

ClientSession:
- FIFO of pending calls (pipelining). Each entry: kind `single | more | upgrade`.
- `oneway` calls never enter the FIFO (they complete when written; they never consume a reply).
- A reply is matched to the head entry. `continues` keeps the head; final reply or error pops it.
- Reply without a pending call, or `continues` for a non-`more` call ⇒ protocol error ⇒ close.
- While an `upgrade` call is pending, new calls are rejected locally (`UpgradePendingError`). If the reply is an
  error, the connection stays a varlink connection (UAPI) and accepts calls again. If it succeeds, the session ends.
- On close: reject every pending entry with `ConnectionClosedError` (fixes F4).

ServerSession:
- Decodes ahead at most `maxQueuedCalls` calls, but **stops splitting the byte stream right after a call
  with `upgrade: true`** until that call resolves. Bytes after it may belong to the upgraded protocol
  and must never reach the JSON decoder.
- Processes calls strictly in order; does not hand out call N+1 until call N is finished: its final reply was
  produced by the session, or, for `oneway`, its handler settled (keeps side effects ordered). The driver
  awaits `dispatchCall`, which resolves only after `send` of the final reply resolved, so call N+1 starts after
  call N's reply was written. This is the UAPI ordering rule, and it also avoids reading past an `upgrade`.
  After an `upgrade` error reply, reading resumes.
- Produces exactly one final reply per non-oneway call, zero for oneway (F5, F7).
- Dispatch rules: §5.4.

### 4.6 Addresses and resolution

`parseAddress(s): AddressSpec`, accepting:

| Syntax | Meaning | Source |
|---|---|---|
| `unix:/abs/path`, `/abs/path`, `./rel/path` | AF_UNIX path | UAPI, varlinkctl |
| `unix:@name` | abstract namespace (Linux only) | UAPI |
| `tcp:host:port`, `tcp:[v6]:port` | TCP | UAPI (optional), C/py/rust |
| `exec:/abs/path` | spawn with socket activation (§5.8) | sd-varlink |
| `ssh-unix:host:/path` (alias `ssh:`) | `ssh -W /path host` (needs OpenSSH ≥ 9.4 remote) | sd-varlink.c:388 |
| `ssh-exec:host:cmdline` | `ssh -e none -T host env SYSTEMD_VARLINK_LISTEN=- cmdline`, varlink on its stdio | sd-varlink.c:445 |
| `ws://`, `wss://`, and `http://`/`https://` whose path ends in `/ws/services/{svc}` | WebSocket mode (full protocol) | UAPI |
| any other `http://`/`https://` URL | simple HTTP mode, URL = bridge base URL (no oneway/upgrade/pipelining); service via option or derived from the method | UAPI |

Anything after `;` is ignored (UAPI: future extensions). Programmatic `bridge: string[]` (spawn argv,
speak on its stdio) covers python/libvarlink `--bridge`.

Interface resolution (`resolveInterface("io.systemd.Hostname")`): `/run/varlink/registry/<iface>`
(then the `--user` registry `$XDG_RUNTIME_DIR/varlink/registry/`), then optional
`org.varlink.resolver` at `unix:/run/org.varlink.resolver`. *Verify the user registry path against
systemd before shipping M8.*

### 4.7 Runtime adapters

- **Node** (`varlink-js/node`): `node:net` (unix, tcp, abstract), `node:child_process` (exec/ssh/bridge),
  `server.listen({fd})` for socket activation.
- **Bun, Deno 2**: start by running the Node adapter through their `node:` compat; M10 adds CI jobs. Native
  adapters (`Bun.connect`, `Deno.connect`) only if CI shows gaps. Unknowns to test: abstract sockets,
  `listen({fd})`, half-close.
- **Browser**: `varlink-js/websocket` (WebSocket mode against systemd's `varlink-http-bridge` or any
  UAPI bridge). It's standardised now, so it is worth doing. No fds, as the spec says.
- **fd passing / peer credentials**: no JS runtime exposes `SCM_RIGHTS` or `SO_PEERCRED`. Plan: a
  separate optional package `varlink-js-native` (small N-API addon, Linux, prebuilt binaries) that
  provides a `ByteChannel` with `capabilities.fdPassing` and `.peer`. Prior art on npm to evaluate first:
  `usocket` ("unix local sockets with descriptor passing"), `peercred`. Without the addon those
  capabilities are simply absent and fd-using calls fail with `OperationNotSupportedError` locally.

### 4.8 IDL (M1)

`src/core/idl/` (re-exported by `varlink-js/idl`): `parseInterface`, `validateInterface`, `formatInterface`,
`formatType`, name predicates, `IdlSyntaxError` (`code`, `reason`, `position`). **AST**: an `Interface` holds
`members` in source order (`type` = struct or enum, `method` = input/output structs plus `more`/`upgrade`,
`error` = struct); types are `bool int float string object any`, `named`, `struct`, `enum`, `array` (`[]T`),
`map` (`[string]T`) and `nullable` (`?T`). Interfaces, members, fields and enum values carry `doc?` (lines
joined by `\n`) and `experimental`; parsed nodes carry optional `span`/`nameSpan` (UTF-16 offset, 1-based
line/column) so ASTs can also be built by hand, and `validateInterface` checks those like untrusted input.
- **Doc comments** (libvarlink-like): the block of full-line comments on the lines directly above an item
  whose token is first on its line; `#` and one space are stripped. Blank lines detach; trailing comments and
  comments elsewhere are not doc and are **dropped** (the formatter cannot keep them). Unlike libvarlink, a
  whitespace-only line detaches too (libvarlink only detaches on a truly empty line), and a trailing comment
  never starts a doc block (libvarlink would prepend it).
- **systemd markers** (sd-varlink-idl.c, "part of the API"): doc lines `[Experimental]` (any item) and, on
  methods, `[Supports|Requires 'more' flag]` / `[Supports|Requires 'upgrade' flag]` become flags and leave
  `doc`; "requires" wins. Validation rejects doc lines that would read back as markers. systemd also carries
  `[Experimental]` across blank lines and from trailing comments; we only read markers inside the doc block
  (real systemd output never relies on that).
- **Not enforced** (systemd-only rules; UAPI has none): `validate-idl`'s experimental consistency
  (`varlink_idl_field_consistent`: an experimental field in a non-experimental symbol must be nullable, no
  experimental values in a non-experimental enum, a non-experimental field must not reference an experimental
  type), and systemd's rejection of empty `()` (`type T ()`, `[string]()`), which UAPI allows.
- **Lenient** vs the UAPI grammar: zero-member interfaces (libvarlink and systemd accept them); whitespace,
  line breaks and comments before `,` (the PEG has no `_` there; it does allow `_*` before `)`); a final
  comment without a trailing newline (PEG `comment` must end in `eol_r`; a final member without one is legal);
  a trailing comment after whitespace at the end of an interface or member line (PEG `eol` only allows a
  comment directly after the code; libvarlink and systemd accept it too).
- **Strict**: nothing between `?`/`[]`/`[string]` and their element (the PEG has no `_` there); every member
  keyword must follow a line break; `?any` parses (it is grammatical); nesting is capped at 64 levels
  (`too-deep`), so neither parser nor validator can overflow the stack.
- **Formatter** = libvarlink `varlink format`, which is also the style of the UAPI examples: source order
  (systemd regroups by kind), 2-space indent (systemd: tabs), `type Name (…)` / `error Name (…)` but
  `method Name(…) -> (…)`, one blank line between members, comment lines `# text` or `#`. Before a method:
  doc, more marker, upgrade marker, `[Experimental]` (systemd's order). A struct/enum goes multiline if it has
  more than two fields (structs only), any commented item, a field typed directly as a struct or enum, or an
  inline form over 40 characters; nested types are laid out one level deeper even inside a single-line
  parent (libvarlink), and commented items get blank lines around them. Ten corpus files are already
  canonical (list in `test/unit/idl/corpus.test.ts`).

### 4.9 Types and errors (M2)

`src/core/types/` (codec, validators, descriptor types) and `src/core/errors/`, both re-exported by the root
entry.
- **Codec**: `createJsonCodec({sourceText?})` / `jsonCodec` as in §4.3. Features are detected when the codec
  is created; `losslessInts` = `context.source` && `JSON.rawJSON`; `sourceText: false` forces plain
  `JSON.parse`. Any `JSON.parse` failure is a `ProtocolError` with `cause`, and a non-string argument a
  `TypeError` (caller bug); encode throws `TypeError` (also for too deep values; an engine `RangeError`
  becomes a `TypeError` with `cause`). Limits: integer literals of at most 1024 characters become bigint
  (longer ones stay `Infinity`, an `int-range` in `int` slots), and more than 2048 `[`/`{` levels (sd-json
  `DEPTH_MAX`) is a `ProtocolError` on decode in both modes and a `TypeError` on encode (peers refuse it).
  bigints are written from the holder (read via its own data property, so a getter runs once), so a
  `BigInt.prototype.toJSON` polyfill is ignored. That defence covers data properties only: for an accessor the
  replacer sees only the getter's result after the polyfill's `toJSON`, and does not re-invoke the getter.
  Validator outputs are always data properties, so only by-reference `object`/`any` content with bigint
  getters is affected. A float `-0` stays `-0` where `JSON.rawJSON` exists (else it is written as `0`). Encode
  escapes U+007F as `\u007f` (sd-json refuses it raw). An integer-valued unsafe `number` in untyped content
  comes back from a lossless peer as a `bigint` (§4.3). The codec, like `JSON.stringify`, is O(length) on a
  sparse array; validator encode refuses arrays longer than `MAX_ENCODE_ARRAY_LENGTH` (8 Mi: each element
  needs at least 2 bytes, so such an array cannot fit in a default 16 MiB message) with `type` ("array too
  long to send") before copying them. It is a fixed v1 limit: raising `maxMessageSize` does not lift it, so
  such arrays can be received but not sent. Decode is bounded by the message size.
- **sd-json string rules**: systemd refuses strings containing NUL (`\u0000`); v1 allows them (valid JSON and
  Unicode; UAPI has no rule). `string` slots reject strings that are not well-formed UTF-16 (a lone surrogate
  has no UTF-8 encoding, and UAPI messages are UTF-8) in both directions (`type`), as do map keys (`type`, the
  path ends with the key) and `any` slots holding a string at the top level; nested `object`/`any` content is
  not checked for lone surrogates (sd-json refuses them).
- **Validators**: `compileInterface(ast, {ints, lenientInts, codec})` (runs `validateInterface` first;
  `"bigint"` needs `codec.losslessInts`) gives per method `input`/`output`, per error and per `type` a
  `Validator` with `decode(v, {unknownFields})` (from the peer: servers `reject` unknown struct fields,
  clients `drop` them in replies) and `encode(v)` (what we send: unknown fields are always our bug, rejected).
  Both return a new value and never mutate; the first problem (IDL field order, then unknown keys; array/key
  order) throws `ValidationError {path, parameter, reason}`, reason `missing | null | type | enum |
  unknown-field | int-range | too-deep`. `parameter` joins the path with `.` (indices in decimal, map keys
  raw, so a key containing `.` is ambiguous); it is the `InvalidParameter` parameter. Since path segments can
  come from the peer, `parameter` (and the message) pass string segments through `toWellFormed()` and are cut
  to 256 UTF-16 code units (on a code point boundary, then `…`), so they can always be sent back; `path` keeps
  the raw segments. The message quotes `parameter` JSON-style with C0/DEL/C1 controls and U+2028/U+2029 as
  `\uXXXX`, so a peer-chosen key cannot inject escapes or line breaks into logs. Messages name types, never
  values.
- **Per type**: `int` takes a safe-integer `number` (so `1.0`/`1e3` from JSON are 1/1000, as in sd-json; `-0`
  → 0) or a `bigint` in −2⁶³…2⁶⁴−1. A non-integer is `type`; an unsafe `number` (e.g. `1e18`, or a rounded
  value without `context.source`) is `int-range` in **both** modes, as is an out-of-range bigint
  (`IntegerRangeError`). Decode outputs `number` (`"number"`; an unsafe bigint is `int-range`) or `bigint`
  (`"bigint"`). Encode outputs a `number` as is (`-0` → 0); a bigint stays a bigint in `"bigint"` mode, while
  in `"number"` mode a safe one becomes a `number` and an unsafe one is passed through (written exactly with
  `JSON.rawJSON`; the codec throws without it). `lenientInts` lets decode accept `/^-?(0|[1-9][0-9]*)$/`
  strings. `float`: finite number, or a bigint whose `Number()` is finite (→ number on decode; on encode →
  number if exact, `BigInt(Number(v)) === v`, so it is sendable without `JSON.rawJSON`, else as given, exact
  on the wire). `object`: a plain object (prototype `Object.prototype` or `null`), returned by reference;
  objects from another realm (`vm`, iframes) are not plain objects and are rejected (`type`). `any`, in both
  directions: a boolean, finite number, bigint, well-formed string, array or plain object (not
  `JSON.rawJSON`); anything else is `type`/`null`, including functions, symbols, `Date`, `Map` and a top-level
  `Infinity` (from `1e400` or a too long literal; it could not be sent back). Only the top level is checked.
  Structs are plain objects; a field is present iff it is an own enumerable key (inherited `toString` etc. are
  never read). **Absent ≡ null ≡ undefined for `?T` fields, and the output omits them**; in arrays and maps a
  `?T` null stays `null` (array holes encode as `null`; `undefined` map values are skipped on encode, like
  `JSON.stringify`). `?[]T`/`?[string]T`: `[]`/`{}` are values, not null. Map outputs are built with own data
  properties (`"__proto__"` is a plain key). Named types compile lazily, so recursive types work; more than
  `MAX_VALUE_DEPTH` (1024) struct/array/map levels is `too-deep` (also stops cyclic values on encode). A
  non-finite number in an `int` slot is `int-range` (NaN: `type`); `JSON.rawJSON` objects are not plain
  objects; an `undefined` map value on decode is `null`, as in arrays.
- Validators let exceptions from user getters/Proxies propagate as-is (only locally built values can have
  them).
- `object`/`any` content on encode is whatever `JSON.stringify` makes of it (`Date` → string, `Map` → `{}`,
  `undefined` dropped).
- Recognise `int-range` across duplicated module copies by `ValidationError.reason`, not
  `instanceof`/`localName` (`localName` is `org.varlink.service.InvalidParameter` for every
  `ValidationError`).
- **Descriptors** (codegen output, §5.7): `MethodDescriptor<In, Out>` (phantom `"~types"`, `MethodInput`/
  `MethodOutput`), `InterfaceDescriptor {name, idl, ints, methods, errors}`, `JsonValue`. `compileDescriptor`
  checks the descriptor against its IDL both ways (names, `more`/`upgrade`/`experimental`, error names; every
  IDL method and error present); `JsonValue` admits readonly arrays; `assertIntsMode` checks `ints` at bind
  time.
- **Errors**: `VarlinkError`/`isVarlinkError` (brand, §6), the seven `org.varlink.service` classes (IDL text:
  `ORG_VARLINK_SERVICE_IDL`, verbatim UAPI) and `InternalError` (Q2: `INTERNAL_ERROR_INTERFACE` and its IDL
  `INTERNAL_ERROR_INTERFACE_IDL`), each with `errorName` and `is()`. The class `InternalError` shadows
  SpiderMonkey's non-standard global of the same name in modules that import it; `e.name` is `"InternalError"`
  for both, so recognise ours with `InternalError.is(e)` or `isVarlinkError`. A `VarlinkError`'s `message` is
  its name, but a name that is not a valid `interface.Name` (peers can send anything) or is over 256 code
  units is quoted with control and format characters escaped and cut to 256 code units; `error` keeps the raw
  name. `ErrorRegistry.register` checks `errorName` is `interface.Name`, ignores re-registering the same class
  and throws `TypeError` for a different class under a taken name (also within one call); it is atomic (on a
  throw nothing is registered). `create(name, params)` builds the registered class or a plain `VarlinkError`,
  without validating params. `createErrorRegistry()` is pre-filled with the 8 classes above. `X.is(e)` and
  `create` match by name only and don't validate parameters, so M4 MUST validate error parameters with the
  compiled error validators (including `org.varlink.service` errors, using a compiled `org.varlink.service`
  IDL) before `create`, and fall back to a plain `VarlinkError` when they don't validate. Outgoing errors (a
  handler throws a `VarlinkError`): M4 MUST check that its `error` is a valid `interface.Name` and, when that
  interface is known to the server, encode its `parameters` with the compiled error validator; on either
  failure it sends `InternalError` instead and reports the original error to `onError`.
- **Local errors** (`VarlinkLocalError`, own brand, `isVarlinkLocalError`, `localName`):
  `ConnectionClosedError` (`io.systemd.Disconnected`), `CallTimeoutError` (`io.systemd.TimedOut`),
  `ProtocolError` and `MessageTooLargeError` (`io.systemd.Protocol`), `UpgradePendingError`
  (`varlink-js.UpgradePending`), `OperationNotSupportedError` (`varlink-js.OperationNotSupported`),
  `ValidationError` and `IntegerRangeError` (`org.varlink.service.InvalidParameter`).

### 4.10 Protocol and sessions (M3)

`src/core/protocol/`: `channel.ts` (the §4.1 types), `framer.ts`, `messages.ts`, `client-session.ts`,
`server-session.ts`, `dispatch.ts`, all re-exported by `src/core/index.ts`; the root entry exports only the
handler-facing part (`streamOf`, `Handler`, `CallContext`, `HandlerResult`, the `ByteChannel` types and
`DEFAULT_MAX_MESSAGE_SIZE`); M4 decides on exposing sessions. `src/testing/` (`varlink-js/testing`): `pair()`,
`faulty()`.
- **Framer**: one growable `Uint8Array` (doubling, compacted with `copyWithin` once the read offset passes half the
  buffer, or when it needs room and the read offset is at least a quarter of the buffer; otherwise it grows and
  copies only the unconsumed bytes); each byte is scanned for NUL once, on push, so 1-byte pushes stay O(n). When
  `next()` empties a buffer larger than 64 KiB it is dropped and re-allocated lazily (4 KiB) on the next push, so
  one big message does not pin its memory; `capacity` (tests/diagnostics) is the buffer's size. Size = bytes
  before the NUL; `> maxMessageSize` (default 16 MiB, a positive safe integer) is an error, exactly the limit is
  fine. As soon as the incomplete message is over the limit, a `MessageTooLargeError` is recorded and later pushes
  are dropped (memory ≤ limit + one chunk + complete messages); `next()` still returns the complete messages before
  it, then throws it. UTF-8 is decoded with `fatal` and `ignoreBOM` (a leading U+FEFF stays in the text, so JSON
  parsing rejects it); invalid UTF-8 is a `ProtocolError` (`cause` = the `TypeError`) when that message is reached.
  After `next()` threw, it rethrows the same error and `push()` is a no-op. `completeMessages` counts buffered
  complete messages (server backpressure); `accepting` is false once push would be ignored. `takeRemainder()`
  (upgrade) returns a copy of the unconsumed bytes and finishes the framer; it throws the pending
  `MessageTooLargeError` if bytes were dropped, so a truncated stream is never handed over. `frameMessage()`
  refuses U+0000 and lone surrogates (`TypeError`).
- **Messages**: decode = §4.4 (null ≡ absent for every header; a key containing `.` goes to `ext`, built with own
  data properties; a header valid only in the other direction is an unknown key; `method` syntax is dispatch's
  job; the error name is not checked). Errors name the header and quote a peer key cut to 64 code units (on a
  code point boundary) and then log-safe quoted like §4.9 messages (`safeQuote`: control, bidi, U+2028/2029 and
  other format characters escaped). Decoded `parameters` are used by reference. Encode key order: call `method, parameters,
  oneway|more|upgrade, ext…`; reply `error?, parameters, continues?, ext…`; caller bugs (bad types, several flags,
  `continues` with `error`, an ext key without `.`) are `TypeError`s, as are codec failures.
- **ClientSession**: `call(init)` returns `{id, bytes}` (ids from 1, increasing); oneway calls get an id but never
  enter the reply FIFO. `call()` throws `UpgradePendingError` while an upgrade call is pending and
  `ConnectionClosedError` when closed or upgraded, and never changes state when it throws. `receive()` returns
  events (`reply`, `error`, `upgraded`, `failed`, `closed`) in stream order; a violation (decode/framer error,
  reply with no pending call, `continues` for a `single`/`upgrade` entry) fails every pending entry with
  `ConnectionClosedError` (`cause` = the `ProtocolError`) after the events decoded before it, then `closed` with
  the error. A final non-error reply to the upgrade call stops decoding at once: state `upgraded`, the bytes after
  its NUL (and later `receive()`s) are `takeUpgradeRemainder()` (repeated takes allowed: each returns what arrived
  since the previous one). An error reply to it keeps the session
  open. `receiveEnd()` (EOF) fails pending calls with "connection closed by peer" and discards a partial message;
  `close(reason)` is idempotent.
- **ServerSession**: `nextEvent()` decodes lazily and hands out one call at a time (ids from 1); the next one only
  after the previous finished (final reply produced, or `finish(id)` for oneway, whose `reply()`/`error()` return
  null). `wantsInput` is false while `maxQueuedCalls` (default 64) complete messages are buffered, while at least
  one complete message is buffered and the buffered bytes reach `maxMessageSize` (like sd-varlink's 16 MiB input
  buffer cap, json-stream.c:1240, with room for one partial message: without a complete message reading goes on,
  the framer caps the partial one; so at most about 2 × `maxMessageSize` + one chunk per connection), while paused
  after an upgrade call, after EOF or a framing error, and when not open. A malformed message, when reached, is
  `{type: "close", error}` (calls before it are answered first, nothing is written for it). An upgrade call pauses
  splitting until it ends: an error reply resumes, a final non-error reply makes the state `upgraded` and every
  byte after the call's NUL (also bytes received later; repeated takes allowed, each returns what arrived since the
  previous one) is `takeUpgradeRemainder()`. If that remainder was lost to the size limit, the confirming `reply()`
  returns null instead of bytes and the session closes (`{type: "close", error}` with the `MessageTooLargeError`):
  the peer never sees a confirmation. A second final reply, a wrong
  id, `continues` without `more` or any reply when not open is a `TypeError` with no state change; an encode
  failure rethrows and leaves the call active. After EOF the buffered calls are still delivered, then `{type:
  "close"}`. `close()` is local: nothing more is produced.
- **Dispatch** (`dispatchCall(session, id, call, table, send, options)`, never rejects, resolves when the call is
  finished): checks in order 1. `parseMethodName` (last dot; interface and member grammar) → `InvalidParameter
  {parameter: "method"}`; 2. `InterfaceNotFound {interface}` / `MethodNotFound {method}`; 3. `requires` more →
  `ExpectedMore`; 4. `requires` upgrade → `ExpectedUpgrade`; 5. `upgrade` on a method without upgrade support →
  `InvalidParameter {parameter: "upgrade"}` (Q4, provisional: sd-varlink does not check this at all; M9 decides);
  6. no handler → `MethodNotImplemented`; 7. `input.decode(…, {unknownFields: "reject"})`, a `ValidationError` →
  `InvalidParameter {parameter}`, anything else → `InternalError`. Then the handler runs (a sync throw counts as a
  rejection). An async-iterator result streams (each yield a `continues` reply, awaiting `send` first; the return
  value, or `{}`, is final); without `more` the first yield (or the return value) is the single reply and
  `return()` closes the iterator (a throw there is `cleanup-threw`). Other results: a plain object or `undefined`
  (→ `{}`); anything else (also a value whose prototype cannot be read, e.g. a throwing Proxy) is `bad-result` and
  `InternalError`. Thrown values: a `VarlinkError` with a valid name is checked with `table.errorValidator`
  (unknown interface: sent as is; known interface without that error, or parameters that do not validate or that
  the codec cannot encode: `InternalError` + `invalid-error`); anything else is `InternalError` +
  `handler-threw`, with nothing about it on the wire. `validateReplies` (`"warn"` default) applies to every reply
  value when the entry has `output`: `"warn"` sends the encoded value, or the original one plus `invalid-reply`;
  `"throw"` ends the call with `InternalError` (stopping a generator first). A reply the session cannot encode is
  `invalid-reply` and `InternalError`; if even the `InternalError` cannot be produced (a broken codec) while the
  session is open, the session is closed (`ctx.signal` aborted), so the connection never hangs on a call that
  cannot end. A generator is never resumed once the call ended while its reply was being written. A rejected `send` aborts `ctx.signal`, stops the generator, reports
  `send-failed` and closes the session; `options.signal` aborts `ctx.signal` and replies after the session closed
  are dropped silently. Oneway: nothing is sent, non-`VarlinkError` throws are still `handler-threw`, then
  `finish(id)`. A confirmed upgrade with nobody to take the stream is `upgrade-unclaimed` (M9 adds
  `ctx.upgrade()`). `onError` exceptions are swallowed.
- **`ctx.notify(v)`**: with `more`, a `continues` reply serialized with the other sends (resolves when written;
  validated like any reply, a `"throw"` failure ends the call with `InternalError` and rejects; the rejected
  promise has a no-op handler attached, so a fire-and-forget notify is never an unhandled rejection). Without `more`
  the first notify is the single final reply and later notify calls and the return value are dropped (a later
  throw goes to `onError` only). sd_varlink_notify answers `ExpectedMore` there instead; we follow the generator
  rule ("Monitor without more = current state") so a handler does not need two code paths. Oneway: a no-op. After
  the handler settled and the call ended: resolves without sending, `late-notify`.
- **Testing channels**: `pair({highWaterMark})` (default 64 KiB): chunks arrive in order as written (copied, never
  merged); `write()` resolves once the peer's unread bytes are ≤ `highWaterMark` and rejects after this side's
  `end()`/`close()` or the peer's `close()`; `read()` gives `null` after the peer's `end()` once drained and after
  this side's `close()`; `close()` lets the peer drain what was queued; `closed` resolves on `close()` or after
  both `end()` and reading EOF; concurrent `read()` is a `TypeError`; no timers. `faulty(channel, plan)` splits reads
  and/or writes (`"every-byte"`, a max size, or cut offsets), simulates a reset after N bytes read or written
  (`ConnectionClosedError("connection reset (faulty)")`, inner channel closed; after a write reset every later
  write rejects, also a zero-length one) and awaits `delay()` before every read and write. Writes are serialized
  (each starts after the previous one settled), so concurrent writes arrive in order and never interleave.
- **Leftovers**: `JSON.parse` keeps the last of duplicate keys while sd-varlink rejects duplicates; not detectable
  without a custom parser. sd-varlink rejects `null` flags; we accept them per UAPI (null ≡ absent). Upgraded data
  pipelined behind an upgrade call that is not yet processed counts against `maxMessageSize`; if it overflows, the
  server session closes with `MessageTooLargeError` instead of handing over a truncated stream.

---

## 5. Public API sketch

Single package `varlink-js`, subpath exports (§8). Names are final unless Pawel objects.

### 5.1 Client

```ts
import { connect } from "varlink-js/node";

const conn = await connect("unix:/run/systemd/io.systemd.Hostname", {
  timeout: 45_000,          // default 45 s like sd-varlink; 0 = none. See "Timeouts" below.
  ints: "number",           // §4.3
  maxMessageSize: 16 << 20,
  validateReplies: "off",   // "off" | "warn" | "throw"; needs an IDL (typed client or getInterface)
});

// Untyped calls
const info = await conn.call("io.systemd.Hostname.Describe");                 // Promise<Record<string, unknown>>
await conn.oneway("org.example.Log", { msg: "hi" });                          // resolves when written
for await (const rec of conn.stream("io.systemd.UserDatabase.GetUserRecord",  // AsyncIterable over replies (sets `more`)
                                    { service: "io.systemd.Multiplexer" },
                                    { signal: AbortSignal.timeout(5_000) })) { … }
const all = await conn.collect("…GetUserRecord", { service: "…" });           // array (max 1024, like sd)

// Introspection
await conn.getInfo();                                   // org.varlink.service.GetInfo
const iface = await conn.getInterface("io.systemd.Hostname");  // parsed IDL (idl.Interface)

// Upgrade (M9)
const { parameters, channel } = await conn.upgrade("com.example.Decompress.XZ", {});
// On success `conn` is finished as a varlink connection and `channel` carries the custom protocol.
// On an error reply this rejects with the VarlinkError and `conn` stays usable (UAPI).

await conn.close();
```

Semantics:
- Calls on one `Connection` are pipelined in order. While a `stream()` is active, later calls queue
  behind it (the server won't process them until the stream ends; UAPI "more").
- **Timeouts**: the clock starts when the call reaches the head of the connection's reply queue (i.e.
  everything before it has finished), not when it is enqueued. So a `call()` queued behind a
  long-running `stream()` can't time out and kill that stream. For `call()`/`collect()`/`upgrade()`,
  `timeout` covers the whole call from that point. For `stream()` it
  covers only the time to the *first* reply, because subscriptions legitimately run forever. An optional
  `idleTimeout` limits the gap between replies (default none). `signal` bounds anything. The client's
  default timeout differs from `varlinkctl --more`, which applies 45 s to the whole stream; the difference
  is deliberate and documented. Timeouts reject with `CallTimeoutError`.
- **Cancellation**: varlink has no cancel message; UAPI says a client that loses interest closes the
  connection. So aborting (`signal`) or timing out an in-flight call **closes the connection**. The
  aborted call rejects with `signal.reason` (the standard `AbortError`/`TimeoutError` `DOMException`),
  or `CallTimeoutError` for the `timeout` option. Every other call queued on that connection rejects
  with `ConnectionClosedError` (`cause` = that reason). Aborting a call that is still queued and not yet
  written just removes it. Breaking out of a `for await` over `stream()` also closes the connection.
  Documented loudly; use a `Pool` (§5.2) if you want independent cancellation.
- **Backpressure**: `stream()` buffers at most `highWaterMark` replies (our default 64; sd-varlink has no
  equivalent knob), then stops reading the socket so the kernel pushes back on the server.
- Errors: remote error replies reject with a `VarlinkError` subclass (§6).
- **fds** (M11, fd-capable channels only): `conn.call(m, p, { fds: [h1, h2] })` attaches fds to that
  call's message; `{ acceptFds: true }` opts in to receiving fds for that call only (UAPI: clients MUST
  NOT accept fds unless they invoke a method that returns them). With `acceptFds`, the result is
  `{ parameters, fds }` instead of bare parameters (and stream items likewise). fds arriving for a call
  without the opt-in are closed, and the connection is treated as a protocol error.

### 5.2 Pool

```ts
import { createPool } from "varlink-js/node";
const pool = createPool("unix:/run/foo", { max: 8, idleTimeout: 30_000 });
await pool.call("org.example.Ping", {});   // same methods as Connection; each call/stream leases a connection
await pool.close();
```

The pool leases an idle healthy connection or opens one (up to `max`, then waits). A connection that
closed or failed is discarded, never reused (F4). Streams hold their lease until they end, so
cancelling one stream doesn't kill other calls.

### 5.3 Typed calls (codegen output, §5.7)

```ts
import { IoSystemdHostname } from "./gen/io.systemd.Hostname.ts";
import { OrgExampleFtl } from "./gen/org.example.ftl.ts";

const hostname = IoSystemdHostname.client(conn);        // or .client(pool)
const d = await hostname.Describe({});                  // typed params and result

const ftl = OrgExampleFtl.client(conn);
const { configuration } = await ftl.CalculateConfiguration({ current, target });
try { await ftl.Jump({ configuration }); }
catch (e) { if (OrgExampleFtl.NotEnoughEnergy.is(e)) … }   // typed error

// Each method is callable (single reply) and also has .stream(), .collect(), .oneway() (and .upgrade()),
// mirroring the untyped Connection API, so the return type never depends on a runtime option.
for await (const c of ftl.Monitor.stream({})) { c.condition.state }  // "idle" | "spooling" | "busy"
```

Generated descriptors carry the IDL, so typed clients can validate replies with `validateReplies`
(same option as §5.1; default `"off"`). Clients SHOULD ignore unknown reply fields, so reply
validation skips unknown fields.

Untyped introspection proxy (no codegen, part of M4): `const x = await conn.proxy("org.example.ftl")`
fetches and parses the interface, then exposes the same method shape with runtime validation and
`Record<string, unknown>` types.

### 5.4 Server

```ts
import { createServer } from "varlink-js";
import { listen } from "varlink-js/node";
import { OrgExampleFtl } from "./gen/org.example.ftl.ts";

const server = createServer({
  vendor: "Example", product: "ftl", version: "1.0", url: "https://example.com",
  onError: (err, ctx) => log(err),        // handler bugs and transport errors land here, never crash
});

server.implement(OrgExampleFtl, {
  async CalculateConfiguration({ current, target }, ctx) {
    if (current.distance < 0) throw new OrgExampleFtl.ParameterOutOfRange({ field: "current.distance" });
    return { configuration: … };
  },
  async *Monitor(_params, ctx) {               // async generator ⇒ streaming method
    yield { condition: now() };                // each `yield` = reply with continues:true, sent immediately
    for await (const c of changes({ signal: ctx.signal })) yield { condition: c };
  },                                           // runs until the client disconnects (ctx.signal)
  async *ListDrives(_p, ctx) {                 // finite enumeration: `return` = the final reply
    return yield* streamOf(drives());          // helper: holds back one item so the last goes out as final
  },
  async Jump(params, ctx) { … return {}; },
});

// Untyped registration (no codegen): pass IDL text; it is parsed and validated at startup.
server.addInterface(idlText, { Ping: async (p) => ({ pong: p.ping }) });

await server.serve(await listen("unix:/run/org.example.ftl", { mode: 0o644 }));
// 0o644 = owner can connect, others can only read the xattr (UAPI recommendation). Widen deliberately.
// also: listen("tcp:127.0.0.1:0"), listenFromEnv() (socket activation), any Listener / ByteChannel
await server.shutdown({ graceful: true, timeout: 5_000 });
```

`org.varlink.service` is built in: `GetInfo` lists registered interfaces (always including
`org.varlink.service`), and `GetInterfaceDescription` returns the registered IDL source text
**verbatim** (it was parsed and validated at registration, and codegen embeds the original text, so every
comment survives as UAPI requires), or `InterfaceNotFound` (fixes F9).

**Streaming handler contract.** A handler written as an async generator is a streaming handler:
- each `yield v` sends `v` immediately with `continues: true`;
- `return v` sends `v` as the final reply (no `continues`);
- returning `undefined` after at least one `yield` sends a final `{}`. That is only valid if every output
  field is nullable (UAPI: fields absent in some reply of a `more` series MUST be `?`). Like any other
  invalid reply it is handled by `validateReplies`: `"warn"` sends it and reports to `onError`, `"throw"`
  replaces it with the internal error reply, and `"off"` sends it unchecked.
- For finite enumerations, `streamOf(iterable)` holds back one item so the last one is the final reply
  (the sd-varlink pattern); the one-item delay is harmless there. For infinite monitors, just `yield`.
- Called **without** `more`: if the method requires `more` (`[Requires 'more' flag]` in the IDL, or handler
  option `requiresMore: true`) the reply is `ExpectedMore`. Otherwise the first `yield` (or the `return`
  value) is sent as the single reply and the generator is closed with `.return()` (Monitor without `more` =
  "current state").
- Plain async handlers can stream too: `ctx.notify(v)` sends a `continues` reply when `ctx.more` is true
  (sd-varlink's `sd_varlink_notify` style), and the returned value is final.

Handler context `ctx`: `signal` (aborts when the client disconnects or the server shuts down),
`more`/`oneway`/`upgrade` flags, `method`, `peer` (M11), `fds` (M11), `notify(partial)` (send a
`continues` reply from a plain async handler, sd-varlink style), `upgrade()` (M9).

**Dispatch rules (the spec, from UAPI.20; these fix F5–F7):**

| Situation | Reply (none at all if `oneway`) |
|---|---|
| Malformed message (see §4.4) | close connection, no reply |
| `method` not a fully-qualified `interface.Method` | `org.varlink.service.InvalidParameter {parameter: "method"}` (what libvarlink does, service.c:274) |
| Interface not registered | `org.varlink.service.InterfaceNotFound {interface}` |
| Interface known, method not in IDL | `org.varlink.service.MethodNotFound {method}` |
| Method in IDL, no handler | `org.varlink.service.MethodNotImplemented {method}` |
| Params fail validation (missing, null for non-`?`, wrong type, unknown field, unsafe int) | `org.varlink.service.InvalidParameter {parameter: "<dotted.path>"}` |
| Method requires `more` (`[Requires 'more' flag]` or `requiresMore`), call without `more` | `org.varlink.service.ExpectedMore` |
| Generator handler that doesn't require `more`, call without `more` | first yielded (or returned) value as single reply |
| Plain handler, call with `more` | single reply without `continues` (allowed by spec) |
| Method requires `upgrade` (`[Requires 'upgrade' flag]` or `requiresUpgrade`), call without `upgrade` | `org.varlink.service.ExpectedUpgrade` |
| Method only *supports* `upgrade`, call without it | handler runs as a plain call (`ctx.upgrade` unavailable) |
| `upgrade` set on a method that does not support it | provisional (M3): `InvalidParameter {parameter: "upgrade"}`; M9 settles Q4 |
| Handler throws `VarlinkError` | that error (name + params) |
| Handler throws anything else | `onError` hook, then the internal error reply (see Q2); no details leak |
| Generator throws after yielding | error reply ends the stream (an error is always final) |
| Client disconnects mid-call | `ctx.signal` aborts; pending replies are discarded |

Output validation uses the same option as the client, `validateReplies: "off" | "warn" | "throw"`, but the
server default is `"warn"`: an invalid reply is still sent, and the mismatch is reported to `onError`.
That catches handler bugs against the IDL, like sd-varlink's `validate_method_reply`. Core never reads
environment variables; set the option explicitly (e.g. `"off"` for hot paths).

Limits: from sd-varlink, `maxConnections` 4096, `maxConnectionsPerUid` 128 (only when peer credentials
are available, M11) and `maxMessageSize` 16 MiB; our own default, `maxQueuedCalls` 64 per connection
(beyond that, stop reading: backpressure). No idle timeout on server connections (F1). Optional
`exitOnIdle: ms` for socket-activated services (M8).

### 5.5 Errors

See §6.

### 5.6 Upgrade (M9)

Client: `conn.upgrade(method, params)` sends the call, waits for the single confirming reply, then
returns `{parameters, channel}`. `channel` is the §4.2 wrapper: it first yields the bytes the framer had
already read past the reply's `NUL`, then reads from the socket. That satisfies UAPI ("MUST NOT
consume") in effect: no byte is lost or misinterpreted. On an error reply the promise rejects and the
connection stays a varlink connection.

Server: a handler declared `upgrade: true` receives `ctx.upgrade(replyParams?) → Promise<ByteChannel>`.
The session stops reading after the upgrade call (§4.5), so the only bytes already buffered are the
client's early data, which the wrapper channel hands over. If the handler throws a `VarlinkError` before
calling `ctx.upgrade()`, the error is sent and the session resumes reading varlink calls. If it returns
normally without calling `ctx.upgrade()`, the return value goes out as the confirming reply (any
non-error reply confirms, per UAPI), nobody owns the upgraded stream, and the server closes the
connection and reports it to `onError`.

### 5.7 Codegen

`varlink-js codegen io.systemd.Hostname.varlink -o src/gen/` (also a programmatic `generate()` API).
One `.ts` file per interface:

- `type` structs and error parameters → `type` aliases, not `interface` (TS interfaces are not assignable to
  index signatures such as `JsonValue` or `VarlinkError<P extends Record<string, unknown>>`); fields `?T` →
  `field?: T | null`; enums → string literal unions plus
  `const …Values = [...] as const`; `[]T` → `T[]`; `[string]T` → `Record<string, T>`; `[string]()` →
  `Record<string, Record<string, never>>` (string set); `object` → `Record<string, unknown>`;
  `any` → `JsonValue` (non-null; includes `bigint`, §4.3); `int` → `number` or `bigint` per
  `--ints number|bigint` (must match the runtime `ints` option; the generated descriptor records it and the
  client/server checks the match at bind time);
  anonymous inline structs/enums → inline types, named `Method_Input_field` only when needed for
  readability.
- Doc comments → TSDoc on the generated declarations.
- Errors → classes extending `VarlinkError` with typed `parameters` and a static `is()` guard, registered so
  clients map error replies to them. Exception: for `org.varlink.service` and `INTERNAL_ERROR_INTERFACE`,
  codegen MUST NOT generate new classes; the generated descriptor's `errors` re-export the core classes
  (`InterfaceNotFoundError`, `MethodNotFoundError`, …, `InternalError`), so `createErrorRegistry()` plus a
  bound generated descriptor never conflict and `instanceof` keeps working.
- Methods → `MethodDescriptor`s (§4.9): `{ interface, name, method, more?, upgrade?, experimental? }` plus the
  phantom `"~types"` carrying the input/output types (`more`/`upgrade`/`experimental` come from the systemd
  annotations). Validators are not in the descriptor: they come from compiling the descriptor's `idl`
  (`compileDescriptor`).
- `client(conn)` proxy factory, and a `Handlers` type used by `server.implement`.
- The interface's IDL text as a constant (for `GetInterfaceDescription` and runtime validation).

Generated code imports only `varlink-js` (core). It is deterministic (stable ordering; header with the
generator version and a hash of the source) so it can be committed and diff-reviewed.

The repo regenerates `org.varlink.service`, `org.varlink.certification` and `org.varlink.resolver`
from `.varlink` files at build time; the hand-written `*.varlink.ts` files go away.

### 5.8 Socket activation and exec

- `listenAuto()` mirrors `sd_varlink_server_listen_auto` (sd-varlink.c:3883): if
  `SYSTEMD_VARLINK_LISTEN` is set, `-` means "serve one connection on stdin/stdout" (that is what
  `ssh-exec:` relies on) and anything else is an address to listen on; otherwise use `listenFromEnv()`.
- `listenFromEnv()` reads `LISTEN_PID` (must equal `process.pid`), `LISTEN_PIDFDID` (ignored unless we
  can check it), `LISTEN_FDS`, `LISTEN_FDNAMES` (pick the fd named `varlink`; if there is one fd and no
  names, use it). It returns a `Listener` over `net.Server.listen({fd})`. It unsets the variables
  (like `sd_listen_fds(1)`). Connected (already-accepted) activation sockets are accepted via
  `new net.Socket({fd})`. Without the native addon we can't `getsockopt(SO_ACCEPTCONN)`, so the
  connected case is selected by an option. *Verify both in the VM.*
- `exec:/path` client: create a listening unix socket in a private temp dir, spawn
  `/bin/sh -c 'LISTEN_PID=$$ exec "$0" "$@"' /path` with the listener as fd 3, `LISTEN_FDS=1`,
  `LISTEN_FDNAMES=varlink`, and `VARLINK_ADDRESS=unix:<path>` (the rust/python convention), then
  connect. The `sh -c … exec` trick is needed because Node can't set env after fork. Clean up the
  socket dir and kill the child on close.

---

## 6. Error model

```ts
const BRAND = Symbol.for("varlink-js.VarlinkError");

class VarlinkError<P extends Record<string, unknown> = Record<string, unknown>> extends Error {
  /** Fully-qualified varlink error name, e.g. "org.varlink.service.MethodNotFound". */
  readonly error: string;
  readonly parameters: P;
  constructor(error: string, parameters?: P, options?: ErrorOptions) {
    super(error, options);
    this.name = new.target.name;               // JS class name, e.g. "MethodNotFoundError"
    this.error = error;
    this.parameters = parameters ?? ({} as P);
    Object.defineProperty(this, BRAND, { value: true });   // instance brand, survives duplicated module copies
  }
}
/** Brand check; `error` filters on the varlink error name. */
function isVarlinkError(e: unknown, error?: string): e is VarlinkError;

// Generated subclass (codegen): fixed name, typed parameters.
class ParameterOutOfRange extends VarlinkError<{ field: string }> {
  static readonly errorName = "org.example.ftl.ParameterOutOfRange";
  constructor(parameters: { field: string }, options?: ErrorOptions) { super(ParameterOutOfRange.errorName, parameters, options); }
  static is(e: unknown): e is ParameterOutOfRange { return isVarlinkError(e, ParameterOutOfRange.errorName); }
}
```

- Standard `org.varlink.service` errors are exported classes: `InterfaceNotFoundError`,
  `MethodNotFoundError`, `MethodNotImplementedError`, `InvalidParameterError`, `PermissionDeniedError`,
  `ExpectedMoreError`, `ExpectedUpgradeError`.
- Generated interface errors extend `VarlinkError` and register in an `ErrorRegistry`. A client maps a
  reply's `error` string to the most specific registered class; an unknown error name gives a plain
  `VarlinkError` with the name and parameters intact.
- **Local errors** (never on the wire) are separate classes, so `catch` blocks can tell "the server
  said no" from "the connection broke":
  `ConnectionClosedError` (≈ `io.systemd.Disconnected`), `CallTimeoutError` (≈ `io.systemd.TimedOut`;
  named so it doesn't clash with the `TimeoutError` DOMException from `AbortSignal.timeout()`),
  `ProtocolError` (≈ `io.systemd.Protocol`; includes `MessageTooLargeError`), `ValidationError`
  (≈ `org.varlink.service.InvalidParameter`; parent of `IntegerRangeError`, §4.3, §4.9),
  `UpgradePendingError`, `OperationNotSupportedError` (e.g. fds over TCP). An aborted call
  rejects with the signal's own reason; no wrapper class. Local errors expose `.localName` with the
  systemd-equivalent name for CLI output and logs.
- The server never puts `err.message` or stacks of unexpected exceptions on the wire (0.1.x leaked
  `e.toString()`, F6). They go to `onError`.

---

## 7. Testing strategy

All tests run with `node --test` (TS executed directly via Node's type stripping, so the source is
restricted to erasable syntax: `erasableSyntaxOnly` in tsconfig, no enums or namespaces). Property tests
use `fast-check` (dev dependency).

### 7.1 Unit

- `idl/`: golden tests on a corpus: every `.varlink` in libvarlink, python-varlink, rust varlink, the
  UAPI examples, and real systemd interfaces dumped with `varlinkctl introspect` in the VM (stored
  under `test/corpus/systemd-<version>/`). Parse → format → parse must be a fixpoint. Against `varlinkctl validate-idl`
  (VM, M1, `test/corpus/VARLINKCTL.md`): systemd's re-print of our output must equal its re-print of the original
  (the styles differ, so the texts themselves are not compared).
- Negative cases: each grammar rule (bad names, `__` in field names, trailing `_`, missing newline
  after members, duplicate member names, unresolved refs, `??T`). Note that `?any` is grammatical
  (`"?" element_type`) and must parse.
- `types/`: validator tables per type. JSON codec ints: ±2⁵³ boundary, 2⁶³−1, 2⁶⁴−1, −2⁶³, `1.0`, `1e3`.
- `protocol/`: Framer (split at every byte offset, many messages per chunk, max size, invalid UTF-8),
  header validation table from §4.4, sessions driven by scripted message sequences (pure, no I/O).

### 7.2 Regression (one test per finding, named `F1`…`F17`; F18 is docs, checked in M12 review)

Mirrors the reproductions in `review-varlink-js.md`: client RST mid-call and idle client (server
survives, other connections unaffected), `not json\0`, `null\0`, `42\0`, 4 MB echo both directions,
server restart then call (client rejects, pool recovers), client timeout then call, oneway to unknown
method followed by a normal call (no off-by-one), `throw "x"` in a handler, `EADDRINUSE` rejects
`listen()`, `GetInterfaceDescription` with `../../etc/hosts#` → `InterfaceNotFound`, ESM import of
every `exports` entry plus `tsc --moduleResolution nodenext` on a consumer fixture, 64 MiB of input
without NUL → connection closed and memory bounded, wire output contains no `continues:false`.

### 7.3 Property-based

- IDL: arbitrary ASTs (fast-check) → format → parse ⇒ equal AST; random whitespace/comment insertion
  preserves the AST; fuzz the parser with mutated corpus files (it must never throw anything other
  than `IdlSyntaxError` with a position).
- Types: values generated from random types validate; a single mutation (drop required field, wrong
  primitive, extra field) is rejected with the correct `parameter` path.
- Protocol: random interleavings of chunk boundaries, pipelined calls and `more` streams give the same
  replies as the unsplit stream.

### 7.4 Interop and certification

- **python-varlink certification, both directions**, in CI (`pip install varlink`):
  JS client → `python -m varlink.tests.test_certification --varlink=unix:…` server, and
  python `--client` → JS certification server. Same for TCP. (Command lines from varlink.org
  Language-Bindings and test_certification.py.)
- **rust varlink certification**: optional CI job (`cargo install varlink-certification`) if it builds
  quickly; otherwise manual.
- **systemd**: 
  - CI (GitHub `ubuntu-latest` has systemd and `varlinkctl`; version to check in M5): `varlinkctl info`,
    `introspect` and `call` against our test server, `varlinkctl validate-idl` on our formatter output (only for
    inputs systemd itself accepts: see the differences in `test/corpus/VARLINKCTL.md` (empty `()`, `?any`, `?[]?T`, …)
    and the experimental-consistency rules of §4.8), and
    our client against `/run/systemd/userdb/io.systemd.Multiplexer` (`GetUserRecord` with `more`).
  - UTM Linux VM (`~/oss/vm/README.md`, once available): a newer systemd for `--upgrade` (≥ 261),
    `exec:` against `/usr/lib/systemd/systemd-pcrextend`-style binaries, socket activation with
    `systemd-socket-activate`, abstract sockets, fd passing with the native addon, the registry.
- **Runtimes**: CI matrix Node 22 / 24 / 26; Bun latest and Deno 2 run the unit tests plus the unix/tcp
  integration subset (M10).

### 7.5 Fuzz and soak (M4, cheap)

A fuzzer driving random bytes and valid-but-hostile messages into a server over `pair()`. Invariant:
no unhandled rejection, connection closes or replies, RSS stays bounded. A 10-minute soak in CI
nightly (optional).

---

## 8. Packaging and tooling

- Package name stays **`varlink-js`**, version **1.0.0-alpha.N** on the fork. Publishing is Pawel's
  decision (Q1). Nothing is published by the bot.
- ESM only, `"type": "module"`, `"engines": {"node": ">=22.12"}` (first 22.x with unflagged `require(esm)`,
  so CJS consumers still work), `"sideEffects": false`, zero runtime dependencies for the core and Node adapter.
  Development needs unflagged type stripping: Node ≥ 22.18 (confirmed in M0: the v22.18.0 release notes,
  "Type stripping is enabled by default", nodejs/node#56350; on 23.x/24.x it has been unflagged since 23.6).
  CI uses the latest 22.x/24.x/26.x (`check-latest`). ESLint 10 itself needs Node ≥ 22.13, so lint never
  runs on the 22.12 floor; the floor job runs compiled JS only.
- `exports`:
  ```json
  {
    ".":           { "types": "./dist/index.d.ts",     "default": "./dist/index.js" },
    "./node":      { "types": "./dist/node/index.d.ts", "default": "./dist/node/index.js" },
    "./websocket": { "types": "./dist/websocket/index.d.ts", "default": "./dist/websocket/index.js" },
    "./http":      { "types": "./dist/http/index.d.ts", "default": "./dist/http/index.js" },
    "./idl":       { "types": "./dist/idl/index.d.ts",  "default": "./dist/idl/index.js" },
    "./codegen":   { "types": "./dist/codegen/index.d.ts", "default": "./dist/codegen/index.js" },
    "./testing":   { "types": "./dist/testing/index.d.ts", "default": "./dist/testing/index.js" },
    "./package.json": "./package.json"
  }
  ```
  `"bin": { "varlink-js": "./dist/cli/main.js" }`, `"files": ["dist", "src", "!src/**/*.test.ts", "README.md", "LICENSE"]`
  (src for source maps), `"devEngines": {"runtime": {"name": "node", "version": ">=22.18"}}` (contributors need type stripping).
- Build: plain `tsc` (`module`/`moduleResolution: nodenext`, `declaration`, `declarationMap`,
  `sourceMap`, `rewriteRelativeImportExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`,
  `isolatedDeclarations`). No bundler, so one module graph and no duplicated classes (F11).
- Layout (ownership per milestone in §10):
  ```
  src/core/{idl,types,protocol,errors,address}/   src/rpc/   src/node/   src/websocket/   src/http/
  src/codegen/   src/interfaces/ (generated built-ins)   src/cli/   src/testing/
  interfaces/*.varlink   examples/   native/   test/{unit,regression,interop,corpus,fixtures}/
  .github/workflows/{ci,interop,runtimes,release}.yml   (one workflow file per owning milestone)
  ```
  Cards that run in parallel own disjoint files. Where a later milestone has to touch an earlier one's
  files (M6 regenerating built-ins, M9), the dependency graph in §10 serialises them.
- Lint/format: ESLint 10 flat config + typescript-eslint (strict-type-checked), prettier pinned exact,
  `package-lock.json` committed (F12). Layer rule (§4), enforced in M0 for `src/core`, `src/rpc` and the
  browser-facing subpaths (`src/index.ts`, `src/idl`, `src/websocket`, `src/http`, plus M6's generated
  `src/interfaces`, which is not a subpath): a local rule (`eslint-rules/layer-boundaries.js`) allows only relative imports that resolve
  inside the layer's allowed directories (core → core; rpc, the root entry and interfaces → core+rpc+interfaces;
  idl → core+idl; websocket/http → core+rpc+self),
  so `node:*`, bare built-ins, npm packages, the package's own name and adapter paths are all rejected,
  including `export … from`, `import()`, `import("x").T` and `declare module "x"`;
  `no-restricted-globals` (`process`, `Buffer`, `Bun`, `Deno`, `require`, `window`, `document`, …), the same
  names via `globalThis.*` (and `globalThis.globalThis`), no `import.meta`, no aliasing `globalThis`, no ambient
  declarations (`declare const/enum Deno`, `declare global`, any namespace). Tests live under `test/` only
  (a tooling test fails on a colocated `src/**/*.test.ts`). Only the transports (websocket, http) may use
  `fetch`/`WebSocket`/`EventSource`/workers; everything else does I/O through ByteChannel (§4.1).
  `tsconfig.core.json` typechecks all of these with `lib: es2024 + dom` and **no `@types/node`**, so
  `NodeJS.Timeout`, `Buffer` or `.unref()` fail to compile there. `test/tooling/lint-boundaries.test.ts` proves the rules fire. (M0 deviation: the design
  said ESLint 9, but 9.x is end-of-life and deprecated on npm since ESLint 10; TypeScript is pinned to 6.0.x
  because typescript-eslint 8 supports `typescript <6.1`, so TS 7 waits for typescript-eslint.)
- CI (GitHub Actions on the fork): lint + typecheck + tests on Node 22/24/26; Bun and Deno jobs (M10);
  python certification job (M5); systemd interop job (M5); `npm pack` and consumer-fixture import test
  (ESM + `tsc nodenext`). Release workflow on tag, with npm provenance, gated by a manual approval
  environment. It exists but is not run without Pawel's OK.
- Docs: README rewritten (quick start client/server, codegen, CLI, address table, limits, cancellation
  semantics), `docs/MIGRATION.md` from 0.1.x, TSDoc on the public API.

---

## 9. Open questions for Pawel

Defaults are what gets built if there's no answer.

| # | Question | Default |
|---|---|---|
| Q1 | Publish as `varlink-js@1.0.0` (same npm name, breaking major) once you approve, or under a new name? | Same name, major bump. Nothing published without your OK. |
| Q2 | Wire error for *unexpected* handler exceptions: there's no standard one, and UAPI says calls SHOULD only return errors defined in an interface. Options: (a) a tiny interface the server auto-registers (so it is introspectable), e.g. `io.github.pzmarzly.varlinkjs` with `error InternalError ()`, no details on the wire; (b) reuse systemd's `io.systemd.System` (but we can't fill its `errno` honestly); (c) close the connection (kills unrelated pipelined calls). Interface name is your call. | (a), details only to `onError`. |
| Q3 | Default `ints` mode: `"number"` (reject unsafe ints) vs `"bigint"`. | `"number"` with rejection. Opt in to `bigint`. |
| Q4 | `upgrade` flag on a method that doesn't support it: `InvalidParameter{parameter:"upgrade"}` vs `ExpectedUpgrade` vs treat as a plain call. UAPI is silent. Need to check what sd-varlink does (M9). | Match sd-varlink once checked. |
| Q5 | Native addon for fd passing / peer creds (M11): own small N-API addon vs depending on `usocket`/`peercred`. | Evaluate in M11. Prefer own ~200-line C addon with prebuilds, Linux only. |
| Q6 | Keep TCP listen support in the server (systemd dropped TCP; UAPI says OPTIONAL)? | Keep, bind `127.0.0.1` in all examples. |

---

## 10. Milestones

Each milestone is one kanban card (or more), ends with green CI on the fork and pushed commits on
`rewrite`, and owns the listed directories. Code over ~500 lines goes through `claude -p` in a
worktree, and the card owner reviews the diff. Estimates are rough agent-session sizes (S < 1 session,
M ≈ 1, L ≈ 2–3).

| M | Scope | Owns | Depends | Done when | Size |
|---|---|---|---|---|---|
| **M0** | Scaffold: remove old `src/` (history keeps it), tsconfig nodenext, ESLint 10 (§8), pinned prettier, lockfile, `node --test`, CI Node 22/24/26, `exports` skeleton, consumer-fixture test (ESM import, `require(esm)`, `tsc nodenext`), plus a dist-only smoke job on Node 22.12.0 (compiled tests + fixture; checks `context.source` and `JSON.rawJSON` on the engines floor) | root config, `.github/workflows/ci.yml`, `test/fixtures/consumer/` | — | CI green on an empty skeleton; fixture imports every subpath | S |
| **M1** | IDL: lexer, parser (positions, doc and field comments, systemd annotations), AST, semantic validation, canonical formatter, corpus + golden + property tests | `src/core/idl/`, `test/unit/idl/`, `test/corpus/` | M0 | Whole corpus round-trips; fuzz finds no non-`IdlSyntaxError` throws | M |
| **M2** | Types: AST → compiled validators with dotted error paths, `ints` policy, JSON codec, method/interface descriptor types (what codegen will emit), error classes and registry | `src/core/types/`, `src/core/errors/` | M1 | Validator and codec tables pass; property tests pass | M |
| **M3** | Protocol: framer, message encode/decode (UAPI header rules), ClientSession/ServerSession (sans-IO), dispatch table §5.4, streaming handler contract, in-memory `pair()` + `faulty()` | `src/core/protocol/`, `src/testing/` | M2 | Session-level tests (scripted messages, no I/O) for F2, F5, F6, F7, F15, F17; the same regressions run end-to-end over `pair()` and real sockets in M4 | L |
| **M4** | RPC + Node runtime: `Connection`, `Pool`, `Server` (`implement` on descriptors, `addInterface(idlText)`), built-in `org.varlink.service`, introspection `proxy()`, timeouts, AbortSignal, backpressure, limits; Node `connect`/`listen` (unix, `unix:@`, tcp); address parser | `src/rpc/`, `src/node/` (base files), `src/core/address/`, `src/index.ts` | M3 | All regressions F1–F17 pass end-to-end over `pair()` and real sockets; fuzz/soak smoke | L |
| **M5** | Certification: `org.varlink.certification` server + client via `addInterface(idlText)` (no codegen needed), python-varlink both directions in CI (unix + tcp), systemd `varlinkctl` CI job, rust cert if cheap | `interfaces/org.varlink.certification.varlink`, `examples/certification/`, `test/interop/`, `.github/workflows/interop.yml` | M4 | Python certification green both ways in CI | M |
| **M6** | Codegen (`generate()`, types, descriptors, error classes, `client()` factory, `Handlers` type), regenerate built-in interfaces into `src/interfaces/` and switch M4's built-ins to them | `src/codegen/`, `src/interfaces/`, `test/unit/codegen/` | M4 | Generated code for the corpus typechecks; typed e2e tests over `pair()` | M |
| **M7** | CLI `varlink-js`: `info`, `list-interfaces`, `list-methods`, `introspect`, `call` (`--more`, `-E`, `--collect`, `--oneway`, `--timeout`, `--graceful`, `-j`/`--json`, `-q`), `format`, `validate-idl`, `codegen`, `bridge` (stdio ↔ address), `certify` | `src/cli/` | M5, M6 | CLI e2e tests; output matches varlinkctl conventions (JSON-SEQ for `--more`) | M |
| **M8** | Addresses II and activation: `exec:`, `ssh-unix:`, `ssh-exec:`, bridge argv, `listenAuto()`/`listenFromEnv()`, stdio serving, exit-on-idle, registry lookup and server-side registry binding (`server.serve(listener, {registry: true})` symlinks the entrypoint into `/run/varlink/registry/<iface>` for every registered interface except `org.varlink.service`, or `registry: ["…"]` for an explicit list; removed on shutdown), resolver client | `src/node/spawn*`, `src/node/activation*`, `src/node/registry*` | M4 | Tests on macOS + VM (`systemd-socket-activate`, ssh to localhost) | M |
| **M9** | `upgrade`: client + server + CLI `--upgrade`; resolve Q4 | touches `src/core/protocol/`, `src/rpc/`, `src/cli/` | M7, M8 | Interop with `varlinkctl call --upgrade` / `serve` in VM (systemd ≥ 261) | S |
| **M10** | WebSocket + HTTP client transports; Bun and Deno CI; browser smoke test (Playwright optional) | `src/websocket/`, `src/http/`, `.github/workflows/runtimes.yml` | M4 | Tests against a local WebSocket bridge fixture; Bun/Deno green | M |
| **M11** | `varlink-js-native` (separate package in `native/`): fds (incl. client `fds`/`acceptFds` and CLI `--push-fd`), peer creds, `user.varlink` xattr tagging (`listen`/`server`/`entrypoint`/`client`, best effort), per-UID limits; resolve Q5 | `native/` (+ small touches to `src/rpc/`, `src/cli/` after M9) | M4 (addon), M9 (rpc/CLI integration) | fd passing to/from a systemd service in the VM | L |
| **M12** | Docs: README, `docs/MIGRATION.md`, TSDoc, examples (incl. a safe reference server bound to 127.0.0.1, mode 0644), release workflow (not run); open PR `rewrite → master` **inside the fork** for Pawel | `README.md`, `docs/`, `examples/` (except certification), `.github/workflows/release.yml` | M5–M7 (others may follow) | PR open with test evidence | S |

Critical path: M0 → M1 → M2 → M3 → M4 → (M5 ∥ M6) → M7 → M12. After M4, these can run in parallel because
they own disjoint files: M5, M6, M8, M10 and M11. M9 waits for M7 and M8 because it touches protocol, rpc
and CLI files. M10 may overlap with M9. M11 starts its addon work after M4, but its rpc/CLI
integration waits for M9.

"Usable state" for the fork-internal PR (implementation card's wording): M0–M7 done and M5
certification green.

---

## 11. Risks

- **Precision of ints**: JS developers will hit `int` > 2⁵³ in systemd APIs (e.g. `uid` is fine, but
  sizes and timestamps in µs are close). Mitigated by rejecting rather than rounding, plus `bigint` mode.
- **Cancellation = close** surprises users. Mitigated by docs and by the Pool.
- **Native addon maintenance** (prebuilds for x64/arm64 glibc/musl). Kept optional and isolated in M11.
- **Bun/Deno `node:` compat gaps** (abstract sockets, `listen({fd})`). Found in M10, fixed with native
  adapters only where needed.
- **Spec drift**: UAPI.20 is v0.1 and systemd moves fast (upgrade landed in v261, `list-sockets` in v262).
  The corpus from a pinned systemd version plus the CI interop job will catch regressions.
