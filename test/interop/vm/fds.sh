#!/usr/bin/env bash
# fd passing interop (M11, DESIGN.md §7.4, §4.15): varlink-js with varlink-js-native ↔ systemd's varlinkctl (≥ 257 has
# --push-fd= and --exec). For the Linux VM; NOT run by CI or `npm test`. Needs `npm --prefix native run build` first.
#
#   VARLINKCTL=/path/to/varlinkctl [NODE=node] [SYSTEM_VARLINKCTL=/usr/bin/varlinkctl] test/interop/vm/fds.sh
#
# Cases (one PASS/FAIL/INFO line each; exit status 1 if any failed):
#   a   varlinkctl call --push-fd=3 … 3<file → a varlink-js server's org.example.Fds.ReadFd: the server reads the file
#       through the fd and returns its text
#   a2  varlinkctl call --push-fd=/path (varlinkctl opens it) → ReadFd
#   b   varlinkctl --exec call … OpenPipes → the command gets the reply on stdin and two pipes as fds 3 and 4
#       (LISTEN_FDS=2, LISTEN_PID = its pid) and reads them
#   c   varlink-js call --push-fd=3 → ReadFd (our CLI, VARLINK_JS_NATIVE)
#   c2  varlink-js call --exec → OpenPipes (our CLI): the same contract as b, output compared with varlinkctl's
#   e   a plain varlinkctl call (fd input off) to a method replying with fds: the reply arrives (fds dropped)
#   f1  varlinkctl --push-fd to a varlink-js server without fd input (default): the call runs, the fd is dropped
#   f2  INFO: the same against a strict server (fdPassingInputStrict): EPERM for varlinkctl on Linux >= 6.16
#   d   INFO: which systemd services of this machine (its own systemd, looked at with SYSTEM_VARLINKCTL) declare
#       methods that take or return fds (introspection grepped for fd-ish field names; nothing installed or called)
#
# To keep a record: `test/interop/vm/fds.sh 2>&1 | tee test/interop/vm/results-fds-systemd-262.log`.
set -u

VARLINKCTL=${VARLINKCTL:?set VARLINKCTL to a varlinkctl from systemd >= 257}
NODE=${NODE:-node}
SYSTEM_VARLINKCTL=${SYSTEM_VARLINKCTL:-/usr/bin/varlinkctl}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
CLI="$ROOT/src/cli/main.ts"
export VARLINK_JS_NATIVE="$ROOT/native/index.js"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/vj-fds.XXXXXX")
PIDS=()
failed=0

cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "PASS $1"; }
info() { echo "INFO $1"; }
fail() {
  echo "FAIL $1${2:+: $2}"
  failed=1
}

wait_socket() {
  for _ in $(seq 100); do
    [ -S "$1" ] && return 0
    sleep 0.1
  done
  return 1
}

echo "varlinkctl: $("$VARLINKCTL" --version | head -n1)"
echo "system varlinkctl: $("$SYSTEM_VARLINKCTL" --version 2>/dev/null | head -n1)"
echo "node: $("$NODE" --version), kernel: $(uname -r)"
printf 'hello through an fd\n' >"$WORK/file"

"$NODE" "$HERE/fds-server.ts" "unix:$WORK/js.sock" 2>"$WORK/js-server.log" &
PIDS+=($!)
if ! wait_socket "$WORK/js.sock"; then
  fail "setup" "the varlink-js fd server did not start: $(cat "$WORK/js-server.log")"
  exit 1
fi
ADDR="unix:$WORK/js.sock"

# The reader script for --exec: stdin (the reply), then fds 3 and 4, then the activation variables.
cat >"$WORK/reader.sh" <<'EOF'
#!/bin/sh
printf 'reply=%s\n' "$(cat)"
printf 'fd3=%s\n' "$(cat <&3)"
printf 'fd4=%s\n' "$(cat <&4)"
printf 'LISTEN_FDS=%s pid-ok=%s\n' "$LISTEN_FDS" "$([ "$LISTEN_PID" = "$$" ] && echo yes || echo no)"
EOF
chmod +x "$WORK/reader.sh"
EXPECTED_EXEC='reply={"count":2}
fd3=one
fd4=two
LISTEN_FDS=2 pid-ok=yes'

# (a) varlinkctl --push-fd=3 → varlink-js.
if out=$(timeout 30 "$VARLINKCTL" call --json=short --push-fd=3 "$ADDR" org.example.Fds.ReadFd '{}' 3<"$WORK/file" 2>"$WORK/err.a") &&
  [ "$out" = '{"text":"hello through an fd\n","fds":1}' ]; then
  pass "a varlinkctl call --push-fd=3 -> varlink-js server (the server read the file through the fd)"
else
  fail "a varlinkctl call --push-fd=3 -> varlink-js server" "got '${out:-}' $(head -c 300 "$WORK/err.a")"
fi

# (a2) varlinkctl --push-fd=/path.
if out=$(timeout 30 "$VARLINKCTL" call --json=short --push-fd="$WORK/file" "$ADDR" org.example.Fds.ReadFd '{}' 2>"$WORK/err.a2") &&
  [ "$out" = '{"text":"hello through an fd\n","fds":1}' ]; then
  pass "a2 varlinkctl call --push-fd=/path -> varlink-js server"
else
  fail "a2 varlinkctl call --push-fd=/path -> varlink-js server" "got '${out:-}' $(head -c 300 "$WORK/err.a2")"
fi

# (b) varlinkctl --exec ← varlink-js's reply fds.
if out=$(timeout 30 "$VARLINKCTL" --exec call "$ADDR" org.example.Fds.OpenPipes '{"texts":["one","two"]}' -- "$WORK/reader.sh" 2>"$WORK/err.b") &&
  [ "$out" = "$EXPECTED_EXEC" ]; then
  pass "b varlinkctl --exec call -> varlink-js server (reply on stdin, fds 3 and 4, LISTEN_FDS/LISTEN_PID)"
else
  fail "b varlinkctl --exec call -> varlink-js server" "got '${out:-}' $(head -c 300 "$WORK/err.b")"
fi
sd_exec_out=${out:-}

# (c) varlink-js --push-fd=3 → varlink-js.
if out=$(timeout 30 "$NODE" "$CLI" call --json=short --push-fd=3 "$ADDR" org.example.Fds.ReadFd '{}' 3<"$WORK/file" 2>"$WORK/err.c") &&
  [ "$out" = '{"text":"hello through an fd\n","fds":1}' ]; then
  pass "c varlink-js call --push-fd=3 -> varlink-js server"
else
  fail "c varlink-js call --push-fd=3 -> varlink-js server" "got '${out:-}' $(head -c 300 "$WORK/err.c")"
fi

# (c2) varlink-js --exec.
if out=$(timeout 30 "$NODE" "$CLI" call --exec "$ADDR" org.example.Fds.OpenPipes '{"texts":["one","two"]}' -- "$WORK/reader.sh" 2>"$WORK/err.c2") &&
  [ "$out" = "$EXPECTED_EXEC" ]; then
  pass "c2 varlink-js call --exec -> varlink-js server (same contract as varlinkctl's)"
else
  fail "c2 varlink-js call --exec -> varlink-js server" "got '${out:-}' $(head -c 300 "$WORK/err.c2")"
fi
if [ "${out:-}" = "$sd_exec_out" ]; then
  info "c2 parity: varlink-js --exec and varlinkctl --exec gave the command the same input"
else
  info "c2 parity: outputs differ (varlinkctl: '$sd_exec_out')"
fi

# (e) A plain varlinkctl call (fd input off) to a method that replies with fds: sd-varlink reads with recv() then
# (json-stream.c:1318-1321) and never sets SO_PASSRIGHTS on a client that did not enable input, so the kernel drops
# the fds and the reply arrives; our server's sendmsg must not fail.
if out=$(timeout 30 "$VARLINKCTL" call --json=short "$ADDR" org.example.Fds.OpenPipes '{"texts":["one"]}' 2>"$WORK/err.e") &&
  [ "$out" = '{"count":1}' ]; then
  pass "e varlinkctl call (no fd input) -> a reply with fds: the reply arrives, the fds are dropped"
else
  fail "e varlinkctl call (no fd input) -> a reply with fds" "got '${out:-}' $(head -c 300 "$WORK/err.e")"
fi

# (f) varlinkctl --push-fd to a server without fd input. Default (as sd-varlink without FD_PASSING_INPUT_STRICT):
# SO_PASSRIGHTS untouched, the server drops the fd and the call runs. Strict (fdPassingInputStrict): on Linux >= 6.16
# varlinkctl's sendmsg fails with EPERM (INFO: what varlinkctl prints is systemd's behaviour).
"$NODE" "$HERE/fds-server.ts" "unix:$WORK/noin.sock" no-input 2>"$WORK/noin.log" &
PIDS+=($!)
"$NODE" "$HERE/fds-server.ts" "unix:$WORK/strict.sock" strict-no-input 2>"$WORK/strict.log" &
PIDS+=($!)
if wait_socket "$WORK/noin.sock" && wait_socket "$WORK/strict.sock"; then
  if out=$(timeout 30 "$VARLINKCTL" call --json=short --push-fd=3 "unix:$WORK/noin.sock" org.example.Fds.Count '{}' 3<"$WORK/file" 2>"$WORK/err.f1") &&
    [ "$out" = '{"n":0}' ]; then
    pass "f1 varlinkctl call --push-fd=3 -> varlink-js server without fd input (default): the call runs, the fd is dropped"
  else
    fail "f1 varlinkctl call --push-fd=3 -> server without fd input (default)" "got '${out:-}' $(head -c 300 "$WORK/err.f1")"
  fi
  out=$(timeout 30 "$VARLINKCTL" call --json=short --push-fd=3 "unix:$WORK/strict.sock" org.example.Fds.Count '{}' 3<"$WORK/file" 2>"$WORK/err.f2")
  status=$?
  info "f2 varlinkctl call --push-fd=3 -> strict server without fd input: exit $status, stdout '${out:-}', stderr '$(head -c 200 "$WORK/err.f2" | tr '\n' ' ')'"
else
  fail "f setup" "the no-input servers did not start: $(cat "$WORK/noin.log" "$WORK/strict.log")"
fi

# (d) Look, don't touch: systemd services here whose interfaces mention fds.
found=0
seen=0
answered=0
names=""
for sock in /run/systemd/io.systemd.* /run/systemd/userdb/* /run/varlink/registry/*; do
  [ -S "$sock" ] || continue
  seen=$((seen + 1))
  ifaces=$(timeout 5 "$SYSTEM_VARLINKCTL" list-interfaces "unix:$sock" 2>/dev/null) || continue
  answered=$((answered + 1))
  for iface in $ifaces; do
    case " $names " in *" $iface "*) ;; *) names="$names $iface" ;; esac
    case "$iface" in org.varlink.service | io.systemd) continue ;; esac
    text=$(timeout 5 "$SYSTEM_VARLINKCTL" introspect "unix:$sock" "$iface" 2>/dev/null) || continue
    hits=$(printf '%s\n' "$text" | grep -iE 'fileDescriptor|[a-z]Fd[A-Z ,:)]|fdIndex|[ (]fd ?:' | tr -s ' ' | head -n 3 | paste -sd ';' -)
    if [ -n "$hits" ]; then
      info "d $sock $iface mentions fds: $hits"
      found=1
    fi
  done
done
info "d looked at $seen sockets, $answered answered (as $(id -un)); interfaces:$names"
[ "$found" = 1 ] || info "d no systemd service on this machine declares fd-carrying fields (sockets under /run/systemd, the userdb dir and the registry)"

exit "$failed"
