// MIGRATION.md "Errors": `node examples/migration/errors.ts ADDRESS` (against examples/reference-server.ts).
import { ConnectionClosedError, isVarlinkError, MethodNotFoundError, VarlinkError } from "../../src/index.ts";
import { connect } from "../../src/node/index.ts";

const address = process.argv[2] ?? "tcp:127.0.0.1:12345";
const conn = await connect(address);
try {
  // Error replies reject with a VarlinkError: `error` is the varlink error name (0.1.x: `type_`).
  try {
    await conn.call("org.example.reference.Lookup", { word: "xyzzy" });
  } catch (e) {
    if (!isVarlinkError(e, "org.example.reference.NotFound")) throw e;
    console.log(`${e.error} ${JSON.stringify(e.parameters)}`);
  }

  // Standard errors have classes. An unknown method is MethodNotFound (0.1.x sent InvalidParameter).
  try {
    await conn.call("org.example.reference.NoSuchMethod");
  } catch (e) {
    if (!MethodNotFoundError.is(e)) throw e;
    console.log(`${e.error} ${JSON.stringify(e.parameters)}`);
  }

  // Server side: throw a VarlinkError to send it; any other exception becomes
  // io.github.pzmarzly.varlinkjs.InternalError, and its details go only to the server's onError.
  console.log(new VarlinkError("org.example.reference.NotFound", { word: "xyzzy" }).message);
} finally {
  await conn.close();
}

// Local failures are not VarlinkErrors: ConnectionClosedError, CallTimeoutError, ProtocolError, ValidationError, …
try {
  await conn.call("org.example.reference.Ping", { ping: "too late" });
} catch (e) {
  if (!(e instanceof ConnectionClosedError)) throw e;
  console.log(`local error: ${e.name}`);
}
