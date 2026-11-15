// MIGRATION.md "Client": `node examples/migration/client.ts ADDRESS` (e.g. against examples/reference-server.ts).
import { connect } from "../../src/node/index.ts";

const address = process.argv[2] ?? "tcp:127.0.0.1:12345";
// `timeout` is now per call (default 45 s; 0 = none), not a socket idle timeout.
const conn = await connect(address, { timeout: 10_000 });
try {
  // Call any method by name: parameters and result are Record<string, unknown>.
  const response1 = await conn.call("org.varlink.service.GetInterfaceDescription", {
    interface: "org.varlink.service",
  });
  console.log(typeof response1.description); // string (unknown to TypeScript)

  // org.varlink.service has typed helpers; for your own interfaces, generate a typed client (examples/codegen).
  const description = await conn.getInterfaceDescription("org.varlink.service");
  console.log(description === response1.description); // true
} finally {
  await conn.close();
}
