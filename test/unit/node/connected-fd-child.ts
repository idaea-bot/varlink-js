// Child process for connected-fd.test.ts: the activation channel over a connected socket on fd 3
// (connectedChannel), driven in-process. Args: <scenario> <delay ms>. After the delay (so the peer's data is already
// waiting), it reads "ping" and writes "pong", then:
// - close: close() twice, awaits closed;
// - end: end() (the peer answers our EOF with "after" and its own EOF), reads to EOF, then close(), awaits closed.
// Then prints one JSON line on stdout: what it read, whether fd 3 was a socket, the second close()'s outcome, and
// what fd 3 is after the close (fstat's error code, or `reused`/`open` by dev + inode).
import { fstatSync } from "node:fs";
import { connectedChannel } from "../../../src/node/activation.ts";

const [scenario = "", delay = "0"] = process.argv.slice(2);
await new Promise((resolve) => setTimeout(resolve, Number(delay)));

const before = fstatSync(3);
/** fd 3 after the close: its fstat error code, `reused` if the number now names another file, `open` if not closed. */
const fdCode = (): string => {
  try {
    const after = fstatSync(3);
    // The runtime may have opened something on the freed number in between.
    return after.dev === before.dev && after.ino === before.ino ? "open" : "reused";
  } catch (e) {
    return String((e as { code?: unknown }).code);
  }
};
const socket = before.isSocket();
const ch = connectedChannel(3);
const dec = new TextDecoder();
let got = "";
async function readUntil(stop: (text: string) => boolean): Promise<void> {
  while (!stop(got)) {
    const chunk = await ch.read();
    if (chunk === null) return;
    got += dec.decode(chunk.bytes);
  }
}

await readUntil((t) => t.includes("ping"));
await ch.write(new TextEncoder().encode("pong"));
let secondClose = "ok";
if (scenario === "end") {
  await ch.end();
  await readUntil(() => false);
  ch.close();
} else {
  ch.close();
  try {
    ch.close();
  } catch (e) {
    secondClose = String(e);
  }
}
await ch.closed;
const out = JSON.stringify({ got, socket, secondClose, fd: fdCode(), readAfterClose: await ch.read() });
await new Promise((resolve) => process.stdout.write(`${out}\n`, resolve));
process.exit(0);
