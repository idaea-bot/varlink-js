// A typed client from the generated module: `node examples/codegen/client.ts ADDRESS`.
import { connect } from "../../src/node/index.ts";
import { NoSuchNote, OrgExampleNotes } from "./org.example.notes.ts";

const address = process.argv[2];
if (address === undefined) throw new Error("usage: node examples/codegen/client.ts ADDRESS");

const conn = await connect(address);
try {
  const notes = OrgExampleNotes.client(conn); // also works with a Pool
  const { id } = await notes.Add({ text: "buy milk", tags: ["shopping"] });
  const { note } = await notes.Get({ id });
  console.log(`note ${String(note.id)}: ${note.text} [${note.tags.join(", ")}]`);

  for await (const reply of notes.List.stream()) console.log(`listed: ${reply.note?.text ?? "(none)"}`);

  try {
    await notes.Get({ id: 999 });
  } catch (e) {
    if (!NoSuchNote.is(e)) throw e;
    console.log(`no note ${String(e.parameters.id)}`); // e.parameters is typed { id: number }
  }
} finally {
  await conn.close();
}
