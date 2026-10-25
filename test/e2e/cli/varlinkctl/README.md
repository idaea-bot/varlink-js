# varlink-js CLI vs varlinkctl (manual, Linux)

Run inside a Linux machine with systemd's `varlinkctl` and Node ≥ 22.18, from anywhere:

```sh
bash test/e2e/cli/varlinkctl/compare.sh       # info/list/introspect/call/validate-idl vs systemd services + certify server
bash test/e2e/cli/varlinkctl/compare-json.sh  # byte-compare JSON (short, pretty, JSON-SEQ) for tricky payloads
```

`compare.sh` uses `/run/systemd/io.systemd.ManagedOOM` and, if present, the userdb Multiplexer
(`apt-get install systemd-userdbd && systemctl enable --now systemd-userdbd.socket`). Results on systemd 255.4
(Ubuntu 24.04 arm64): `results-systemd-255.log`; the differences are explained in DESIGN.md §4.14.
