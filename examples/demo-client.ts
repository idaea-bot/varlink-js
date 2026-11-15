// Calls examples/server.ts: `node examples/demo-client.ts ADDRESS` (the address the server printed).
import { isVarlinkError } from "../src/index.ts";
import { connect } from "../src/node/index.ts";

const address = process.argv[2];
if (address === undefined) throw new Error("usage: node examples/demo-client.ts ADDRESS");

const conn = await connect(address);
try {
  const { greeting } = await conn.call("org.example.demo.Hello", { name: "world" });
  console.log(greeting); // Hello, world!

  // `more`: one iteration per reply, the final one included.
  for await (const reply of conn.stream("org.example.demo.Count", { n: 3 })) console.log(reply.i); // 1 2 3

  try {
    await conn.collect("org.example.demo.Count", { n: 1000 }); // collect(): all replies as an array
  } catch (e) {
    if (!isVarlinkError(e, "org.example.demo.OutOfRange")) throw e;
    console.log(`${e.error}: max is ${String(e.parameters.max)}`);
  }
} finally {
  await conn.close();
}
