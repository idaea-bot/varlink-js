# varlink certification server and client

The [`org.varlink.certification`](../../interfaces/org.varlink.certification.varlink) interface (a copy of
python-varlink's file, Apache-2.0) is varlink's interoperability test: a client calls `Start`, `Test01` …
`Test09`, `Test10` (with `more`), `Test11` (`oneway`) and `End`, passing each reply on as the next call's
parameters, and the server checks every call. Both sides here use the untyped API (`addInterface(idlText)`, no
codegen).

```sh
node examples/certification/server.ts --varlink=unix:/tmp/cert.sock   # or tcp:127.0.0.1:0, unix:@cert (Linux)
node examples/certification/client.ts --varlink=unix:/tmp/cert.sock
```

The server prints exactly one line, `Listening on <address>` (with the real port for `tcp:…:0`), and shuts down
gracefully on SIGINT/SIGTERM (exit 0). Its own replies are validated against the IDL (`validateReplies: "throw"`);
server errors go to stderr. The client prints each step, then `Certification passed` (exit 0), or the failure on
stderr (exit 1).

Against the reference implementations:

```sh
pip install varlink==31.0.0
python -u -m varlink.tests.test_certification --varlink=tcp:127.0.0.1:12345 &   # python server
node examples/certification/client.ts --varlink=tcp:127.0.0.1:12345
node examples/certification/server.ts --varlink=tcp:127.0.0.1:0                 # prints the port
python -m varlink.tests.test_certification --client --varlink=tcp:127.0.0.1:<port>
# rust: github.com/varlink/rust, cargo build --release -p varlink-certification
varlink-certification --varlink=unix:/tmp/rust.sock &
varlink-certification --client --varlink=unix:/tmp/cert.sock                     # exit 0 = passed
```

## Server semantics

As in python-varlink's `test_certification.py` and rust's `varlink-certification`:

- `Start` returns a random 32-hex-digit `client_id`; the next expected call is `Test01`.
- Every later call must name a known `client_id` (else `ClientIdError`), be the next method in order, be called
  the right way (`Test10` with `more`, `Test11` as `oneway`, the others with neither) and carry exactly the
  reference parameters (`Test06`/`Test07` compare the float with `Math.PI` exactly; maps and string sets compare
  regardless of key order; in `Test10`'s `MyType` the nullable fields may be absent or null).
- Any mismatch forgets the client and fails with `CertificationError {wants, got}`. Both are JSON objects (the IDL
  declares `object`; python sometimes sends strings there): `got` is the call as received (`method`,
  `parameters`, and `more`/`oneway` when set), `wants` the expected call (for a call out of order just
  `{method}` of the expected one).
- `Test10` sends `Reply number 1` … `Reply number 10`, the last one final. `Test11` cannot reply (oneway), so a
  failed `Test11` is recorded and the client's `End` fails with that CertificationError. `End` returns
  `{all_ok: true}` and forgets the client.
- State is bounded: at most 1024 clients (the oldest is forgotten on `Start`), each for at most 12 h after its
  `Start`. Expiry is checked on access (no timers).
- `Test09`'s `MyType` leaves the nullable fields `nullable` and `nullable_array_struct` out (python sends them as
  null; for a `?` field absent and null are the same).

The logic lives in [`certification.ts`](certification.ts) (`createCertificationService`,
`createCertificationServer`, `runCertificationClient`), used by the CLIs and by `test/interop/`.
