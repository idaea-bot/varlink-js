// MIGRATION.md "Pool": `node examples/migration/pool.ts ADDRESS` (against examples/reference-server.ts).
import { createPool } from "../../src/node/index.ts";

const address = process.argv[2] ?? "tcp:127.0.0.1:12345";
// Each operation leases one connection until it settles; closed connections are dropped, never reused.
const pool = createPool(address, { max: 4, idleTimeout: 30_000 });
try {
  const words = ["a", "b", "c", "d", "e", "f"];
  const replies = await Promise.all(words.map((ping) => pool.call("org.example.reference.Ping", { ping })));
  console.log(replies.map((r) => r.pong).join(" ")); // a b c d e f
  console.log(`open connections: ${String(pool.size)}`); // at most 4
} finally {
  await pool.close();
}
