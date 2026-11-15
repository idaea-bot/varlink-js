// A small server from IDL text: `node examples/server.ts [ADDRESS]` (default tcp:127.0.0.1:0, a free port).
import { createServer, streamOf, VarlinkError } from "../src/index.ts";
import { listen } from "../src/node/index.ts";

const IDL = `# A demo interface.
interface org.example.demo

# Greets someone.
method Hello(name: string) -> (greeting: string)

# Counts from 1 to n, one reply per number.
# [Requires 'more' flag]
method Count(n: int) -> (i: int)

# n is not between 1 and max.
error OutOfRange (n: int, max: int)
`;

const server = createServer({ vendor: "Example", product: "demo", version: "1.0", url: "https://example.org" });
server.addInterface(IDL, {
  // Parameters are validated against the IDL before a handler runs.
  Hello: (p: { name: string }) => ({ greeting: `Hello, ${p.name}!` }),
  // An async generator streams: each `yield` is a reply with `continues`, the `return` value is the final reply.
  // streamOf() re-yields items but returns the last one, so it goes out as the final reply.
  Count: async function* (p: { n: number }) {
    if (p.n < 1 || p.n > 100) throw new VarlinkError("org.example.demo.OutOfRange", { n: p.n, max: 100 });
    return yield* streamOf(Array.from({ length: p.n }, (_, k) => ({ i: k + 1 })));
  },
});

// unix:/path (mode applies to unix sockets), unix:@name (Linux) or tcp:127.0.0.1:PORT
const listener = await listen(process.argv[2] ?? "tcp:127.0.0.1:0", { mode: 0o644 });
server.serve(listener);
console.log(`Listening on ${listener.address}`);

const stop = (): void => {
  void server.shutdown().then(() => process.exit(0)); // graceful: running calls may finish (5 s deadline)
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
