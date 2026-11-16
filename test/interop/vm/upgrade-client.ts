// Client side of test/interop/vm/upgrade.sh (M9). Exit 0 on success, 1 on failure; one line on stdout.
//   api ADDRESS METHOD FILE   conn.upgrade(METHOD), FILE's bytes through the upgraded channel, expects them back.
//   q4 ADDRESS METHOD         raw socket: METHOD with upgrade:true, then METHOD plain, in one write; prints what came
//                             back within 5 s (Q4: two replies = the flag was ignored and the peer kept speaking
//                             varlink).
import { readFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { parseAddress } from "../../../src/core/address/index.ts";
import { socketOptions } from "../../../src/node/connect.ts";
import { connect } from "../../../src/node/index.ts";

const [mode, address, method, file] = process.argv.slice(2);

async function api(): Promise<boolean> {
  if (address === undefined || method === undefined || file === undefined) throw new Error("api ADDRESS METHOD FILE");
  const data = readFileSync(file);
  const conn = await connect(address, { timeout: 10_000 });
  const { channel } = await conn.upgrade(method);
  const writing = (async () => {
    for (let at = 0; at < data.length; at += 65_536) await channel.write(data.subarray(at, at + 65_536));
    await channel.end();
  })();
  const chunks: Uint8Array[] = [];
  for (let c = await channel.read(); c !== null; c = await channel.read()) chunks.push(c.bytes);
  await writing;
  channel.close();
  const got = Buffer.concat(chunks);
  const ok = got.equals(data);
  process.stdout.write(
    `api: sent ${String(data.length)} bytes, got ${String(got.length)} back, ${ok ? "equal" : "DIFFERENT"}\n`,
  );
  return ok;
}

async function q4(): Promise<boolean> {
  if (address === undefined || method === undefined) throw new Error("q4 ADDRESS METHOD");
  const socket = netConnect(socketOptions(parseAddress(address)));
  socket.on("error", () => undefined);
  const call = (upgrade: boolean): string =>
    `${JSON.stringify({ method, parameters: {}, ...(upgrade ? { upgrade } : {}) })}\0`;
  const received: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.on("data", (b: Buffer) => received.push(b));
  socket.write(call(true) + call(false));
  const deadline = Date.now() + 5000;
  const replies = (): string[] => Buffer.concat(received).toString("utf8").split("\0").slice(0, -1);
  while (replies().length < 2 && Date.now() < deadline && !socket.destroyed)
    await new Promise((resolve) => setTimeout(resolve, 20));
  socket.destroy();
  const got = replies();
  process.stdout.write(`q4: ${method} with upgrade:true then plain → ${JSON.stringify(got)}\n`);
  return got.length === 2 && got.every((r) => !("error" in (JSON.parse(r) as object)));
}

try {
  const ok = mode === "api" ? await api() : mode === "q4" ? await q4() : false;
  if (mode !== "api" && mode !== "q4") process.stdout.write("usage: upgrade-client.ts api|q4 …\n");
  process.exit(ok ? 0 : 1);
} catch (e) {
  process.stdout.write(`${mode ?? "?"}: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
