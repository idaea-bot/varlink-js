// A safe reference server: `node examples/reference-server.ts [--varlink=ADDRESS]`.
//
// - Default address: unix:./org.example.reference.sock. Unix sockets are created with mode 0644: listen() applies the
//   mode before the socket appears at its path (on a file system without hard links, right after bind). Connecting
//   to a unix socket needs write permission, so only the owner can connect.
// - TCP only on a loopback host (tcp:127.0.0.1:PORT, tcp:[::1]:PORT, tcp:localhost:PORT; port 0 picks a free port).
//   Any other host is refused: this server never binds 0.0.0.0 or ::.
// - Interface descriptions come only from the interfaces registered below (the built-in
//   org.varlink.service.GetInterfaceDescription); nothing is read from the file system.
//
// Prints one line, `Listening on <address>` (the real port for tcp:…:0), and shuts down gracefully on SIGINT/SIGTERM
// (exit 0). Usage errors exit with 2, other failures with 1.
import { parseArgs } from "node:util";
import { createServer, parseAddress, streamOf, VarlinkError, type AddressSpec } from "../src/index.ts";
import { listen } from "../src/node/index.ts";

const DEFAULT_ADDRESS = "unix:./org.example.reference.sock";

const REFERENCE_IDL = `# The varlink-js reference server's demo interface.
interface org.example.reference

# Returns its argument.
method Ping(ping: string) -> (pong: string)

# Looks a word up in a tiny dictionary.
method Lookup(word: string) -> (meaning: string)

# Counts from 1 to n, one reply per number; the last reply is the final one.
# [Requires 'more' flag]
method Count(n: int) -> (i: int)

# Records a message. It has no reply to lose, so it is safe to call as oneway.
method Log(message: string) -> ()

# The last messages recorded by Log, oldest first.
method Messages() -> (messages: []string)

# Lookup: the word is not in the dictionary.
error NotFound (word: string)

# Count: n is not between 1 and max.
error OutOfRange (n: int, max: int)
`;

const DICTIONARY: ReadonlyMap<string, string> = new Map([
  ["varlink", "an interface description format and protocol"],
  ["oneway", "a call that gets no reply"],
]);
const MAX_COUNT = 1000;
const MAX_MESSAGES = 16;

function usage(message: string): never {
  console.error(`reference-server: ${message}`);
  console.error("Usage: node examples/reference-server.ts [--varlink=ADDRESS]");
  console.error(`  ADDRESS: unix:/path or ./path (default ${DEFAULT_ADDRESS}), unix:@name (Linux), tcp:127.0.0.1:PORT`);
  process.exit(2);
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

let spec: AddressSpec;
try {
  const { values } = parseArgs({ options: { varlink: { type: "string", default: DEFAULT_ADDRESS } } });
  spec = parseAddress(values.varlink);
} catch (e) {
  usage(e instanceof Error ? e.message : String(e));
}
if (spec.kind === "tcp" && !isLoopback(spec.host))
  usage(`refusing to listen on ${spec.host}: use a loopback host such as 127.0.0.1`);
if (spec.kind !== "unix" && spec.kind !== "unix-abstract" && spec.kind !== "tcp")
  usage(`cannot listen on ${spec.kind} addresses`);

const messages: string[] = [];
const server = createServer({
  vendor: "varlink-js",
  product: "reference-server",
  version: "1",
  url: "https://github.com/pzmarzly/varlink-js",
  onError: (error, info) => {
    const where = info.method === undefined ? "" : ` in ${info.method}`;
    console.error(`reference-server: ${info.reason}${where}: ${error instanceof Error ? error.message : "error"}`);
  },
});
server.addInterface(REFERENCE_IDL, {
  Ping: (p: { ping: string }) => ({ pong: p.ping }),
  Lookup: (p: { word: string }) => {
    const meaning = DICTIONARY.get(p.word);
    if (meaning === undefined) throw new VarlinkError("org.example.reference.NotFound", { word: p.word });
    return { meaning };
  },
  // Streams: each yield is a reply with `continues`; streamOf() returns the last item, so it is the final reply.
  Count: async function* (p: { n: number }) {
    if (p.n < 1 || p.n > MAX_COUNT)
      throw new VarlinkError("org.example.reference.OutOfRange", { n: p.n, max: MAX_COUNT });
    return yield* streamOf(Array.from({ length: p.n }, (_, k) => ({ i: k + 1 })));
  },
  Log: (p: { message: string }) => {
    messages.push(p.message);
    if (messages.length > MAX_MESSAGES) messages.shift();
  },
  Messages: () => ({ messages: [...messages] }),
});

try {
  const listener = await listen(spec, { mode: 0o644 });
  server.serve(listener);
  console.log(`Listening on ${listener.address}`);
} catch (e) {
  console.error(`reference-server: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const stop = (): void => {
  server.shutdown().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(`reference-server: shutdown failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
