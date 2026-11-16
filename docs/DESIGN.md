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

- sd-varlink defaults (line numbers at 6bd4689f): method-call timeout **45 s** (`VARLINK_DEFAULT_TIMEOUT_USEC`,
  sd-varlink.c:49); max **4096** server connections (`VARLINK_DEFAULT_CONNECTIONS_MAX`, sd-varlink.c:46), **128 per
  UID** when `SD_VARLINK_SERVER_ACCOUNT_UID` is set (`VARLINK_DEFAULT_CONNECTIONS_PER_UID_MAX`, sd-varlink.c:47); input
  buffer max **16 MiB** (`JSON_STREAM_BUFFER_MAX_DEFAULT`, json-stream.c:30); `collect` max 1024 replies
  (`VARLINK_COLLECT_MAX`, sd-varlink.c:50);
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
| `upgrade` | ❌ | ✅ (v261 varlinkctl) | ◐ | ✅ `call_upgraded` | ❌ | ✅ M9 (implemented, §5.6; Q4 as sd-varlink; interop run against varlinkctl 262.2 in the UTM VM, 2026-11-15, §7.4) |
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
| `/run/varlink/registry/` lookup | ❌ | ✅ (v260) | ❌ | ❌ | ❌ | ✅ M8 (lookup, list, publish via `serve(…, {registry})`) |
| `org.varlink.resolver` client | ✅ | ❌ | ✅ | ✅ | ◐ (schema only) | ◐ M8 (untyped, Resolve + GetInfo only) |
| fd passing (`SCM_RIGHTS`) | ❌ | ✅ (opt-in per direction) | ❌ | ❌ | ❌ | ✅ M11 (optional `varlink-js-native`, unix sockets, Node on Linux; §4.15; interop with varlinkctl 262.2 `--push-fd=`/`--exec`) |
| Peer credentials (`SO_PEERCRED`/pidfd) | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ M11 (native addon; pidfd on Linux ≥ 6.5) |
| `user.varlink` xattr tagging | ❌ | ✅ | ❌ | ❌ | ❌ | ◐ M11 (best effort, native addon: the roles are set as sd-varlink does, but Linux 6.8 sockfs refuses user xattrs with `EPERM`, so nothing is tagged there) |
| Per-call timeout | — (caller's event loop) | ✅ (45 s default) | ? | ? | ❌ (socket idle timeout, crashes server, F1/F4) | ✅ M4 |
| Cancellation | — (close) | — (close) | — | — | ❌ | ✅ M4 `AbortSignal` (closes connection, per spec) |
| Write backpressure | ? | ✅ (output queue cap) | ? | ? | ❌ (hangs, F3) | ✅ M4 |
| Read backpressure for streams | ? | ? | ? | ? | ❌ | ✅ M4 |
| Max message size | ? | ✅ 16 MiB | ? | ? | ❌ (F15) | ✅ M3 (16 MiB default) |
| Connection limits (total / per UID) | ? | ✅ 4096 / per UID opt-in (`SD_VARLINK_SERVER_ACCOUNT_UID`, then 128) | ? | ◐ (worker cap) | ❌ | ✅ M4 / M11 (`maxConnectionsPerUid`, opt-in like sd-varlink's flag; counted where the peer's credentials are known: unix sockets through the native addon) |
| Exit-on-idle | ? | ✅ | ? | ✅ (listen idle timeout) | ❌ | ✅ M8 |
| Graceful shutdown | ? | ✅ (SIGINT/SIGTERM flags) | ? | ? | ❌ | ✅ M4 |
| Connection pool | — | — | — | — | ◐ (dead conns, F4) | ✅ M4 |
| **Codegen** `.varlink` → types | ❌ | — (C macros) | — (dynamic) | ✅ `varlink_generator` | ❌ (hand-written) | ✅ M6 |
| Dynamic client from introspection | ✅ (`call` any method) | ✅ | ✅ | ✅ | ◐ (`VarlinkDynamicMethod`) | ✅ M6 |
| **CLI** info / introspect / call / format / validate | ✅ | ✅ | ◐ (no format) | ✅ | ❌ | ✅ M7 (implemented, §4.14) |
| CLI `--more`/`--collect`/`--oneway`/`--upgrade`/`--timeout`/`--graceful` | ◐ | ✅ | ◐ | ◐ | ❌ | ✅ M7, `--upgrade` M9 (implemented, §4.14) |
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

Rule: `src/core/**` and `src/rpc/**` (and the browser-facing `src/index.ts`, `src/idl`, `src/websocket`, `src/http`, plus the generated `src/interfaces`, which rpc and http may import for the built-in `org.varlink.service`) must not import `node:*` or read `process`/`Deno`/`Bun` globals (ESLint layer rules plus a no-`@types/node` typecheck, §8). That is what keeps
the browser/Deno/Bun story honest.

### 4.1 ByteChannel (the transport interface)

The one interface every transport implements. Pull-based, promise-returning, trivially adaptable from
Node sockets, Deno `Conn`, Bun sockets, WebSockets and Web Streams.

```ts
export interface ReadChunk {
  bytes: Uint8Array;
  /** fds that arrived with the first byte of `bytes` (SCM_RIGHTS). Only on fd-capable channels. */
  fds?: FdHandle[];
  /** M11: the kernel truncated the fds (MSG_CTRUNC) and the channel closed them; the bytes go on (reported, not fatal). */
  fdError?: "truncated";
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
    upgraded?: () => void;          // M11: called once on upgrade (the native channel drops its xattr)
  };
}

/** Owned file descriptor. Closing is the owner's job; unclaimed fds are closed when their message is done. */
export interface FdHandle { readonly fd: number; close(): void; }

export interface FdPassing {
  /** Receiving is opt-in (UAPI). Off by default: fds that arrive are dropped silently, the message going on
   *  (json-stream.c:1318-1321). On: reads stop at each NUL so fds stay with their message (json-stream.c:1187-1227).
   *  SO_PASSRIGHTS (Linux ≥ 6.16) stays at the kernel default (on), as in sd-varlink (json-stream.c:691-692,
   *  sd-varlink.c:3347-3352); only strict channels (`fdPassingInputStrict` listeners, like
   *  SD_VARLINK_SERVER_FD_PASSING_INPUT_STRICT) set it from this, so a sender's sendmsg with fds gets EPERM. */
  setAcceptInput(on: boolean): void;
  setAllowOutput(on: boolean): void;         // off: write() with fds rejects (OperationNotSupportedError)
  duplicate(fd: number): FdHandle;           // M11: F_DUPFD_CLOEXEC, owned by the caller
}

export interface PeerCredentials { uid: number; gid: number; pid: number; pidfd?: FdHandle; } // pidfd: the channel's

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

**fd ownership (M11, decided once, followed everywhere):**
- `ByteChannel.write(chunk, fds)` takes no ownership: it neither duplicates nor closes `fds`, which must stay open
  until the promise settled.
- fds a *caller* hands to the library (`conn.call(…, {fds})`, `ctx.pushFds(…)`; numbers or FdHandles such as an
  `fs.FileHandle`) stay the caller's: the library duplicates each one (`F_DUPFD_CLOEXEC`, through
  `FdPassing.duplicate`) synchronously when the call or `pushFds` is made, sends the duplicates and closes them once
  the message was written or dropped. So the caller may close its own fds as soon as the method returned, and the
  library never closes anything it was given. (sd-varlink's `sd_varlink_push_fd` takes ownership instead,
  sd-varlink.c:3262-3263; duplicating spares JS callers the timing question of "after the write".)
- Received fds belong to the library until claimed: a client result with `acceptFds` hands them to the caller (who
  must close them); in a handler `ctx.fds` lists them (library-owned, valid until the call finished) and
  `ctx.takeFd(i)` claims one; everything unclaimed (also fds of error replies, of dropped or abandoned replies, of
  an upgrade confirmation, after an upgrade or a close) is closed by the library.
- `PeerCredentials.pidfd` (fetched on first access) belongs to the channel and is closed with it.
- What handlers and users are lent is a view, never the owned handle: `ctx.fds[i]` and `peer.pidfd` have a no-op
  `close()` and report `fd` -1 once the library no longer holds that fd (claimed with `takeFd`, closed at the end of
  the call, or with the connection), so a stale number is never handed out or closed by mistake.
- Write errors close what the library owns: a call's duplicates are closed once its write settled, also when it failed
  (the Connection's write path and dispatch both close in a `finally`).

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
Encoding always writes `parameters` (`{}` when empty: some peers index it directly). This is a deliberate
difference: sd-varlink omits empty parameters (`JSON_BUILD_PAIR_VARIANT_NON_EMPTY`, sd-varlink.c:1955) and the spec
says senders SHOULD omit them (varlink.md:611, 632-633); receivers MUST treat both forms alike. Encoding also
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

`unix:` followed by a relative path (`unix:relative/path`, `unix:./x`) is accepted as an AF_UNIX path relative to the
current directory. This is a deliberate difference: sd-varlink refuses a `unix:` path that is not absolute
(sd-varlink.c:613-616); we keep it for the CLI and tests, like the bare `./rel/path` form.

Anything after `;` is ignored (UAPI: future extensions). Programmatic `bridge: string[]` (spawn argv,
speak on its stdio) covers python/libvarlink `--bridge` (`connectBridge(argv)`, §5.8).

ssh notes (M8): the host must be non-empty, without whitespace or control characters, and must not start with `-`
(else `TypeError`); sd-varlink does not check the `-`, we do so on purpose (a host `-oProxyCommand=…` would be an ssh
option). The `ssh-unix:` path must be absolute and normalized. `ssh-exec:` splits the command line like sd-varlink's
`strv_split_full(EXTRACT_UNQUOTE|EXTRACT_CUNESCAPE)` (whitespace-separated words, `'…'` and `"…"` alike,
quotes inside words, C escapes `\a \b \f \n \r \t \v \s \\ \" \' \xNN \NNN \uXXXX \UXXXXXXXX` everywhere, also
inside quotes as in systemd's extract-word.c, no NUL, the result valid UTF-8; an unterminated quote, trailing backslash, unknown escape or zero
words is a `TypeError`). As with varlinkctl, the words go to ssh as separate arguments and ssh joins them with spaces
for the remote shell, so remote arguments containing spaces or shell metacharacters are re-parsed remotely.

**Service registry (M8, `src/node/registry.ts`).** UAPI.20 "Service Registry Directory": entries named after the
interface, each a socket inode or a symlink to one; other inodes are ignored and readers must not assume the list is
complete. The directory is systemd's `runtime_directory_generic(scope, "varlink/registry")` (verified against
varlinkctl.c:1188, systemd 2336319d): `/run/varlink/registry` (system) or `$XDG_RUNTIME_DIR/varlink/registry`
(user). `registryDirectory(scope = "system")` returns it (user scope without an absolute `XDG_RUNTIME_DIR`:
`TypeError`).

- `listRegistry({scope?, directory?})` (like `varlinkctl list-registry`, varlinkctl.c:1182-1260): entries sorted by
  interface, `{interface, address: "unix:<entry path>", target}` (`address` is connectable through the symlink and
  short; `target` the socket, symlinks chased with `realpath`). Names failing `isInterfaceName`, dangling symlinks and
  non-sockets are skipped; a missing directory gives `[]`. An entry path that does not fit in sun_path (over 103
  bytes, 107 on Linux) cannot be connected to: `address` is then `unix:<target>` if the target fits.
- `resolveInterface(name, {scope = "auto", directory?, resolver?, timeout?, signal?})` → an address: the entry
  `<dir>/<name>` (socket or symlink to one → `unix:<entry path>`, or `unix:<target>` under the same sun_path rule) in
  `directory` if given, else the system registry
  then (scope `"auto"`, if `XDG_RUNTIME_DIR` is set and absolute) the user one; then `org.varlink.resolver` at
  `resolver` (default `unix:/run/org.varlink.resolver`, `false` = none). Nothing found: `InterfaceNotFoundError`
  `{interface}` with `cause` = the resolver's `org.varlink.resolver.InterfaceNotFound` (or the service's
  InterfaceNotFound of a peer without the resolver interface), or the connect error if the resolver was unreachable.
  An aborted `signal` and other resolver failures (timeouts, invalid replies) reject as they are. Invalid name:
  `TypeError`.
- Resolver client (partial and untyped until M6 regenerates it): `resolverResolve(conn, iface)` (the reply's
  `address` must be a string `parseAddress` accepts *of a socket kind*, `unix`, `unix-abstract` or `tcp`, else
  `ValidationError` for `address`, naming the kind: `connect()` spawns for `exec:`/`ssh-unix:`/`ssh-exec:`, so a
  malicious or spoofed resolver must not be able to make `connect(await resolveInterface(…))` run a local binary or
  a remote command; websocket/http are refused too, as no resolver has a reason to send them) and
  `resolverGetInfo(conn)` (reply checked against the IDL), plus `ORG_VARLINK_RESOLVER_IDL` for implementing one
  (`server.addInterface(ORG_VARLINK_RESOLVER_IDL, …)`, as the tests do).
- Publishing: `serve(listener, {registry})` (§5.4) through `bindRegistry` below.

### 4.7 Runtime adapters

- **Node** (`varlink-js/node`): `node:net` (unix, tcp, abstract), `node:child_process` (exec/ssh/bridge),
  `server.listen({fd})` for socket activation. Found in M4 (§4.11): libuv unlinks a unix socket's bound path on
  `server.close()` even after it was replaced (hence bind in a private directory + `link`), and `server.address()` is `null`
  for a unix socket listened via `{fd}` (hence the `fd:<n>` placeholder address).
- **Bun, Deno 2**: the Node adapter runs through their `node:` compat; no native adapters (`Bun.connect`,
  `Deno.connect`) were needed. M10 (`.github/workflows/runtimes.yml`, ubuntu-latest): Bun latest runs
  `bun test test/unit test/regression`, Deno 2.x `deno test -A --no-check test/unit test/regression` (`npm ci` for the
  dev dependencies; types are checked by `tsc` in ci.yml), i.e. every unit test plus the e2e regressions over pair,
  unix and tcp, `sockets.test.ts`, the WebSocket/HTTP clients against the bridge fixture, abstract sockets and
  `listen({fd})`. Checked on Bun 1.4.4 and Deno 2.9.8 (macOS, and the versions CI resolves on Linux). Results:
  abstract sockets (Linux), `listen({fd})` (unix and tcp), half-close, `context.source`/`JSON.rawJSON` and the global
  `WebSocket`/`fetch` all work on both. Gaps found and how they are handled: Bun's `server.address()` for a unix socket
  inherited via `{fd}` is an object without `address`/`port` (handled: `fd:<n>` placeholder, as on Node); Bun reports
  an accepted socket's `timeout` as `0` instead of `undefined` (both mean none; the F1 test accepts either); Bun keys
  its module cache by path and ignores a `?query`, so the F11 two-module-instances test is skipped on Bun (the brand
  check itself runs everywhere); RSS grows in ~4 MiB steps on Bun and Deno, so F15's pair bound is doubled there.
  Not covered on Bun/Deno: the fuzz suite and the tooling tests (`test/fuzz`, `test/tooling`; they run on Node), and
  the compiled-dist consumer fixture (Node only). Browsers: the websocket/http subpaths are lint- and
  typecheck-guarded (no `node:`, no runtime globals, `.d.ts` without DOM types) but no browser runs them yet
  (Playwright smoke test not done; M10 leftover).
  M8 on Bun/Deno: the registry, resolver, `mergeListeners`, `/proc` parser, stdio and `listen({fd}, {address})` tests
  run on both (Bun on macOS refuses `realpath()` of a socket with `EOPNOTSUPP`; the registry resolves such paths by
  hand). The spawned-child paths (`exec:` in both socket modes, `connectBridge`, the ssh kinds, and `listenFromEnv`
  /`listenAuto` in an activated child) run on both too (checked on Bun 1.4.4 and Deno 2.9.8, macOS). The tests start
  fixtures through `childCommand()` (`deno run -A --no-check` on Deno: a bare `deno script` inside a shell script
  or a `#!` line would run without permissions). Runtime workarounds in `src/node`:
  - Bun: `new net.Socket({ fd })` on an inherited socket fd never reads or writes. `net.connect({ fd })` does open a
    real socket over it there (reads, writes, `end()` sends a FIN, `destroy()` closes the fd; blocking and
    `O_NONBLOCK` fds alike), so a connected activation fd goes through it on Bun. Node and Deno reject
    `net.connect({ fd })` (no port or path) and keep `new net.Socket({ fd })`. `test/unit/node/connected-fd.test.ts`
    checks half-close and close on every runtime, and that the fd is released on Node and Bun (on Deno an inherited
    fd taken by the runtime is not visible to `fstatSync`, so that check proves little there).
  - Deno: a socket `process.stdin` is a plain Duplex with `emitClose: false` that never emits `close` after
    `destroy()` (it only sets `closed`). For such a stream (`emitClose: false` and not a `net.Socket`, which emits
    `close` itself), on Deno only, the streams channel also counts the stream as closed once its `_destroy` calls
    back (it wraps it; `closed` is set there), whoever destroyed it (our `close()`, auto-destroy after EOF, an
    error), so `Connection.closed`/`server.closed` of a stdio server resolve. A clean `end` alone does not count; a
    stream already being destroyed when the channel is built counts as closed at once.
    `stream.finished()` cannot do it: for such a stream it fires on `end`/`finish` and never on a destroy. Child
    pipes (`net.Socket`s) still wait for the event.
  - Deno: `spawn()` fails with `EBADF` when one fd fills two stdio slots, so the `/dev/null` cover of inherited
    activation fds opens one `/dev/null` per slot.

  Still skipped, as genuine runtime gaps (as of Bun 1.4.4 and Deno 2.9.8; constants in
  `test/unit/node/helpers.ts`):
  - Deno: the `O_NONBLOCK` (accepted unix socket) half of `connected-fd.test.ts`: a Deno `net.Socket` has no real fd
    (`_handle.fd`) to hand to a child. The socketpair half runs.
  - Bun and Deno (`STDOUT_END_NO_FIN`): `process.stdout.end()` on a socket stdout sends no FIN, so a stdio server's
    peer sees EOF only when the process exits. The must-exit rule of `listenStdio` covers it. The skipped test is
    the bridge `--hold` one.
  - Bun (`BUN_NO_SPAWN_DIAGNOSTICS`): `node:child_process` does not publish the `child_process` diagnostics
    channel, which the abort/timeout-during-spawn tests use to act at the moment of the spawn. The code path itself
    is portable.
  - Bun: `process.getActiveResourcesInfo()` lists no timers, so the exit-on-idle "no timers once shut down" test is
    skipped there (Deno 2.9.8 lists them).
- **Browser**: `varlink-js/websocket` (WebSocket mode against systemd's `varlink-http-bridge` or any
  UAPI bridge). It's standardised now, so it is worth doing. No fds, as the spec says.
- **fd passing / peer credentials**: no JS runtime exposes `SCM_RIGHTS` or `SO_PEERCRED`. Done in M11 (§4.15, Q5):
  a separate optional package `varlink-js-native` (`native/`, a small Node-API addon, Linux; no prebuilds yet) whose
  sockets back a `ByteChannel` with `capabilities.fdPassing` and `.peer`. It is injected (`connect(…, {native})`,
  `listen(…, {native})`, `listenFromEnv({native})`), never imported by the library. Node only: Bun and Deno lack the
  libuv access it needs, so there (and when it is not built) the capabilities are simply absent and fd-using calls
  fail with `OperationNotSupportedError` locally, before anything is sent.

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
  never read). **Absent ≡ null ≡ undefined for `?T` fields, and the output omits them** (except on decode, where
  an absent `?T` field named like an `Object.prototype` member — `constructor`, `toString`, `valueOf`,
  `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString` — is an own `undefined` property, so
  it never reads as the inherited function; `JSON.stringify` still omits it); in arrays and maps a
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
  time. Connection, Server, Pool and the HTTP client (§4.12) bind through the internal
  `bindDescriptor(desc, runtimeInts, options)`: the checks of `compileDescriptor`, then an interface with no `int` anywhere (`usesInt` walks every member, field and
  element type, nested, nullable, array, map and inline) compiles with the runtime's `ints` whatever `desc.ints`
  says (its TS types are the same in both modes); one that uses `int` goes through `assertIntsMode`.
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
`DEFAULT_MAX_MESSAGE_SIZE`, plus the `ValidateReplies`/`DispatchErrorReason` types since M4). M4 decided: sessions,
`Framer`, message codecs and `dispatchCall` stay internal (not exported from the root); transports (M10) import core
by relative path (§4.11). `src/testing/` (`varlink-js/testing`): `pair()`, `faulty()`.
- **Framer**: one growable `Uint8Array` (doubling, compacted with `copyWithin` once the read offset passes half the
  buffer, or when it needs room and the read offset is at least a quarter of the buffer; otherwise it grows and
  copies only the unconsumed bytes); each byte is scanned for NUL twice, once on push (counting complete messages,
  checking the limit, so 1-byte pushes stay O(n)) and once more when `next()` returns its message. When `next()`
  empties a buffer larger than 64 KiB it is dropped and re-allocated lazily (4 KiB) on the next push; when it
  leaves less than a quarter of such a buffer buffered, the rest moves to a new buffer of the smallest 4 KiB × 2ᵏ
  ≥ 2 × buffered (copies < ¼ of the capacity, so still amortised O(n)). So one big message, also one followed by
  the first bytes of the next, does not pin its memory; `capacity` (tests/diagnostics) is the buffer's size. Size = bytes
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
  `continues` with `error`, an ext key without `.`, an ext value that is not a plain object: vendor members MUST be
  objects, varlink.md:780-786) are `TypeError`s, as are codec failures. Decoding keeps any vendor value as received.
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
  buffer cap, json-stream.c:1245-1246, with room for one partial message: without a complete message reading goes on,
  the framer caps the partial one; so at most about 2 × `maxMessageSize` + one chunk buffered, and since the buffer
  doubles, a framer capacity of about 4 × `maxMessageSize` per connection in the worst case while reading, which
  drops back once the messages are consumed), while at least one complete message is buffered and the buffered,
  not yet dispatched calls hold `maxQueuedFds` (default 253) received fds or more (M11; fds a call event handed out
  no longer count; a partial message with fds keeps reading, so one message carrying more is still accepted), while paused
  after an upgrade call, after EOF or a framing error, and when not open. A malformed message, when reached, is
  `{type: "close", error}` (calls before it are answered first, nothing is written for it). An upgrade call pauses
  splitting until it ends: an error reply resumes, and so does any reply after `ignoreUpgrade(id)` (M9, Q4: dispatch
  calls it for a method without upgrade support, which then runs as a plain call); a final non-error reply makes the
  state `upgraded` and every
  byte after the call's NUL (also bytes received later; repeated takes allowed, each returns what arrived since the
  previous one) is `takeUpgradeRemainder()`. If that remainder was lost to the size limit, the confirming `reply()`
  returns null instead of bytes and the session closes (`{type: "close", error}` with the `MessageTooLargeError`):
  the peer never sees a confirmation. A second final reply, a wrong
  id, `continues` without `more` or any reply when not open is a `TypeError` with no state change; an encode
  failure rethrows and leaves the call active. If the call ended or the session closed while the reply was being
  encoded (a re-entrant reply from a `toJSON` or getter), the outer `reply()`/`error()` throws `TypeError("re-entrant
  reply …")` and produces nothing, so a call never gets two final replies. After EOF the buffered calls are still
  delivered, then `{type: "close"}`. `close()` is local: nothing more is produced. There is at most one close
  event, and the driver always gets it: a `close()` before one was delivered (by the driver, or by dispatch after a
  failed send or an unencodable `InternalError`) makes the next `nextEvent()` return one, keeping a pending error
  (e.g. the lost upgrade remainder's `MessageTooLargeError`), else `{type: "close"}`; then null. `closedSignal`
  aborts whenever the state becomes `closed`, after every other field (the pending close event included) is
  updated; dispatch listens to it until its call is finished (it acts only while the call is unanswered). The driver awaits `dispatchCall` before taking the
  next call, so at most one dispatch listens at a time.
- **Dispatch** (`dispatchCall(session, id, call, table, send, options)`, never rejects, resolves when the call is
  finished): checks in order 1. `parseMethodName` (last dot; interface and member grammar) → `InvalidParameter
  {parameter: "method"}`; 2. `InterfaceNotFound {interface}` / `MethodNotFound {method}`; 3. `requires` more →
  `ExpectedMore`; 4. `requires` upgrade → `ExpectedUpgrade` (an `upgrade` call to a method without upgrade support is
  no error since M9, Q4 as sd-varlink: dispatch calls `session.ignoreUpgrade(id)` and the call runs as a plain one, its
  reply or error goes out normally and the session reads varlink calls again; M3's provisional `InvalidParameter
  {parameter: "upgrade"}` is gone); 5. no handler → `MethodNotImplemented`; 6. `input.decode(…, {unknownFields:
  "reject"})`, a `ValidationError` →
  `InvalidParameter {parameter}`, anything else → `InternalError`. Then the handler runs (a sync throw counts as a
  rejection). An async-iterator result streams (each yield a `continues` reply, awaiting `send` first; the return
  value, or `{}`, is final); without `more` the first yield (or the return value) is the single reply and
  `return()` closes the iterator (a throw there is `cleanup-threw`). Oneway: a generator runs only up to its first
  `yield`, then `return()` (intended: no reply is wanted, and an endless monitor must not run forever; side effects
  after the first `yield` do not happen). An iterator result that is not an object (`null`, `5`), or whose
  `done`/`value` getter throws, counts as a throw (rule 9: `InternalError` + `handler-threw`) and the iterator is
  closed with `return()`. Other results: a plain object or `undefined`
  (→ `{}`); anything else (also a value whose prototype cannot be read, e.g. a throwing Proxy) is `bad-result` and
  `InternalError`. Thrown values: a `VarlinkError` with a valid name is checked with `table.errorValidator`
  (unknown interface: sent as is; known interface without that error, or parameters that do not validate or that
  the codec cannot encode: `InternalError` + `invalid-error`); anything else is `InternalError` +
  `handler-threw`, with nothing about it on the wire. `validateReplies` (`"warn"` default) applies to every reply
  value when the entry has `output`: `"warn"` sends the encoded value, or the original one plus `invalid-reply`;
  `"throw"` ends the call with `InternalError` (stopping a generator first). A reply the session cannot encode is
  `invalid-reply` and `InternalError`; if even the `InternalError` cannot be produced (a broken codec) while the
  session is open, the session is closed (`ctx.signal` aborted), so the connection never hangs on a call that
  cannot end. Dispatch never produces a reply from inside another one (a reply's `toJSON` or getter calling
  `ctx.notify()`: that notify rejects with a `TypeError` and `invalid-reply`, the outer reply goes on), so it never
  queues two final replies. A generator is never resumed once the call ended while its reply was being written. A
  rejected `send` aborts `ctx.signal`, stops the generator, reports
  `send-failed` and closes the session; `options.signal` aborts `ctx.signal` and replies after the session closed
  are dropped silently. Oneway: nothing is sent, non-`VarlinkError` throws are still `handler-threw`, then
  `finish(id)`. A confirmed upgrade with nobody to take the stream is `upgrade-unclaimed`. `onError` exceptions are
  swallowed.
- **`ctx.upgrade(replyParams?)`** (M9, §5.6): available iff the call has `upgrade: true`, the method supports or
  requires upgrade and the driver passed `options.upgrade` (its hand-over: `() => ByteChannel`, called once the
  confirming reply was written and the session is `upgraded`); otherwise, when called a second time (also while the
  first is writing) or after the call's final reply (e.g. a notify without `more`), it rejects with a `TypeError` and
  nothing is written. It produces the final reply like a returned value (validated per `validateReplies`; an invalid
  one in `"throw"` mode, or a non-plain value, ends the call with `InternalError` and rejects with the problem), waits
  for its write (a failed write or a session closed meanwhile rejects with `ConnectionClosedError`) and resolves with
  the hand-over's channel. Afterwards the call is claimed (no `upgrade-unclaimed`), the return value is ignored, a
  later throw is `handler-threw`, and `ctx.notify()` rejects with a `TypeError`. The raw flag is
  `ctx.upgradeRequested` (M3's boolean `ctx.upgrade` became the method).
- **`ctx.notify(v)`**: with `more`, a `continues` reply serialized with the other sends (resolves when written;
  validated like any reply, a `"throw"` failure ends the call with `InternalError` and rejects; the rejected
  promise has a no-op handler attached, so a fire-and-forget notify is never an unhandled rejection). Without `more`
  the first notify is the single final reply and later notify calls and the return value are dropped (a later
  throw goes to `onError` only). sd_varlink_notify answers `ExpectedMore` there instead; we follow the generator
  rule ("Monitor without more = current state") so a handler does not need two code paths. Oneway: nothing is
  sent, resolves. Dropped notifies (oneway, non-`more` after the first) resolve immediately. After the call's final
  reply: resolves without sending (`late-notify` once the handler settled). A `bad-result` value (any mode) or an
  `invalid-reply` in `"throw"` mode ends the call with `InternalError` and rejects with that problem. Once the
  connection is gone it rejects with a `ConnectionClosedError` (`cause`: `ctx.signal.reason`), for every kind of
  call, oneway included: gone means a send of the call failed (also this notify's own) or the session was closed
  while the call was still unanswered (by the driver or by dispatch); either also aborts `ctx.signal` at once
  (dispatch listens to `session.closedSignal`, which aborts whenever the session becomes `closed`). An aborted
  `ctx.signal` alone is not gone (a graceful shutdown aborts it and still writes replies, so a notify-style reply
  goes out like a returned one), and neither is a session closed by a clean peer EOF after the final reply (a UAPI
  client may half-close after sending its calls and still read the replies). Because
  dropped notifies resolve immediately, a handler must wait on real events between notifies (`for await (const c
  of changes({ signal: ctx.signal })) await ctx.notify(c)`); a bare `for (;;) await ctx.notify(x)` busy-loops for
  a oneway or non-`more` call. Methods meant to stream should declare `more: "requires"`. Every rejected notify
  promise has the no-op handler attached.
- **Testing channels**: `pair({highWaterMark})` (default 64 KiB): chunks arrive in order as written (copied, never
  merged); `write()` resolves once the peer's unread bytes are ≤ `highWaterMark` and rejects after this side's
  `end()`/`close()` or the peer's `close()`; `read()` gives `null` after the peer's `end()` once drained and after
  this side's `close()`; `close()` lets the peer drain what was queued; `closed` resolves on `close()` or after
  both `end()` and reading EOF; concurrent `read()` is a `TypeError`; no timers. `faulty(channel, plan)` splits reads
  and/or writes (`"every-byte"`, a max size, or cut offsets), simulates a reset after N bytes read or written
  (`ConnectionClosedError("connection reset (faulty)")`, inner channel closed; after a write reset every later
  write rejects, also a zero-length one) and awaits `delay()` before every read and write. Writes are serialized
  (each starts after the previous one settled), so concurrent writes arrive in order and never interleave; `end()`
  runs after the queued writes settled (like a socket flushing before its FIN; their failures do not prevent it).
  `close()` is immediate: `read()` gives `null` from then on (also a read waiting for its delay; undelivered split
  pieces are dropped), and queued or later writes reject, also a zero-length one.
- **Leftovers**: `JSON.parse` keeps the last of duplicate keys while sd-varlink rejects duplicates; not detectable
  without a custom parser. sd-varlink rejects `null` flags; we accept them per UAPI (null ≡ absent). For an `upgrade`
  call to a `[Requires 'more' flag]` method we send `ExpectedMore`; sd-varlink sends it only in state
  `VARLINK_PROCESSING_METHOD` (sd-varlink.c:1386), so there the call gets no reply at all (not copied). sd-varlink lets
  any method callback upgrade once the client set the flag (`sd_varlink_reply_and_upgrade` checks only the call flag,
  sd-varlink.c:2704); `ctx.upgrade()` also needs the method's upgrade support, so a typed handler cannot upgrade
  a call its IDL does not allow (deliberate). Upgraded data
  pipelined behind an upgrade call that is not yet processed counts against `maxMessageSize`; if it overflows, the
  server session closes with `MessageTooLargeError` instead of handing over a truncated stream.

### 4.11 RPC layer (M4)

`src/core/address/` (`parse.ts`), `src/rpc/` (`connection.ts`, `pool.ts`, `server.ts`, `service.ts`, `proxy.ts`,
internal `util.ts`), all runtime-agnostic (I/O only through `ByteChannel`, Web `setTimeout`/`AbortSignal` only).
The root entry re-exports the rpc API (`createConnection`/`Connection`, `createPool`/`Pool`,
`createServer`/`Server`, their option/handler types, `InterfaceProxy`, `StreamIterator`, …) and `parseAddress`,
`formatAddress`, `AddressSpec`; sessions stay internal (§4.10). `varlink-js/node` (`src/node/`: `socket.ts`,
`connect.ts`, `listen.ts`, `pool.ts`) exports `connect`, `listen`, `createPool(address)`, `fromNodeSocket` and the
types `ConnectOptions`, `ListenOptions`, `NodeListener` (`createServer` stays in the root entry); the e2e suite runs
over `pair()`, unix and tcp sockets.
- **Addresses** (§4.6): `parseAddress` returns `unix {path}` (`unix:` + any non-empty path as given, bare `/…`,
  `./…`, `../…`), `unix-abstract {name}`, `tcp {host, port}` (`[v6]` brackets removed; a bracketed host must contain
  `:`; an unbracketed one is split at its last `:` and may not contain `[`/`]`; port 1–5 decimal digits ≤ 65535, so
  `080` is 80), `exec {path}`, `ssh-unix {host, path}` (alias `ssh:`; split at the first `:` like sd-varlink; path
  absolute), `ssh-exec {host, command}`, `websocket {url}` / `http {url}` (`URL`-normalized `href`, scheme
  case-insensitive; `http(s)` is WebSocket mode iff the path ends in `/ws/services/<svc>`). Everything after the
  first `;` is dropped except in URL forms. No NUL in unix paths or abstract names. Errors are `TypeError`s quoting
  the input with `safeQuote` (§4.9). `formatAddress` renders the canonical form and re-parses it: a spec with no
  string form that parses back to it (a `;` the parser would cut, a unix path starting with `@`, an `http` URL
  naming a WebSocket path) is a `TypeError`, so `parseAddress(formatAddress(x))` always equals `x`.
- **Connection** (`createConnection(channel, options)`; options and defaults as in §5.1 plus `codec`, `errors`,
  `interfaces`, `highWaterMark` 64 and `onError`). One serialized write queue: a call reaches
  `ClientSession.call()` only when its turn to write comes (so a queued call can still be removed); each write is
  awaited; a write failure closes the connection. A call that cannot be encoded (codec `TypeError`) rejects alone.
  One reader loop (`read()` → `receive()` → events; `null` → `receiveEnd()`; a rejection closes with
  `ConnectionClosedError(cause)`), top-level catches everywhere. `channel.closed` settling also closes it.
  `closeReason` is the ProtocolError, transport error, CallTimeoutError, abort reason or `close(reason)`, undefined
  for `close()` and a clean EOF. Closing rejects every queued and pending call with `ConnectionClosedError`
  (`cause` where there is one) and settles `closed` once the channel's `closed` did; later calls reject at once.
- **Upgrade** (M9, §5.6): `upgrade(method, params, options)` is op kind `upgrade` (`init.upgrade`), with the timeout,
  abort and pipelining rules of a single call (calls queued after it reach `ClientSession.call()` while it is pending
  and reject with its `UpgradePendingError`). The session's `upgraded` event is routed while the reader loop is
  processing the chunk that held the reply, so no further `read()` is issued: the channel handed out is an
  `UpgradedChannel` (`src/rpc/upgrade.ts`, internal) over the transport whose first read is
  `takeUpgradeRemainder()` (bytes past the reply's NUL in that chunk) and which delegates everything else (writes and
  their backpressure, `end()`, `close()`, `closed`, `capabilities`) to the transport. The connection is then
  finished without touching the channel: `isClosed` true, `closeReason` undefined, `closed` resolved, `close()` a
  no-op for the transport, later calls reject with `ConnectionClosedError("connection was upgraded")`. The confirming
  reply is decoded like a single reply (typed: always; `"throw"` failure → rejects and closes the channel, which nobody
  else owns). A descriptor without an `upgrade` flag is a `TypeError` before anything is sent (strings are sent as
  is). Typed clients and proxies get `.upgrade()` (§5.3); the Pool has none (an upgraded connection can never return
  to it), so a typed client over a pool rejects `.upgrade()` with `OperationNotSupportedError`.
- **Timeouts**: armed when a call reaches the head of the reply FIFO (or, for oneway, when its write starts: it
  covers the write); `call`/`collect` whole call, `stream` until the first reply, then `idleTimeout` (re-armed per
  reply, paused while the stream's buffer is full). Expiry rejects with `CallTimeoutError` and closes. Timers and
  abort listeners are removed on every settle path.
- **Abort**: aborted before → reason, nothing written; while queued → removed, connection open; after it was handed
  to the session → reason, connection closed, others `ConnectionClosedError(cause = reason)`.
- **Streams**: `stream()` returns a `StreamIterator` (`AsyncIterableIterator` with a non-optional `return()`); the
  call is enqueued at once; every reply, the final one included, is yielded; an error (error reply, close, timeout,
  abort) rejects `next()` after the replies already buffered were consumed, then `done`. `return()` before the final
  reply closes the connection if the call was handed to the session, and only drops it if it was still queued; after
  the final reply it is a no-op. Read backpressure: while the head stream holds ≥ `highWaterMark` undelivered
  replies the reader stops calling `read()`. So a stream must be consumed (or `return()`ed): with its buffer full
  the connection stops reading, every later call on it waits, and their timeouts start only when they reach the
  head, so awaiting a later call before draining the stream waits forever (documented on `stream()`).
  `collect()` rejects with `RangeError` past `max` (1024).
- **Validation** only for interfaces registered on the connection (`interfaces` option, `addInterface`; built-ins
  `org.varlink.service` and `INTERNAL_ERROR_INTERFACE` always, registered from their generated descriptors (§4.13)
  with `ints` set to the connection's; their core error classes are registered only under names that have no class
  in `errors` yet, so a user-supplied registry keeps its entries, e.g. a custom `InvalidParameter` subclass, and is
  used for those replies, while an empty one is filled with the core classes): parameters are `input.encode`d (a
  ValidationError rejects before writing); replies per `validateReplies` (`"off"` raw, so unsafe ints may be
  bigints; `"warn"` decode with `drop`, raw value + `onError invalid-reply` on failure; `"throw"` reject).
  **Typed (descriptor) calls treat `"off"` as `"warn"`**, so their replies are always decoded (unknown fields
  dropped, ints per mode) and valid replies match their types; an invalid reply under `"off"`/`"warn"` is delivered
  raw and reported to `onError` (`invalid-reply`), so use `"throw"` for a hard guarantee. Untyped calls keep `"off"`. An `int-range` in `"number"` mode
  rejects in `"warn"` too. A rejection while replies are still pending (a stream's non-final reply, collect over
  `max`) closes the connection; on a final reply the connection stays intact. Error replies of a registered
  interface are decoded with its error validator (`drop`) and built with `errors.create`; invalid or undeclared →
  plain `VarlinkError` + `invalid-error`; unregistered interface → plain `VarlinkError`. `addInterface`: same name
  and same text is a no-op (a descriptor's error classes are still registered), different text a `TypeError`,
  except for the two built-in names: another text is accepted if it is compatible with the built-in definition
  (`assertBuiltinCompatible` in service.ts, used by Connection and Pool: every method, type and error of the text
  exists in the built-in interface with the same kind and the same `formatType` of its input/output structs, error
  struct or type; docs, member order and the experimental/more/upgrade markers are ignored), else a `TypeError`
  (`interface org.varlink.service: method GetInfo differs from the built-in definition` / `… is not in the built-in
  definition`), since the built-in (UAPI) definition stays in charge of validation and a member it lacks or types
  otherwise would make generated types lie; a descriptor's classes fill only the registry's gaps (generated
  built-ins map to the core classes, so a client generated from another implementation's `org.varlink.service`
  binds); descriptors go through `bindDescriptor` (§4.9: an `int`-free one binds in either `ints` mode). Typed overloads (descriptor must be registered) exist
  for `call`, `oneway`, `stream`, `collect`, `upgrade` (M9). `getInfo`/`getInterfaceDescription` always validate their replies
  (`"throw"`); `getInterface` parses + validates and checks the declared name (`TypeError` otherwise).
- **Proxy** (`conn.proxy(name, {validateReplies = "throw"})`): `getInterface` + a private `compileInterface` (not
  registered); a frozen null-prototype object (so `px.toString`, `px.constructor`, `px.__proto__` are `undefined`
  like any unknown method) with one frozen function per method (`.stream`/`.collect`/`.oneway`), `name` and
  `interface`; parameters always encoded, replies per the option, errors of that interface validated against it.
  `InterfaceProxy` is an interface with `name: string`, `interface: Interface` and an index signature
  `[method: Capitalize<string>]: ProxyMethod | undefined` (varlink method names start upper-case, so it never
  overlaps the two fields); indexing with a plain `string` needs `name as Capitalize<string>`.
- **Pool** (`createPool(factory, {max = 8, idleTimeout = 30_000, timeout = 45_000})`): a FIFO of waiters served by idle connections
  (most recently used first; closed ones are discarded) or new ones while `idle + leased + opening < max`. A lease
  lasts until the operation settles; a stream's until its call is over for the connection (final reply, error,
  `return()`), via an internal settle hook. A factory failure (also a synchronous throw) rejects that operation and
  frees its slot; the factory's signal aborts when its waiter gives up or the pool closes (a connection that still
  arrives goes idle). Waiting for a lease is bounded by the operation's `signal` and `timeout` (else the pool's
  `timeout`, default 45 000 like a connection's, 0 = none): expiry removes the waiter and rejects with
  `CallTimeoutError("timed out waiting for a pool connection")` (if the waiter's connection is being opened, the
  factory's signal aborts with that error, so a factory that would hang frees its slot); the operation's `timeout`
  then applies again to the call itself. A `stream()` whose lease failed rejects its first `next()`, then is done. Connections are dropped
  when their `closed` settles. `close()` rejects waiters, closes all connections, later operations reject. `size`
  counts open connections (not those being opened). **`addInterface(descriptorOrIdl)`** (M6): the pool keeps a list
  of interfaces and registers the ones a connection has not seen yet on it (`Connection.addInterface`) right after
  every lease, before the operation (`call`/`oneway`/`collect`/`stream`, also `getInfo` & co.); a `WeakMap` per
  connection remembers how much of the list it has applied, so nothing is recompiled per lease. It is checked
  eagerly (IDL: parse + validate; descriptor: `compileDescriptor` in `"number"` mode, since the pool has no `ints` of
  its own; same value again a no-op, a different IDL under a registered name a `TypeError`, except for the built-in
  names, which take a compatible text as on a Connection and throw for an incompatible one at once); the `ints`
  match is checked per connection when applied. Each entry is applied on its own and a failure (ints mismatch, a
  different IDL already on that connection) is recorded for that connection and that entry: an operation then
  rejects with the recorded error (and releases the connection) only if it uses the failed entry — a method
  descriptor of a rejected descriptor unless that connection also accepted a descriptor holding the same method
  object (spread copies share method objects; such an entry has the same name, hence the same IDL text, and
  registered the interface: as on a Connection given the same sequence, where the rejected `addInterface`
  registers nothing, so failures are per entry, not per shared method object); a method object only of rejected
  entries stays rejected even if another descriptor registered the interface (its types were generated for the
  other `ints` mode); a name or another descriptor of the interface while the leased connection itself has no
  registration of that name (asked through the internal `has(name)`, so one from another entry or from the
  connection's own `interfaces` option counts). Everything else (`getInfo` & co., other interfaces, a correct
  client of the same interface) keeps working. Typed descriptor overloads of `call`/`oneway`/`stream`/`collect` mirror
  Connection's. `stream()` resolves the validation spec on the leased connection like `Connection.stream`, for a
  descriptor and for a name of a registered interface alike (M4's `pool.stream(name)` skipped validation even when
  `pool.call(name)` validated; M6 makes them consistent).
- **Server** (`createServer(options)`, `service.ts` for the built-ins behind `builtinInterfaces()`, compiled from the
  generated descriptors of §4.13 with `{ ...Desc, ints: server ints }`, sound because the built-in IDLs contain no
  `int`; GetInfo/GetInterfaceDescription are typed with the generated `OrgVarlinkService_Handlers`): registration
  compiles at once (verbatim text kept for GetInterfaceDescription); handlers are functions or `{handler,
  requiresMore?: true, requiresUpgrade?: true}` (raising, never lowering, the IDL flag); unknown keys, bad values,
  built-in or taken names are `TypeError`s and nothing is registered. `UntypedHandler` uses a method signature, so
  an untyped handler may annotate its parameters. `implement(desc, handlers: NoInfer<Handlers<D>>)` infers `D`
  from the descriptor only (inferring it from inline handlers too widened their literal results, M6). The dispatch
  table and GetInterfaceDescription use `Map`s only.
  GetInfo lists `org.varlink.service`, user interfaces in registration order, then `INTERNAL_ERROR_INTERFACE`.
- **Server driver**: per connection a reader task (`while wantsInput` read → receive; woken when the dispatcher takes
  a call off the queue and after each finished call, so a reader parked on a full queue reads again — and notices a
  reset — as soon as there is room) and a dispatcher task (`nextEvent()` → `await dispatchCall(…, {signal})` →
  next). Clean EOF is not gone. A read
  rejection reports `transport-error`, aborts the active call's signal (`ConnectionClosedError`), closes session and
  channel; `channel.closed` settling does the same without a report. An unclaimed upgrade closes the connection.
  **Upgrade hand-over** (M9): dispatch gets `upgrade: () => handOver()`, which returns an `UpgradedChannel` over the
  transport whose reads are, in order, `session.takeUpgradeRemainder()` (the client's early data), the outcome of the
  reader's `read()` still in flight at that moment (the reader reads ahead while the upgrade call waits for dispatch,
  so this is the common case; the reader then drops it), or an EOF/rejection the reader saw after the confirming
  reply, then the transport's reads; after the hand-over the reader and dispatcher leave the channel alone (the
  dispatcher ends without closing it). The connection still counts (`connections`, exit-on-idle) until the channel
  closes. Shutdown: graceful aborts the upgraded handler's signal (if it still runs) but neither waits for its
  connection (each wait races its `released` promise) nor closes it at the deadline; `graceful: false` closes it.
  `handle()` resolves once the channel is closed and the reader ended (a handler that ignores its signal is not
  awaited) and never rejects; at `maxConnections` (or after shutdown) the channel is closed at once. `serve()` takes the
  listener's iterator synchronously and iterates it in the background; while the server runs, a listener already
  being served (by this Server: `TypeError`; by another: whatever its `[Symbol.asyncIterator]()` throws, a
  `TypeError` for a Node listener) makes `serve()` throw and is left alone (after shutdown, `serve()` closes the
  listener); an iteration error is reported as `accept-failed`, ends that loop and calls
  `listener.close()` (its errors swallowed), so the address is released and shutdown has nothing dangling. `shutdown({graceful, timeout})` checks its options synchronously (`RangeError`/`TypeError`, nothing
  memoized, the server keeps running), closes the listeners, then aborts active calls' signals and closes each
  connection gracefully when its call finished (buffered calls dropped; idle connections at once): `session.close()`,
  `await channel.end()` (FIN after the last reply), then read and discard input until `read()` gives `null` or
  rejects, then `channel.close()` — closing a TCP socket with unread input sends RST, which can destroy the reply
  still in flight. The discarding lasts at most `GRACEFUL_LINGER_MS` (2000) after `end()` resolved (or until the
  deadline, if sooner), then the connection is closed hard, so a peer that never closes its side (or never sends
  anything more, leaving the reader inside `read()`) cannot hold the shutdown; a `read()` rejection during the
  finish closes at once. At the deadline (`timeout`, default 5000; 0 = no deadline) or with `graceful: false`
  everything is closed hard. With `timeout: 0` the shutdown still waits for every active handler and for its reply writes: a handler that
  ignores its signal holds it forever, and so does a peer that stops reading while a reply is being written (the
  linger only starts after `end()`). Protocol
  errors, unclaimed upgrades, transport errors and the clean-EOF close stay hard closes. No timers on server
  connections other than the shutdown deadline (F1).
- **Node channel** (`fromNodeSocket(socket)`): the socket is paused and read on demand: `read()` returns the next
  buffered chunk (a plain `Uint8Array` view of the Buffer's memory) or resumes the socket for one `data` event and
  pauses again, so Node's own buffering is the read backpressure. Order: buffered data, then a socket error (rejects
  one read; later reads give `null`), then `null` (after the peer's FIN once drained, or after a local `close()`,
  which drops buffered data). Concurrent `read()` is a `TypeError`. `write()` resolves on `socket.write`'s callback,
  rejects with its error, and with `ConnectionClosedError` when the socket closes (or is `close()`d) before the
  callback fired, or at once after `end()`/`close()`/destroy (F3: no `flush` event, `drain` is implicit in the
  callback). `end()` = `socket.end()`, resolves on `finish` or `close`; `close()` = `destroy()`, idempotent;
  `closed` resolves on `close`. An `error` listener is always attached (F1/F8). `capabilities: {}`.
  **A write failing because the peer is gone** (EPIPE, ECONNRESET, ECONNABORTED, ENOTCONN, ESHUTDOWN) does not
  destroy the socket (M9 fix round 3): Node's Writable would mark the readable side errored at once (`readableAddChunk`
  then drops every later chunk, even one read in the same event-loop pass) and destroy the socket, losing what the
  peer sent before it went (VM interop: `yes | varlink-js call --upgrade` into a `head -n1`-like service printed
  nothing, 3 of 3 runs, Linux). The channel wraps the socket's `_write`/`_writev` so such an error never reaches the
  Writable: that write and every later one (also any whose callback had not fired) reject with the error, the write
  side is ended (`socket.end()`), and the socket reads ahead into the channel's buffer up to 1 MiB (`DRAIN_LIMIT`,
  plus Node's highWaterMark), so it closes on its own when the peer sent less than that; past it the socket keeps
  its backpressure and stays open until the reader drains it to the EOF/error or the owner calls `close()` (an
  upgraded channel's owner must close it, as always). Reads return those bytes, then the EOF or the error. A read
  error (the peer's reset) also no longer drops what Node had already buffered for a paused socket: those bytes are
  read out before the destroy, so e.g. a server now gets a call the client sent just before it reset (it may run;
  before M9 it was usually dropped). Server and client sessions are unaffected in practice: a failed write closes
  the session, which closes the channel at once. Other write
  errors reach Node as before. Guarantee: AF_UNIX keeps the peer's queued bytes readable before the error (Linux
  `unix_stream_read_generic` reports `sk_err` only on an empty queue), so they are delivered. TCP is best effort:
  the peer's close with unread data sends an RST, which on Linux leaves the receive queue readable
  (`tcp_recvmsg` drains it before `sk_err`) and on macOS kept it in every local run, but the peer's own kernel drops
  whatever it had not yet transmitted. Bun's own `net.Socket` closes natively on the failed write (unix: ECANCELED)
  and drops the bytes; the guard cannot reach below that (its tests skip there). Deno runs the same tests and
  passes them (`deno test`, macOS; Linux via the Runtimes workflow). The spawn
  channel (§5.8, ssh-*) is unaffected: a child's stdin and stdout are separate pipes, stdin's EPIPE destroys only
  stdin (test: a child that answers one line and exits while we write); `exec:` uses a socketpair, so this guard.
- **`connect(address, {…ConnectionOptions, signal})`**: `unix` (path), `unix-abstract` (Linux: Node path
  `"\0" + name`; elsewhere `OperationNotSupportedError`), `tcp` (`noDelay`), the spawned kinds `exec`, `ssh-unix`,
  `ssh-exec` (M8, §5.8, process options in `spawn`); other kinds → `OperationNotSupportedError` naming the kind
  (M10). All sockets `allowHalfOpen`. The connect phase is bounded by
  `timeout` (default 45 s, 0 = none → `CallTimeoutError("connect timed out")`) and `signal` (its reason); the socket
  is destroyed on either; Node errors (`ENOENT`, `ECONNREFUSED`) reject as they are. `createPool(address, options)`
  splits `max`/`idleTimeout` off and passes the rest, plus the factory's signal, to `connect`; `timeout` goes to
  both the pool (lease wait) and the connections.
- **`listen(address | {fd}, {mode, backlog, onError})`** → `NodeListener` (`Listener` + read-only
  `server: net.Server`): `net.createServer({allowHalfOpen, pauseOnConnect})`; `listen()` rejects on `EADDRINUSE`
  and every other listen error (F8). Server `error`s after listening are accept failures (`EMFILE`, `ENFILE`,
  `ECONNABORTED`): they go to `onError` (default: ignored; its exceptions swallowed) and the listener keeps accepting
  (the `net.Server` stays bound and listening, and libuv's EMFILE trick drops the pending connection so the loop does
  not spin). The iterator ends only on `close()` or the server's `close` event. Unix paths: setups of `listen()` on
  one resolved absolute path are serialized in the process (an async mutex, released when the setup settles). The
  socket is bound inside a private directory `mkdtemp(<dirname>/.vjs-)` (mode 0700) as `<dir>/s`, the listener's
  `error`/`connection` handlers are attached before any further await (so nothing in the setup window is unhandled
  or leaked), it is `chmod`ed to `mode` there, then published with `link(<dir>/s, path)`, and `<dir>/s` and `<dir>`
  are removed. Nobody else can connect before the socket is published with its final mode (the directory is 0700).
  `link` never overwrites: on `EEXIST` the existing path is inspected — a socket that refuses 3 connects ~20 ms
  apart (`ECONNREFUSED` each time; `ENOENT` = it vanished: retry the link) is stale and is replaced atomically:
  `rename(path, <dir>/old)` moves whatever is there now; if that is the probed inode it is unlinked and the link
  retried once (a second `EEXIST` → `EADDRINUSE`); if not (someone published a live socket meanwhile), it is renamed
  back (failing that, linked back; the rejection message says so) and `listen()` rejects `EADDRINUSE`. A live socket
  (connect succeeds, or `EAGAIN`) or a non-socket → `EADDRINUSE`, never touched. So of concurrent `listen()`s on one
  path exactly one wins, in one process (mutex) and across processes (link + rename), assuming no third party
  publishes at the path during the stale replace (then a live socket may end up kept in our private directory, see
  the rejection message, rather than at `path`). Every error path closes the
  server and removes the private directory with its contents. libuv unlinks a pipe's bound name on close, which hits
  the (already removed) private name, so `close()` unlinks the path only if it is still our inode (dev+ino).
  Fallback: if `<dir>/s` would exceed sun_path (107 bytes on Linux, 103 elsewhere), or `mkdtemp`/the first `link`
  fail with `EPERM`/`ENOTSUP`/`EOPNOTSUPP`/`EXDEV`/`ENAMETOOLONG` (no hard links, e.g. some FUSE/virtiofs mounts),
  the socket is bound at `path` directly after the same stale check: `mode` is then applied after bind (a short
  umask-mode window), the stale probe → unlink is a check-then-act race against other processes, and libuv's
  unlink-on-close removes `path` even if it was replaced. Left in both modes: on macOS/BSD a live server whose listen
  backlog is full also refuses connects (`ECONNREFUSED`), so a server that stays saturated for all 3 probes is taken
  for stale and replaced. Consequence: `listener.server.address()` names the (removed) private path, except in the
  fallback (use `listener.address`). `unix:@name` Linux only. tcp:
  `address` from `server.address()` (port 0 → the real port, `tcp:[::1]:p` for IPv6). `{fd}` (socket activation,
  §5.8; `listenFromEnv` in M8 builds on it): `server.listen({fd})`; `address` from `server.address()` (object →
  `tcp:…`, string with leading NUL → `unix:@…`, other string → `unix:…`), but Node returns `null` for a unix socket
  inherited this way (pipes have no getsockname in Node), so the address is the placeholder `fd:<n>` there (not a
  dialable varlink address) unless `options.address` (M8, `{fd}` only) names it. Accepted sockets are wrapped (`fromNodeSocket`) at once,
  queued and handed out by the iterator; `close()` (idempotent) stops listening without waiting for taken
  connections, ends the iterator (a pending `next()` resolves done) and closes queued ones. A second concurrent
  iteration is a `TypeError`; after `return()` the listener may be iterated again.
- **Tests**: `test/unit/rpc/` (connection, pool, server, proxy), `test/unit/address/`, `test/unit/node/` (socket
  channel, connect incl. a mocked-clock connect timeout, listen, `abstract.test.ts` Linux-only, `fd.test.ts`: a
  child process serves on a listening fd inherited as `stdio[3]`), `test/regression/harness.ts`
  (`Transport`/`Endpoint`/`RawPeer`; `pairTransport` resets the server end like an RST; `unixTransport` /
  `tcpTransport` serve `listen()` in a `vj-` temp dir / on `127.0.0.1:0`, `restart()` closes the listener and every
  server connection and listens again on the same address; `transports` is the list the suite runs over),
  `e2e.test.ts` (one `describe` per F-id, every case over every transport), `sockets.test.ts` (F8, F3 with both
  socket buffers full, accept errors, graceful shutdown over tcp keeping the last reply), `tooling.test.ts`
  (F10–F14, F16), `test/fuzz/server.test.ts` (fast-check, seeded, `VARLINK_FUZZ_RUNS` default 200; each case's
  deadline covers the writes too, and the replies are counted against the server's own framing/decoding of what was
  written: at most one final reply per non-oneway call, none for oneway calls, exactly one each when the input was
  all valid non-upgrade calls, fully written and ended). M9: `test/regression/upgrade.test.ts` (every transport:
  echo both ways, 8 MiB each way at once, half-close each way, early data in the call's chunk and in later writes,
  error reply then a call, `UpgradePendingError`, timeout/abort close, unclaimed, `close()` after the upgrade, Q4 on the
  wire, an upgrade call's error reply and a plain call pipelined in one chunk, the client's early data and/or EOF
  arriving before the handler's `ctx.upgrade()` (the EOF read ahead while paused), a read still in flight at the
  hand-over, graceful vs hard shutdown with a plain connection whose handler ignores its signal so the deadline fires
  and force-closes it but not the upgraded one; the early-EOF and in-flight cases also over a `fromNodeStreams`
  channel; plus a raw service writing reply + first bytes in one write over unix and tcp),
  `test/unit/rpc/upgrade.test.ts` (same-chunk remainder over `pair()`, typed client/proxy/pool, write backpressure
  into a handler that does not read, exit-on-idle, `UpgradedChannel`), `test/unit/websocket/upgrade.test.ts`. The F1 idle test mocks `setTimeout`/`setInterval`/`Date`
  before the server and connections exist, ticks an hour, and checks the accepted `net.Socket`s have no timeout. Soak: `VARLINK_SOAK_SECONDS=600 node test/fuzz/soak.ts` runs the same generator
  against one server, prints RSS every 10 s and exits non-zero on an unhandled rejection, uncaught exception, hang
  or a server that stops answering (`VARLINK_FC_SEED` fixes the seed).
- **Known limits**: a `pair()` peer's `close()` looks like a clean EOF to the server (only a socket RST or the
  harness reset is a disconnect), so over `pair()` a handler waiting on its signal is not aborted by a client
  `close()`; it is when its reply's write fails. Over unix sockets the harness reset is a plain `destroy()` of a
  peer with nothing unread, which the server reads as a clean EOF (a unix socket closed with unread data does give
  its peer `ECONNRESET` on Linux, but that is not what the harness does), so F1's "reset aborts `ctx.signal`" is
  tested for pair and tcp only (`Transport.abruptReset`); over unix the test checks that the server survives and
  keeps serving. A reset is noticed by reading: while parked on a full queue, the reader reads again (and notices
  the reset) only if exactly `maxQueuedCalls` complete calls were buffered, because taking the first one makes room;
  with more complete calls buffered (e.g. 66 small calls in one chunk), the reader stays parked until the queue
  drains below the limit, however empty Node's read buffer is, so the handler's signal aborts only when its write
  fails, it finishes, or the socket's `close` arrives. F15's memory bound is 4 × `maxMessageSize` over
  pair and 16 × over sockets (a fresh Buffer per read, garbage until the next GC, plus kernel buffers), still a
  quarter of the 64 MiB input.

### 4.12 WebSocket and HTTP clients (M10)

`src/websocket/` (`channel.ts`, `connect.ts`) is `varlink-js/websocket`: `connect`, `createPool`, `fromWebSocket` and
the types `WebSocketConnectOptions`, `WebSocketChannelOptions`, `WebSocketLike`, `WebSocketConstructorLike`.
`src/http/` (`client.ts`, `errors.ts`, internal `jsonseq.ts`) is `varlink-js/http`: `createHttpClient`, the class
`HttpClient` (a class like `Connection`, created by the factory), `HttpBridgeError` and the types `HttpClientOptions`,
`HttpRequestOptions`, `HttpCallOptions`, `HttpStreamOptions`, `HttpCollectOptions`, `FetchLike`, `FetchInitLike`,
`ResponseLike`, `ReadableStreamLike`, `ReadableStreamReaderLike`. Both are browser-facing layers (§4, §8): imports from
core, rpc and their own directory only; globals `fetch`, `WebSocket`, `setTimeout`, `AbortController`,
`TextEncoder`/`TextDecoder`, `queueMicrotask`. Public signatures name no DOM type: structural interfaces of exactly the
members used, so the `.d.ts` compiles with lib `dom` or with `@types/node` (both runtimes' globals are assignable to
them); the globals are read as `unknown` and checked with `typeof … === "function"`.
- **WebSocket channel** (`fromWebSocket(ws, {maxBufferedBytes, writeHighWaterMark})`): `TypeError` unless OPEN; sets
  `binaryType = "arraybuffer"`. Frames are bytes, never messages (UAPI: clients MUST NOT rely on one message per frame;
  the Connection's framer reassembles on NUL): ArrayBuffers and views as they are, text UTF-8 encoded, a `Blob` (a
  runtime ignoring `binaryType`) read with `arrayBuffer()` in its own queue slot (later messages wait behind it; a
  failed read fails the stream at that position, close 1011), empty messages skipped, any other data type fails the
  stream (1003). Pull API, one reader (concurrent `read()` is a `TypeError`). The WebSocket API cannot apply
  backpressure, so the queue is bounded by `maxBufferedBytes` (default 4 × `DEFAULT_MAX_MESSAGE_SIZE` = 64 MiB,
  counting unread bytes, a Blob by its `size`; every incoming message is checked against the room left, so a single
  larger message fails too): exceeding it drops the queue, closes with 1009 and the next `read()` rejects with
  `ConnectionClosedError("websocket receive buffer limit exceeded …")`, later reads `null`. The WHATWG `close()` only
  takes 1000 and 3000–4999, so 1009/1011/1003 (fine for the `ws` package) fall back to 1000 with the same reason text.
  `WebSocketStream` would give real backpressure but is not universally available. Order as in `fromNodeSocket`:
  queued data, then the close outcome: a `close` event with `wasClean` and code 1000 or 1005 is EOF; anything else
  rejects ONE read with `ConnectionClosedError("websocket closed: code N" + safeQuote(reason))` (an `error` event
  alone: `"websocket error"`; when a close follows before it was read, the close's message with the error as `cause`),
  later reads `null`. `write(chunk)`: non-empty `fds` → `OperationNotSupportedError`; not OPEN, or after
  `end()`/`close()`/a failure → `ConnectionClosedError`; `send()` throwing → `ConnectionClosedError(cause)`; resolves
  once `bufferedAmount <= writeHighWaterMark` (default 1 MiB; polled with `setTimeout`, 1 ms doubling to 50 ms); a
  waiting write resolves on a clean close that `end()` started while the socket was OPEN (the closing handshake
  follows the queued data; `close()` and our own failures reject waiting writes at once) and rejects on an unclean
  close or a clean one the peer started (RFC 6455 lets the peer discard data frames arriving after its Close; two
  Close frames crossing on the wire cannot be told apart from ours). `end()` (WebSocket has no half-close) is `close(1000)` after the queued data and resolves on the `close` event;
  reads go on until then. So over WebSocket `end()` closes the whole connection, not just our side: a protocol
  upgrade's stream (M9) cannot half-close, and what the peer writes after our `end()` may be lost (a bridge
  tears its backend down at the Close; `call --upgrade ws://…` sends stdin's EOF this way, §4.14). The
  `ByteChannel` interface stays as it is (no half-close capability flag); prefer unix/tcp/exec:/ssh for upgrade
  pipes. `test/unit/websocket/upgrade.test.ts` checks that the bytes written before `end()` reach the service,
  which then sees EOF, and that our reads end with `null`. `close(reason?)` is an idempotent hard close: queue dropped, a pending read gives `null`,
  pending and later writes reject, `ws.close(1000)` if CONNECTING/OPEN. `closed` never rejects and settles once the
  `close` event arrived and the end of the stream was read (or after a local `close()`), one microtask after that
  read settled: a read that settles inside its executor has no reaction yet, and the Connection, which closes when
  `channel.closed` settles, must see the end of the stream (and its error) first. A 5 s guard after
  `close()`/`end()` settles `closed` and `end()` if the peer never answers the closing handshake: waiting writes
  reject, a pending or later read rejects once with `ConnectionClosedError("the websocket did not close in time")`
  (after `end()` reads were still allowed), then `null`, and the listeners are removed; the `close` event clears it. Every listener is removed on the `close` event (the socket's last event).
  `capabilities: {}`. The channel's own failures — the receive limit, an unsupported or unreadable message, and the write
  rejections they cause (as `cause`) — are `ConnectionClosedError`s marked with an own
  `local: true` property; those caused by the peer (its close, an `error` event, no answer to our Close within the guard time) are not, so a caller can tell a
  local failure from a disconnect (`call --upgrade` does, §4.14). The other channels (`fromNodeSocket`, the spawn /
  ssh streams, `pair()`) reject reads only for peer-side reasons (their backpressure is real) and writes only after a close
  (`ConnectionClosedError`) or because the peer is gone (its errno, e.g. EPIPE; §4.11), so they need no mark.
- **`connect(address, options)`**: kind `websocket` (`http(s)` URLs dialled as `ws(s)`); `http` → `TypeError` naming
  `createHttpClient` from `varlink-js/http`; other kinds → `OperationNotSupportedError` naming `varlink-js/node`.
  Options: `ConnectionOptions`, the channel options (checked before dialling), `signal`, `protocols`, `WebSocket`
  (default `globalThis.WebSocket`, absent → `OperationNotSupportedError`; lets Node users pass e.g. a subclass of the
  `ws` package's client that sets headers or a client certificate). The channel is created inside the `open` handler,
  so no message can be dispatched before it listens. The connect phase is bounded by `timeout` (default 45 s, 0 = none
  → `CallTimeoutError("connect timed out")`) and `signal` (its reason); the socket is closed on either and on an
  `error`/`close` before `open` (→ `ConnectionClosedError("websocket connect failed", {cause: event})`: browsers do
  not expose the HTTP status, e.g. the bridge's 502 or 404). After a failure a no-op `error` listener stays until the
  socket's `close` (the `ws` package throws on an unheard `error`). Constructor exceptions (invalid URL, a fragment's
  `SyntaxError`) reject as they are. `createPool(address, options)` mirrors `src/node/pool.ts`.
- **HTTP client** (`createHttpClient(base, options)`): `base` is an `http` address (a string goes through
  `parseAddress`); `websocket` → `TypeError` naming `varlink-js/websocket`, other kinds and URLs with credentials
  (fetch refuses them) → `TypeError`; fragment and query are dropped (nothing of the query is kept) and a trailing `/`
  is added, so `https://h/waldo` and `https://h/waldo/` both address `https://h/waldo/call/…` (`baseUrl`). Options:
  `fetch` (default `globalThis.fetch`, looked up per request, absent → `OperationNotSupportedError` at call time;
  always called as a plain function, never as a method, which browsers refuse), `headers` (sent with every request;
  checked at construction: token names, values without CR/LF/NUL; the client's `Content-Type`/`Accept` replace any
  case variant), `service`, `timeout` (45 000, 0 = none), `ints`, `validateReplies` (as on a Connection: for typed calls
  `"off"` acts as `"warn"`), `codec`, `errors`, `interfaces`, `maxMessageSize` (16 MiB: a whole non-streaming body and each json-seq record), `onError` (as on a Connection).
  Methods mirror Connection (same option names; a per-call `service` overrides the client's): `call`, `stream`,
  `collect` (with the typed descriptor overloads; the descriptor's interface must be registered), `addInterface`
  (the same rules as on a Connection: `bindDescriptor`, compatible IDL for the built-ins, their classes fill gaps),
  `oneway()` → `OperationNotSupportedError` (UAPI "Limitations"), `listServices()` (`GET services`),
  `getInfo(service)` (`GET services/{service}`, always validated against GetInfo's output, `"throw"`),
  `listMethods(service, iface)`, `health()` (`GET health`: true iff 200, the body is cancelled, a network failure
  rejects). There is no connection, so no `close()`: each call is its own request, cancelled by its `signal`, and
  nothing orders concurrent calls.
- **Requests**: the method must be a fully qualified `interface.Method` and services/interfaces valid interface names
  (`TypeError` before any request); parameters are `input.encode`d for registered interfaces (a `ValidationError`
  rejects before any request), must be an object and are `codec.encode`d (`{}` when none). `POST {base}call/{enc(method)}`
  or `call/{enc(service)}/{enc(method)}` (`enc` = `encodeURIComponent`), streams add `?more=true`; `Content-Type:
  application/json`, `Accept: application/json` (calls, GETs) or `application/json-seq, application/json;q=0.9`
  (streams, which also take one JSON reply; bridge error bodies are JSON). Bodies are read
  with the body's reader, bounded by `maxMessageSize` (exceeded → `MessageTooLargeError`, body cancelled, request
  aborted), decoded as strict UTF-8 and with `codec.decode` (lossless ints). One `AbortController` per request,
  linked to `signal` and the timer; after an abort every later rejection (fetch, a body read, or a cancelled reader's
  plain end) reports the recorded reason (`CallTimeoutError` on expiry, else the signal's reason). On every settle path
  the timer and the abort listener are removed and an unread body is cancelled. `call`/`collect`/introspection:
  `timeout` covers the whole request, body included.
- **Response mapping**: 2xx + a JSON object → the reply parameters (validated as on a Connection, §4.11; a non-object
  → `ProtocolError`). Non-2xx: a JSON body `{error: <valid fully qualified error name>, parameters?: object|null}` →
  that `VarlinkError` whatever the status (the status is only the broad class, UAPI; registered interfaces: error
  validator + `errors.create`, else a plain `VarlinkError` + `onError` `invalid-error`); anything else →
  `HttpBridgeError` (`VarlinkLocalError`, `localName` `"varlink-js.HttpBridge"`, `status`, `bridgeMessage` from a
  `{message: string}` body, message `HTTP bridge error (status N): "<safeQuote'd message>"`; such bodies are decoded
  leniently). `fetch` rejecting (network, CORS) → `ConnectionClosedError("http request failed", {cause})`; a body
  read failing → `ConnectionClosedError("http response body failed", {cause})`.
- **Streams**: the body is sniffed, not its Content-Type: a first non-whitespace byte RS (0x1E) means json-seq, else
  it is one `application/json` document → one reply (a bridge whose method replied once; never taken for an error
  record). The splitter (`jsonseq.ts`) tracks strings, escapes and bracket depth, so an object record is handed out when
  its outermost bracket closes, without waiting for its LF or the next RS (monitors see each reply at once, and
  pretty-printed records with inner LFs work). It tolerates leading whitespace, CRLF, a missing final LF and empty
  records; `ProtocolError` for data before the first RS or after a complete record and for a record cut off by an RS
  or the end of the body (truncated JSON); `MessageTooLargeError` for a record text over `maxMessageSize`. Each record
  is one reply (`continues` is not transmitted; the stream ends with the body; a body without any record is a
  `ProtocolError`). A success reply may itself have a field named `error`, so a record is a terminating error only if
  it is an object whose own keys are within {`error`, `parameters`}, `error` is a string and `parameters` is
  absent/null/an object; such a record is held back until the next record starts (it was a reply: yielded) or the
  body ends (a valid error name → that `VarlinkError`, otherwise `HttpBridgeError(200, bridgeMessage = error)`, the
  spec's transport-failure record `{"error": "<message>"}`). Every other record is yielded at once. Records completed before an error in the same body chunk (a
  record too large, malformed or not JSON, data after a record) are still yielded first, so the result does not depend
  on how the body is chunked; an error-shaped record held back right before the error is dropped (the error wins), and
  an error found this way wins over a later abort or timeout while the buffered records are read. Records are pulled
  from the body reader on demand (natural backpressure); concurrent `next()` calls are served in order. `timeout`
  counts from the call to the first record (also while nobody calls `next()`), `idleTimeout` (default none) runs only
  while a `next()` waits for the network, armed once per wait and reset only by a complete record (never by a body
  chunk, so a peer trickling whitespace or a partial record times out). Expiry → `CallTimeoutError`, abort → `signal.reason`; a validation failure
  rejects too; each ends the request (body cancelled, request aborted), after which the iterator is done. `return()`
  cancels the body and aborts the request (a pending `next()` resolves done). `collect()` rejects with `RangeError`
  past `max` (1024) and aborts.
- **Tests**: `test/unit/websocket/` (`channel.test.ts` with a scripted `FakeWebSocket` and a mocked clock for the
  write poll and the 5 s guard; `connect.test.ts` end to end with each runtime's own `WebSocket` in every framing mode;
  `bridge.ts`, the fixture; `service.ts`, the backend service and its descriptor) and `test/unit/http/`
  (`client.test.ts` end to end with each runtime's own `fetch`; `jsonseq.test.ts` at every split point;
  `fetch.test.ts`, the request lifecycle against a scripted fetch: timers, abort listeners, cancel, abort). The bridge
  fixture (dev-only) is a UAPI bridge on `node:http` at `127.0.0.1:0` (its `upgrade` event works on Node, Bun and Deno,
  so no runtime-specific path and no skips): a hand-written RFC 6455 server side (`Sec-WebSocket-Accept` via
  `node:crypto`, masked client frames, 7/16/64-bit lengths, continuation frames, text = binary, ping → pong, the close
  handshake answered, or awaited for 1 s after its own close frame), one backend channel per WebSocket with framing
  `message` (one varlink message per frame), `split` (1-byte first frame, then up to three) or `coalesce` (5 ms
  batches, cut anywhere); 401/404/502 before the upgrade; simple mode over a fresh `Connection` per request (the UAPI
  error → status table, json-seq with error and transport-failure records, `{"message"}` bodies), and knobs
  (`requiredHeader`, `stallHandshake`, `earlyStreamHeaders`, `streamAsJson`, `dropAfterRecords`, `delayMs`, `healthy`,
  a scripted raw `respond`). Backends run over `pair()` and, in one test per transport, a tcp listener.
- **Known limits**: no read backpressure on the WebSocket side (a fast stream the consumer does not read hits the
  64 MiB cap and the connection is closed); a failed WebSocket handshake shows no HTTP status in browsers (every
  failure is "websocket connect failed"); browsers cannot set headers on a WebSocket (authentication by cookie or by
  the browser's TLS client certificate; in Node pass a `WebSocket` constructor that can); the json-seq error-record
  ambiguity: a reply whose only fields are a string `error` and optionally `parameters` is taken for an error record
  when it is the last record of the body, and is held back by one record otherwise; simple mode has no oneway, no
  upgrade and no pipelining, and concurrent calls are unordered; neither mode carries fds. WebSocket mode upgrades like
  any Connection (M9), but only through a bridge that relays bytes: one that frames per varlink message (cuts at NUL,
  the fixture's `message`/`split` modes) never forwards upgraded bytes without a NUL. `connect()` checks the
  channel options and `timeout` before dialling but the other `ConnectionOptions` (`ints`, `interfaces`, …) only in
  `createConnection`, after the handshake. The websocket/http mode-mismatch errors quote addresses without their user/password
  (`parseAddress`'s own "invalid varlink address" errors, a core M4 file, still quote the raw input).
### 4.13 Codegen (M6)

`src/codegen/` (`varlink-js/codegen`: `generate`, `generateFromService`, `GENERATOR_VERSION`; internal `doc.ts`,
`sha256.ts`), `src/rpc/typed-client.ts` (root: `createClient`, `TypedClient`, `TypedMethod`, `freezeDescriptor`,
`VarlinkErrorOptions`), `src/interfaces/` (generated built-ins + hand-written `runtime.ts`, `index.ts`),
`interfaces/*.varlink`, `scripts/gen-interfaces.ts` (`npm run gen:interfaces`). No `node:*` in `src/codegen`.
- **API**: `generate(idl, {ints = "number", importPath = "varlink-js"})` → `{fileName: "<iface>.ts", code,
  interfaceName, constName}`; parses and validates (`IdlSyntaxError`); `options` not an object (null, an array),
  unknown `ints`, or an `importPath` that is empty or contains a quote, backtick, backslash, C0 control, DEL or
  U+2028/U+2029 → `TypeError`. `generateFromService(conn | pool, name, {…GenerateOptions, signal, timeout})` =
  `getInterfaceDescription` + `generate`; its options are checked before any I/O (as `generate`'s, plus `signal`
  an `AbortSignal` and `timeout` a number, else `TypeError`; the timeout's range is the call's, `RangeError`); a
  description declaring another interface is a `TypeError` (M6's "dynamic client from
  introspection"; the runtime one is `conn.proxy()`). `GENERATOR_VERSION` equals package.json's version (tested).
- **File shape** (deterministic, byte-identical for identical input + options): header `// Generated by varlink-js
  codegen <version> from interface <name> (ints: <mode>).` + `// Source sha256: <hex of the UTF-8 IDL>. Do not
  edit; regenerate instead.` (no timestamps or paths; SHA-256 in pure TS, since `generate()` is synchronous; lone
  surrogates hash as U+FFFD), `import * as $vjs from "<importPath>";`, then `<C>_IDL: string` (a template literal
  whose value is the IDL byte for byte: `` ` `` `\` `$` and CR escaped, LF and TAB raw, other C0, DEL, C1, the
  Bidi_Control characters (U+061C, U+200E/F, U+202A–E, U+2066–9), lone surrogates and ESLint's irregular
  whitespace as `\uXXXX`), the members in IDL order, then `<C>_Descriptor` (type), `<C>_Client =
  $vjs.TypedClient<…>`, `<C>_Handlers = $vjs.Handlers<…>` and `export const <C>: <C>_Descriptor =
  $vjs.freezeDescriptor<<C>_Descriptor>({name, idl, ints, methods, errors, <each error>, client: (target) =>
  $vjs.createClient(<C>, target)})`. `freezeDescriptor` freezes the method descriptors, `methods`, `errors` and the
  descriptor (no `Object.freeze` in generated code, see naming). Per member: `type` → `export type T = …` (+ for an
  enum `export const T_Values = [...] as const`, IDL order); `method M` → `M_Input`, `M_Output`; `error E` →
  `E_Parameters` and `class E extends $vjs.VarlinkError<E_Parameters>` with `static readonly errorName =
  "<iface>.E"` (literal type), `constructor(parameters[?]: E_Parameters, options?: $vjs.VarlinkErrorOptions)`
  (`?` iff no required field) and `static is(e): e is E` via `$vjs.isVarlinkError` (the core classes' shape).
  Method descriptors are `{interface, name, method, more?, upgrade?, experimental?: true}` (absent flags omitted;
  no `"~types"` at runtime); every generated descriptor passes `compileDescriptor` (tested for the whole corpus).
- **Naming**: `<C>` = PascalCase of the dotted name, `-` segments joined (`io.systemd.Resolve.Monitor` →
  `IoSystemdResolveMonitor`, `org.example.my-iface` → `OrgExampleMyIface`), or `<C>_Interface` if a member has that
  name. Member names match `[A-Z][A-Za-z0-9]*`, so every generator-made name, which contains `_` or `$`, is
  collision-free. Generated code names no global (a varlink type may be called `Record`, `Array`, `Promise`, `Error`,
  `ErrorOptions`, `Object`, …): only keywords, its own names and `$vjs.*` (`VarlinkErrorOptions` is the root's
  alias of `ErrorOptions` for that reason). Field names are emitted bare (reserved words are valid keys).
- **Type mapping** (§5.7): struct → object type literal in a `type` alias (never `interface`), always multiline;
  `()` → `{ [key: string]: never }`; field `?T` → `f?: T | null` (`f?: T | null | undefined` if `f` is one of the
  `Object.prototype` names of §4.9, `INHERITED_NAMES` in compile.ts, which the decoder sets to an own `undefined`
  when absent, so under `exactOptionalPropertyTypes` the type admits it), others `f: T`; `bool` boolean, `int` number or
  bigint, `float` number, `string` string, `object` `{ [key: string]: unknown }`, `any` `$vjs.JsonValue`; `[]T` →
  `T[]` (a union in parentheses), `[string]T` → `{ [key: string]: T }` (so `[string]()` is a map of empty structs);
  named refs by name (recursion works); inline enum → string literal union with no `_Values` const; inline struct
  → inline object type (no `Method_Input_field` names: §5.7's "when needed" never arises); `?` of an enum flattens
  into one union. Enum values are JSON string literals. Decoded maps are ordinary objects (own data properties on
  `Object.prototype`): look keys up with `Object.hasOwn(m, k)`, since an absent key such as `toString` reads the
  inherited function although `m[k]` is typed `T | undefined`.
- **Docs**: TSDoc on the IDL const and descriptor const (interface doc), types, fields, classes and the
  descriptor's method entries (type and const); `*/` → `*\/`; doc text from the IDL has every `@` followed by an ASCII
  letter, `_` or `$` written as the text `\u0040` (the generated comments contain no `@internal`/`@deprecated`/
  `@__PURE__`/… substring, so a peer's doc adds no `@` tag or `@`-form bundler hint (`#__PURE__` is kept, but doc comments only precede declarations and object keys, never a call) and `stripInternal`, which matches `@internal` by substring, cannot drop declarations;
  tested with `ts.transpileDeclaration`), and every C0 control
  (TAB too), DEL, C1 and Bidi_Control character and ESLint's irregular whitespace as `\uXXXX` text (no raw control
  bytes, no "Trojan Source" reordering); enum-value docs become a ``- `v`: doc`` list in the owning type's or
  field's TSDoc; `[Experimental]` → `@experimental` (the generator's own tags are not escaped); method notes for
  `[Requires|Supports 'more' flag]` (use `.stream()`/`.collect()`) and the upgrade flags. Decoded structs never
  expose inherited `Object.prototype` members for absent optional fields (§4.9), so a generated
  `constructor?: number | null | undefined` reads `undefined`, not `Object`.
- **Layout**: `doc.ts` is a small Wadler/prettier document printer (group, indent, align, line, softline,
  hardline, ifBreak, width 120) and the generator builds the documents prettier would for these constructs
  (structs always broken; maps, unions, `(…)[]`, type arguments, call arguments and long strings break as
  prettier breaks them), so output is prettier-clean; `prettier.test.ts` checks it for every corpus file in both
  modes plus a layout stress interface. The committed generated files need no `.prettierignore` or
  `eslint-disable`. Without methods, `<C>_Client`/`<C>_Handlers` are `{ readonly [K in never]: never }` (a generic
  reference resolving to `{}` trips `@typescript-eslint/no-generated-empty-object-type`), as are empty
  `methods`/`errors` types (`{}` trips `no-empty-object-type`).
- **Built-in exception**: for `ORG_VARLINK_SERVICE` and `INTERNAL_ERROR_INTERFACE` (compared with the exported
  constants, never a literal) no classes are generated: each error is `export const E: typeof $vjs.EError =
  $vjs.EError` plus `export type E = $vjs.EError`, and `errors` holds the core classes, matched by `errorName`
  (`InterfaceNotFoundError` … `InternalError`); an error of those interfaces without a core class is a `TypeError`.
- **Typed client** (`createClient(desc, target)`, what `<C>.client(target)` calls): `target` must have Connection's
  /Pool's `addInterface`/`call`/`stream`/`collect`/`oneway` (duck-typed, else `TypeError`; `typed-client.ts`
  imports Connection and Pool as types only, so rpc/connection.ts → src/interfaces → runtime.ts →
  typed-client.ts is no cycle; a fresh-process test imports service.ts first). It calls
  `target.addInterface(desc)` (a Connection: idempotent, `TypeError` for an ints mismatch of an interface that
  uses `int` or a different IDL; a Pool:
  as in §4.11) and returns a frozen null-prototype object with one frozen function per method (`.stream()`,
  `.collect()`, `.oneway()`, `.upgrade()` since M9: TypeError for a method without an upgrade flag,
  OperationNotSupportedError over a Pool) over the target's typed overloads. `TypedMethod`'s
  parameters are optional iff the input has no required field. Replies are always decoded: the connection's
  `validateReplies` `"off"` (the default) acts as `"warn"` for typed calls (§4.11), so valid replies match their
  types, while an invalid one under `"off"`/`"warn"` is delivered raw and reported to `onError` (`invalid-reply`);
  `"throw"` rejects it (use it for a hard guarantee); error replies
  of the interface become the generated classes (`instanceof` works). `ints` (said in `<C>.client`'s TSDoc): an
  interface without `int` binds in either mode (`bindDescriptor`, §4.9); otherwise regenerate with
  `generate(idl, { ints })` for the target's mode. Spreading a descriptor with another `ints` would change only the
  runtime check, not the generated types (an `int` typed `number` would arrive as `bigint`), so it is not advised.
  `Handlers<D>` (server.ts) gives the precise input/result types (a `@ts-expect-error` test covers wrong
  parameter use, results, unknown keys and client parameters).
- **Built-ins** (deviation from §5.7, which said "at build time"): `interfaces/org.varlink.service.varlink` and
  `interfaces/<INTERNAL_ERROR_INTERFACE>.varlink` (byte-identical to the core IDL constants) are generated by
  `scripts/gen-interfaces.ts` with `importPath: "./runtime.ts"` into `src/interfaces/` and committed;
  `builtins.test.ts` fails when they are stale, when a source differs from its constant, or when a built-in IDL
  contains `int` (so they bind in both modes). rpc imports them through `src/interfaces/index.ts`, so the
  internal interface's name stays in one place in hand-written code. A generated built-in descriptor says
  `ints: "number"` and, being `int`-free, binds on a bigint connection, server or HTTP client as is (`bindDescriptor`, the same
  rule as for any descriptor; no built-in override): `OrgVarlinkService.client(bigintConn)` works. A client generated from another implementation's `org.varlink.service` text (libvarlink,
  python, rust, systemd) binds too: connections, pools and HTTP clients accept a text under the built-in names that is
  compatible with the built-in definition (§4.11; all five corpus texts are), and reject others. Not generated here: `org.varlink.certification` (M5's interface file) and
  `org.varlink.resolver` (M8).
- **Tests** (`test/unit/codegen/`): `generate.test.ts` (each mapping rule, docs, flags, names and collisions,
  built-in exception, options, determinism, IDL round trip, `generateFromService`), `snapshots/*.ts.snap`
  (ftl in both modes, rust's org.example.complex, python's org.varlink.certification, io.systemd.Resolve,
  org.varlink.service; `UPDATE_SNAPSHOTS=1 npm test` rewrites them and the committed generated files),
  `corpus-typecheck.test.ts` (every corpus file × both modes + collision/layout/test interfaces with usage files,
  one `tsc` run with the repo's strict options and `paths` to `src/index.ts`, plus `compileDescriptor` at runtime),
  `prettier.test.ts`, `builtins.test.ts`, `sha256.test.ts` (NIST vectors, node:crypto at lengths 0–200),
  `e2e.test.ts` over `pair()` with the committed fixtures in `generated/` (incl. a bigint one), `review-fixes.test.ts`
  (review-1 regressions: typed decoding under `"off"`, per-entry pool failures, corpus `org.varlink.service`
  clients, `Object.prototype` field names, user registries, control/bidi/`@` escaping, `generateFromService`
  options), `review-fixes-2.test.ts` (review-2: incompatible built-in texts rejected on Connection and Pool,
  `stripInternal` keeps a peer-`@internal` type, pool per-entry failures ask the leased connection, `| undefined`
  only for the `Object.prototype` names).

### 4.14 CLI (M7)

`src/cli/`: `main.ts` (the bin: `process.exitCode = await run(argv, nodeIo())`, nothing else), `node-io.ts` (the
process side), `run.ts` (`run(argv, io): Promise<number>`, `USAGE`), `args.ts`, `io.ts`, `json.ts`, `target.ts`,
`context.ts`, one file per command group (`introspect.ts`, `call.ts`, `idl.ts`, `bridge.ts`, `certify.ts`),
`version.ts` (package.json via `createRequire`, same relative path from `src/cli/` and `dist/cli/`), and M5's
`certification.ts` (moved from `examples/certification/`, which re-exports it) with the IDL embedded in
`certification-idl.ts` (`interfaces/` is not in the npm package; a test compares it byte for byte with the file).
`run` sees only a `CliIo` (`stdin` async iterable + `isTTY`; `stdout`/`stderr` `write()` → promise resolved once the
OS took the data, `isTTY`; `env`; `signal`), never `process`, so the unit tests run it in-process on Node, Bun, Deno.

| Command | Does |
|---|---|
| `info`, `list-interfaces ADDRESS` | GetInfo: varlinkctl's vertical table (labels right-aligned, interfaces sorted with duplicates kept like `strv_sort`, continuation lines aligned) / sorted names (duplicates kept); JSON: the reply / its `interfaces` |
| `list-methods`, `introspect ADDRESS [IFACE…]` | none = all of GetInfo's (sorted, unique: `strv_sort_uniq`); names checked before connecting; `list-methods` sorted unique `iface.Method`, ` (experimental)` only on a TTY (stdout and stderr, `on_tty()`); `introspect` text = `formatInterface` per interface, blank line between, unparsable → warning + raw text; JSON: the reply objects, JSON-SEQ when more than one |
| `call ADDRESS METHOD [PARAMS]` | PARAMS or stdin (absent or `-`; blank = `{}`; the TTY notice unless `-q`); `--more` (JSON-SEQ, one awaited write per reply), `-E`, `--collect` (one array), `--oneway` (exit once written), `--graceful=ERROR`, `-q`; the three modes are mutually exclusive; `--upgrade` (M9, below) |
| `validate-idl [FILE]`, `format [FILE…]` | stdin when absent or `-`; errors `FILE:LINE:COL: reason` (`<stdin>`); `format --check` (names the non-canonical files on stderr), `-i` (atomic: a temp file `.<first 32 code points of the name>.<8 hex>.tmp` in the same directory with the original's mode and, best effort, its owner, renamed over it — through a symlink, its target; removed on failure; written in place instead, not atomically, when the file has other hard links or the temp file cannot be created: `EACCES`/`EPERM`/`EROFS`/`ENAMETOOLONG`, e.g. a writable file in a read-only directory) |
| `codegen FILE…`, `codegen --address ADDR IFACE…` | `generate()` / `generateFromService`; `-o DIR` writes `<DIR>/<iface>.ts` (paths on stderr unless `-q`), else one input to stdout; output names that clash case-insensitively (`a.B`/`a.b` on macOS) fail before anything is written; `--ints`, `--import-path` |
| `bridge ADDRESS` | raw bytes stdin ↔ socket (`openSocket` of `src/node/connect.ts`), unix/abstract/tcp only; one chunk at a time both ways (the socket paused while a stdout write is pending; the next stdin chunk pulled once the socket took the last); stdin EOF half-closes, peer EOF ends it (0; stdin's iterator is `return()`ed) |
| `certify server\|client ADDRESS` | `Listening on <address>` (real port for `:0`), graceful stop on SIGINT/SIGTERM (0) / every step (escaped: `client_id` and replies are the peer's), `Certification passed` |

- **Options**: `node:util` `parseArgs`, one table per command plus the global ones (`-h`, `-V`, `--json=`, `-j`,
  `-q`); options anywhere (a lenient pass over the union of the tables finds the command, then a strict pass with
  its table; `--j`/`--E` rejected). Order counts like varlinkctl (`-E --timeout=5` has a timeout, `--timeout=5 -E`
  none). `--timeout`: empty = none, else systemd's `parse_sec` (time-util.c): a sum of `[+]NUMBER[.DIGITS][ ]UNIT`
  terms (`1min 30s`, `1.5h`, `+5s`: strtoll's sign, M9; `+` must be followed by digits, `-` is ERANGE; a bare number is seconds; units by first prefix match in its table order, `seconds
  second sec s`, `minutes minute min m`, `months month M` (30.44 d), `msec ms`, `hours hour hr h`, `days day d`,
  `weeks week w`, `years year y` (365.25 d), `usec us µs μs`; not `nsec ns`, which are parse_nsec's), `infinity` = none; whole
  microseconds, rounded down per term and fraction digit like `parse_time`, ≥ 2⁶⁴−1 µs fails to parse, and zero
  after rounding is "Timeout cannot be zero."; the deadline is µs/1000 ms (fractional, the timers make it ≥ 1 ms);
  default 45 s; it bounds the connect and the whole call, `--more` included (sd-varlink's semantics: the CLI runs its own
  deadline and sets the library's timeouts to 0, §5.1's stream timeout does not apply); beyond 2³¹−1 ms it means none.
- **`call --upgrade`** (M9, `upgrade.ts`, after varlinkctl.c:801-947 at 6bd4689f): PARAMETERS from argv only (absent
  or `-` → `{}`; stdin is the stream, never parameters); with `--more`/`-E`/`--collect`/`--oneway`/`--graceful`/`--push-fd=` (M11) a usage
  error with varlinkctl's text (`--upgrade may not be combined with --collect/--more/--oneway/--push-fd=/--graceful.`).
  An error reply is `Upgrade via M() failed with error: NAME` (exit 1), a local failure `Failed to upgrade connection
  via M(): …`; the confirming reply's parameters are not printed (varlinkctl passes `ret_parameters=NULL`). Then a byte
  pipe with socket-forward semantics (src/shared/socket-forward.c): stdin → channel (stdin's EOF → `channel.end()`),
  channel → stdout (one awaited write per chunk: backpressure both ways), exit 0 once both directions are done. As in
  socket-forward, a disconnect (systemd's `ERRNO_IS_DISCONNECT` errnos such as ECONNRESET/EPIPE, or the channels'
  `ConnectionClosedError`, also as a `cause`) is no failure: while writing to the channel it ends stdin → channel
  quietly (stdin is no longer read, e.g. `yes | … ` into a service that reads one line, answers and goes: its answer
  on stdout, exit 0; the failed write does not drop what the service sent before going, §4.11), while reading it is
  that direction's EOF. A `ConnectionClosedError` marked `local: true` (anywhere on the `cause` chain:
  the WebSocket channel's own receive-limit / bad-data failures, §4.12; the Close guard timeout is the peer's,
  so it ends the pipe like a disconnect, exit 0) is no disconnect but a
  failure, so output cut short by the 64 MiB receive limit exits 1 instead of looking like the service's end. When
  channel → stdout ends, stdout is ended at once (`CliOutput.end`, after socket-forward's
  `socket_forward_direction_done`: `shutdown(SHUT_WR)`, `close()` where that fails with ENOTSOCK). In `node-io.ts`:
  when fd 1 is a socket (`fstat`), `stream.end()` shuts its write side down after the last write and waits for
  `finish`, which also covers a socket that is stdin too (socat's `EXEC:`, inetd-style `StandardInput=socket`, where
  closing fd 1 alone would send no FIN); otherwise (Node never closes fds 0-2) fd 1 is closed one turn after the
  drain (`setImmediate`, so libuv drops a pending writability watch on it first) and /dev/null opened in its place —
  unless fd 1 and fd 2 are the same file (same `dev`+`ino`, e.g. `2>&1`), where closing fd 1 would not end the
  reader's stream anyway: that reader sees EOF when the process exits. A TTY and Windows are left alone (no early
  EOF there). So a downstream reader sees EOF while stdin → channel goes on until stdin's EOF. Any other transport
  failure is `Upgraded connection failed: …` (1); stdout EPIPE (or any other disconnect errno: ECONNRESET from a
  socket stdout whose reader reset it, CLI-wide, see Signals) stops the command quietly (0, as everywhere in the
  CLI, and both directions: see the differences below); signals as for other calls (130/143, the channel closed, an `exec:` child stopped and awaited
  through the channel's close). `--timeout` (and `+5s`, M9: parse_time takes strtoll's `+` per term, `-` stays
  rejected) bounds the connect and the upgrade call only. Every connection kind upgrades (unix, abstract, tcp, exec:,
  ssh-*, WebSocket); simple HTTP mode is a clear error. Over WebSocket there is no half-close: `end()` closes the
  whole connection (§4.12), so `call --upgrade ws://…` sends stdin's EOF as a WebSocket Close and output the service
  writes after that may be lost (the bridge tears the backend down); prefer unix/tcp/exec:/ssh for upgrade pipes.
- **`call --push-fd=FD` and `call --exec`** (M11, after varlinkctl.c at 6bd4689f): both load the optional
  `varlink-js-native` (`node-io.ts`: `VARLINK_JS_NATIVE=<path to its index.js>`, else the `varlink-js-native`
  package; absent is fine until needed), and only these two load it, so every other command keeps plain Node sockets.
  `--push-fd=` (repeatable, varlinkctl.c:204-229): a value starting with `/` or `./` is opened read-only, anything else
  must be a decimal fd number of the CLI process, duplicated at once (early validation; the same fd may be pushed
  twice); the fds go with the call in every mode (single, `--more`, `--collect`, `--oneway`). Messages as varlinkctl's:
  `Failed to parse --push-fd= parameter: X`, `Failed to duplicate file descriptor N: …`, `Failed to open 'P': …`;
  without the addon `--push-fd= requires the optional varlink-js-native addon (Linux)`; a connection that cannot pass
  fds (tcp, exec:, WebSocket, HTTP) fails the call with OperationNotSupportedError before sending. `--exec ADDRESS
  METHOD PARAMETERS -- CMDLINE…` (varlinkctl.c:915-921, 1088-1170, exec_with_listen_fds 670-720): PARAMETERS is
  required (`-` = stdin), `Expected command line to execute.` otherwise; `--exec and --collect/--more/--oneway may not
  be combined.`; the call accepts fds where the connection can (else a plain call, like varlinkctl's "ignoring");
  an error reply fails as usual and the command does not run (its fds are closed), except a `--graceful` one, which
  runs it with the error's parameters and the error reply's fds (as varlinkctl takes the fds of whatever message it
  got, varlinkctl.c:1139-1155). With fds the command runs through `/bin/sh -c 'LISTEN_PID=$$ … exec "$0" "$@"'`;
  `exec --` is not portable (dash runs `--` as the command), so a command word starting with `-` is made `./-…` when it
  is a path and refused when it is a bare name (`Refusing to execute '-x': a command name may not start with '-'`), so
  it never reaches `exec` as an option. `--push-fd=` to a server that does not accept fds: by default (sd-varlink's
  default too) the server drops them and the call runs, on every kernel; against a strict server (varlink-js
  `fdPassingInputStrict`, sd-varlink `SD_VARLINK_SERVER_FD_PASSING_INPUT_STRICT`) on Linux ≥ 6.16 its socket refuses
  them (SO_PASSRIGHTS off: `sendmsg` fails with `EPERM`), so the call fails with `Method call M() failed: connection
  closed: write failed: the peer does not accept file descriptors (…)` (exit 1; varlinkctl prints `Failed to issue
  M() call: Operation not permitted`, fds.sh f2). The CLI's own socket never touches SO_PASSRIGHTS (§4.15). The command gets the reply (short JSON plus LF unless `--json`/`-j` asked
  otherwise) on stdin (a sealed memfd with the addon on Linux, like `memfd_new_and_seal_string`; else a pipe), our
  stdout/stderr, the reply's fds as 3, 4, … with `LISTEN_FDS=n` and `LISTEN_PID` = its pid (`/bin/sh -c
  'LISTEN_PID=$$; export LISTEN_PID; exec "$0" "$@"'`), `LISTEN_FDNAMES` removed, and with no fds `LISTEN_FDS`/
  `LISTEN_PID` removed too. Differences: see below. `call --upgrade` rejects `--push-fd=` with varlinkctl's text.
- **Output**: `pretty` = sd-json's (TAB, `"key" : value`, `{}`/`[]`, final LF), `short` = minimal + LF, `-j` =
  pretty on a TTY (stdout and stderr both TTYs, systemd's `on_tty()`). `call` defaults to `-j` (varlinkctl.c ~900),
  also for `--json=off`; the others print text unless asked. Strings as `JSON.stringify`, numbers as JS prints them,
  bigints as integer literals. A reply (or error reply's parameters) holding a non-finite number (a peer's `1e400`
  decodes to Infinity) is not printed: `Method call M() failed: reply contains a number out of range`, exit 1.
- **Input limits**: stdin (parameters, an IDL) is read up to 16 MiB (`DEFAULT_MAX_MESSAGE_SIZE`); more is `… too
  large (more than 16777216 bytes)`, exit 1, and reading stops.
- **Target** (`target.ts`): `parseAddress`; `websocket` → `varlink-js/websocket` `connect`, `http` →
  `createHttpClient` (oneway → its `OperationNotSupportedError`; introspection goes to the named interface's service,
  or with none to the bridge's only service — several → a clear error), anything else → `varlink-js/node` `connect`
  (exec:, ssh-unix:/ssh:, ssh-exec: spawn their child there, §4.7; closing the connection SIGTERMs it and waits for
  its exit). Connections: `ints: "bigint"`, `validateReplies:
  "off"`, `timeout: 0`; every path closes them.
- **Integers**: parameters go through `jsonCodec.decode` (lossless), replies are raw (unsafe ints are bigints), and
  the printer writes bigints as digits: 2⁶³−1, −2⁶³, 2⁶⁴−1 round-trip through `call`, `--more`, `--collect`.
- **Exit codes and messages**: 0, else 1 for every failure (usage errors print one line + `See 'varlink-js
  --help'.`). Error reply: parameters on stdout (current format, SEQ under `--more`) unless `-q`, `Method call M()
  failed: NAME` (ExpectedMore: varlinkctl's text); local failures `Failed to connect to ADDRESS: …` / `Method call
  M() failed: <message>`; internal errors one line (`varlink-js: internal error: …`, the stack only with
  `VARLINK_JS_DEBUG`, escaped too, LF kept). Stderr and text output (the `certify client` lines included) escape
  C0/DEL/C1 as `\xNN` and U+2028/U+2029 and the bidi controls (U+061C, U+200E/F, U+202A–E, U+2066–9; codegen's class)
  as `\uNNNN` (IDL text keeps LF and TAB).
- **Signals, EPIPE**: main.ts turns the first SIGINT/SIGTERM into `io.signal` (reason = the signal name; a second
  one exits at once: an `exec:`/`ssh-*` child still in its SIGTERM → SIGKILL wait, killTimeout 2 s, is not
  SIGKILLed then, so one that ignores SIGTERM outlives the CLI; the Connection does not expose the child to kill it
  from the CLI, a known limit); `run` closes the connection and returns 130/143 (stdin reads, connects, calls, `bridge` all
  watch it; `certify server` shuts down and returns 0, as USAGE says). The local commands (`validate-idl`, `format`,
  `codegen FILE…`, help, version) are raced with the signal in `run`, so the first one stops them too; they check
  `io.signal` before each file they read or write, so a multi-file `format -i`/`codegen -o` does not go on (the one
  file in flight finishes unobserved). A stdout write failing with EPIPE (`| head -1`), or with any other errno of
  systemd's `ERRNO_IS_DISCONNECT` (ECONNRESET, ENOTCONN, … when stdout is a socket; the list lives in `io.ts`,
  shared with `call --upgrade`), is a `BrokenPipeError`: the command stops, closes, exits 0, prints nothing. `node-io.ts` opens stdin only when read and
  destroys it at the end, so the process always exits by itself.
- **Differences from varlinkctl**: no colours, no pager, no `--no-ask-password`/polkit, no `sd_notify`
  (`READY=1`/`VARLINKERROR=`), no experimental-method notice (an extra round trip); the error *name* instead of
  systemd 259's errno text; `--more` messages name the method (varlinkctl's reply callback says `Method call failed:
  NAME` / `… returned expected error: NAME`); exit 130/143 instead of dying from the signal; validate-idl's messages
  are ours (`FILE:L:C: reason`), `-` is stdin there; a path ADDRESS is always a socket (varlinkctl execs an
  executable); `--json` takes no `help`; maps print integer-like keys first (JS object order, sd-json keeps the
  wire order); reals print as JS does (`1e+300`; not checked against sd-json's formatter, whose source was not at
  hand; `/`, DEL, C1 and non-ASCII are left raw as by `JSON.stringify`); `format`, `codegen`, `bridge`, `certify`
  and the HTTP/WebSocket targets are ours; `--upgrade` came with M9, `--push-fd=` and `--exec` with M11 (below);
  `serve`, `list-registry`, `list-sockets`, `--user`/`--system`, `monitor` options are not implemented (M9 left
  `serve` out of scope). M11's `--exec` differs: the command is spawned, not exec'ed, so its exit status becomes ours
  (a signal: 128 + its number), the connection is closed before it starts, `LISTEN_PIDFDID` is not set (Node cannot
  read a pidfd's inode id), SIGTERM is passed on to it (SIGINT reaches it through the terminal's process group),
  fds we inherited without close-on-exec reach it unless the addon could mark them (varlinkctl closes all others),
  without the addon its stdin is a pipe instead of a sealed memfd, and `--exec --upgrade` (varlinkctl puts the
  upgraded connection on the command's stdin/stdout) is not implemented. `call --upgrade`: a broken stdout (EPIPE) ends both directions and closes
  the connection (exit 0), where socket-forward ends only channel → stdout and goes on forwarding stdin until its
  EOF (the service then sees a close instead of a half-close): stopping only that direction can deadlock against a
  cat-like service whose output nobody reads any more. Over WebSocket, stdin's EOF closes the whole connection
  (no half-close, see above). No early EOF on stdout when it is a TTY or on Windows, nor when stdout and stderr are
  the same pipe or file (`2>&1`; socket-forward's `close()` would not end that reader's stream either): the reader
  then sees EOF when the command exits.
- **Checked against varlinkctl** (systemd 255.4 in the UTM VM, Node 24.22.1, M7; scripts and results in
  `test/e2e/cli/varlinkctl/`): byte-identical stdout and the same exit code for `info`, `info -j`,
  `list-interfaces` (both), `introspect -j`, `call --json=short`, `call --oneway`, `call --more` (JSON-SEQ) against
  `io.systemd.ManagedOOM` and the userdb Multiplexer, and for 34 of 42 echo replies in `--json=short|pretty` (nested
  empty containers, escapes, `\u0001`, U+007F/U+0080/U+2028, non-ASCII, ±2⁶³, 2⁶⁴−1, `-0`, key order, `--more`
  pretty SEQ). Differences seen: reals (sd-json 255 prints `1.500000000000000000000000000000000000e+00` /
  `1.000000000000000055511151231257827021e-01`; we print JS's shortest round-trip form `1.5` / `0.1`, deliberately);
  systemd 255 ends `call` output without a newline (newer varlinkctl adds it, as we do); `introspect`/`validate-idl`
  text is our canonical formatting, not sd-varlink's re-print (multi-line parameter lists); 255 has no `-q`,
  `--graceful`, `--collect`, `list-methods`, sends invalid method names unchecked and names `ExpectedMore` instead of
  newer varlinkctl's text; our validate-idl messages are ours. systemd 259 was not compared in M7.
- **Tests**: `test/unit/cli/` (in-process `run()` with a fake `CliIo` against a service on a unix socket and
  `tcp:127.0.0.1:0`, a raw socket peer for hostile bytes, and the M10 bridge fixture for one WebSocket and one HTTP
  call; Node, Bun, Deno): every command and option, usage errors, goldens of both JSON styles, SEQ framing, int
  precision, timeouts (the `parse_sec` table), `--graceful`, signals (sent once the phase under test is reached:
  polled, no fixed delays), EPIPE, escaping, non-finite replies, the 16 MiB stdin cap, atomic `format -i`, bridge
  backpressure both ways (32 MiB against a blocked stdout / a peer that does not read: the other side stalls —
  polled until its progress counter stops — then everything arrives intact). `test/e2e/cli/` spawns `node
  src/cli/main.ts` (`--version`, info, call, SEQ bytes, oneway, piped stdin, exit codes, EPIPE after closing its
  stdout, SIGINT → 130, SIGTERM → 143, bridge as a byte pipe, bridge exiting by itself when the peer closes while
  its stdin stays open, `certify client` ↔ `certify server` as two children). M9: `test/unit/cli/upgrade.test.ts`
  (unix/tcp, interactive, argv-only parameters, error reply, timeout of the call only, HTTP error, SIGINT/SIGTERM,
  EPIPE, peer reset, 8 MiB backpressure each way) and `test/e2e/cli/upgrade.test.ts` (piped stdin, 4 MiB, `-`, error
  reply, flag combinations, SIGINT, an `exec:` child that exits once the stream is done, stdout ended early on a
  FIFO, on one socket shared with stdin (FIN while stdin stays open) and not with `2>&1`); the WebSocket channel's
  local failures (`local: true`) exit 1 through the pipe, and every disconnect errno on stdout is a
  `BrokenPipeError`. Fix round 3: an endless (`yes`-like) stdin into a service that answers one line and closes must
  put the answer on stdout (in-process over unix/tcp; real process over unix and `exec:`), plus the channel-level
  cases in `test/unit/node/socket.test.ts` and `test/regression/upgrade.test.ts` (§4.11).

### 4.15 varlink-js-native (M11)

`native/` is the separate, private (`"private": true`, never published, no prebuilds) package `varlink-js-native`
1.0.0-alpha.0: `src/varlink_native.c` (one C file, Node-API only, `NAPI_VERSION 8`, plus libuv's `uv_poll_t` through
`napi_get_uv_event_loop`), `scripts/build.js` (no node-gyp: one `${CC:-cc} -std=gnu11 -O2 -Wall -Wextra -Werror
-fPIC -shared -fvisibility=hidden -I<node>/include/node` call, `-undefined dynamic_lookup` on macOS, `NODE_INCLUDE_DIR`
and `CFLAGS` override; a missing compiler or missing headers fail with a message, exit 1), `index.js` + `index.d.ts`
(plain ESM, loads `build/varlink_native.node` with `createRequire`; never throws at import: `isAvailable()`,
`loadError`, and every other export throws `ERR_VARLINK_NATIVE_UNAVAILABLE` when not loaded; Bun and Deno are refused
up front), `test/*.test.ts` (`npm --prefix native test`, outside the root `npm test` glob, so Bun/Deno runs and a
macOS root `npm test` without the addon are unaffected; every file skips when the addon is unavailable). Zero
dependencies. Supported: Linux (glibc; musl untested). **macOS is a development target only, not supported at
runtime**: it builds and its tests run so the addon can be worked on there (SCM_RIGHTS works; credentials from
`getpeereid` + `LOCAL_PEERPID`; no pidfd, no xattr, no `MSG_CMSG_CLOEXEC`: `FD_CLOEXEC` is set right after
`recvmsg`, so a concurrent fork/exec can inherit a received fd), but its kernel differs where the channel relies on
Linux semantics and those differences are not handled: a `sendmsg` with fds while the peer's buffer is full fails
with `EMSGSIZE` instead of `EAGAIN` (the channel treats it as a write error and the connection ends, where Linux would
wait for `wantWrite`; seen while writing the peek tests, below), fds that do not fit the control buffer stay installed
unreported instead of `MSG_CTRUNC`, and there is no SO_PASSRIGHTS. Windows: not built.

**Q5 (resolved, §9): our own addon.** `usocket` 1.1.0 is built on `nan` (not ABI-stable: rebuilt per Node major) and
pulls bindings, debug, nan, node-gyp; `peercred` 1.1.2 (nan + bindings + errno) was last modified 2022-06-23;
`unix-socket-credentials` 0.1.3 uses ffi/ref (2022). None does pidfd, xattr or the read/write semantics below.

**The addon's API** (`index.d.ts`; src/node defines the `NativeAddon`/`NativeSocket` interfaces it needs, so neither
core nor rpc imports native types): `connect(sunPathBytes)` (a leading NUL = abstract, exact length; `socket(AF_UNIX,
SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK)` + `connect`; `EINPROGRESS` → poll writable → `SO_ERROR`, reported through
`onconnect`; anything else throws, `EAGAIN` (a full backlog: AF_UNIX does not queue the connect) included, as libuv's
`uv_pipe_connect` does), `adopt(fd)` (a socket over an `F_DUPFD_CLOEXEC` duplicate made non-blocking; the caller keeps
its fd), `dup`, `close`, `setCloexec`, `isUnixSocket`, `setPassRights(fd, on)` (SO_PASSRIGHTS on a listening socket;
false where the kernel has none), `pipe`, `setXattr`/`removeXattr`/`setPathXattr`, `memfdSealed` (Linux),
`SCM_MAX_FD` (253). A socket has `read()` (arms one `recvmsg`, result through `onread(error, bytes, fds, truncated)`),
`send(bytes, fds?)` (bytes written, or -1 when the buffer is full), `wantWrite()` (→ `onwritable`), `shutdownWrite()`,
`close()` (idempotent), `setAcceptFds(on)`, `peerCred()` (uid/gid/pid), `peerPidfd()` (a new pidfd, or null),
`getFd()`, `ref()`/`unref()` and the test hook `setControlBufferFds(n)`; module-level test hooks `eventfd()` and
`pidfdOpen(pid)` (Linux, else `ENOSYS`; untracked: the caller owns the fd). Callbacks are properties of the socket object
(looked up by name, so no strong reference from C to JS closures). Errors are JS `Error`s with `code` (errno name),
`errno` (negative, as Node) and `syscall`; an argument of the wrong type throws (`ERR_INVALID_ARG_TYPE`), every setter
included.

**C rules.** Every syscall result checked; every fd we create or receive is close-on-exec; no SIGPIPE
(`MSG_NOSIGNAL`, `SO_NOSIGPIPE` on macOS); `EINTR` retried everywhere except `close()`; no fd is touched after its
close. One `uv_poll_t` per socket, started only while a read, a write wait or a connect is pending (and then the JS
wrapper is held by a strong reference, so it cannot be collected while libuv may call back); idle, the reference is
weak and an unreachable socket is closed by its finalizer (`uv_close`, the struct freed in the close callback). An
open socket keeps the event loop alive while something is pending, which is always the case for a varlink connection
(its reader has a read outstanding) except while a stream's buffer is full. Per-environment instance data (one per
Node environment: the main thread and each worker) holds the class, the 64 KiB read buffer (never shared between
threads) and the list of live sockets; an async environment cleanup hook (`napi_add_async_cleanup_hook`) closes every
socket's poll handle and fd when the environment tears down (a worker terminated with open connections, the main
environment exiting) and lets teardown go on once libuv ran the close callbacks; the instance-data finalizer detaches
sockets that are finalized later. The instance also tracks the fds its JS holds for the library: fds received with
messages, the library's duplicates (`dup(fd, true)`, used for every fd the library sends) and its channels' pidfds
(`peerPidfd(true)`); the addon's exported `dup(fd)`/`peerPidfd()` are untracked, owned by the caller (close them any
way). Each tracked fd is recorded with its file's identity (`st_dev`, `st_ino`, file type, `F_GETFL` access mode;
a number tracked again replaces its stale entry, since a number cannot be open twice). JS forgets one with `close()`
(which closes it) or `release()`, called when the fd is handed to a user (`ctx.takeFd`, an `acceptFds` reply or error;
`handOver` in the core framer calls the native handle's `handOver()`, duck-typed), so the hook closes exactly what
the library still held when the environment went away (fds queued in a framer, `ctx.fds` of an unfinished call, a
pidfd) and never an fd a user owns. The hook is defensive, best effort, about fds closed behind the library's back:
before closing a tracked number it `fstat`s it and closes it only if it still matches the recorded identity (EBADF or
any difference: left alone), so a number another thread reused meanwhile is usually not closed under it. What it
cannot tell apart: a reused number on the same inode (a `dup` of the tracked file, or another open of it with the
same access mode), and anon-inode fds, which all share one inode (eventfd, epoll, timerfd, signalfd, inotify, and
pidfds before Linux 6.9, peer pidfds via `SO_PEERPIDFD` from 6.5; from 6.9 pidfds have their own pidfs inodes). The
anon inode is probed once per environment (`fstat` of an eventfd, or of an epoll fd if eventfd fails; the fallback
does not help with `EMFILE`/`ENFILE`, which fail both; `stats().anonProbe`); a tracked fd on it is classified when
tracked from `/proc/self/fd/N` (`anon_inode:[pidfd]`) and, for a pidfd, the `Pid:` of `/proc/self/fdinfo/N`, which
must be > 0 (-1, a process already gone, and 0, one outside our pid namespace, are shared by unrelated pidfds: such
a pidfd is treated like any other anon-inode fd).
What teardown closes: **≥ 6.9**, every tracked fd still matching its identity (received fds, duplicates, pidfds:
pidfs inodes are per process); **before 6.9**, the same for non-anon fds, and a tracked pidfd only if `/proc` still
names it a pidfd of the same `Pid:` > 0 (not told apart: another pidfd of the same process on a reused number); any
other anon-inode fd (a received eventfd, say: libuv's own loop fds in other threads are of these kinds) is left open,
a documented best-effort leak at worker teardown, as is a pidfd whose process exited meanwhile (`Pid:` -1). Any
tracked pidfd (peer, received or `dup(fd, true)`) whose `Pid:` is 0 (the process is outside our pid namespace) or
-1 when tracked is left open at teardown too and counted (round-6 change, see the fix-round notes). Without
`/proc` no anon-inode fd is closed, and without the probe (both fds failed, e.g. `EMFILE`/`ENFILE`) none at all. Every
tracked fd left open counts in the process-wide `stats().teardownSkipped`. `more` replies of an `acceptFds` stream or
collect are handed over when they reach the caller (the iterator yields one, the collection resolves), not on arrival:
buffered replies never delivered stay tracked, are closed when dropped (`return()`, a failed collect) and otherwise at
teardown. errno is saved right after each syscall, before any napi
call; every fd received is settled (handed on or closed) before the first napi call, so a failing handle scope or
allocation cannot leak one.

Reads follow sd-varlink's `json_stream_read` (json-stream.c:1229-1376): one `recvmsg` per `read()`, flags
`MSG_DONTWAIT|MSG_CMSG_CLOEXEC`. **While fd input is accepted, reads are bounded**: a `recv(MSG_PEEK)` finds the next
NUL and only that much is read, as `json_stream_peek_message_boundary` does (json-stream.c:1187-1227, used at 1282;
our peek starts with a 4 KiB window and widens it ×4 up to the 64 KiB buffer only while no NUL is in sight, so a
stream of small messages does not copy 64 KiB per peek),
because "recvmsg() may combine preceding data with the next SCM_RIGHTS-bearing send" (1049-1051): on Linux one
unbounded `recvmsg` returned a fd-less message plus the next send's start with its fds, which the framer then gave to
the wrong message (shown in the VM by building without the bound; macOS's kernel ends a read at such a send anyway).
**While input is off**, fds that arrive are closed at once and the message goes on without them: sd-varlink reads
with plain `recv()` then (json-stream.c:1318-1321), so the kernel discards them; we keep a control buffer and close
them ourselves because macOS leaves fds that do not fit installed and unreported. **`MSG_CTRUNC`** (input on; e.g. an
LSM refused some fds): the fds received are closed, the bytes delivered, `truncated` set, as json-stream.c:1308-1317
logs, drops and continues ("the request handler will surface a clean error to the peer when it tries to peek the
missing fd"). An EOF never carries fds. `setAcceptFds(on, passRights)` sets `SO_PASSRIGHTS` only when asked (strict
mode, below): always on the first such call, later only when the value changes (the value 83 is defined where the headers lack it, asm-generic
architectures only; a kernel without the option, `ENOPROTOOPT`/`EINVAL`/`EOPNOTSUPP`, is ignored like
json-stream.c:705-708, and the requested value is recorded anyway, as json-stream.c:711 sets its flag, so later calls
with the same value do not re-issue it). Writes: `sendmsg` with `SCM_RIGHTS` on the first byte only (a message's first part); more
than 253 fds is `ENOBUFS` before writing, like sd-varlink.c:3268.

**SO_PASSRIGHTS (Linux ≥ 6.16): sd-varlink's default, strict mode opt-in.** A socket with it off makes the *sender's*
`sendmsg` with fds fail with `EPERM` (on Linux ≤ 6.15 there is no such option). We copy sd-varlink's default, which
leaves it alone:
- **Default (every socket):** never touched; the kernel default (on) stays. `json_stream_set_allow_fd_passing_input`
  returns early when the input flag does not change (json-stream.c:691-692), so a fresh sd-varlink client keeps the
  default, and server connections without `SD_VARLINK_SERVER_FD_PASSING_INPUT_STRICT` skip the per-connection
  setsockopt (sd-varlink.c:3347-3352, applied at 3612); the listening socket is touched only in strict mode
  (sd-varlink.c:3787-3792, 3851-3853). With input off the read path drops the fds and the message goes on, on every
  kernel: a client without `acceptFds` gets a reply that carried fds (fds dropped, connection usable), a server
  without `allowFdPassingInput` runs a call that carried fds (fds dropped). **Clients differ from sd-varlink:** its
  client connections always use the setsockopt when input changes (`with_sockopt = !v->server || …STRICT`,
  sd-varlink.c:3347-3352), so an sd-varlink client that switches input off after having it on makes a later reply with
  fds fail the server's write (`EPERM`). Our client never touches SO_PASSRIGHTS: its input is switched per call
  (`acceptFds`) and stays permissive (a reply's fds while input is off are dropped silently, no peer `EPERM`).
- **Strict (opt-in, `listen(…, {native, fdPassingInputStrict: true, allowFdPassingInput})`, also on
  `listenFromEnv`/`listenAuto`):** as `SD_VARLINK_SERVER_FD_PASSING_INPUT_STRICT`, the listening socket gets
  SO_PASSRIGHTS = `allowFdPassingInput` before anything is accepted (accepted sockets inherit it; for an `{fd}` socket
  before Node serves it, like sd-varlink.c:3787-3792), and each accepted connection sets it when the server switches
  input: always on the first switch (an accepted socket's value is unknown: inherited from the listening socket, or
  from a service manager's `PassRights=`; sd-varlink's tracked flag starts off, so its first allow reaches the
  setsockopt too, sd-varlink.c:3612, json-stream.c:691-692, 705-708; its first *disallow* returns early there and
  keeps the inherited value, where we set it off), later only when the value changes. A
  `listen()`/`listenFromEnv()` strict listener carries the `allowFdPassingInput` it was given
  (`strictFdPassingInput`), and `server.serve()` throws a `TypeError` when it differs from the server's (so the two
  cannot silently disagree; `server.handle()` on single channels still works, each connection being set from the
  server). A client sending fds to a strict server without input
  then fails: the channel turns the `EPERM` into an `OperationNotSupportedError` ("the peer does not accept file
  descriptors …", `code` "EPERM", the errno error as `cause`); like any write error it ends the connection's writes
  and the connection closes, which is what sd-varlink does (`json_stream_write` returns the errno,
  json-stream.c:1151-1161, and `sd_varlink_process` disconnects, sd-varlink.c:1610-1614, 1675-1678); varlinkctl
  prints `Failed to issue M() call: Operation not permitted` (fds.sh f2). Known windows (strict mode only):
  sd-varlink sets it before `bind` on a socket it creates (sd-varlink.c:3851-3853); Node creates the listening fd
  inside `listen()`, so ours is set right after: no client can reach a unix path socket then (still in the private
  0700 directory), but the bind-at-path fallback and `unix:@` are reachable between Node's `listen()` and our
  setsockopt, so a client that fast gets the kernel default. Per connection: an accepted socket has its listener's
  value until the server's `handle()` runs the setsockopt, so where the two differ (a custom accept loop handing a
  strict listener's channels to a server with another `allowFdPassingInput`; `serve()` and `mergeListeners` refuse the
  mismatch) a client that sends fds right after connecting gets the listener's value: with a listener without input,
  `EPERM` (seen in the VM on Linux 7.0: the client's `sendmsg` runs before the server's `accept`, every time, when
  both are in one process). sd-varlink's per-connection setsockopt also runs only after `accept`
  (`varlink_server_link_connection`, sd-varlink.c:3612, called from `sd_varlink_server_add_connection_pair`, sd-varlink.c:3659); it avoids the
  mismatch by setting the listening socket from the same server's flags. Pass the server's `allowFdPassingInput` to `listen()` (`serve()` enforces it).
The tests probe the kernel (`setPassRights` on a socket) and assert the branch it takes: default behaviour on every
kernel, the strict branch per kernel; CI's `native` job prints `uname -r`.

**The channel** (`src/node/native.ts`, `nativeChannel`): the `fromNodeSocket` contract (§4.11) over an addon socket:
reads one `recvmsg` at a time (the kernel buffer is the read backpressure), bytes before an error or EOF first; writes
queued, each `write()` resolving when all of it went to the kernel; partial writes keep the remainder and never send
the fds twice (they ride with offset 0 only); `EAGAIN` → `wantWrite`. A write error (EPIPE, ECONNRESET, …) rejects
that write and every later one but reads go on to the peer's EOF or error (no unread input is lost; the M9 lesson).
`end()` = `shutdown(SHUT_WR)` after the queue drained; `close()` idempotent (queued writes reject, a pending read gives
null, the fd and the peer's pidfd are closed, `closed` resolves); once the peer's EOF (or a read error) was read and
our side is ended (or failed) the channel closes by itself, like a half-open Node socket. `capabilities`: `fdPassing`
(input off by default, SO_PASSRIGHTS untouched unless strict; output off by default; `duplicate`), `peer` (uid/gid/pid read once at
accept/connect with `SO_PEERCRED`; when that fails, `peer()` throws the error, so a server enforcing a per-UID limit
refuses the connection; `pidfd` is fetched with `SO_PEERPIDFD` on first access only (Linux ≥ 6.5; it names the process
that connected whenever it is asked), owned by the channel, handed out as a view) and `upgraded`.

**Where the channel is used** (only with `native` given and available; without it nothing changes):
`connect(address, {native})` for `unix:` and `unix:@` (client role); `listen(address, {native})` keeps Node's
`net.Server` for listening and accepting (activation, `mode`, the private-directory publish and unlink logic stay as
they are) with `pauseOnConnect: true` (it already was), and on `connection` takes `socket._handle.fd`, has the addon
adopt a duplicate and destroys the Node socket (closing only Node's copy: nothing was read, so a call sent right with
the connect is not lost; tested 40 times per run); unix paths, `unix:@` and `{fd}` listeners whose fd is a unix socket
(`isUnixSocket`), never TCP. A connection the addon cannot take over (no fd, an adopt failure such as `EMFILE`) is
refused: closed and reported to the listener's `onError`, never served as a plain socket, which would have no
credentials and escape the per-UID limit (sd-varlink refuses a connection whose credentials it cannot get,
sd-varlink.c:3568-3570). `listenFromEnv({native, fdPassingInputStrict, allowFdPassingInput})` (and `listenAuto`)
passes them to `listen({fd})`, adopts connected unix activation fds (closing the original; a unix socket the addon
cannot adopt is closed too, the connection refused, and `listenFromEnv` rejects; the listeners it already opened are
closed by its error path, as in M8, so no activation fd is left half-owned) and sets `FD_CLOEXEC` on every `LISTEN_FDS` fd, as `sd_listen_fds` does (the `/dev/null` cover
of §5.8 stays). `exec:` socketpairs, TCP, ssh, WebSocket and HTTP never get fd passing or peer
credentials.

**fds through the protocol** (core, §4.1): `Framer.push(bytes, fds)` binds fds to the message starting at the
chunk's first byte (`takeFds()` after `next()`); fds while a message is incomplete are a protocol error recorded like
an oversized message (complete messages before it are still delivered, then the connection closes): sd-varlink's
`json_stream_read` returns `EPROTO` when fds come while its input buffer is not empty (json-stream.c:1345-1350), and
its input fds belong to the message parsed next. With bounded reads (above) a chunk never reaches past a NUL, so the
first message it starts is the one sent with the fds. A single send holding several messages carries its fds on the
first one (tested). An `fdError` ("truncated") is not a protocol error: the server reports `fds-dropped` to `onError`,
the client to its `onError` (`fds-dropped`), and the message goes on without fds. `ClientSession`/`ServerSession` put a
message's fds on its `reply`/`error`/`call` event; an upgrade confirmation's and post-upgrade fds are closed. An
`acceptFds` call's error reply keeps its fds on the rejected error as `fds` (non-enumerable; the caller owns them);
other error replies' fds are closed.
The framer counts the fds it holds for messages not yet returned (`queuedFds`); `ServerSession.wantsInput` is false
while a complete call is buffered and that count reaches `maxQueuedFds` (server option, default 253 = SCM_MAX_FD), so
the reader parks until the dispatcher takes calls (their fds then belong to the handler and no longer count). A
partial message keeps reading, so one message carrying more than the bound is still accepted. So the framer holds at
most `maxQueuedFds` − 1 + one read's fds (at most 253), plus the fds of the call being handled (`ctx.fds`, outside the
framer): at the default about 252 + 253 + 253 = 758 per connection in the worst case (sd-varlink, reading one message
at a time, holds at most 253), instead of `maxQueuedCalls` × 253.
Dispatch gives handlers `ctx.fds`, `ctx.takeFd(i, parameter = "fds")`, `ctx.pushFds(...fds)` and `ctx.peer` (§5.4),
closes unclaimed received fds and unsent pushed duplicates when the call finished, and passes a reply's pushed fds
to `send(bytes, fds)`. The `UpgradedChannel` is bytes only: it switches fd input off, closes fds that still come,
rejects writes with fds, keeps only `capabilities.peer` (and calls `upgraded`, which removes the xattr).

**The upgrade boundary and fds (M5 of review-1).** sd-varlink bounds reads for upgradable servers too
(`JSON_STREAM_BOUNDED_READS`, sd-varlink.c:3604-3606) so it never consumes post-upgrade bytes, then hands the raw fd to
the upgrade callback, which reads with plain `read()`: fds riding on post-upgrade bytes are discarded by the kernel
there (or refused with `EPERM` on ≥ 6.16 when input is off). We do not need bounded reads for the bytes: the framer
keeps everything past the upgrade call's NUL and the upgraded channel yields it first (§4.10). For fds the result is
the same as systemd's: the server's reader parks after an upgrade call (no read is issued until it is answered),
reads are bounded at its NUL whenever input is on, and the upgraded channel switches input off before its first read
and closes any fd that still arrives. So fds sent after the upgrade request are dropped (≤ 6.15) or refused (≥ 6.16),
never delivered to the varlink side; a protocol that needs fds after an upgrade is out of scope (documented).

**The `user.varlink` xattr** (best effort, sd-varlink.c:165-211): "client" on a connected socket (sd-varlink.c:230,
648), "server" on an accepted one (3685), "listen" on the listening socket (3798, 3850), "entrypoint" on an absolute
socket path (3863-3864); removed from a connection socket on upgrade (1524-1527, `ENODATA` no error). Every failure
is ignored. Seen in the VM: on Linux 6.8 `fsetxattr(user.varlink)` on a unix socket fails with `EPERM`, and setting
it on the socket's path is refused too (user xattrs only on regular files and directories), so nothing is tagged
there; Linux 7.0.0-43 (fix round 1) gives the same `EPERM` for the socket; macOS: `ENOTSUP`.

**Per-UID limit** (§5.4): opt-in, like sd-varlink's `SD_VARLINK_SERVER_ACCOUNT_UID` (sd-varlink.c:3492, 3518):
without `maxConnectionsPerUid` nothing is counted; with a number (sd-varlink uses 128 when the flag is set,
sd-varlink.c:47) connections are counted by the channel's `peer().uid`, where the channel has the capability (the
server's side reads it, so with a native listener a client without the addon counts too); checked after the total
limit like `validate_connection` (sd-varlink.c:3468-3508), the connection refused (closed, `connection-limit`), root
not exempt; decremented when the connection ends. With the limit set, a channel whose `peer()` throws, or whose UID is
invalid (`(uid_t) -1`, not an integer), is refused (`connection-refused`), as sd-varlink refuses a connection whose
credentials it cannot acquire or whose UID is invalid (sd-varlink.c:3494-3497, 3568-3570). Channels without the
capability (tcp, plain Node sockets) are not counted.

**Tests** (`native/test/`, `{ timeout }` everywhere, each file checks that it leaves no fd behind by counting
`/proc/self/fd` or `/dev/fd`): `fds.test.ts` (both directions, `more`/collect replies with fds, an abandoned stream, a failed proxy collect,
the opt-ins and their absence: default behaviour on every kernel (a reply with fds to a call without `acceptFds`
arrives and the connection stays usable; a server without input runs the call), strict mode per kernel; unclaimed
fds, a coalesced send, separate sends read in one go (A gets no fd, B its own: bounded reads; on Linux the addon's
`stats().boundedCuts` counter proves A and B were queued together), 8 MiB messages with fds both ways, the 253 cap,
no addon → OperationNotSupportedError, upgrade, first call on connect, `ctx.fds` views, a strict listener without
input whose connections a server with input handles (fds pass), strict `listen({fd})` prepared once), `channel.test.ts`
(MSG_CTRUNC on the channel and at a server (`fds-dropped`, the call runs), input off by default (dropped on every
kernel) and on a strict channel (EPERM on ≥ 6.16), input on, bounded reads (two queued sends, a 200 KiB message
through the widening peek, 2000 small pipelined messages one per read, a message whose NUL is at offset 4095, 4096,
16383, 16384, 65535 or 65536 followed by one with an fd, the `peekWidenings` counter showing the widening ran), the
first strict `setAcceptFds` always reaching the setsockopt (`passRightsCalls` counter, and no repeat for an unchanged value on any kernel), a re-tracked number keeping one
entry (`trackedFds`), setter type checks, output off, half-close,
close, a write error keeping the peer's data readable, the helpers, error shape), `peer.test.ts` (credentials of a
child process client, the server's from a client, pidfd on Linux ≥ 6.5 and its lazy view, the per-UID limit, xattr
probe), `worker.test.ts` (a stress test, not a smoke test: three workers, each 3000 tiny pipelined calls through
bounded reads plus 40 fd calls with 100 kB replies, at once; a worker terminated while it holds a received fd and a
pidfd; a worker terminated while it keeps fds handed to it (an `acceptFds` reply, a pulled stream item, `takeFd`: they
stay open) with two stream replies buffered (closed); a tracked number closed behind the addon's back and reused (left
open); a worker terminated with an open native connection), `cli.test.ts` (`--push-fd=` and `--exec` end to
end, their messages, `--push-fd=` to a server without input by default and strict, `--exec --graceful` taking the error
reply's fds, a command word starting with `-`). Root tests without the addon: `test/unit/protocol/framer-fds.test.ts`
(fds mid-message, coalesced, unclaimed: deterministic, chunk by chunk), `test/unit/rpc/server-peer.test.ts` (per-UID
opt-in with more than 128 connections, refusals incl. UIDs 0xFFFFFFFF and 0xFFFF), `test/unit/node/native-listen.test.ts`
(an addon that cannot adopt: the connection is refused; SO_PASSRIGHTS only in strict mode; `serve()` refusing a strict
listener whose `allowFdPassingInput` differs, also through `mergeListeners`; `mergeListeners` refusing strict
sources that disagree). macOS skips MSG_CTRUNC
(the kernel leaves fds that did not fit installed, unreported) and pidfd. Proofs (each run against the code without
the fix, in the VM on Linux 7.0 unless said): review-1's bounded-read tests fail without the bound and its
worker-termination test fails without the cleanup hook (on macOS both pass anyway); review-2's default-behaviour tests
(fds.test "reply with fds to a call without acceptFds", "server without allowFdPassingInput (default)", cli.test
"--push-fd= to a server without fd input (default)") fail with fix round 1's code (EPERM); the stress test fails 3 of
3 runs with one read buffer shared by all environments (corrupted JSON); the worker-hold test fails without closing
the tracked fds (2 fds leak: the received one and the pidfd). Fix round 3 (review-3, run on macOS against the code
without each fix): the first-strict-call test fails with the old `-1 = on` logic (0 setsockopt attempts, expected 1;
on Linux ≥ 6.16 the strict-listener test is then the EPERM case); the reused-number test fails with round 2's
addon (teardown closed the reused fd); the kept-fds worker test fails with arrival-time `handOver` (2 fds leak: the
buffered replies); the `serve()` mismatch and `listen({fd})`-once tests fail without their fixes. Fix round 4 (run
on macOS against the code without each fix): the failed-proxy-collect test leaks 2 fds without `collectSink`; the
first-strict-call test makes 2 setsockopt attempts for an unchanged value (expected 1) when a kernel without
SO_PASSRIGHTS leaves the state unrecorded; the re-tracking test keeps 2 entries for one number; the `mergeListeners`
test sees no exception. The strict-listener test (CI run 43782174441, Linux 7.0-azure; 6 of 6 runs in the VM) sent
fds right after connecting, inside the per-connection window above (the client's `sendmsg` failed with `EPERM` before
the server had accepted, 0 setsockopt attempts); it now completes a plain call first. Round 4's drop of a reply
pushed to a `ReplyStream` after it is done (`#push`, connection.ts) is defensive: no path reaching it is known or
tested. Fix round 5 (in the VM on Linux 6.8, pidfds on the anon inode): the worker-hold test timed out with round 4's
addon (the pidfd leaked: anon-inode fds were never closed) and passes with the `/proc` pidfd classification; a Linux
test asserts `anonProbe` is `"eventfd"`, and the hold test that teardown skipped nothing. Fix round 6 (review-6):
the native CI job runs on ubuntu-22.04 too (kernel 6.8.0-1070-azure: pidfds on the anon inode; it ran the
pidfd-reuse test, which passed; ubuntu-24.04/latest are on 7.0-azure); a pidfd is classified as one only with
`Pid:` > 0; worker tests for a received eventfd (left open, counted) and a reused pidfd number; the
`teardownSkipped` counter is an `unsigned long` (lock-free on 32-bit targets). Fix round 7 (review-7, tests and
docs): a regression test for the `Pid:` > 0 rule (a tracked pidfd of a reaped child, its number reused by a pidfd of
a second reaped child, both `Pid:` -1: left open, `teardownSkipped` +1; in the VM on Linux 6.8 it fails with the
`pid > 0` guard removed, the fd being closed); CI's ubuntu-22.04 entry sets `VJN_REQUIRE_ANON_PIDFD=1`, which turns
that test's "pidfds are not on the anon inode" skip into a failure; the pidfd probe of the tests never throws
(ENOSYS/EPERM become a skip reason); the eventfd test reads back a counter (0x5eed) the worker wrote, proving the
fd left open is that eventfd; the pidfd-reuse test runs on every kernel with pidfds (≥ 6.9: different pidfs inodes);
`pidfdOpen`'s argument error says "pid". macOS quirk seen
while writing the peek tests: a `sendmsg` with fds while unread bytes fill the peer's buffer fails with `EMSGSIZE`
(not `EAGAIN`), so there the fd message goes after the first was read (dev platform; not handled in the channel).
`test/interop/vm/fds.sh` (§7.4): varlinkctl 262.2 ↔ varlink-js.

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
  validateReplies: "off",   // "off" | "warn" | "throw"; needs an IDL (typed calls: "off" acts as "warn")
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

// Upgrade (M9, §5.6)
const { parameters, channel } = await conn.upgrade("com.example.Decompress.XZ", {});
// On success `conn` is finished as a varlink connection and `channel` (a ByteChannel that owns the transport)
// carries the custom protocol. On an error reply this rejects with the VarlinkError and `conn` stays usable (UAPI).

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
- **fds** (M11, implemented; fd-capable channels only: `connect("unix:…", { native })`, §4.15):
  `conn.call(m, p, { fds: [h1, 3, fileHandle] })` attaches fds (numbers or FdHandles, at most 253: more is a
  `RangeError`) to that call's message, in every kind of call (`call`, `stream`, `collect`, `oneway`, `upgrade`). The
  caller keeps its fds: the library sends duplicates made when the call is made and closes them after the write
  (§4.1), so `fh.close()` right after `conn.call(…)` returned is fine. `{ acceptFds: true }` opts in to receiving fds
  for that call only (UAPI: clients MUST NOT accept fds unless they invoke a method that returns them; fd input is
  switched on while such a call is in flight). With `acceptFds`, the result is `{ parameters, fds }` (`WithFds<T>`)
  instead of bare parameters, and stream/collect items likewise; overloads type it (`acceptFds?: false` on the plain
  options), so typed results still match their types; the caller owns those fds. `acceptFds` on `oneway`/`upgrade` is
  a `TypeError`. With no `acceptFds` call in flight the client's input is off: fds a server sends then arrive and are
  dropped silently, the reply going through and the connection staying usable, on every kernel (the client never
  touches SO_PASSRIGHTS, so the server's `sendmsg` is not refused; json-stream.c:691-692, 1318-1321). fds that do come
  with a reply to a call without the opt-in (input on for another, pipelined call) close the connection as a protocol
  error, and are closed. An `acceptFds` call's error reply rejects with the error carrying its fds as `fds`
  (non-enumerable; the caller owns them and must close them, as the `call()`/`acceptFds` JSDoc says). Buffered or
  collected replies that never reach the caller (an abandoned stream, a failed collect) have their fds closed; the
  caller's ownership (the transport's `handOver`) starts when a `more` reply is yielded or the collection resolves, a
  single reply's at once (§4.15). Without fd capability,
  `fds`/`acceptFds` reject with `OperationNotSupportedError` before anything is sent. Not on the Pool or typed clients
  (use a Connection: `conn.call(Desc.Method, p, { acceptFds: true })` is typed).

### 5.2 Pool

```ts
import { createPool } from "varlink-js/node";
const pool = createPool("unix:/run/foo", { max: 8, idleTimeout: 30_000 });
await pool.call("org.example.Ping", {});   // same methods as Connection; each call/stream leases a connection
await pool.close();
```

The runtime-agnostic core is `createPool(factory, options)` from `varlink-js` (`factory(signal) =>
Promise<Connection>`); the Node adapter's `createPool(address)` wraps it (§4.11). The pool leases an idle healthy
connection or opens one (up to `max`, then waits). A connection that
closed or failed is discarded, never reused (F4). Streams hold their lease until they end, so
cancelling one stream doesn't kill other calls. `pool.addInterface(descriptorOrIdl)` registers an interface on
every connection it hands out (§4.11), and `call`/`oneway`/`stream`/`collect` have the same typed descriptor
overloads as Connection, so `X.client(pool)` works like `X.client(conn)` (§5.3). There is no `pool.upgrade()` (M9):
an upgraded connection can never return to the pool, so upgrade on a Connection of your own (a typed client over a
pool rejects `.upgrade()` with `OperationNotSupportedError`).

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

// Each method is callable (single reply) and also has .stream(), .collect(), .oneway() and .upgrade() (M9),
// mirroring the untyped Connection API, so the return type never depends on a runtime option. Generated method
// descriptor types do not carry the IDL flags, so .upgrade() exists on every method's type; on a method without an
// upgrade flag it rejects with a TypeError at run time, nothing sent.
for await (const c of ftl.Monitor.stream({})) { c.condition.state }  // "idle" | "spooling" | "busy"
```

Generated descriptors carry the IDL, so typed calls always decode their replies (unknown fields dropped, `int`s
converted per the `ints` mode), whatever `validateReplies` says: for them the default `"off"` acts as `"warn"` (an
invalid reply is delivered raw and reported to `onError` as `invalid-reply`; an unsafe int in `"number"` mode
rejects), and `"throw"` rejects an invalid reply. Untyped calls keep `"off"` (raw). Clients SHOULD ignore unknown
reply fields, so reply validation skips unknown fields. `X.client(target)` is `createClient(X, target)` (§4.13): it registers the
descriptor on the connection (`addInterface`; a different IDL under the name or an `ints` mismatch is a
`TypeError`) or the pool (checked per leased connection), so parameters are encoded with the IDL and error replies
of the interface become the generated classes. Parameters are optional iff the input has no required field.

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
// M11: listen(address, { native }) (import * as native from "varlink-js-native"): fds, ctx.peer, per-UID limit
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
  (sd-varlink's `sd_varlink_notify` style), and the returned value is final. `notify` rejects with a
  `ConnectionClosedError` once the connection is gone (a send failed, or the session closed under the call). Dropped notifies
  (oneway, or non-`more` after the first) resolve immediately, so wait on real events between notifies (`for await
  (const c of changes({ signal: ctx.signal })) await ctx.notify(c)`), never a bare `for (;;) await
  ctx.notify(x)`; methods meant to stream should declare `more: "requires"` (§4.10).

Handler context `ctx`: `signal` (aborts when the client disconnects or the server shuts down),
`more`/`oneway`/`upgradeRequested` flags, `method`, `peer` (M11), `fds` (M11), `notify(partial)` (send a
`continues` reply from a plain async handler, sd-varlink style), `upgrade(replyParams?)` (M9, §5.6; the flag was
`ctx.upgrade` before M9 and is `upgradeRequested` now that `upgrade` is the method).

M11 (implemented, §4.15): `ctx.peer` (`{uid, gid, pid, pidfd?}` or undefined: credentials exist on unix connections
accepted by a listener with the native addon; read once at accept; `pidfd` is fetched on first access and is a view:
the connection owns and closes it, its `close()` does nothing, its `fd` is -1 once the connection closed), `ctx.fds`
(the fds of this call as views: library-owned and closed when the call finished; a view's `close()` does nothing and
its `fd` is -1 once the fd was claimed or closed, so a handler that keeps `ctx.fds` past the call or past `takeFd`
never sees a number that may have been reused), `ctx.takeFd(index, parameter = "fds")` (claims one, returning the
owned handle; `InvalidParameterError({parameter})` for a missing or already claimed index, so a handler can let it
propagate), and
`ctx.pushFds(...fds)` (like `sd_varlink_push_fd`, sd-varlink.c:3258-3277: fds for the call's *next* message, a
notify, yield, returned value or error; duplicated at once, so the handler may close its own right away; at most 253
per message, `RangeError`; `OperationNotSupportedError` unless the server allows fd output on that connection).
fd passing is opt-in per server, like `sd_varlink_server_new` flags `SD_VARLINK_SERVER_ALLOW_FD_PASSING_INPUT`/
`OUTPUT` applied per connection in `varlink_server_link_connection` (sd-varlink.c:3612-3613): `createServer({
allowFdPassingInput, allowFdPassingOutput })` (default false). Fds sent with a call to a server without input are
dropped and the call runs without them, on every kernel (sd-varlink's default: SO_PASSRIGHTS untouched, plain `recv()`,
json-stream.c:1318-1321). Strict mode is opt-in on the listener, like `SD_VARLINK_SERVER_FD_PASSING_INPUT_STRICT`:
`listen(…, {native, fdPassingInputStrict: true, allowFdPassingInput})` (pass the server's `allowFdPassingInput`) sets
SO_PASSRIGHTS on the listening socket and per connection (§4.15), so on Linux ≥ 6.16 a client sending fds to a server
without input fails its `sendmsg` with `EPERM` (its call rejects, its connection closes).
fds the kernel truncated (MSG_CTRUNC) are dropped and reported to `onError` as `fds-dropped`; the call runs.
Received fds are bounded per connection by `maxQueuedFds` (default 253, SCM_MAX_FD): while the calls buffered but not
yet dispatched to a handler hold that many fds (with a complete call buffered), the connection stops reading
(backpressure, as for `maxQueuedCalls`) and resumes once they are dispatched; fds a handler received (`ctx.fds`) no
longer count. One message carrying more than the bound is still accepted (the kernel caps it at 253). So the framer
holds at most `maxQueuedFds` − 1 + one read's fds, plus the fds of the call being handled: at the default about
252 + 253 + 253 = 758 per connection in the worst case. Without the bound, 64 pipelined calls × 253 fds could pin
about 16 000 fds per connection; sd-varlink reads one message at a time and holds at most 253. No
per-method or per-connection switch (sd's `sd_varlink_set_allow_fd_passing_*` from a connect callback): input must be
decided before the call's bytes are read, and we have no connect callback.

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
| Method supports/requires `upgrade`, call with it | handler runs with `ctx.upgrade()` available (§5.6) |
| `upgrade` set on a method that does not support it | Q4 (M9, as sd-varlink): handler runs as a plain call (`ctx.upgradeRequested` true, `ctx.upgrade()` rejects), its reply or error goes out, the connection stays varlink; a `[Requires 'more' flag]` method still answers `ExpectedMore` |
| Handler throws `VarlinkError` | that error (name + params) |
| Handler throws anything else | `onError` hook, then the internal error reply (see Q2); no details leak |
| Generator throws after yielding | error reply ends the stream (an error is always final) |
| Client disconnects mid-call | the driver aborts the call's signal and closes the session: `ctx.signal` aborts, later replies are discarded, `notify` rejects |

Output validation uses the same option as the client, `validateReplies: "off" | "warn" | "throw"`, but the
server default is `"warn"`: an invalid reply is still sent, and the mismatch is reported to `onError`.
That catches handler bugs against the IDL, like sd-varlink's `validate_method_reply`. Core never reads
environment variables; set the option explicitly (e.g. `"off"` for hot paths).

Limits: from sd-varlink, `maxConnections` 4096, `maxConnectionsPerUid` (M11, §4.15: opt-in like sd-varlink's
`SD_VARLINK_SERVER_ACCOUNT_UID`, sd-varlink.c:3492, 3518; unset = no per-UID counting; sd-varlink uses 128 with the
flag, sd-varlink.c:47; counted where peer credentials are available; a connection over it is closed and reported as
`connection-limit`, root included; with it set, unreadable credentials or an invalid UID are refused as
`connection-refused`) and `maxMessageSize` 16 MiB; our own default, `maxQueuedCalls` 64 per connection
(beyond that, stop reading: backpressure), and `maxQueuedFds` 253 (M11, SCM_MAX_FD: received fds held by a
connection's buffered, not yet dispatched calls; at that many, with a complete call buffered, stop reading; one
message carrying more is still accepted; sd-varlink reads one message at a time, so it holds at most 253). No idle timeout on server connections (F1). Optional
`exitOnIdle: ms` for socket-activated services (M8): the *server* shuts down after that long without any open
connection (0 = when the last one closed), and `server.closed` resolves after any shutdown (§5.8).

**`serve(listener): void` / `serve(listener, options): Promise<void>`** (M8, two overloads: the one-argument form
keeps M4's `void`, so fire-and-forget calls need no `void` under `no-floating-promises`). Accepting starts at once, as
before, and the synchronous throws stay synchronous. Without `options.registry` the promise is resolved at once and
never rejects. `registry` publishes
the listener in the service registry (§4.6): `true` = every interface registered at `serve()` time except
`org.varlink.service` and `INTERNAL_ERROR_INTERFACE` (shared by every varlink-js server, never published); a list of
names (each registered and not one of those two, no duplicates, else `TypeError`, synchronously); or `{interfaces =
true, directory?, scope?: "system" | "user"}`. It needs `listener.bindRegistry(interfaces, {directory, scope})` →
`{entries, unbind()}` (`ServeListener`, types in rpc): without it `OperationNotSupportedError`, synchronously, the
listener untouched. With `registry` the promise resolves once every entry exists and rejects if binding failed:
`bindRegistry` rolled its entries back, and the listener stops being served and is closed (all or nothing;
connections accepted meanwhile are served on). **Callers using `registry` must await or handle the promise** (an
unhandled rejection ends a Node process). Entries are removed in `shutdown()` *before* the listeners close (no entry
ever points at a closed socket we own; a pending binding is waited for first) and when the listener's accept loop
ends by itself; exit-on-idle shutdowns do the same. Unbind failures go to `onError` as `"registry-failed"` and the
shutdown completes.

Node (`bindRegistry(socketPath, interfaces, options)` in `src/node/registry.ts`, also exported): a `NodeListener` has
a `bindRegistry` method only for unix path sockets (also `{fd}` ones whose `address` option names a unix path, e.g.
from `/proc` under socket activation); `unix:@`, tcp and nameless fds have none. Merged listeners delegate to their
first member that has one; one-shot (connected-fd, stdio) listeners have none. Per entry `<dir>/<iface>` (`dir` =
`directory`, else `registryDirectory(scope ?? "system")`; names checked with `isInterfaceName` before any filesystem
access, so no path traversal): `mkdir -p` the directory, the directories it created `chmod`ed to 0755 (a restrictive
umask must not hide the registry from readers; each is `lstat`ed first and skipped unless it is a directory, not a
symlink, owned by `process.getuid()` where that exists); target = the absolute socket path; absent → `symlink` (an `EEXIST`
race is re-evaluated once); a symlink whose `readlink` equals the target, or that resolves to the same file (same
dev + inode; e.g. a relative link) → adopted (not rolled back; removed on unbind only if spelled exactly as the target);
stale (dangling symlink, or a socket /
symlink to one that refuses 3 connects ~20 ms apart with `ECONNREFUSED`/`ENOENT`) → replaced atomically (`symlink` to
`<dir>/.<iface>.<random>.tmp`, `rename` over the entry, then `readlink` again: if another binder replaced it right
after us, that is retried as above instead of counted as ours); anything else (a live socket of another service, a
regular file, a directory) → an `Error` with `code: "EEXIST"` naming the entry, and the entries this call created are
removed. `unbind()` (idempotent) unlinks each entry only while it is still a symlink whose `readlink` is exactly
our target (ENOENT ignored; no `realpath` matching on removal), so foreign entries are left alone, and so is an
adopted entry spelled differently (it may be another binder's spelling of the same socket); the check and the `unlink` are two steps (no atomic compare-and-unlink),
so an entry another binder puts in place between them is removed. On macOS/BSD a live socket with a full backlog
refuses connects like a stale one (Linux gives `EAGAIN`, counted as live), so a busy service's entry may be replaced
there, as with `listen()`. The `user.varlink` xattr is M11 (native addon, best effort: `listen(…, {native})` sets
"entrypoint" on the socket path and "listen" on the socket, as sd-varlink does; registry entries are symlinks and
get none; §4.15).

The binding of a `listen({fd})` listener (an inherited socket: socket activation, so also a merged activation
listener delegating to it) has an `unbind()` that does nothing: the socket belongs to the service manager and
outlives the service (a connect through the entry activates it again, e.g. after an exit-on-idle), so its entries
persist. A later binder adopts such an entry; one that went stale is replaced by binders and fails to connect for
readers, as any stale entry. Path listeners own their socket and remove their entries; the standalone
`bindRegistry(socketPath, …)` keeps its real `unbind()`.

### 5.5 Errors

See §6.

### 5.6 Upgrade (M9)

Implemented in M9 (details §4.10, §4.11; CLI §4.14).

Client: `conn.upgrade(method, params, {timeout, signal})` → `Promise<UpgradeResult> = {parameters, channel}`
(descriptor overload typed; typed clients and proxies have `.upgrade()`; no Pool, no simple HTTP mode). It sends
the call, waits for the confirming reply (any non-error reply confirms, per UAPI), then returns. `channel` is the §4.2
wrapper: it first yields the bytes the framer had already read past the reply's `NUL` (also those in the reply's own
chunk), then reads from the transport; writes, half-close (`end()`), `close()` and `closed` are the transport's, so
backpressure holds and nothing is buffered beyond those bytes. That satisfies UAPI ("MUST NOT consume") in effect: no
byte is lost or misinterpreted. The channel owns the transport: `conn` is finished (calls reject with
`ConnectionClosedError`, `closed` resolves) and `conn.close()` leaves the channel alone. On an error reply the promise
rejects and the connection stays a varlink connection. While pending, later calls reject with `UpgradePendingError`;
`timeout` covers the time to the confirming reply, and a timeout or abort closes the connection (nobody can tell
whether the service upgraded).

Server: a handler of a method that supports or requires upgrade, called with `upgrade: true`, gets
`ctx.upgrade(replyParams?) → Promise<ByteChannel>`: it sends the confirming reply (validated per `validateReplies`),
resolves once it was written, and the channel first yields the client's early data (the session stopped splitting
after the upgrade call, §4.5) and then the transport. A second call, a call after the call ended, or one where it is
unavailable rejects with a `TypeError` and writes nothing; afterwards the return value and later throws do not reach
the wire (a throw is `handler-threw`) and `ctx.notify()` rejects. If the handler throws a `VarlinkError` before calling
`ctx.upgrade()`, the error is sent and the session resumes reading varlink calls. If it returns normally without
calling `ctx.upgrade()`, the return value goes out as the confirming reply, nobody owns the upgraded stream, and the
server closes the connection and reports `upgrade-unclaimed`. An upgraded connection is no varlink session any more
but counts as open (exit-on-idle, `connections`) until its channel closes; a graceful shutdown neither waits for it nor
closes it (it aborts the handler's signal if the handler still runs), `graceful: false` destroys it.

Q4 (sd-varlink's behaviour, §9): an `upgrade: true` call to a method without upgrade support runs as a plain call;
`ctx.upgrade()` is then unavailable. sd-varlink lets any callback upgrade once the client set the flag; we do not
(deliberate: the typed API stays honest).

### 5.7 Codegen

`varlink-js codegen io.systemd.Hostname.varlink -o src/gen/` (also a programmatic `generate()` API).
One `.ts` file per interface:

- `type` structs and error parameters → `type` aliases, not `interface` (TS interfaces are not assignable to
  index signatures such as `JsonValue` or `VarlinkError<P extends Record<string, unknown>>`); fields `?T` →
  `field?: T | null`; named enums → string literal unions plus
  `const …_Values = [...] as const` (inline enums: the union only); `[]T` → `T[]`; `[string]T` →
  `{ [key: string]: T }`; `[string]()` → `{ [key: string]: { [key: string]: never } }` (string set); `()` →
  `{ [key: string]: never }`; `object` → `{ [key: string]: unknown }`;
  `any` → `JsonValue` (non-null; includes `bigint`, §4.3); `int` → `number` or `bigint` per
  `--ints number|bigint` (must match the runtime `ints` option; the generated descriptor records it and the
  client/server checks the match at bind time);
  anonymous inline structs/enums → inline types. (M6: index signatures instead of `Record<…>`, because generated
  code must not name globals a varlink type may shadow, and no `Method_Input_field` names: §4.13.)
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

The repo generates `org.varlink.service` and `INTERNAL_ERROR_INTERFACE` from `interfaces/*.varlink` into
`src/interfaces/` (M6 deviation: by `npm run gen:interfaces`, committed, and checked up to date by a test, not
regenerated during `npm run build`); `org.varlink.certification` (M5) and `org.varlink.resolver` (M8) are not
generated in M6. Details in §4.13.

### 5.8 Socket activation and exec

M8 phase A: `src/node/spawn-channel.ts`, `spawn.ts`, `activation.ts`, plus `exitOnIdle`/`closed` in
`src/rpc/server.ts`. Phase B: `src/node/registry.ts` (registry and resolver, §4.6) and `serve(listener, {registry})`
(§5.4). All exported from `varlink-js/node` except where noted.

- **`fromNodeStreams(readable, writable, {onClose})`**: a ByteChannel over a separate Readable + Writable (a child's
  stdout/stdin, `process.stdin`/`stdout`) with the `fromNodeSocket` contract (§4.11): paused, read on demand; `null`
  after the readable's end/close or a local `close()`; a readable error rejects one read; `write()` resolves on the
  callback, rejects with `ConnectionClosedError` once the writable closed/ended; `end()` ends the writable only;
  `close()` destroys both (idempotent); `closed` once both closed and `onClose` (called once, on `close()` or when
  both streams closed) settled; error listeners on both.
- **Spawning** (`connectExec(command, opts)`, `connectBridge(argv, opts)`, and `connect()` dispatching `exec:`,
  `ssh-unix:`/`ssh:`, `ssh-exec:` with the process options in `ConnectOptions.spawn`). Process options: `env`
  (default `process.env`), `cwd`, `stderr: "inherit" | "ignore"`, `killTimeout` (2000 ms; 0 = SIGKILL at once),
  `ssh`. Every child's environment drops `LISTEN_PID`, `LISTEN_PIDFDID`, `LISTEN_FDS`, `LISTEN_FDNAMES`,
  `SYSTEMD_VARLINK_LISTEN`, `VARLINK_ADDRESS` and `VARLINK_JS_ACTIVATION` (an inherited `LISTEN_PIDFDID` from our own
  activation would make a systemd child ignore its fds) before the kind's variables are added. Every child also gets
  `/dev/null` on each activation fd number we inherited (below) that its stdio does not set: one `/dev/null` opened
  per spawn, passed in the `stdio` array (libuv `dup2`s it onto those slots), closed after the `spawn` event or the
  failure. Lifetime: the channel's `close()` destroys the transport, sends SIGTERM to a still-running child and SIGKILL
  after `killTimeout` (unref'd timer); `closed` resolves once the transport closed **and** the child exited (no
  zombies), then cleanup ran. A Connection closes its channel on EOF too, so a child that shuts its side down while it
  still runs is SIGTERMed then (sd-varlink kills its exec child too); a child that already exited is not signalled
  (only `close()` signals, and only a running child). Spawn errors reject the connect; the connect phase (spawning,
  the listening-mode connect) is bounded by `timeout`/`signal` as in `connect()`, the child killed (and the
  listening-mode directory removed) on either, also when they fire after the spawn started. `end()` half-closes only.
- **`exec:/path`** (sd-varlink `connect_exec`): `command` absolute and normalized (`TypeError`), `access(X_OK)`
  first (`ENOENT`/`EACCES` reject as they are). Spawned as `/bin/sh -c 'LISTEN_PID=$$; export LISTEN_PID; exec "$0"
  "$@"' command argv[1…]` (Node can't set env after fork), so the child's argv[0] is always `command`; `LISTEN_FDS=1`,
  `LISTEN_FDNAMES=varlink`; stdin `/dev/null`, stdout on **our fd 2** (never our stdout: we may be stdio-served
  ourselves). fd 3 per `socket`: `"connected"` (default, what sd-varlink/varlinkctl pass and systemd services with
  `sd_varlink_invocation(ALLOW_ACCEPT)` expect): stdio `"pipe"`, which libuv creates as an AF_UNIX socketpair; the
  parent end `child.stdio[3]` is a `net.Socket` created with `allowHalfOpen: false`, so we set it to `true`
  (verified: then the child's FIN does not end our write side); the child also gets
  `VARLINK_JS_ACTIVATION=connected:$$`, set and exported by the same shell script as `LISTEN_PID` (`/bin/sh -c
  'LISTEN_PID=$$; VARLINK_JS_ACTIVATION=connected:$$; export …; exec …'`), so it names the child's pid (see
  `listenFromEnv` below) and a varlink-js child's default `listenFromEnv()` serves it on every system.
  `"listening"` (libvarlink/python `--activate`): a
  `mkdtemp(os.tmpdir()/varlink-exec-)` 0700 dir, a `net.Server` bound at `<dir>/socket.tmp` and renamed to
  `<dir>/socket` (so closing our copy, which makes libuv unlink the bound name, leaves the path), its `_handle.fd`
  (else `OperationNotSupportedError`) as fd 3, `VARLINK_ADDRESS=unix:<dir>/socket`; our server is closed right after
  the spawn (so only the child accepts) and then we connect; the dir is removed when the channel closed (and on every
  failure path). The child's fd 3 shares our open file description, on which libuv set `O_NONBLOCK`: a child doing a
  blocking `accept()` must handle `EAGAIN` (documented on `ExecProcessOptions.socket`).
- **Bridge** (`connectBridge(argv)`, libvarlink/python `--bridge`): `argv[0]` spawned with the rest (no shell),
  varlink over its stdin/stdout via `fromNodeStreams`; empty argv `TypeError`. No activation variables are added; to
  have a varlink-js/systemd child serve on its stdio, pass `["env", "SYSTEMD_VARLINK_LISTEN=-", …]` (our env
  stripping removes it from `env`).
- **ssh** (§4.6): binary `opts.ssh ?? $SYSTEMD_SSH ?? "ssh"`. `ssh-unix:host:/path` → `[ssh, "-W", path, host]`
  (path absolute + normalized), `ssh-exec:host:cmdline` → `[ssh, "-e", "none", "-T", host, "env",
  "SYSTEMD_VARLINK_LISTEN=-", ...words]`, both over the child's stdin/stdout.
- **`listenFromEnv({name = "varlink", unsetEnvironment = true, accept = "auto"})`** (sd_listen_fds_with_names +
  sd_varlink_server_listen_name): `null` unless `LISTEN_PID` equals `process.pid` and `LISTEN_FDS` is set;
  `LISTEN_FDS` must be a decimal 1…1024 and `LISTEN_FDNAMES` (split on `:`, empty names kept) must have that many
  names (else `TypeError` naming the variable). The variables (and `VARLINK_JS_ACTIVATION`) are unset in every
  outcome (like `sd_listen_fds(1)`), before the options are validated, so also when those throw.
  fds 3… named `name` are used; with no `LISTEN_FDNAMES` a single fd is used. Per fd, `accept: "auto"` on Linux
  reads `/proc/self/fd/N` (`socket:[ino]`) and looks the inode up in `/proc/self/net/unix` (Flags `__SO_ACCEPTCON`
  = listening; the Path column, the name at bind time, gives the address, `@…` → `unix:@…`; best effort: an
  absolute path is used only if a socket still exists there or we cannot look (`EACCES`), so a renamed, removed or
  relative bind path gives `fd:<n>` instead of a dangling address) and `tcp`/`tcp6` (st
  `0A`). Those tables list only our network namespace: under `PrivateNetwork=yes` the sockets systemd made (an
  `Accept=yes` connection included) are in the host's, so an inode missing there is looked up in
  `/proc/1/net/{unix,tcp,tcp6}` (pid 1's namespace, where the service manager made it; read lazily, once per call).
  Where `/proc` still says nothing (not Linux, `/proc` unreadable, an inode unknown in both, e.g. `hidepid` or a
  container whose pid 1 is not the socket's owner: pass `accept: "connected"` for `Accept=yes` there) the fd is
  connected if `VARLINK_JS_ACTIVATION` is exactly `connected:<LISTEN_PID>`, else listening. That variable is a
  varlink-js-private hint that our connected-mode `exec:` sets (macOS has no `/proc`, and without the native addon
  nothing else tells a connected socket from a listening one); it is honoured only in `"auto"` mode, only where
  `/proc` is silent and only with our pid (a stale copy inherited from an ancestor names another pid), and any
  other value means nothing. A listening fd → `listen({fd}, {address})` (the new
  `ListenOptions.address`, `{fd}` only, parsed and canonicalized; closing never unlinks); a connected one → a
  one-shot listener over `new net.Socket({fd, allowHalfOpen: true})` (`fd:<n>` or the `/proc` address) that yields
  that connection and ends (`close()` before it was taken closes it). Several fds → one merged listener.
  Close-on-exec: `sd_listen_fds` sets `FD_CLOEXEC` on the passed fds; libuv's `uv_pipe_open`/`uv_tcp_open` do not and
  Node has no `fcntl`, so children would inherit fds 3 … 3+n−1, including those for other names. Mitigation until the
  M11 native addon can set `FD_CLOEXEC`: `listenFromEnv` records every fd number of `LISTEN_FDS` (selected or not) in
  a module-level set (`src/node/activation-fds.ts`, internal `inheritedActivationFds()`), and our spawners put
  `/dev/null` on those numbers in every child (above). A user's own `child_process.spawn` is not covered: it must
  pass `/dev/null` for those fd numbers itself (documented on `listenFromEnv`).
- **`mergeListeners(listeners)`**: yields from all until all ended (a source's iteration error reaches `next()`
  once), `close()` closes all (`allSettled`: a failing source does not keep the others or the queued channels from
  being closed; then it rejects with the first failure), `address` is the first one's, one iteration at a time (again
  after `return()`; the sources' `return()` failures are ignored, never unhandled rejections).
- **`listenStdio()`**: a one-shot listener over `fromNodeStreams(process.stdin, process.stdout)`, address `stdio:`
  (not a dialable varlink address); the streams are touched only when the channel is taken. Nothing else may write
  to stdout meanwhile. Node never closes fds 0/1 (destroying `process.stdout` leaves the fd open), so the channel's
  `end()`/`close()` also call `process.stdout.end()` (never throwing): on a socket stdout (libuv's `"pipe"` stdio,
  ssh) that sends FIN, after `close()` only if no write is still pending (`close()` destroys the stream, and a
  destroyed stream skips the `_final` that shuts the socket down once drained); a pipe or terminal stdout cannot be
  closed. **A stdio-served process must exit when that
  connection ends** (`exitOnIdle` plus `await server.closed; process.exit()`), which is what sd-varlink gets by
  `dup`ing 0/1 away (we cannot without the native addon).
- **`listenAuto({…, mode})`** (sd_varlink_server_listen_auto, sd-varlink.c:3873): the `listenFromEnv()` fds plus,
  if `SYSTEMD_VARLINK_LISTEN` is set, `-` → `listenStdio()`, anything else → `listen(value, {mode})`; merged, `null`
  if nothing. `SYSTEMD_VARLINK_LISTEN` is not unset (sd parity).
- **Server** (§5.4): `exitOnIdle` (ms, finite ≥ 0, off by default): once serving started (first `serve()` or
  `handle()`), whenever there is no open connection a timer runs; a connection cancels it; on expiry `shutdown()`
  (graceful defaults). It starts at the first `serve()` (spurious activation, a client that gave up). `0` = when the
  last connection closed (sd-varlink `exit_on_idle`, sd-varlink.c:3979). The expiry is confirmed one timer turn
  later, so a connection already queued on a listener (in the kernel backlog when the service starts) is accepted
  first instead of losing the race against a 0 ms timer. No timers once shut down. `Server.closed` resolves when a
  shutdown by any trigger completed (never rejects): `server.serve((await listenAuto()) ?? …); await server.closed;
  process.exit(0)`.
- Tests (macOS; Linux-only parts skip on darwin, the VM runs them): `test/unit/node/spawn-channel.test.ts`
  (PassThrough pairs and `cat`), `spawn.test.ts` (an `activation-child.ts` fixture behind an executable `#!/bin/sh`
  wrapper: exec connected/listening, env stripping, half-close, SIGTERM → SIGKILL, bridge, ssh via a fake ssh script
  that logs its argv, the word splitter table), `activation.test.ts` (fds and `LISTEN_*` set by
  `/bin/sh -c 'LISTEN_PID=$$ … exec'`; the `VARLINK_JS_ACTIVATION` hint; `/proc` detection and the `/dev/null` cover
  of activation fds in grandchildren Linux-only), `test/unit/rpc/exit-on-idle.test.ts`. The exec tests use the
  child's default `accept: "auto"` on every platform. Phase
  B: `test/unit/node/registry.test.ts` (filesystem: list, bind, adopt, stale, conflict + rollback, foreign entries,
  serve end to end), `registry-serve.test.ts` (serve semantics with fake listeners), `resolver.test.ts` (a JS
  `org.varlink.resolver`), and the Linux interop suite `test/interop/vm/` (systemd-socket-activate, varlinkctl
  `exec:`/`info`, systemd-pcrextend as root, registry via varlinkctl, real ssh behind `VARLINK_SSH_*`; each file skips
  without its tools, see its README).

**M8 deviations** from the earlier text of this section: `exec:` passes a *connected* socketpair by default (as
sd-varlink does and systemd services expect), the listening socket + `VARLINK_ADDRESS` is the `socket: "listening"`
option; the single-unnamed-fd rule is kept (sd-varlink names such an fd "unknown" and would not pick it);
`LISTEN_PIDFDID` is ignored (Node cannot read the inode id of its own pidfd); a connected activation fd is detected
from `/proc` on Linux, elsewhere it needs `accept: "connected"` (no `getsockopt(SO_ACCEPTCONN)` without the native
addon, and probing with `listen()` is not an option: a failed `listen({fd})` closes the fd), except that our own
connected-mode `exec:` passes the `VARLINK_JS_ACTIVATION=connected:<pid>` hint; activation fds are not close-on-exec (our
spawners cover them with `/dev/null`). Phase B: `serve(listener)` keeps M4's `void`; only the new overload
`serve(listener, options)` returns a `Promise<void>` (resolved at once without `registry`),
`ServerErrorReason` gains `"registry-failed"`, entries bound through a `listen({fd})` listener persist after unbind
(the socket is the service manager's), and `bindRegistry` exists only on listeners that
can be published (instead of throwing `OperationNotSupportedError` from the method), so `serve()` can refuse them
synchronously with the listener untouched; one-shot (connected-fd) listeners are never published (the socket
belongs to whoever accepted it).

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
  - M9 upgrade interop (VM only, not CI, not `npm test`): `VARLINKCTL=/path/to/varlinkctl [NODE=node]
    [SOCKET_ACTIVATE=…] test/interop/vm/upgrade.sh` (helpers `upgrade-server.ts`, `upgrade-client.ts`), one PASS/FAIL
    line per case, exit 1 on any failure: (a) `varlinkctl call --upgrade` → a varlink-js server's
    `org.example.Upgrade.Cat` (requires upgrade, cat-like), 1 MiB; (b) `systemd-socket-activate -l SOCK varlinkctl
    serve org.example.Upgrade.Cat cat` (serve needs socket activation) ← `varlink-js call --upgrade` and ←
    `conn.upgrade()`; (c) Q4: a plain method with `upgrade: true` then a plain call, against both sides (two plain
    replies expected; the line prints what came back). Run against varlinkctl 262.2 in the UTM VM, 2026-11-15
    (systemd built from source, commit 63511d72): all 5 cases PASS (a, b1, b2, c1, c2); c2 confirmed Q4 on the wire
    (`GetInfo` with `upgrade: true`, then a plain call: two plain replies from sd-varlink). M9 review 2 added (d)
    `yes | … call --upgrade` into a service that reads one line, writes it back and goes (`varlinkctl serve
    org.example.Upgrade.Head -- head -n1`: the `--` is needed, varlinkctl otherwise parses the command's options,
    "unrecognized option '-n'"; and the varlink-js fixture's `Head`), both CLIs against both servers: d2 and d4
    (varlink-js) PASS only with exit 0 and `y` on stdout; d1 and d3 (varlinkctl) and `d parity` (both CLIs' exit
    codes) are INFO lines, since what they show is systemd's behaviour; (e) the service ends first (`varlinkctl serve
    … echo BYE`) while stdin stays open 3 s: stdout's reader (a FIFO) must see EOF before stdin closes; e2 (varlink-js)
    is PASS/FAIL, e1 (varlinkctl) INFO. The first VM run of (d) found a bug of ours: varlink-js exited 0 with EMPTY
    stdout against both servers, 3 of 3 (the failing writes made Node destroy the socket before the answer was read;
    fixed in §4.11). Final run on the M9 head (Node 24.22.3, varlinkctl 262.2), output in
    `test/interop/vm/results-systemd-262.log`: a, b1, b2, c1, c2, d2, d4, e2 PASS. INFO, i.e. systemd's own
    behaviour: varlinkctl died of SIGPIPE (exit 141) in d1 and d3 (it printed `y` in d3; in d1 against `serve --
    head -n1` it printed `y` in only 1 of 3 earlier runs); e1: varlinkctl gives the FIFO reader EOF only at exit,
    because it forwards a reopened copy of stdout (`dup_stdio_fd`), so socket-forward's close at the peer's EOF
    leaves fd 1 open.
  - M11 fd passing interop (VM only, not CI, not `npm test`): `npm --prefix native run build`, then
    `VARLINKCTL=/path/to/varlinkctl [NODE=node] [SYSTEM_VARLINKCTL=/usr/bin/varlinkctl] test/interop/vm/fds.sh`
    (helper `fds-server.ts`, a varlink-js server with the addon): (a) `varlinkctl call --push-fd=3 … 3<file` → the
    server reads the file through the fd; (a2) `--push-fd=/path`; (b) `varlinkctl --exec call … OpenPipes -- reader`
    → the command reads the reply on stdin and two pipes as fds 3 and 4, with `LISTEN_FDS=2` and `LISTEN_PID` its
    pid; (c) `varlink-js call --push-fd=3`; (c2) `varlink-js call --exec`, its output compared with (b)'s; (e) a plain
    `varlinkctl call` (fd input off) to a method that replies with fds: the reply must arrive (sd-varlink's client
    never turns SO_PASSRIGHTS off unless it enabled input, so our sendmsg succeeds and the kernel drops the fds); (f1)
    `varlinkctl call --push-fd=3` to a varlink-js server without fd input (default policy): the call runs, the fd is
    dropped; (f2) INFO: the same against a strict server (`fdPassingInputStrict`), where varlinkctl's sendmsg is refused
    on ≥ 6.16; (d) INFO: which systemd services of the machine declare fd-carrying fields (introspection only). First
    run on the M11 head (Linux 6.8): a, a2, b, c, c2 PASS. Fix round 1 (Linux 7.0.0-43): a, a2, b, c, c2, e PASS, and
    on Linux 6.8 (the re-test after that round) all PASS. Fix round 2, UTM VM, 2026-11-16 (Ubuntu 24.04 arm64, Linux 7.0.0-43, which has
    SO_PASSRIGHTS and SO_PEERPIDFD; Node 24.22.3, varlinkctl 262.2, system systemd 255.4), output in
    `test/interop/vm/results-fds-systemd-262-k7.0.log` (kernel in its header; `results-fds-systemd-262.log` is the
    other kernel's run): a, a2, b, c, c2, e, f1 PASS; f2: varlinkctl exits 1 with `Failed to issue
    org.example.Fds.Count() call: Operation not permitted`; c2 parity: both CLIs gave the command the same input; d: of
    3 sockets (2 answered as a normal user: ManagedOOM, UserDatabase) none mentions fds, so no systemd 255 service of
    that VM passes fds and the "systemd service" side of the interop is varlinkctl's client.
- **Runtimes**: CI matrix Node 22 / 24 / 26; Bun latest and Deno 2 run the unit tests plus the unix/tcp
  integration subset (M10). The `native` CI job (M11) builds the addon and runs `npm --prefix native test` on
  ubuntu-24.04 and ubuntu-latest, Node 24.

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
  idl → core+idl; websocket → core+rpc+self; http → core+rpc+interfaces+self),
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
| Q4 | `upgrade` flag on a method that doesn't support it: `InvalidParameter{parameter:"upgrade"}` vs `ExpectedUpgrade` vs treat as a plain call. UAPI is silent. | **Resolved in M9: a plain call, as sd-varlink** (systemd 6bd4689f, 263~devel): `varlink_idl_validate_method_call()` (sd-varlink-idl.c:2126-2142) checks only `REQUIRES_MORE` without `more` and `REQUIRES_UPGRADE` without `upgrade`; `varlink_dispatch_method()` sets `PROCESSING_METHOD_UPGRADE` (sd-varlink.c:1339-1342) and calls the callback as usual (1412-1419); a plain `sd_varlink_reply()` is allowed there (`VARLINK_STATE_WANTS_REPLY`, varlink-internal.h:79-83) and leads back to `IDLE_SERVER` (sd-varlink.c:2587, 2647-2657, 1460-1466), errors go out as usual; the client takes any non-error reply as acceptance (965-980); only `sd_varlink_respond_and_upgrade()` checks the call flag (2704-2708), not the IDL. Not copied: no `ExpectedMore` for an upgrade call to a `[Requires 'more' flag]` method (sent only in `VARLINK_PROCESSING_METHOD`, 1386; we send it), and any callback may upgrade (our `ctx.upgrade()` needs the method's upgrade support). Confirmed on the wire by the M9 interop run (§7.4, case c2: `GetInfo` with `upgrade: true`, then a plain call, got two plain replies from sd-varlink of systemd 262.2). |
| Q5 | Native addon for fd passing / peer creds (M11): own small N-API addon vs depending on `usocket`/`peercred`. | **Resolved in M11: our own addon** (`native/`, §4.15), Node-API only (`NAPI_VERSION 8`, ABI-stable across Node majors) plus libuv's `uv_poll_t` through `napi_get_uv_event_loop`, built without node-gyp, Linux (macOS for development), no prebuilds yet (a follow-up). Evidence: `usocket` 1.1.0 (npm, modified 2026-07-20) is built on `nan` (not ABI-stable: rebuilt per Node major) with runtime deps bindings, debug, nan, node-gyp; `peercred` 1.1.2 (nan + bindings + errno) was last modified 2022-06-23; `unix-socket-credentials` 0.1.3 uses ffi/ref (2022); none does pidfd, xattr or the read/write semantics we need (fds bound to messages, data before errors, writes failing without losing input). About 1200 lines of C (including comments) rather than 200. |
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
| **M7** | CLI `varlink-js`: `info`, `list-interfaces`, `list-methods`, `introspect`, `call` (`--more`, `-E`, `--collect`, `--oneway`, `--timeout`, `--graceful`, `-j`/`--json`, `-q`), `format`, `validate-idl`, `codegen`, `bridge` (stdio ↔ address), `certify` | `src/cli/` | M5, M6 | CLI e2e tests; output matches varlinkctl conventions (JSON-SEQ for `--more`). **Implemented** (§4.14) | M |
| **M8** | Addresses II and activation: `exec:`, `ssh-unix:`, `ssh-exec:`, bridge argv, `listenAuto()`/`listenFromEnv()`, stdio serving, exit-on-idle, registry lookup and server-side registry binding (`server.serve(listener, {registry: true})` symlinks the entrypoint into `/run/varlink/registry/<iface>` for every registered interface except `org.varlink.service`, or `registry: ["…"]` for an explicit list; removed on shutdown), resolver client | `src/node/spawn*`, `src/node/activation*`, `src/node/registry*` | M4 | Tests on macOS + VM (`systemd-socket-activate`, ssh to localhost) | M |
| **M9** | `upgrade`: client + server + CLI `--upgrade`; resolve Q4 | touches `src/core/protocol/`, `src/rpc/`, `src/cli/` | M7, M8 | Interop with `varlinkctl call --upgrade` / `serve` in VM (systemd ≥ 261). **Implemented** (§5.6, §4.14; Q4 resolved; `test/interop/vm/upgrade.sh` run against varlinkctl 262.2 in the UTM VM, 2026-11-15: all 5 cases PASS, §7.4) | S |
| **M10** | WebSocket + HTTP client transports; Bun and Deno CI; browser smoke test (Playwright optional) | `src/websocket/`, `src/http/`, `.github/workflows/runtimes.yml` | M4 | Tests against a local WebSocket bridge fixture; Bun/Deno green | M |
| **M11** | `varlink-js-native` (separate package in `native/`): fds (incl. client `fds`/`acceptFds` and CLI `--push-fd`), peer creds, `user.varlink` xattr tagging (`listen`/`server`/`entrypoint`/`client`, best effort), per-UID limits; resolve Q5 | `native/` (+ small touches to `src/rpc/`, `src/cli/` after M9) | M4 (addon), M9 (rpc/CLI integration) | fd passing to/from a systemd service in the VM. **Implemented** (§4.15, §5.1, §5.4, §4.14 `--push-fd=`/`--exec`; Q5 resolved; `test/interop/vm/fds.sh` against varlinkctl 262.2 in the UTM VM, 2026-11-15: a, a2, b, c, c2 PASS on Linux 6.8, and after fix round 1 a, a2, b, c, c2, e PASS on Linux 7.0, §7.4; no systemd 255 service there passes fds, so "to/from a systemd service" is varlinkctl's client side only. Fix round 1 (review-1 + CI on kernels ≥ 6.16): bounded reads, SO_PASSRIGHTS semantics per kernel, per-environment buffers and cleanup hook, opt-in per-UID limit, MSG_CTRUNC tolerated, fd views, §4.15. Fix round 2 (review-2): sd-varlink's default SO_PASSRIGHTS policy (never touched) with strict mode opt-in (`fdPassingInputStrict`), tracked fds closed at environment teardown, a widening peek window, a real worker stress test; fds.sh a, a2, b, c, c2, e, f1 PASS on Linux 7.0, `results-fds-systemd-262-k7.0.log`) | L |
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
