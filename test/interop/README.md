# Interop tests (DESIGN.md §7.4)

| File                  | Runs                                     | Needs                                                                 |
| --------------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| `certification.test.ts` | always (`npm test`)                    | nothing: JS client ↔ JS server over pair/unix/tcp, the server's checks, the CLIs as child processes |
| `python.test.ts`      | `VARLINK_PYTHON=<python>`                | a python with `varlink` (`pip install varlink==31.0.0`)               |
| `rust.test.ts`        | `VARLINK_RUST_CERT=<binary>`             | `varlink-certification` from github.com/varlink/rust (`cargo build --release --locked -p varlink-certification`) |
| `varlinkctl.test.ts`  | `VARLINK_VARLINKCTL=1`                   | Linux with systemd ≥ 255 (`varlinkctl`); the Multiplexer cases also need `systemd-userdbd` |

Without their variable the optional suites skip with a reason. `VARLINK_REQUIRE_INTEROP=1` (set by the
`Interop` workflow) turns a skip for a missing python, rust binary or `varlinkctl` into a failure; a missing
`/run/systemd/userdb/io.systemd.Multiplexer` skips unless `VARLINK_REQUIRE_MULTIPLEXER=1` (set by the workflow's
varlinkctl job, which installs and starts `systemd-userdbd.socket`).

```sh
VARLINK_PYTHON=python3 VARLINK_RUST_CERT=…/target/release/varlink-certification npm run test:interop
```

python and rust run four cases each: {our client → their server, their client → our `server.ts` CLI} ×
{unix socket in a `vj-` temp dir, tcp on 127.0.0.1}. Readiness: python's server prints `Listening on …` (for
`tcp:127.0.0.1:0` the bound tuple, whose port is parsed, so no port is pre-picked); the rust server prints
nothing, so a free port is picked first (a small race, fine for tests) and its address is polled with connects
until it accepts, with a deadline. python's client passes if it exits 0 and its last line is
`Certification passed`; rust's client returns an error (exit 1) on any failed call, so exit 0 plus `all_ok: true`
in its output is the pass. Children are killed in `after`; their output goes to the test diagnostics on failure.

`varlinkctl.test.ts` serves [`org.example.interop`](org.example.interop.varlink) (only constructs systemd 255
accepts) in-process on a unix socket and runs `varlinkctl info`, `list-interfaces`, `introspect` (compared with
`validate-idl`'s re-print of the registered text), `call` (plain, `--more`, `--oneway`, an error reply, an unknown
method; systemd 255 prints `org.varlink.service.MethodNotFound`, systemd 259 maps it to ENXIO "No such device or
address" and prints the parameters), then `validate-idl` on every corpus file and on our
`formatInterface(parseInterface(x))` of it (the re-prints must be equal; the three files with `[string]()` that
systemd 255 rejects, see `test/corpus/VARLINKCTL.md`, must then be rejected in both forms), `introspect` + `call
Start` against the certification server, and our client against the userdb Multiplexer (`GetUserRecord` with and
without `more`; the record count must match `varlinkctl call --more`).

The workflow runs the varlinkctl job on `ubuntu-24.04` (systemd 255) and `ubuntu-latest` (Ubuntu 26.04 since
2026-10, systemd 259).

## Results (2026-10-25)

- **GitHub Actions** (`Interop` workflow): python-varlink 31.0.0 (python 3.13) both ways over unix and tcp on
  ubuntu-latest and macos-latest; rust `varlink-certification` (varlink/rust 2041093d, `cargo build --locked`,
  about 30 s) both ways over unix and tcp; varlinkctl on ubuntu-24.04 (systemd 255.4-1ubuntu8.18, userdb
  Multiplexer 39 records) and ubuntu-latest (Ubuntu 26.04, systemd 259.9-0ubuntu0.1, 37 records). systemd 259
  still rejects `[string]()` in `validate-idl`, and its `introspect` then prints the description verbatim.
- **UTM VM** (`ossvm`, Ubuntu 24.04 arm64, systemd 255.4-1ubuntu8.18, Node 24.22.1, python 3.12 + varlink 31.0.0,
  `systemd-userdbd` installed), run once on the first M5 commit: `certification.test.ts`, `python.test.ts` (all
  four directions) and `varlinkctl.test.ts`, 58/58 pass, Multiplexer 34 records from our client and from
  `varlinkctl call --more`. Rust was not run in the VM (no cargo there); CI covers it.
- **macOS** (dev host, Node 26, python 3.14 + varlink 31.0.0, rust binary built locally): everything except
  `varlinkctl.test.ts`.
