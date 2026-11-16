// For compare-json.sh (run in a Linux VM with varlinkctl): an echo service for byte-comparing JSON output of varlinkctl and varlink-js.
import { createServer, type CallContext } from "../../../../src/index.ts";
import { listen } from "../../../../src/node/index.ts";
const server = createServer({ ints: "bigint", onError: () => undefined });
server.addInterface(
  `interface org.example.echo
method Echo(value: any) -> (value: any)
method Count(n: int, value: ?any) -> (i: int, value: ?any)
`,
  {
    Echo: (p: Record<string, unknown>) => ({ value: p["value"] }),
    Count: async (p: Record<string, unknown>, ctx: CallContext) => {
      const n = Number(p["n"]);
      for (let i = 0; i < n - 1; i++) await ctx.notify({ i, value: p["value"] });
      return { i: n - 1, value: p["value"] };
    },
  },
);
const address = process.argv[2];
if (address === undefined) throw new Error("usage: echo-server.ts ADDRESS");
const l = await listen(address);
server.serve(l);
console.log("ready");
