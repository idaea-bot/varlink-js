// Child process for the CLI's exec: tests (test/unit/cli/call.test.ts, test/e2e/cli): `listenAuto()`, then serves
// org.example.execchild (Answer replies with its pid; Hang never answers and first creates `<state>/hang`, so a test
// knows the call is in flight; Upper upper-cases an upgraded stream). Never writes to stdout. Flag: --state=<dir>
// (required).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listenAuto } from "../../../src/node/index.ts";
import { createServer } from "../../../src/rpc/index.ts";

const IDL = `interface org.example.execchild

method Answer() -> (pid: int)

method Hang() -> ()

# Upper-cases the upgraded stream; ends its side at the client's EOF (M9, test/e2e/cli).
# [Requires 'upgrade' flag]
method Upper() -> ()

# Reads one chunk, writes its first line back and closes the connection, the rest unread (M9, test/e2e/cli).
# [Requires 'upgrade' flag]
method Head() -> ()
`;

const state = process.argv
  .slice(2)
  .find((a) => a.startsWith("--state="))
  ?.slice("--state=".length);
if (state === undefined) {
  process.stderr.write("exec-child: --state=<dir> is required\n");
  process.exit(2);
}
const listener = await listenAuto();
if (listener === null) {
  process.stderr.write("exec-child: nothing to listen on\n");
  process.exit(3);
}
const server = createServer({ onError: () => undefined, exitOnIdle: 0 });
server.addInterface(IDL, {
  Answer: () => ({ pid: process.pid }),
  Hang: () => {
    writeFileSync(join(state, "hang"), String(process.pid));
    return new Promise<never>(() => undefined);
  },
  Upper: async (_p, ctx) => {
    const ch = await ctx.upgrade();
    for (let c = await ch.read(); c !== null; c = await ch.read())
      await ch.write(new TextEncoder().encode(new TextDecoder().decode(c.bytes).toUpperCase()));
    await ch.end();
  },
  Head: async (_p, ctx) => {
    const ch = await ctx.upgrade();
    const c = await ch.read();
    const line = c === null ? "" : (new TextDecoder().decode(c.bytes).split("\n")[0] ?? "");
    await ch.write(new TextEncoder().encode(`${line}\n`));
    ch.close();
    await ch.closed;
  },
});
server.serve(listener);
await server.closed;
process.exit(0);
