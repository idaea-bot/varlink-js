// Child process for the spawn and activation tests: `listenAuto()`, then serves Ping (its pid, the activation
// variables it saw before and after listenAuto, the listener's address, its argv) with `exitOnIdle: 0` and exits 0
// once the server closed. Never writes to stdout (it may be the varlink channel).
// Flags: --accept=auto|listening|connected, --name=<fd name>, --keep-env (unsetEnvironment: false),
// --linger (ignore SIGTERM, no exit-on-idle: stays until SIGKILL), --report (print the listenAuto outcome as one
// JSON line on stdout and exit, without serving), --fd-address=<address> (report `listen({fd: 3}, {address})`;
// with --registry=<dir> it serves it with that registry, shuts down and reports the directory's entries instead),
// --grandchild (with --report: also report what a bridge grandchild sees on our activation fd numbers, Linux),
// --grandchild-exec=<cmd> (the same through an `exec:` grandchild with a listening socket, `cmd` being this
// fixture's wrapper; Ping reports fds 3…6 as /proc shows them),
// --hold (after the server closed, stay alive instead of exiting, until signalled).
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import type { Listener } from "../../../src/core/protocol/index.ts";
import { connectExec, listen, listenAuto } from "../../../src/node/index.ts";
import { openBridge } from "../../../src/node/spawn.ts";
import { createServer } from "../../../src/rpc/index.ts";

const IDL = `interface org.example.child

method Ping() -> (pid: int, before: object, after: object, address: string, argv: []string, fds: object)
`;

const VARS = [
  "LISTEN_PID",
  "LISTEN_PIDFDID",
  "LISTEN_FDS",
  "LISTEN_FDNAMES",
  "SYSTEMD_VARLINK_LISTEN",
  "VARLINK_ADDRESS",
  "VARLINK_JS_ACTIVATION",
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
const registry = flag("registry");
if (fdAddress !== undefined && registry !== undefined) {
  // Published through an inherited fd, then shut down: the entries stay (the socket is not ours).
  const l = await listen({ fd: 3 }, { address: fdAddress });
  const server = createServer({ onError: () => undefined });
  server.addInterface(IDL, {});
  await server.serve(l, { registry: { directory: registry } });
  const bound = readdirSync(registry);
  await server.shutdown();
  await report({ result: "listener", bound, left: readdirSync(registry) });
}
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
/** What /proc/self/fd/<n> is for each fd number (null: closed, or no /proc). */
function fdLinks(fds: readonly number[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const fd of fds)
    try {
      out[fd] = readlinkSync(`/proc/self/fd/${String(fd)}`);
    } catch {
      out[fd] = null;
    }
  return out;
}

/** What /proc/self/fd/<n> is for each of our activation fd numbers, ours and as a grandchild sees it. */
async function grandchild(): Promise<{ ours: Record<string, string>; theirs: Record<string, string | null> }> {
  const count = Number(before.LISTEN_FDS ?? "0");
  const fds = Array.from({ length: count }, (_, i) => 3 + i);
  const ours = Object.fromEntries(fds.map((fd) => [fd, readlinkSync(`/proc/self/fd/${String(fd)}`)]));
  const exec = flag("grandchild-exec");
  if (exec !== undefined) {
    // exec: listening mode: its fd 3 is a listening socket of ours; every other activation fd must be covered.
    const conn = await connectExec(exec, { socket: "listening" });
    const reply = (await conn.call("org.example.child.Ping")) as { fds: Record<string, string | null> };
    await conn.close();
    await conn.closed;
    return { ours, theirs: reply.fds };
  }
  const script = `const fs = require("node:fs"); const out = {};
for (const fd of ${JSON.stringify(fds)}) { try { out[fd] = fs.readlinkSync("/proc/self/fd/" + fd); } catch { out[fd] = null; } }
process.stdout.write(JSON.stringify(out));`;
  const ch = await openBridge([process.execPath, "-e", script], {}, new AbortController().signal);
  let text = "";
  for (let chunk = await ch.read(); chunk !== null; chunk = await ch.read())
    text += new TextDecoder().decode(chunk.bytes);
  ch.close();
  await ch.closed;
  return { ours, theirs: JSON.parse(text) as Record<string, string | null> };
}

const found = await auto();
const after = snapshot();
if (args.includes("--report")) {
  const fds = args.includes("--grandchild") || flag("grandchild-exec") !== undefined ? await grandchild() : undefined;
  await found?.close();
  await report({ result: found === null ? "null" : "listener", address: found?.address, after, fds });
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
  Ping: () => ({
    pid: process.pid,
    before,
    after,
    address: listener.address,
    argv: process.argv.slice(1),
    fds: fdLinks([3, 4, 5, 6]),
  }),
});
server.serve(listener);
await server.closed;
// --hold: whatever the peer sees now comes from closing the connection, not from our exit.
if (args.includes("--hold")) setInterval(() => undefined, 1000);
else process.exit(0);
