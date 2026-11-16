// Fixture service for the VM interop tests: `listenAuto()`, serves org.example.vm.Ping (its pid and the listener's
// address) with exit-on-idle, exits 0 once the server closed. Never writes to stdout (it may be the channel).
// Flags: --idle=<ms> (exitOnIdle, default 0), --name=<fd name> (LISTEN_FDNAMES name, default "varlink"),
// --registry=<dir> (serve with {registry: {directory}}).
import { listenAuto } from "../../../src/node/index.ts";
import { createServer } from "../../../src/rpc/index.ts";

const IDL = `interface org.example.vm

method Ping() -> (pid: int, address: string)
`;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const name = flag("name");
const registry = flag("registry");

const listener = await listenAuto(name === undefined ? {} : { name });
if (listener === null) {
  process.stderr.write("fixture-server: nothing to listen on\n");
  process.exit(3);
}
const server = createServer({
  product: "varlink-js fixture",
  onError: (e, info) => process.stderr.write(`fixture-server: ${info.reason}: ${String(e)}\n`),
  exitOnIdle: Number(flag("idle") ?? "0"),
});
server.addInterface(IDL, { Ping: () => ({ pid: process.pid, address: listener.address }) });
await server.serve(listener, registry === undefined ? {} : { registry: { directory: registry } });
await server.closed;
process.exit(0);
