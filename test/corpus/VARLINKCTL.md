# Comparison with `varlinkctl validate-idl` (systemd 255)

Run by hand in the `ossvm` UTM VM (Ubuntu 24.04, systemd `255.4-1ubuntu8.18`) on 2026-10-25 for M1. Not part
of CI: GitHub's `ubuntu-latest` also has systemd 255, and M5 adds a `varlinkctl` CI job.

**Corpus.** For each of the 27 corpus files, both the original and our `formatInterface(parseInterface(x))`
output were fed to `varlinkctl validate-idl`, which re-prints the interface in systemd's own style:

- 24 files: systemd accepts both, and its re-printed output is byte-identical for the original and for ours.
- 3 files (`python-varlink/org.varlink.certification`, `rust-varlink/…org.varlink.certification`,
  `rust-varlink/…org.example.complex`): systemd 255 rejects the original and ours alike (`Bad syntax` at
  `[string]()`). The string-set type `[string]()` is in UAPI.20 ("Types"); systemd 255 does not accept an
  empty `()`.

**Negative and edge cases.** 40 small inputs (all grammar rules from `test/unit/idl/errors.test.ts` plus a
few positives). We agree with systemd 255 on 33. The 7 differences all follow UAPI.20 where systemd 255 does not:

| Input                                                   | varlink-js                                      | systemd 255                    |
| ------------------------------------------------------- | ----------------------------------------------- | ------------------------------ |
| `interface a` (one component)                           | `invalid-interface-name`                        | accepted                       |
| `a: ?any`                                               | accepted (`"?" element_type`, `any` is UAPI)    | rejected (`unresolved type`) |
| `a: ?[]?string`                                         | accepted (grammar: `"?" "[]" type`)             | `Bad syntax`                   |
| `interface a.b method A() -> ()` (one line)             | `expected-line-break` (UAPI `eol` after members) | accepted                       |
| `method A() -> () method B() -> ()` (one line)          | `expected-line-break`                           | accepted                       |
| comments inside `( … )`, after a member and at EOF (case35) | accepted (comments are `_` anywhere)            | `Bad syntax` at 7:3            |
| `type T ()` (empty struct)                              | accepted (`struct = "(" ")"`)                   | `Bad syntax`                   |
