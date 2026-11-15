#!/usr/bin/env bash
# Protocol upgrade interop (M9, DESIGN.md §7.4): varlink-js ↔ systemd's varlinkctl (systemd ≥ 261, which has
# `call --upgrade` and `serve`). For the Linux VM; NOT run by CI or `npm test`.
#
#   VARLINKCTL=/path/to/varlinkctl [NODE=node] [SOCKET_ACTIVATE=systemd-socket-activate] test/interop/vm/upgrade.sh
#
# Cases (one PASS/FAIL line each; exit status 1 if any failed):
#   a   varlinkctl call --upgrade → a varlink-js server's org.example.Upgrade.Cat (upgrade-server.ts), 1 MiB both ways
#   b1  varlink-js call --upgrade → `varlinkctl serve org.example.Upgrade.Cat cat` (socket-activated: serve needs it)
#   b2  the same through the JS API (conn.upgrade, upgrade-client.ts)
#   c1  Q4 against varlink-js: org.example.Upgrade.Ping with upgrade:true, then plain: two plain replies expected
#   c2  Q4 against sd-varlink: org.varlink.service.GetInfo with upgrade:true, then plain (what systemd does is printed)
#   d*  the service stops reading early (`yes | … call --upgrade`): varlinkctl and varlink-js, each against
#       `varlinkctl serve org.example.Upgrade.Head -- head -n1` and against the varlink-js server's Head (reads one
#       line, writes it back, closes). Only varlink-js's runs (d2, d4) PASS/FAIL: exit 0 with "y" on stdout. The
#       varlinkctl runs (d1, d3) and "d parity" are INFO lines: systemd 262.2 can lose the line in d1 and dies of
#       SIGPIPE (exit 141) in d1/d3 (results-systemd-262.log), which is systemd's behaviour, not ours
#   e*  the service ends first (`varlinkctl serve org.example.Upgrade.Bye echo BYE`, which never reads) while stdin
#       stays open for 3 s: stdout's reader (a FIFO) must see EOF before stdin closes, then exit 0 (e2, varlink-js);
#       e1 (varlinkctl) is INFO: it gives the reader EOF only at exit
#
# Every client run is bounded by `timeout`. To keep a record: `test/interop/vm/upgrade.sh 2>&1 | tee results.log`.
set -u

VARLINKCTL=${VARLINKCTL:?set VARLINKCTL to a varlinkctl from systemd >= 261}
NODE=${NODE:-node}
ACTIVATE=${SOCKET_ACTIVATE:-systemd-socket-activate}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
CLI="$ROOT/src/cli/main.ts"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/vj-upgrade.XXXXXX")
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

# Waits up to 10 s for a socket file.
wait_socket() {
  for _ in $(seq 100); do
    [ -S "$1" ] && return 0
    sleep 0.1
  done
  return 1
}

echo "varlinkctl: $("$VARLINKCTL" --version | head -n1)"
echo "node: $("$NODE" --version)"
head -c 1048576 /dev/urandom >"$WORK/data"

# (a) varlink-js server, varlinkctl client.
"$NODE" "$HERE/upgrade-server.ts" "unix:$WORK/js.sock" 2>"$WORK/js-server.log" &
PIDS+=($!)
if wait_socket "$WORK/js.sock"; then
  if timeout 30 "$VARLINKCTL" call --upgrade "unix:$WORK/js.sock" org.example.Upgrade.Cat <"$WORK/data" >"$WORK/out.a" 2>"$WORK/err.a" &&
    cmp -s "$WORK/data" "$WORK/out.a"; then
    pass "a varlinkctl call --upgrade -> varlink-js server"
  else
    fail "a varlinkctl call --upgrade -> varlink-js server" "$(head -c 300 "$WORK/err.a") ($(wc -c <"$WORK/out.a") bytes back)"
  fi
else
  fail "a varlinkctl call --upgrade -> varlink-js server" "the varlink-js server did not start: $(cat "$WORK/js-server.log")"
fi

# (b) varlinkctl serve (socket-activated), varlink-js client: the CLI, then the JS API.
"$ACTIVATE" -l "$WORK/sd.sock" "$VARLINKCTL" serve org.example.Upgrade.Cat cat 2>"$WORK/sd-serve.log" &
PIDS+=($!)
if wait_socket "$WORK/sd.sock"; then
  if timeout 30 "$NODE" "$CLI" call --upgrade "unix:$WORK/sd.sock" org.example.Upgrade.Cat <"$WORK/data" >"$WORK/out.b" 2>"$WORK/err.b" &&
    cmp -s "$WORK/data" "$WORK/out.b"; then
    pass "b1 varlink-js call --upgrade -> varlinkctl serve"
  else
    fail "b1 varlink-js call --upgrade -> varlinkctl serve" "$(head -c 300 "$WORK/err.b") ($(wc -c <"$WORK/out.b") bytes back)"
  fi
  if out=$(timeout 30 "$NODE" "$HERE/upgrade-client.ts" api "unix:$WORK/sd.sock" org.example.Upgrade.Cat "$WORK/data"); then
    pass "b2 conn.upgrade() -> varlinkctl serve ($out)"
  else
    fail "b2 conn.upgrade() -> varlinkctl serve" "$out"
  fi
else
  fail "b varlinkctl serve" "did not start: $(cat "$WORK/sd-serve.log")"
fi

# (c) Q4: the upgrade flag on a method without upgrade support, against both sides.
if out=$(timeout 30 "$NODE" "$HERE/upgrade-client.ts" q4 "unix:$WORK/js.sock" org.example.Upgrade.Ping); then
  pass "c1 Q4 varlink-js: $out"
else
  fail "c1 Q4 varlink-js" "$out"
fi
if out=$(timeout 30 "$NODE" "$HERE/upgrade-client.ts" q4 "unix:$WORK/sd.sock" org.varlink.service.GetInfo); then
  pass "c2 Q4 sd-varlink: $out"
else
  fail "c2 Q4 sd-varlink (expected two plain replies, as read in sd-varlink.c)" "$out"
fi

# (d) The service stops reading early under an endless stdin: socket-forward ends that direction quietly (exit 0).
# `--`: varlinkctl parses the command's options otherwise ("unrecognized option '-n'").
"$ACTIVATE" -l "$WORK/sd-head.sock" "$VARLINKCTL" serve org.example.Upgrade.Head -- head -n1 2>"$WORK/sd-head.log" &
PIDS+=($!)
# head_case MODE NAME ADDRESS CLI-ARGV…: `yes | CLI call --upgrade ADDRESS org.example.Upgrade.Head`; sets $code.
# MODE strict: PASS/FAIL on exit 0 with "y" on stdout (varlink-js); info: an INFO line with what happened (varlinkctl,
# whose results here are systemd's: see the header).
head_case() {
  local mode=$1 name=$2 address=$3
  local id=${name%% *}
  shift 3
  yes | timeout 30 "$@" call --upgrade "$address" org.example.Upgrade.Head >"$WORK/out.$id" 2>"$WORK/err.$id"
  code=$?
  local first
  first=$(head -n1 "$WORK/out.$id")
  if [ "$mode" = info ]; then
    local note=""
    [ "$code" = 141 ] && note=" (SIGPIPE)"
    info "$name exit $code$note, first line \"$first\""
  elif [ "$code" = 0 ] && [ "$first" = y ]; then
    pass "$name exit 0, stdout \"y\""
  else
    fail "$name" "exit $code, first line \"$first\", stderr: $(head -c 300 "$WORK/err.$id")"
  fi
}
if wait_socket "$WORK/sd-head.sock"; then
  head_case info "d1 varlinkctl -> varlinkctl serve -- head -n1" "unix:$WORK/sd-head.sock" "$VARLINKCTL"
  d1=$code
  head_case strict "d2 varlink-js -> varlinkctl serve -- head -n1" "unix:$WORK/sd-head.sock" "$NODE" "$CLI"
  d2=$code
else
  fail "d varlinkctl serve -- head -n1" "did not start: $(cat "$WORK/sd-head.log")"
  d1=none d2=none
fi
head_case info "d3 varlinkctl -> varlink-js Head" "unix:$WORK/js.sock" "$VARLINKCTL"
d3=$code
head_case strict "d4 varlink-js -> varlink-js Head" "unix:$WORK/js.sock" "$NODE" "$CLI"
d4=$code
# Informational only: varlinkctl may exit 141 (died of SIGPIPE, seen with 262.2) where varlink-js exits 0.
info "d parity: exit codes varlinkctl/varlink-js: against serve $d1/$d2, against varlink-js $d3/$d4"

# (e) The service ends first: stdout's reader must see EOF while stdin is still open.
"$ACTIVATE" -l "$WORK/sd-bye.sock" "$VARLINKCTL" serve org.example.Upgrade.Bye echo BYE 2>"$WORK/sd-bye.log" &
PIDS+=($!)
# end_first_case NAME CLI-ARGV…: stdin is a pipe whose writer creates $WORK/closed.ID and exits after 3 s; stdout is
# a FIFO whose reader notes whether that file existed when it saw EOF. The CLI is exec'd by `sh` after the redirect,
# so only the CLI holds the FIFO's write end (`timeout CLI > f` would leave a copy in `timeout`, the CLI's parent).
end_first_case() {
  local name=$1
  local id=${name%% *}
  shift
  local fifo="$WORK/fifo.$id"
  mkfifo "$fifo"
  timeout 40 sh -c 'cat <"$1" >"$2"; if [ -e "$3" ]; then echo late; else echo early; fi >"$4"' sh \
    "$fifo" "$WORK/out.$id" "$WORK/closed.$id" "$WORK/eof.$id" &
  local reader=$!
  PIDS+=("$reader")
  { sleep 3; : >"$WORK/closed.$id"; } |
    timeout 30 sh -c 'f=$1; shift; exec "$@" >"$f"' sh "$fifo" "$@" call --upgrade "unix:$WORK/sd-bye.sock" \
      org.example.Upgrade.Bye 2>"$WORK/err.$id"
  local code=$?
  wait "$reader"
  local eof out
  eof=$(cat "$WORK/eof.$id" 2>/dev/null)
  out=$(cat "$WORK/out.$id" 2>/dev/null)
  if [ "${E_INFO:-}" = 1 ]; then
    info "$name exit $code, stdout \"$out\", reader EOF ${eof:-never}"
  elif [ "$code" = 0 ] && [ "$out" = BYE ] && [ "$eof" = early ]; then
    pass "$name stdout EOF before stdin closed, exit 0"
  else
    fail "$name" "exit $code, stdout \"$out\", reader EOF ${eof:-never}, stderr: $(head -c 300 "$WORK/err.$id")"
  fi
}
if wait_socket "$WORK/sd-bye.sock"; then
  # INFO: varlinkctl 262.2 gives the reader EOF only at exit ("late"): it forwards a reopened copy of stdout
  # (dup_stdio_fd), so socket-forward's close() at the peer's EOF leaves the original fd 1 open.
  E_INFO=1 end_first_case "e1 varlinkctl -> varlinkctl serve echo BYE" "$VARLINKCTL"
  end_first_case "e2 varlink-js -> varlinkctl serve echo BYE" "$NODE" "$CLI"
else
  fail "e varlinkctl serve echo BYE" "did not start: $(cat "$WORK/sd-bye.log")"
fi

exit "$failed"
