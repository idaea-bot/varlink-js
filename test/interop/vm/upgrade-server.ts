// Fixture for test/interop/vm/upgrade.sh (M9): serves org.example.Upgrade on the address given as the only argument
// (e.g. unix:/run/x). Cat requires the upgrade flag and copies the upgraded stream back (like `cat`, ending its side
// at the client's EOF); Head reads up to the first newline, writes that line back and closes the connection (like
// `head -n1`, which stops reading early); Ping is a plain method, for recording what an upgrade flag on it does (Q4). Runs until killed.
import { listen } from "../../../src/node/index.ts";
import { createServer } from "../../../src/rpc/index.ts";

const IDL = `interface org.example.Upgrade

# [Requires 'upgrade' flag]
method Cat() -> ()

# [Requires 'upgrade' flag]
method Head() -> ()

method Ping() -> ()
`;

const address = process.argv[2];
if (address === undefined) {
  process.stderr.write("usage: upgrade-server.ts ADDRESS\n");
  process.exit(2);
}
const server = createServer({
  product: "varlink-js upgrade fixture",
  onError: (e, info) => process.stderr.write(`upgrade-server: ${info.reason}: ${String(e)}\n`),
});
server.addInterface(IDL, {
  Cat: async (_p, ctx) => {
    const ch = await ctx.upgrade();
    for (let c = await ch.read(); c !== null; c = await ch.read()) await ch.write(c.bytes);
    await ch.end();
  },
  Head: async (_p, ctx) => {
    const ch = await ctx.upgrade();
    const line: Uint8Array[] = [];
    for (let c = await ch.read(); c !== null; c = await ch.read()) {
      const nl = c.bytes.indexOf(0x0a);
      line.push(nl < 0 ? c.bytes : c.bytes.subarray(0, nl + 1));
      if (nl >= 0) break;
    }
    for (const bytes of line) await ch.write(bytes);
    // The rest of the stream is never read: the client's writes then fail (EPIPE/ECONNRESET).
    ch.close();
  },
  Ping: () => ({}),
});
server.serve(await listen(address));
process.stderr.write(`upgrade-server: listening on ${address}\n`);
