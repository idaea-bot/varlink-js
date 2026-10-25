# IDL test corpus: sources and licences

Every `.varlink` file below is vendored unchanged (except the UAPI examples, which are cut out of the
spec's Markdown code blocks) for the IDL golden tests in `test/unit/idl/` (DESIGN.md §7.1, M1). The
corpus is test data only: `test/` is not in the npm package (`files` in package.json).

| Directory         | Upstream                                                                                         | Commit / version                           | Licence                                         | Files                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libvarlink/`     | [varlink/libvarlink](https://github.com/varlink/libvarlink)                                      | `2ad4ec7ca62e148dbf0ad98646ec68c2e7e8a88e` | Apache-2.0 (`LICENSES/Apache-2.0.txt`)          | `lib/org.varlink.service.varlink`                                                                                                                             |
| `python-varlink/` | [varlink/python](https://github.com/varlink/python)                                              | `35566780eb3d455524c56f74fb3068a46e06faf5` | Apache-2.0 (`LICENSES/Apache-2.0.txt`)          | `varlink/org.varlink.service.varlink`, `varlink/tests/*.varlink`                                                                                              |
| `rust-varlink/`   | [varlink/rust](https://github.com/varlink/rust)                                                  | `2041093de7d883b6354087aa39fc4ec9d70a6944` | MIT OR Apache-2.0 (`LICENSES/MIT-rust-varlink.txt`) | every `*.varlink` in the repo; the upstream path is the file name with `__` for `/` and `/src/` dropped (e.g. `examples/ping/src/org.example.ping.varlink`) |
| `uapi/`           | [uapi-group/specifications](https://github.com/uapi-group/specifications) `specs/varlink.md`     | `5f0f51489defcf43999ed23cd03b6ebc69f940e3` | CC-BY-4.0 (UAPI Group)                          | `org.example.ftl.varlink` (lines 109–161, "Example"), `org.varlink.service.varlink` (lines 816–853)                                                       |
| `systemd-255/`    | systemd 255 (`255.4-1ubuntu8.18`, Ubuntu 24.04 arm64, the `ossvm` UTM VM)                        | dumped 2026-10-25                          | interface descriptions of systemd (LGPL-2.1-or-later) | `varlinkctl introspect <socket> <interface>` for every interface the running services expose (list below)                                             |

systemd-255 dump: `org.varlink.service`, `io.systemd`, `io.systemd.Resolve.Monitor`
(`/run/systemd/resolve/io.systemd.Resolve.Monitor`), `io.systemd.Resolve`, `io.systemd.sysext`,
`io.systemd.Journal`, `io.systemd.ManagedOOM` and `io.systemd.UserDatabase`
(`/run/systemd/io.systemd.ManagedOOM`), `io.systemd.oom` (`/run/systemd/oom/io.systemd.ManagedOOM`, after
`apt install systemd-oomd`), `io.systemd.PCRExtend` (`exec:/usr/lib/systemd/systemd-pcrextend`). Also
installed for the dump, without new interfaces: `systemd-container` (machined), `systemd-userdbd`,
`systemd-homed`. systemd 255 prints no comments, so doc comments and the systemd annotations
(`[Experimental]`, `[Supports 'more' flag]`, …) are covered by the hand-written cases in
`test/unit/idl/` instead.
