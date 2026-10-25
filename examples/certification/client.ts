// The org.varlink.certification client: `node examples/certification/client.ts --varlink=<address>`.
// Prints each step and `Certification passed` (exit 0); any failure goes to stderr (exit 1).
import { parseArgs } from "node:util";
import { connect } from "../../src/node/index.ts";
import { describeError, runCertificationClient } from "./certification.ts";

function usage(): never {
  console.error("Usage: node examples/certification/client.ts --varlink=<address>");
  process.exit(2);
}

let address: string | undefined;
try {
  address = parseArgs({ options: { varlink: { type: "string" } } }).values.varlink;
} catch (e) {
  console.error(describeError(e));
  usage();
}
if (address === undefined) usage();

console.log(`Connecting to ${address}`);
try {
  const conn = await connect(address, { validateReplies: "throw" });
  try {
    await runCertificationClient(conn, (line) => {
      console.log(line);
    });
  } finally {
    await conn.close();
  }
  console.log("Certification passed");
} catch (e) {
  console.error(`Certification failed: ${describeError(e)}`);
  process.exitCode = 1;
}
