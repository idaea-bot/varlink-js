// Fixture for test/interop/vm/fds.sh (M11): serves org.example.Fds on the unix address given as the first argument
// with varlink-js-native. The optional second argument is the fd input mode: absent = fd passing allowed both ways;
// "no-input" = no fd input, sd-varlink's default handling (SO_PASSRIGHTS untouched, fds that come are dropped);
// "strict-no-input" = no fd input with `fdPassingInputStrict` (SO_PASSRIGHTS off, so senders get EPERM on Linux ≥
// 6.16). ReadFd reads the first fd sent with the call (up to 1 MiB) and returns its text; Count returns how many fds
// came; OpenPipes replies with one pipe per text, each holding its text (the fds of the reply, in order). Runs until
// killed. Needs `npm --prefix native run build`.
import { readSync, writeSync } from "node:fs";
import { listen } from "../../../src/node/index.ts";
import { createServer } from "../../../src/rpc/index.ts";
import * as native from "../../../native/index.js";

const IDL = `interface org.example.Fds

# The text of the first fd sent with the call.
method ReadFd() -> (text: string, fds: int)

# How many fds came with the call.
method Count() -> (n: int)

# One pipe per text in the reply's fds, each holding its text.
method OpenPipes(texts: []string) -> (count: int)
`;

const address = process.argv[2];
const mode = process.argv[3] ?? "both";
if (address === undefined || !native.isAvailable() || !["both", "no-input", "strict-no-input"].includes(mode)) {
  process.stderr.write(
    `usage: fds-server.ts unix:PATH [no-input|strict-no-input] (needs the built addon: ${String(native.loadError)})\n`,
  );
  process.exit(2);
}
const input = mode === "both";
const server = createServer({
  product: "varlink-js fd fixture",
  allowFdPassingInput: input,
  allowFdPassingOutput: true,
  onError: (e, info) => process.stderr.write(`fds-server: ${info.reason}: ${String(e)}\n`),
});
server.addInterface(IDL, {
  ReadFd: (_p, ctx) => {
    const fds = ctx.fds.length;
    const fd = ctx.takeFd(0);
    try {
      const buf = Buffer.alloc(1024 * 1024);
      let n = 0;
      for (;;) {
        const got = readSync(fd.fd, buf, n, buf.length - n, null);
        if (got === 0 || n + got >= buf.length) {
          n += got;
          break;
        }
        n += got;
      }
      return { text: buf.toString("utf8", 0, n), fds };
    } finally {
      fd.close();
    }
  },
  Count: (_p, ctx) => ({ n: ctx.fds.length }),
  OpenPipes: (p: { texts: string[] }, ctx) => {
    for (const text of p.texts) {
      const [r, w] = native.pipe();
      writeSync(w, text);
      native.close(w);
      try {
        ctx.pushFds(r);
      } finally {
        native.close(r);
      }
    }
    return { count: p.texts.length };
  },
});
// Default: SO_PASSRIGHTS left alone (sd-varlink without FD_PASSING_INPUT_STRICT); strict: from allowFdPassingInput.
server.serve(
  await listen(address, {
    native,
    ...(mode === "strict-no-input" ? { fdPassingInputStrict: true, allowFdPassingInput: false } : {}),
  }),
);
process.stderr.write(`fds-server: listening on ${address} (${mode})\n`);
