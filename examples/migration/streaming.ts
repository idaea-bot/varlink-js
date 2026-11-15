// MIGRATION.md "Streaming": `node examples/migration/streaming.ts ADDRESS` (against examples/reference-server.ts).
import { isVarlinkError } from "../../src/index.ts";
import { connect } from "../../src/node/index.ts";

const address = process.argv[2] ?? "tcp:127.0.0.1:12345";
const conn = await connect(address);
try {
  // One iteration per reply, the final one included (0.1.x: one callback per reply).
  for await (const reply of conn.stream("org.example.reference.Count", { n: 3 })) {
    console.log(`reply ${String(reply.i)}`);
  }

  // An error reply is thrown by the loop (0.1.x passed it to the callback as its first argument).
  try {
    for await (const reply of conn.stream("org.example.reference.Count", { n: 0 })) console.log(reply);
  } catch (e) {
    if (!isVarlinkError(e, "org.example.reference.OutOfRange")) throw e;
    console.log(`stream failed: ${e.error}`);
  }

  // All replies at once (at most 1024 by default: the `max` option).
  const all = await conn.collect("org.example.reference.Count", { n: 3 });
  console.log(`collected ${String(all.length)} replies`);
} finally {
  await conn.close();
}
