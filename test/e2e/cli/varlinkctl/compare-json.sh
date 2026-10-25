#!/bin/bash
# Byte-compare JSON output (short, pretty, SEQ) of varlinkctl and varlink-js for tricky payloads.
cd "$(dirname "$0")/../../../.."; VJS="node $PWD/src/cli/main.ts"; S=/tmp/m7-echo.sock; rm -f $S
node test/e2e/cli/varlinkctl/echo-server.ts $S > /tmp/echo.log 2>&1 & P=$!
for i in $(seq 1 50); do [ -S $S ] && break; sleep 0.1; done
same=0; diff=0
c() { varlinkctl "$@" > /tmp/a 2>/tmp/ae; ra=$?; $VJS "$@" > /tmp/b 2>/tmp/be; rb=$?
  # systemd 255 omits the final newline after call output; compare modulo one trailing LF
  if cmp -s <(cat /tmp/a; [ -n "$(tail -c1 /tmp/a)" ] && echo) /tmp/b && [ $ra = $rb ]; then echo "SAME $*"; same=$((same+1)); else echo "DIFF $* ($ra/$rb)"; diff=$((diff+1)); echo "--- varlinkctl"; cat -A /tmp/a | head -20; cat /tmp/ae; echo "--- varlink-js"; cat -A /tmp/b | head -20; cat /tmp/be; fi; }
for J in short pretty; do
 for V in '{"a":1}' '{}' '[]' '{"e":{},"f":[],"g":[{}],"h":[[]]}' '"q\"b\\s/t\tn\nc\u0001x"' '"zażółć ☃ 😀"' '"\u007f\u0080\u2028"' '9223372036854775807' '-9223372036854775808' '18446744073709551615' '1.5' '0.1' '1e300' '-0' '1e-7' '123456789012' 'true' 'null' '[1,"x",null,false,{"k":[]}]' '{"b":1,"a":2,"1":3}'; do
  c --json=$J call $S org.example.echo.Echo "{\"value\":$V}"
 done
 c --json=$J call --more $S org.example.echo.Count '{"n":3,"value":{"x":[1,2]}}'
done
kill $P
echo "== $same same, $diff different"
