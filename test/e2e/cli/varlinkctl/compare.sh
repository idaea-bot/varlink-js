#!/bin/bash
# M7: compare `varlink-js` CLI with varlinkctl side by side (run inside ossvm, repo at ~/src/m7).
# Usage: bash vm-compare.sh > log; prints per case: SAME/DIFF + exit codes; diffs shown for DIFF.
set -u
cd "$(dirname "$0")/../../../.."
VJS="node $PWD/src/cli/main.ts"
OUT=$(mktemp -d)
pass=0; diffc=0
cmp_case() { # name, then args after the tool name (shared by both)
  local name=$1; shift
  varlinkctl "$@" >"$OUT/a.out" 2>"$OUT/a.err" </dev/null; local ra=$?
  $VJS "$@" >"$OUT/b.out" 2>"$OUT/b.err" </dev/null; local rb=$?
  if cmp -s "$OUT/a.out" "$OUT/b.out" && [ $ra = $rb ]; then
    echo "SAME  $name (exit $ra)"; pass=$((pass+1))
  else
    echo "DIFF  $name (varlinkctl exit $ra, varlink-js exit $rb)"; diffc=$((diffc+1))
    diff <(od -c "$OUT/a.out" | head -30) <(od -c "$OUT/b.out" | head -30) | head -30
  fi
  echo "   stderr varlinkctl: $(head -c 300 "$OUT/a.err" | tr '\n' '|')"
  echo "   stderr varlink-js: $(head -c 300 "$OUT/b.err" | tr '\n' '|')"
}
OOM=/run/systemd/io.systemd.ManagedOOM
MUX=/run/systemd/userdb/io.systemd.Multiplexer
CERT=/tmp/m7-cert.sock
rm -f $CERT
$VJS certify server unix:$CERT > "$OUT/cert.log" 2>&1 &
CPID=$!
for i in $(seq 1 50); do [ -S $CERT ] && break; sleep 0.1; done

echo "== systemd $(varlinkctl --version | head -1)"
cmp_case "info OOM" info $OOM
cmp_case "info OOM -j" -j info $OOM
cmp_case "list-interfaces OOM" list-interfaces $OOM
cmp_case "list-interfaces OOM -j" -j list-interfaces $OOM
cmp_case "introspect OOM io.systemd.ManagedOOM" introspect $OOM io.systemd.ManagedOOM
cmp_case "introspect -j OOM org.varlink.service" -j introspect $OOM org.varlink.service
cmp_case "call GetInfo" call $OOM org.varlink.service.GetInfo '{}'
cmp_case "call GetInfo --json=short" --json=short call $OOM org.varlink.service.GetInfo '{}'
cmp_case "call unknown interface error" call $OOM org.varlink.service.GetInterfaceDescription '{"interface":"x.y"}'
cmp_case "call unknown method" call $OOM x.y.Z '{}'
cmp_case "call --graceful" call --graceful=org.varlink.service.InterfaceNotFound $OOM org.varlink.service.GetInterfaceDescription '{"interface":"x.y"}'
cmp_case "call -q" call -q $OOM org.varlink.service.GetInfo '{}'
cmp_case "call bad params" call $OOM org.varlink.service.GetInfo '[1]'
cmp_case "call bad method name" call $OOM nodots '{}'
cmp_case "call missing socket" call /run/nonexistent.sock a.b.C '{}'
cmp_case "call --oneway" call --oneway $OOM org.varlink.service.GetInfo '{}'
if [ -S $MUX ]; then
  cmp_case "Multiplexer --more" call --more $MUX io.systemd.UserDatabase.GetUserRecord '{"service":"io.systemd.Multiplexer"}'
  cmp_case "Multiplexer --collect" call --collect $MUX io.systemd.UserDatabase.GetUserRecord '{"service":"io.systemd.Multiplexer"}'
  cmp_case "Multiplexer no more" call $MUX io.systemd.UserDatabase.GetUserRecord '{"service":"io.systemd.Multiplexer","userName":"root"}'
  cmp_case "Multiplexer ExpectedMore" call $MUX io.systemd.UserDatabase.GetUserRecord '{"service":"io.systemd.Multiplexer"}'
else
  echo "SKIP  Multiplexer (no $MUX)"
fi
cmp_case "validate-idl service" validate-idl interfaces/org.varlink.service.varlink
printf "interface a.b\nmethod X() -> (y: nope\n" > /tmp/m7-bad.varlink
cmp_case "validate-idl bad" validate-idl /tmp/m7-bad.varlink
cmp_case "cert info" info $CERT
cmp_case "cert call Start" call $CERT org.varlink.certification.Start '{}'
kill $CPID; wait $CPID 2>/dev/null
echo "== $pass same, $diffc different"
rm -rf "$OUT"
