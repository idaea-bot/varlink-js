// Child process for the CLI's exec: tests (test/unit/cli/exec.test.ts): `listenAuto()`, then serves
// org.example.execchild (Answer replies with its pid; Hang never answers and first creates `<state>/hang`, so a test
// knows the call is in flight). Never writes to stdout. Flag: --state=<dir> (required).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listenAuto } from "../../../src/node/index.ts";
import { createServer } from "../../../src/rpc/index.ts";

const IDL = `interface org.example.execchild

method Answer() -> (pid: int)

method Hang() -> ()
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
});
server.serve(listener);
await server.closed;
process.exit(0);
