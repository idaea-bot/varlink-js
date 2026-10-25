// Child process for the spawn and activation tests: `listenAuto()`, then serves Ping (its pid, the activation
// variables it saw before and after listenAuto, the listener's address, its argv) with `exitOnIdle: 0` and exits 0
// once the server closed. Never writes to stdout (it may be the varlink channel).
// Flags: --accept=auto|listening|connected, --name=<fd name>, --keep-env (unsetEnvironment: false),
// --linger (ignore SIGTERM, no exit-on-idle: stays until SIGKILL), --report (print the listenAuto outcome as one
// JSON line on stdout and exit, without serving), --fd-address=<address> (report `listen({fd: 3}, {address})`).
import { existsSync } from "node:fs";
import type { Listener } from "../../../src/core/protocol/index.ts";
import { listen, listenAuto } from "../../../src/node/index.ts";
import { createServer } from "../../../src/rpc/index.ts";

const IDL = `interface org.example.child

method Ping() -> (pid: int, before: object, after: object, address: string, argv: []string)
`;

const VARS = [
  "LISTEN_PID",
  "LISTEN_PIDFDID",
  "LISTEN_FDS",
  "LISTEN_FDNAMES",
  "SYSTEMD_VARLINK_LISTEN",
  "VARLINK_ADDRESS",
] as const;

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of VARS) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const accept = (flag("accept") ?? "auto") as "auto" | "listening" | "connected";
const name = flag("name");
const linger = args.includes("--linger");

/** Prints one JSON line on stdout and exits once it is written (stdout may be an async pipe). */
async function report(value: unknown): Promise<never> {
  await new Promise((resolve) => process.stdout.write(`${JSON.stringify(value)}\n`, resolve));
  process.exit(0);
}

const fdAddress = flag("fd-address");
if (fdAddress !== undefined) {
  // listen({fd: 3}, {address}) directly: report the address, and that closing it left the path alone.
  try {
    const l = await listen({ fd: 3 }, { address: fdAddress });
    await l.close();
    const path = fdAddress.replace(/^unix:/, "");
    await report({ result: "listener", address: l.address, exists: existsSync(path) });
  } catch (e) {
    await report({ result: "error", message: String(e) });
  }
}

const before = snapshot();
async function auto(): Promise<Listener | null> {
  try {
    return await listenAuto({
      accept,
      ...(name === undefined ? {} : { name }),
      ...(args.includes("--keep-env") ? { unsetEnvironment: false } : {}),
    });
  } catch (e) {
    if (!args.includes("--report")) throw e;
    return report({ result: "error", message: String(e), after: snapshot() });
  }
}
const found = await auto();
const after = snapshot();
if (args.includes("--report")) {
  await found?.close();
  await report({ result: found === null ? "null" : "listener", address: found?.address, after });
}
if (found === null) {
  process.stderr.write("activation-child: nothing to listen on\n");
  process.exit(3);
}
const listener: Listener = found;
if (linger) {
  process.on("SIGTERM", () => undefined);
  setInterval(() => undefined, 1000);
}
const server = createServer({ onError: () => undefined, ...(linger ? {} : { exitOnIdle: 0 }) });
server.addInterface(IDL, {
  Ping: () => ({ pid: process.pid, before, after, address: listener.address, argv: process.argv.slice(1) }),
});
server.serve(listener);
await server.closed;
process.exit(0);
