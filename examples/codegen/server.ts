// A typed server from the generated module: `node examples/codegen/server.ts [ADDRESS]` (default tcp:127.0.0.1:0).
import { createServer, streamOf } from "../../src/index.ts";
import { listen } from "../../src/node/index.ts";
import { NoSuchNote, OrgExampleNotes, type Note } from "./org.example.notes.ts";

const notes = new Map<number, Note>();
let nextId = 1;

const server = createServer({ vendor: "Example", product: "notes", version: "1.0", url: "https://example.org" });
// Handlers are typed from the IDL: parameters, results and yielded replies.
server.implement(OrgExampleNotes, {
  Add({ text, tags }) {
    const id = nextId++;
    notes.set(id, { id, text, tags: tags ?? [] });
    return { id };
  },
  Get({ id }) {
    const note = notes.get(id);
    if (note === undefined) throw new NoSuchNote({ id }); // a generated error class
    return { note };
  },
  // streamOf() holds one item back so the last note goes out as the final reply.
  async *List() {
    return yield* streamOf([...notes.values()].map((note) => ({ note })));
  },
});

const listener = await listen(process.argv[2] ?? "tcp:127.0.0.1:0", { mode: 0o644 });
server.serve(listener);
const stop = (): void => {
  void server.shutdown().then(() => process.exit(0));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

// Handlers first, then the line the caller waits for, so an early signal still shuts down cleanly.
console.log(`Listening on ${listener.address}`);
