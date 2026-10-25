// org.varlink.certification (DESIGN.md §7.4, M5): the JS client against the JS server over every harness
// transport, the server's checks one by one (raw calls), and the example CLIs as child processes.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { isVarlinkError, type Connection, type ServerErrorReason } from "../../src/index.ts";
import type { Server } from "../../src/rpc/index.ts";
import {
  CERTIFICATION_ERROR,
  CERTIFICATION_INTERFACE,
  CERTIFICATION_STEPS,
  CLIENT_ID_ERROR,
  createCertificationServer,
  MORE_REPLIES,
  runCertificationClient,
  type CertificationService,
  type CertificationServiceOptions,
} from "../../examples/certification/certification.ts";
import { pairTransport, transports, type Endpoint } from "../regression/harness.ts";
import { CLIENT_SCRIPT, SERVER_SCRIPT, spawnChild, tempDir, withDiagnostics, within, type Child } from "./helpers.ts";

const I = CERTIFICATION_INTERFACE;
const IDL_URL = new URL("../../interfaces/org.varlink.certification.varlink", import.meta.url);

interface Fixture {
  server: Server;
  service: CertificationService;
  endpoint: Endpoint;
  conn: Connection;
  reported: { error: unknown; reason: ServerErrorReason }[];
  close(): Promise<void>;
}

async function start(transport = pairTransport(), options: CertificationServiceOptions = {}): Promise<Fixture> {
  const reported: Fixture["reported"] = [];
  const { server, service } = await createCertificationServer({
    ...options,
    onError: (error, info) => reported.push({ error, reason: info.reason }),
  });
  const endpoint = await transport.start(server);
  const conn = await endpoint.connect({ validateReplies: "throw", timeout: 10_000 });
  return {
    server,
    service,
    endpoint,
    conn,
    reported,
    close: async () => {
      await conn.close();
      await endpoint.close();
      await server.shutdown({ graceful: false });
    },
  };
}

/** Rejects with the VarlinkError `name`; returns its parameters. */
async function expectError(p: Promise<unknown>, name: string): Promise<Record<string, unknown>> {
  let error: unknown;
  await p.then(
    (v: unknown) => assert.fail(`expected ${name}, got ${JSON.stringify(v)}`),
    (e: unknown) => {
      error = e;
    },
  );
  assert.ok(isVarlinkError(error, name), `expected ${name}, got ${String(error)}`);
  return error.parameters;
}

const m = (name: string): string => `${I}.${name}`;

/** Start, then every step before `stop` called correctly; returns the client_id. */
async function advance(conn: Connection, stop: string): Promise<string> {
  const { client_id: id } = await conn.call(m("Start"));
  assert.equal(typeof id, "string");
  const clientId = id as string;
  for (const step of CERTIFICATION_STEPS) {
    if (step.method === stop) break;
    const parameters = { client_id: clientId, ...step.parameters };
    if (step.kind === "more") {
      const replies = [];
      for await (const r of conn.stream(m(step.method), parameters)) replies.push(r);
      assert.deepEqual(replies, step.replies);
    } else if (step.kind === "oneway") await conn.oneway(m(step.method), parameters);
    else assert.deepEqual(await conn.call(m(step.method), parameters), step.replies[0]);
  }
  return clientId;
}

describe("certification: JS client against JS server", () => {
  for (const transport of transports) {
    test(transport.name, async () => {
      const f = await start(transport);
      try {
        const lines: string[] = [];
        await runCertificationClient(f.conn, (line) => lines.push(line));
        assert.equal(lines.at(-1), 'End: {"all_ok":true}');
        assert.equal(lines.filter((l) => l.startsWith("Test10: ")).length, 10);
        assert.equal(f.service.clients, 0, "End forgets the client");
        // A second run on the same connection works too (fresh client_id).
        await runCertificationClient(f.conn);
        assert.deepEqual(f.reported, [], "our replies pass the IDL (validateReplies: throw)");
      } finally {
        await f.close();
      }
    });
  }
});

describe("certification server checks", () => {
  test("GetInterfaceDescription returns the file byte for byte", async () => {
    const f = await start();
    try {
      assert.equal(await f.conn.getInterfaceDescription(I), await readFile(IDL_URL, "utf8"));
      const info = await f.conn.getInfo();
      assert.equal(info.vendor, "varlink-js");
      assert.equal(info.product, "certification");
      assert.ok(info.interfaces.includes(I));
    } finally {
      await f.close();
    }
  });

  test("unknown client_id → ClientIdError", async () => {
    const f = await start();
    try {
      await expectError(f.conn.call(m("Test01"), { client_id: "nope" }), CLIENT_ID_ERROR);
      await expectError(f.conn.call(m("End"), { client_id: "" }), CLIENT_ID_ERROR);
    } finally {
      await f.close();
    }
  });

  test("wrong order → CertificationError with objects, client forgotten", async () => {
    const f = await start();
    try {
      const id = await advance(f.conn, "Test01");
      const p = await expectError(f.conn.call(m("Test02"), { client_id: id, bool: true }), CERTIFICATION_ERROR);
      assert.deepEqual(p["wants"], { method: m("Test01") });
      assert.deepEqual(p["got"], { method: m("Test02"), parameters: { client_id: id, bool: true } });
      await expectError(f.conn.call(m("Test01"), { client_id: id }), CLIENT_ID_ERROR);
      assert.equal(f.service.clients, 0);
    } finally {
      await f.close();
    }
  });

  test("wrong value → CertificationError, client forgotten", async () => {
    const f = await start();
    try {
      const id = await advance(f.conn, "Test02");
      const p = await expectError(f.conn.call(m("Test02"), { client_id: id, bool: false }), CERTIFICATION_ERROR);
      assert.deepEqual(p["wants"], { method: m("Test02"), parameters: { client_id: id, bool: true } });
      assert.deepEqual(p["got"], { method: m("Test02"), parameters: { client_id: id, bool: false } });
      await expectError(f.conn.call(m("Test03"), { client_id: id, int: 1 }), CLIENT_ID_ERROR);

      // A float that is only close to π is wrong too.
      const id2 = await advance(f.conn, "Test06");
      await expectError(
        f.conn.call(m("Test06"), { client_id: id2, bool: false, int: 2, float: 3.14159, string: "a lot of string" }),
        CERTIFICATION_ERROR,
      );
      // A string set with a missing member.
      const id3 = await advance(f.conn, "Test09");
      await expectError(f.conn.call(m("Test09"), { client_id: id3, set: { one: {}, two: {} } }), CERTIFICATION_ERROR);
    } finally {
      await f.close();
    }
  });

  test("Test10 accepts the nullable fields as null", async () => {
    const f = await start();
    try {
      const id = await advance(f.conn, "Test10");
      const mytype = {
        ...(CERTIFICATION_STEPS[9]?.parameters["mytype"] as object),
        nullable: null,
        nullable_array_struct: null,
      };
      const replies = [];
      for await (const r of f.conn.stream(m("Test10"), { client_id: id, mytype })) replies.push(r["string"]);
      assert.deepEqual(replies, MORE_REPLIES);
    } finally {
      await f.close();
    }
  });

  test("Test10 without more → CertificationError", async () => {
    const f = await start();
    try {
      const id = await advance(f.conn, "Test10");
      const mytype = CERTIFICATION_STEPS[9]?.parameters["mytype"];
      const p = await expectError(f.conn.call(m("Test10"), { client_id: id, mytype }), CERTIFICATION_ERROR);
      assert.equal((p["wants"] as Record<string, unknown>)["more"], true);
      assert.equal((p["got"] as Record<string, unknown>)["more"], undefined);
      await expectError(f.conn.call(m("Test11"), { client_id: id, last_more_replies: [] }), CLIENT_ID_ERROR);
    } finally {
      await f.close();
    }
  });

  test("Test11 not oneway → CertificationError", async () => {
    const f = await start();
    try {
      const id = await advance(f.conn, "Test11");
      const p = await expectError(
        f.conn.call(m("Test11"), { client_id: id, last_more_replies: MORE_REPLIES }),
        CERTIFICATION_ERROR,
      );
      assert.equal((p["wants"] as Record<string, unknown>)["oneway"], true);
      await expectError(f.conn.call(m("End"), { client_id: id }), CLIENT_ID_ERROR);
    } finally {
      await f.close();
    }
  });

  test("a failed oneway Test11 makes End fail", async () => {
    const f = await start();
    try {
      const id = await advance(f.conn, "Test11");
      const wrong = [...MORE_REPLIES].reverse();
      await f.conn.oneway(m("Test11"), { client_id: id, last_more_replies: wrong });
      const p = await expectError(f.conn.call(m("End"), { client_id: id }), CERTIFICATION_ERROR);
      assert.deepEqual(p["got"], {
        method: m("Test11"),
        parameters: { client_id: id, last_more_replies: wrong },
        oneway: true,
      });
      await expectError(f.conn.call(m("End"), { client_id: id }), CLIENT_ID_ERROR);
    } finally {
      await f.close();
    }
  });

  test("at most maxClients live clients (oldest evicted)", async () => {
    const f = await start(pairTransport(), { maxClients: 2 });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await f.conn.call(m("Start")))["client_id"] as string);
      assert.equal(f.service.clients, 2);
      await expectError(f.conn.call(m("Test01"), { client_id: ids[0] }), CLIENT_ID_ERROR);
      assert.deepEqual(await f.conn.call(m("Test01"), { client_id: ids[2] }), { bool: true });
    } finally {
      await f.close();
    }
  });

  test("clients expire after their lifetime (checked on access)", async () => {
    let now = 1_000_000;
    const f = await start(pairTransport(), { now: () => now });
    try {
      const { client_id: id } = await f.conn.call(m("Start"));
      now += 12 * 60 * 60 * 1000 - 1;
      assert.deepEqual(await f.conn.call(m("Test01"), { client_id: id }), { bool: true });
      now += 1;
      await expectError(f.conn.call(m("Test02"), { client_id: id, bool: true }), CLIENT_ID_ERROR);
      assert.equal(f.service.clients, 0);
    } finally {
      await f.close();
    }
  });
});

describe("certification CLIs", () => {
  const children: Child[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  after(async () => {
    await Promise.all(children.map((c) => c.kill()));
    for (const c of cleanups) await c();
  });

  const spawnNode = (script: string, ...args: string[]): Child => {
    const c = spawnChild(process.execPath, [script, ...args]);
    children.push(c);
    return c;
  };

  for (const kind of ["unix", "tcp"] as const) {
    test(`server and client as child processes (${kind})`, { timeout: 60_000 }, async (t) => {
      let address = "tcp:127.0.0.1:0";
      if (kind === "unix") {
        const tmp = await tempDir();
        cleanups.push(tmp.remove);
        address = `unix:${join(tmp.dir, "cert.sock")}`;
      }
      const current: Child[] = [];
      await withDiagnostics(
        t,
        () => current,
        async () => {
          // Both argument styles: --varlink=<address> and --varlink <address>.
          const server = spawnNode(SERVER_SCRIPT, `--varlink=${address}`);
          current.push(server);
          const [, listening] = await server.waitForLine(/^Listening on (.+)$/, 20_000);
          assert.ok(listening !== undefined);
          if (kind === "tcp") assert.match(listening, /^tcp:127\.0\.0\.1:[1-9]\d*$/);
          else assert.equal(listening, address);
          const client = spawnNode(CLIENT_SCRIPT, "--varlink", listening);
          current.push(client);
          const { code } = await within(client.exited, 30_000, "client");
          assert.equal(code, 0);
          assert.equal(client.stdout().trimEnd().split("\n").at(-1), "Certification passed");
          server.process.kill("SIGTERM");
          const exit = await within(server.exited, 10_000, "server after SIGTERM");
          assert.deepEqual(exit, { code: 0, signal: null });
          assert.equal(server.stdout().trim(), `Listening on ${listening}`, "exactly one line on stdout");
          assert.equal(server.stderr(), "");
        },
      );
    });
  }

  test("client exits 1 when the server is not there", { timeout: 30_000 }, async (t) => {
    const tmp = await tempDir();
    cleanups.push(tmp.remove);
    const client = spawnNode(CLIENT_SCRIPT, `--varlink=unix:${join(tmp.dir, "nothing")}`);
    await withDiagnostics(
      t,
      () => [client],
      async () => {
        const { code } = await within(client.exited, 20_000, "client");
        assert.equal(code, 1);
        assert.match(client.stderr(), /Certification failed/);
      },
    );
  });
});
