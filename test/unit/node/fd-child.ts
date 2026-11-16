// Child process for fd.test.ts: serves Ping on the listening socket inherited as fd 3 and prints its address.
// Exits when stdin closes (the parent's end of the pipe).
import { listen } from "../../../src/node/index.ts";
import { createServer } from "../../../src/rpc/index.ts";

const server = createServer({ onError: () => undefined });
server.addInterface("interface org.example.fd\n\nmethod Ping() -> (pid: int)\n", {
  Ping: () => ({ pid: process.pid }),
});
const listener = await listen({ fd: 3 });
server.serve(listener);
process.stdout.write(`${listener.address}\n`);
process.stdin.resume();
process.stdin.on("end", () => {
  void server.shutdown({ graceful: false });
});
