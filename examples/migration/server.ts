// MIGRATION.md "Server": `node examples/migration/server.ts [ADDRESS]` (default tcp:127.0.0.1:12345).
import { createServer } from "../../src/index.ts";
import { listen } from "../../src/node/index.ts";

// GetInfo and GetInterfaceDescription (org.varlink.service) are built in: GetInfo lists the registered interfaces.
const server = createServer({
  vendor: "varlink-js",
  product: "varlink-js",
  version: "0.0.1",
  url: "https://example.com",
});

// Methods are declared in IDL; calls are validated against it before a handler runs.
const IDL = `interface org.example.migration

method Echo(text: string) -> (text: string)

method Log(message: string) -> ()

# [Requires 'more' flag]
method Ticks(count: int) -> (tick: int)
`;

server.addInterface(IDL, {
  // was registerCall
  Echo: (input: { text: string }) => ({ text: input.text }),
  // was registerCallOneshot: any handler can be called oneway; the server then sends no reply at all
  Log: (input: { message: string }) => {
    console.error(`log: ${input.message}`);
  },
  // was registerCallStream: ctx.notify() sends a reply with continues, the returned value is the final reply
  // (an async generator works too: yield = reply with continues, return = final reply)
  Ticks: async (input: { count: number }, ctx) => {
    for (let tick = 1; tick < input.count; tick++) await ctx.notify({ tick });
    return { tick: input.count };
  },
});

// The server binds exactly what you pass: 127.0.0.1 here, not every interface.
const listener = await listen(process.argv[2] ?? "tcp:127.0.0.1:12345");
server.serve(listener); // was server.start()
console.log(`Listening on ${listener.address}`); // was transport.address()

process.once("SIGTERM", () => {
  void server.shutdown().then(() => process.exit(0)); // was server.stop()
});
