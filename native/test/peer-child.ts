// Child process for peer.test.ts: connects to argv[2] (with or without the addon, argv[3] === "native") and prints
// its own pid/uid/gid next to what the server reported as its peer (org.example.fd.Peer).
import { connect } from "../../src/node/index.ts";
import * as native from "../index.js";

const address = process.argv[2] ?? "";
const conn = await connect(address, process.argv[3] === "native" ? { native } : {});
const peer = await conn.call("org.example.fd.Peer", {});
await conn.close();
process.stdout.write(
  `${JSON.stringify({ self: { pid: process.pid, uid: process.getuid?.(), gid: process.getgid?.() }, peer })}\n`,
);
