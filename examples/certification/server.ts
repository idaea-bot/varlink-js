// The org.varlink.certification server: `node examples/certification/server.ts --varlink=<address>`.
// Prints `Listening on <address>` once listening (tcp: the real port); SIGINT/SIGTERM shut it down gracefully.
import { parseArgs } from "node:util";
import { listen } from "../../src/node/index.ts";
import { createCertificationServer, describeError } from "./certification.ts";

function usage(): never {
  console.error("Usage: node examples/certification/server.ts --varlink=<address>");
  console.error("  e.g. --varlink=unix:/tmp/cert.sock, --varlink=unix:@cert, --varlink=tcp:127.0.0.1:0");
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

try {
  const { server } = await createCertificationServer();
  const listener = await listen(address);
  server.serve(listener);
  console.log(`Listening on ${listener.address}`);
  const stop = (): void => {
    server.shutdown().then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(`shutdown failed: ${describeError(e)}`);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (e) {
  console.error(`certification server: ${describeError(e)}`);
  process.exit(1);
}
