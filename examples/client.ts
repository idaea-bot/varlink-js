// Calls org.varlink.service.GetInfo: `node examples/client.ts ADDRESS`, e.g. unix:/run/org.example.sock.
import { connect } from "../src/node/index.ts";

const address = process.argv[2] ?? "unix:./org.example.reference.sock";
const conn = await connect(address); // unix:/path, unix:@name (Linux), tcp:host:port, exec:/path, ssh-unix:…
try {
  const info = await conn.getInfo(); // org.varlink.service.GetInfo, reply validated
  console.log(`${info.vendor} ${info.product} ${info.version} (${info.url})`);
  for (const name of info.interfaces) console.log(`  ${name}`);
} finally {
  await conn.close();
}
