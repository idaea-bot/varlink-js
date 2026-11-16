// The four certification cases against another implementation (DESIGN.md §7.4): {JS client → their server,
// their client → JS server (the server.ts CLI)} × {unix path in a temp dir, tcp 127.0.0.1}. python.test.ts and
// rust.test.ts describe how to start their binary and how it reports readiness and success.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test, type TestContext } from "node:test";
import { runCertificationClient } from "../../examples/certification/certification.ts";
import { connect } from "../../src/node/index.ts";
import { gate, SERVER_SCRIPT, spawnChild, tempDir, withDiagnostics, within, type Child } from "./helpers.ts";

export interface Implementation {
  /** Suite name, e.g. "python-varlink". */
  readonly name: string;
  /** Resolves to null when usable, else the reason to skip (a failure under VARLINK_REQUIRE_INTEROP=1). */
  available(): Promise<string | null>;
  /** argv of their certification server listening on `address`. */
  server(address: string): readonly string[];
  /** argv of their certification client connecting to `address`. */
  client(address: string): readonly string[];
  /** The address their server listens on, for a tcp case that may pick the port itself (`tcp:127.0.0.1:0`). */
  tcpAddress(): Promise<string>;
  /** Waits until their server accepts connections; returns the address to dial. */
  ready(child: Child, address: string): Promise<string>;
  /** Asserts that their client (exit code 0 already checked) reported success. */
  passed(child: Child): void;
}

const TIMEOUT = 60_000;

export function certificationSuite(impl: Implementation): void {
  describe(`certification interop: ${impl.name}`, () => {
    let missing: string | null = "not checked";
    const children: Child[] = [];
    const cleanups: (() => Promise<void>)[] = [];
    before(async () => {
      missing = await impl.available();
    });
    after(async () => {
      await Promise.all(children.map((c) => c.kill()));
      for (const c of cleanups) await c();
    });

    const spawn = (argv: readonly string[], current: Child[]): Child => {
      const [command, ...args] = argv;
      if (command === undefined) throw new TypeError("empty argv");
      const c = spawnChild(command, args);
      children.push(c);
      current.push(c);
      return c;
    };

    const address = async (kind: "unix" | "tcp", name: string): Promise<string> => {
      if (kind === "tcp") return impl.tcpAddress();
      const tmp = await tempDir();
      cleanups.push(tmp.remove);
      return `unix:${join(tmp.dir, name)}`;
    };

    for (const kind of ["unix", "tcp"] as const) {
      test(`JS client → ${impl.name} server (${kind})`, { timeout: TIMEOUT }, async (t: TestContext) => {
        if (gate(t, missing) !== null) return;
        const current: Child[] = [];
        await withDiagnostics(
          t,
          () => current,
          async () => {
            const listenOn = await address(kind, "their.sock");
            const server = spawn(impl.server(listenOn), current);
            const dial = await impl.ready(server, listenOn);
            const conn = await connect(dial, { validateReplies: "throw", timeout: 20_000 });
            const lines: string[] = [];
            try {
              await within(
                runCertificationClient(conn, (line) => lines.push(line)),
                TIMEOUT / 2,
                "certification client",
              );
            } finally {
              await conn.close();
              t.diagnostic(lines.join("\n"));
            }
            assert.equal(lines.at(-1), 'End: {"all_ok":true}');
            await server.kill();
          },
        );
      });

      test(`${impl.name} client → JS server (${kind})`, { timeout: TIMEOUT }, async (t: TestContext) => {
        if (gate(t, missing) !== null) return;
        const current: Child[] = [];
        await withDiagnostics(
          t,
          () => current,
          async () => {
            const listenOn = kind === "tcp" ? "tcp:127.0.0.1:0" : await address(kind, "js.sock");
            const server = spawn([process.execPath, SERVER_SCRIPT, `--varlink=${listenOn}`], current);
            const [, dial] = await server.waitForLine(/^Listening on (.+)$/, 20_000);
            assert.ok(dial !== undefined);
            const client = spawn(impl.client(dial), current);
            const { code } = await within(client.exited, TIMEOUT / 2, `${impl.name} client`);
            assert.equal(code, 0, `${impl.name} client exit code`);
            impl.passed(client);
            server.process.kill("SIGTERM");
            assert.deepEqual(await within(server.exited, 10_000, "JS server after SIGTERM"), { code: 0, signal: null });
            assert.equal(server.stderr(), "", "the JS server reported no errors");
          },
        );
      });
    }
  });
}
