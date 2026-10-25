# VM interop suite (M8)

Tests against systemd's tools and real ssh. They run as part of `npm test` and skip themselves (with a reason)
unless their tools are there: Linux, `systemd-socket-activate` / `varlinkctl` on `PATH` (`exec:` needs
varlinkctl ≥ 255), root for `pcrextend.test.ts`, and the `VARLINK_SSH_*` variables for `ssh.test.ts`.

## Running in a Linux VM

```sh
git push <remote> m8-spawn        # from the host; then, in the VM:
git clone -b m8-spawn <remote> varlink-js && cd varlink-js
# Node ≥ 22.18 (e.g. https://nodejs.org tarball, or `fnm install 24`)
npm ci && npm test
sudo env "PATH=$PATH" node --test test/interop/vm/pcrextend.test.ts   # the root-only test
```

Only the suite: `node --test "test/interop/vm/*.test.ts"`.

## ssh

`ssh.test.ts` uses non-interactive ssh (keys or agent, host key already known):

| Variable | Meaning |
|---|---|
| `VARLINK_SSH_HOST` | ssh destination, e.g. `user@vm` (unset: the file skips) |
| `VARLINK_SSH_SOCKET` | remote path of a running varlink server, for `ssh-unix:` (OpenSSH ≥ 9.4 remote) |
| `VARLINK_SSH_EXEC` | remote command serving on stdio under `SYSTEMD_VARLINK_LISTEN=-`, for `ssh-exec:` |

Host → VM: `VARLINK_SSH_HOST=user@vm VARLINK_SSH_SOCKET=/run/systemd/io.systemd.Hostname
VARLINK_SSH_EXEC=/usr/lib/systemd/systemd-pcrextend npm test` (pcrextend needs root on the VM: use `root@vm`).

VM → localhost: `VARLINK_SSH_HOST=localhost VARLINK_SSH_EXEC="$(command -v node) $PWD/test/interop/vm/fixture-server.ts"
npm test` (the fixture serves one stdio connection and exits).
