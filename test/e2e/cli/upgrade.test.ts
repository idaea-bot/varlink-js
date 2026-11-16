// `varlink-js call --upgrade` as a real process (DESIGN.md §4.14, M9): `node src/cli/main.ts` as a child against a
// server in this process (unix socket) and against an exec: child. Node only (spawns process.execPath with the .ts
// file). Every test waits for the child to exit by itself, so a dangling handle fails it (by timeout).
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { createServer, PermissionDeniedError, type CallContext, type Server } from "../../../src/index.ts";
import { listen } from "../../../src/node/index.ts";
import { waitFor } from "../../unit/cli/helpers.ts";

const MAIN = fileURLToPath(new URL("../../../src/cli/main.ts", import.meta.url));
const EXEC_CHILD = fileURLToPath(new URL("../../unit/cli/exec-child.ts", import.meta.url));
const T = { timeout: 60_000 };
const IDL = `interface org.example.e2eup

# [Requires 'upgrade' flag]
method Upper(tag: ?string) -> ()

# [Supports 'upgrade' flag]
method Deny() -> ()

# Writes "BYE\\n" and ends its side at once, then reads to EOF.
# [Requires 'upgrade' flag]
method EndFirst() -> ()

# Reads one chunk, writes its first line back and closes, the rest unread (like \`head -n1\`).
# [Requires 'upgrade' flag]
method Head() -> ()
`;
const I = "org.example.e2eup";

interface Child {
  readonly child: ChildProcessWithoutNullStreams;
  stdout(): Buffer;
  stderr(): string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function start(args: readonly string[]): Child {
  const child = spawn(process.execPath, [MAIN, ...args], {
    env: { ...process.env, VARLINK_JS_DEBUG: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (b: Buffer) => out.push(b));
  child.stderr.on("data", (b: Buffer) => err.push(b));
  child.stdin.on("error", () => undefined);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  return { child, stdout: () => Buffer.concat(out), stderr: () => Buffer.concat(err).toString("utf8"), exited };
}

/** `yes | CLI`: feeds "y\n" lines to the child's stdin, with backpressure, until the child stops reading or exits. */
function feedYes(c: Child): void {
  const chunk = Buffer.from("y\n".repeat(8192));
  const stdin = c.child.stdin;
  let stopped = false;
  stdin.once("error", () => (stopped = true));
  stdin.once("close", () => (stopped = true));
  const pump = (): void => {
    while (!stopped && stdin.write(chunk));
    if (!stopped) stdin.once("drain", pump);
  };
  pump();
}

async function runBin(
  args: readonly string[],
  stdin: string | Buffer = "",
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  const c = start(args);
  c.child.stdin.end(stdin);
  const { code } = await c.exited;
  return { code, stdout: c.stdout(), stderr: c.stderr() };
}

let server: Server;
let dir: string;
let address: string;
const tags: unknown[] = [];
const endFirst = { text: "", done: false };
/** A plain unix socket server whose connections give a child one socket as both stdin and stdout. */
let listener: NetServer;
let socketPath: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "vj-e2eup-"));
  server = createServer({ onError: () => undefined });
  server.addInterface(IDL, {
    Upper: async (p: { tag?: string | null }, ctx: CallContext) => {
      tags.push(p.tag ?? null);
      const ch = await ctx.upgrade();
      for (let c = await ch.read(); c !== null; c = await ch.read())
        await ch.write(c.bytes.map((b) => (b >= 0x61 && b <= 0x7a ? b - 0x20 : b)));
      await ch.end();
    },
    Deny: () => {
      throw new PermissionDeniedError();
    },
    EndFirst: async (_p: unknown, ctx: CallContext) => {
      const ch = await ctx.upgrade();
      await ch.write(new TextEncoder().encode("BYE\n"));
      await ch.end();
      const decoder = new TextDecoder();
      for (let c = await ch.read(); c !== null; c = await ch.read())
        endFirst.text += decoder.decode(c.bytes, { stream: true });
      endFirst.done = true;
    },
    Head: async (_p: unknown, ctx: CallContext) => {
      const ch = await ctx.upgrade();
      const c = await ch.read();
      const line = c === null ? "" : (new TextDecoder().decode(c.bytes).split("\n")[0] ?? "");
      await ch.write(new TextEncoder().encode(`${line}\n`));
      ch.close();
      await ch.closed;
    },
  });
  address = `unix:${join(dir, "s")}`;
  server.serve(await listen(address));
  // Half-open: the test sees the CLI's FIN and still writes stdin's rest.
  listener = createNetServer({ allowHalfOpen: true });
  socketPath = join(dir, "fwd");
  if (process.platform !== "win32") await new Promise<void>((resolve) => listener.listen(socketPath, resolve));
});

after(async () => {
  if (listener.listening) await new Promise((resolve) => listener.close(resolve));
  await server.shutdown({ graceful: false });
  await rm(dir, { recursive: true, force: true });
});

describe("varlink-js call --upgrade (real process)", () => {
  test("piped stdin comes back upper-cased on stdout; stdin EOF → exit 0 with the full output", T, async () => {
    const r = await runBin(["call", "--upgrade", address, `${I}.Upper`], "hello, world\n");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.equal(r.stdout.toString("utf8"), "HELLO, WORLD\n");
  });

  test("4 MiB through the pipe, intact", T, async () => {
    const input = Buffer.alloc(4 * 1024 * 1024);
    for (let i = 0; i < input.length; i++) input[i] = 0x61 + (i % 26);
    const r = await runBin(["call", "--upgrade", address, `${I}.Upper`], input);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.length, input.length);
    assert.ok(r.stdout.equals(input.map((b) => b - 0x20)));
  });

  test("PARAMETERS: '-' is {}, argv JSON is sent; stdin stays the stream", T, async () => {
    tags.length = 0;
    const dash = await runBin(["call", "--upgrade", address, `${I}.Upper`, "-"], '{"tag":"no"}');
    const argv = await runBin(["call", "--upgrade", address, `${I}.Upper`, '{"tag":"yes"}'], "x");
    assert.deepEqual(
      [dash.code, dash.stdout.toString(), argv.code, argv.stdout.toString()],
      [0, '{"TAG":"NO"}', 0, "X"],
    );
    assert.deepEqual(tags, [null, "yes"]);
  });

  test("an error reply: exit 1 and the message", T, async () => {
    const r = await runBin(["call", "--upgrade", address, `${I}.Deny`]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout.length, 0);
    assert.equal(r.stderr, `Upgrade via ${I}.Deny() failed with error: org.varlink.service.PermissionDenied\n`);
  });

  test("flag combinations are usage errors", T, async () => {
    for (const flag of ["--more", "--collect", "--oneway", "-E", "--graceful=a.b.C"]) {
      const r = await runBin(["call", "--upgrade", flag, address, `${I}.Upper`]);
      assert.equal(r.code, 1, flag);
      assert.equal(
        r.stderr,
        "--upgrade may not be combined with --collect/--more/--oneway/--push-fd=/--graceful.\nSee 'varlink-js --help'.\n",
        flag,
      );
    }
  });

  test(
    "the service ends first: stdout's reader sees EOF while stdin is still open (a real pipe), exit 0 after stdin EOF",
    { ...T, skip: process.platform === "win32" ? "Windows: no /bin/sh pipeline" : false },
    async () => {
      endFirst.text = "";
      endFirst.done = false;
      // stdout is a FIFO (a real pipe, not the socketpair Node gives a child, where end() alone would do) read by
      // `cat`, which reports its EOF on stderr; the shell holds no write end and exits with the CLI's status. (A Node
      // reader would not do: on macOS it does not see a FIFO stdin's EOF.) The CLI runs via `( exec … > FIFO )`: dash (Ubuntu's
      // /bin/sh) keeps its own copy of the redirected fd open while a plain `cmd > FIFO` runs, so the reader would never
      // see EOF from the shell side.
      const readerDir = await mkdtemp(join(dir, "r-"));
      const script =
        'mkfifo "$VJ_FIFO" || exit 99; { cat < "$VJ_FIFO"; echo "<reader EOF>" >&2; } & ( exec "$0" "$@" > "$VJ_FIFO" ); ' +
        "code=$?; wait; exit $code";
      const child = spawn(
        "/bin/sh",
        ["-c", script, process.execPath, MAIN, "call", "--upgrade", address, `${I}.EndFirst`],
        {
          env: { ...process.env, VARLINK_JS_DEBUG: "", VJ_FIFO: join(readerDir, "fifo") },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const out: Buffer[] = [];
      let err = "";
      child.stdout.on("data", (b: Buffer) => out.push(b));
      child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
      child.stdin.on("error", () => undefined);
      const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
      // An object, so that TypeScript does not narrow the flag across the awaits.
      const status = { exited: false };
      void exited.then(() => (status.exited = true));
      try {
        await waitFor(() => err.includes("<reader EOF>"), 20_000);
        assert.equal(Buffer.concat(out).toString(), "BYE\n");
        assert.equal(status.exited, false, "the command waits for stdin's EOF");
        child.stdin.write("still ");
        await waitFor(() => endFirst.text === "still ", 20_000);
        child.stdin.end("forwarded");
        assert.equal(await exited, 0, err);
        await waitFor(() => endFirst.done, 20_000);
        assert.equal(endFirst.text, "still forwarded");
        assert.equal(err, "<reader EOF>\n");
      } finally {
        // On a failure: stdin's EOF ends the command, then `cat` and the shell (killing the shell would not).
        if (!status.exited) {
          child.stdin.end();
          await exited;
        }
      }
    },
  );

  test(
    "stdin and stdout are one socket (socat EXEC, inetd style): the service's end shuts its write side down at once",
    { ...T, skip: process.platform === "win32" ? "Windows: no early EOF" : false },
    async () => {
      endFirst.text = "";
      endFirst.done = false;
      // The child gets one end of a unix socket connection as both fd 0 and fd 1 (Node dups a net.Socket passed in
      // stdio); closing fd 1 alone would send no FIN, as fd 0 still holds the socket: only shutdown(SHUT_WR) does.
      const peerSocket = new Promise<Socket>((resolve) => {
        listener.once("connection", resolve);
      });
      const client = createConnection(socketPath);
      await new Promise<void>((resolve, reject) => {
        client.once("connect", resolve);
        client.once("error", reject);
      });
      const peer = await peerSocket;
      const child = spawn(process.execPath, [MAIN, "call", "--upgrade", address, `${I}.EndFirst`], {
        env: { ...process.env, VARLINK_JS_DEBUG: "" },
        stdio: [client, client, "pipe"],
      });
      // Only the child holds that end now.
      client.destroy();
      let got = "";
      let err = "";
      const status = { exited: false, peerEnded: false };
      peer.on("data", (b: Buffer) => (got += b.toString("utf8")));
      peer.on("end", () => (status.peerEnded = true));
      peer.on("error", () => undefined);
      child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
      const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
      void exited.then(() => (status.exited = true));
      try {
        await waitFor(() => status.peerEnded, 20_000);
        assert.equal(got, "BYE\n");
        assert.equal(status.exited, false, "the command waits for stdin's EOF");
        peer.write("still ");
        await waitFor(() => endFirst.text === "still ", 20_000);
        peer.end("forwarded");
        assert.equal(await exited, 0, err);
        await waitFor(() => endFirst.done, 20_000);
        assert.equal(endFirst.text, "still forwarded");
        assert.equal(err, "");
      } finally {
        if (!status.exited) {
          peer.destroy();
          await exited;
        }
        peer.destroy();
      }
    },
  );

  test(
    "stdout and stderr are the same pipe (2>&1): no early EOF, the reader sees EOF when the command exits",
    { ...T, skip: process.platform === "win32" ? "Windows: no /bin/sh pipeline" : false },
    async () => {
      endFirst.text = "";
      endFirst.done = false;
      // As in the FIFO test above, but with 2>&1: fd 2 keeps the pipe open, so closing fd 1 would gain nothing; the
      // CLI leaves fd 1 alone.
      const readerDir = await mkdtemp(join(dir, "r-"));
      const script =
        'mkfifo "$VJ_FIFO" || exit 99; { cat < "$VJ_FIFO"; echo "<reader EOF>" >&2; } & ( exec "$0" "$@" > "$VJ_FIFO" 2>&1 ); ' +
        "code=$?; wait; exit $code";
      const child = spawn(
        "/bin/sh",
        ["-c", script, process.execPath, MAIN, "call", "--upgrade", address, `${I}.EndFirst`],
        {
          env: { ...process.env, VARLINK_JS_DEBUG: "", VJ_FIFO: join(readerDir, "fifo") },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const out: Buffer[] = [];
      let err = "";
      child.stdout.on("data", (b: Buffer) => out.push(b));
      child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
      child.stdin.on("error", () => undefined);
      const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
      const status = { exited: false };
      void exited.then(() => (status.exited = true));
      try {
        await waitFor(() => Buffer.concat(out).toString() === "BYE\n", 20_000);
        child.stdin.write("still ");
        await waitFor(() => endFirst.text === "still ", 20_000);
        assert.equal(err, "", "no EOF for the reader while the command runs");
        child.stdin.end("forwarded");
        assert.equal(await exited, 0, err);
        assert.equal(err, "<reader EOF>\n");
        assert.equal(Buffer.concat(out).toString(), "BYE\n");
      } finally {
        if (!status.exited) {
          child.stdin.end();
          await exited;
        }
      }
    },
  );

  // M9 VM interop: `yes | varlink-js call --upgrade … Head` printed nothing (exit 0) because our failing writes made
  // Node destroy the socket before the service's answer was read. Over a unix socket and over exec: (a socketpair).
  test("yes-like stdin, the service answers one line and closes: stdout has the answer, exit 0", T, async () => {
    for (let run = 0; run < 3; run++) {
      const c = start(["call", "--upgrade", address, `${I}.Head`]);
      feedYes(c);
      const { code } = await c.exited;
      assert.equal(code, 0, c.stderr());
      assert.equal(c.stderr(), "");
      assert.equal(c.stdout().toString(), "y\n", `run ${String(run)}`);
    }
  });

  test(
    "exec: yes-like stdin, the child answers one line and closes: stdout has the answer, exit 0",
    { ...T, skip: process.platform === "win32" ? "Windows: the exec: fixture is a /bin/sh script" : false },
    async () => {
      const childDir = await mkdtemp(join(dir, "h-"));
      const wrapper = join(childDir, "child.sh");
      await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${EXEC_CHILD}" "--state=${childDir}" "$@"\n`, {
        mode: 0o755,
      });
      const c = start(["call", "--upgrade", `exec:${wrapper}`, "org.example.execchild.Head"]);
      feedYes(c);
      const { code } = await c.exited;
      assert.equal(code, 0, c.stderr());
      assert.equal(c.stdout().toString(), "y\n");
    },
  );

  test("SIGINT while piping: exit 130", T, async () => {
    const c = start(["call", "--upgrade", address, `${I}.Upper`]);
    c.child.stdin.write("ping");
    await waitFor(() => c.stdout().toString() === "PING", 20_000);
    c.child.kill("SIGINT");
    const { code } = await c.exited;
    assert.equal(code, 130);
  });

  test(
    "exec: address: the child serves the upgrade, then exits once the stream is done",
    { ...T, skip: process.platform === "win32" ? "Windows: the exec: fixture is a /bin/sh script" : false },
    async () => {
      const childDir = await mkdtemp(join(dir, "c-"));
      const wrapper = join(childDir, "child.sh");
      await writeFile(
        wrapper,
        `#!/bin/sh\necho $$ > "${childDir}/pid"\nexec "${process.execPath}" "${EXEC_CHILD}" "--state=${childDir}" "$@"\n`,
        { mode: 0o755 },
      );
      const r = await runBin(["call", "--upgrade", `exec:${wrapper}`, "org.example.execchild.Upper"], "via exec\n");
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.toString(), "VIA EXEC\n");
      const pidFile = join(childDir, "pid");
      assert.ok(existsSync(pidFile));
      const pid = Number(readFileSync(pidFile, "utf8"));
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 20_000);
    },
  );
});
