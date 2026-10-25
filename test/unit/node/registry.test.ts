// The service registry directory (DESIGN.md §4.6, §5.4): registryDirectory, listRegistry, bindRegistry, and
// serve(listen(unix), {registry}) end to end. Filesystem only: runs on Linux and macOS.
import assert from "node:assert/strict";
import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { mkdir, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { OperationNotSupportedError } from "../../../src/core/errors/index.ts";
import {
  bindRegistry,
  connect,
  listen,
  listenStdio,
  listRegistry,
  mergeListeners,
  registryDirectory,
  resolveInterface,
} from "../../../src/node/index.ts";
import { createServer } from "../../../src/rpc/index.ts";
import { closeServer, listening, realpathOf, tempDir } from "./helpers.ts";

const dir = tempDir();
let seq = 0;
/** A fresh subdirectory name under the temp dir. */
const sub = (name: string): string => join(dir(), `${name}-${String(++seq)}`);

const IDL_A = "interface org.example.rega\n\nmethod Ping() -> (n: int)\n";
const IDL_B = "interface org.example.regb\n\nmethod Ping() -> ()\n";

/** A socket nobody listens on (bound elsewhere, renamed in, the server closed). */
async function staleSocket(path: string): Promise<void> {
  const s = createNetServer();
  await listening(s, { path: `${path}.tmp` });
  await rename(`${path}.tmp`, path);
  await closeServer(s);
}

/** A listening socket of "another service". */
async function liveSocket(path: string): Promise<{ close(): Promise<void> }> {
  const s = createNetServer((c) => c.destroy());
  await listening(s, { path });
  return { close: () => closeServer(s) };
}

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const saved = process.env[name];
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = saved;
  }
}

describe("registryDirectory", () => {
  test("system and user scopes (varlinkctl.c runtime_directory_generic)", () => {
    assert.equal(registryDirectory(), "/run/varlink/registry");
    assert.equal(registryDirectory("system"), "/run/varlink/registry");
    assert.equal(
      withEnv("XDG_RUNTIME_DIR", "/run/user/1000", () => registryDirectory("user")),
      "/run/user/1000/varlink/registry",
    );
  });

  test("user scope needs an absolute XDG_RUNTIME_DIR; bad scopes are TypeErrors", () => {
    for (const value of [undefined, "", "relative/dir"])
      assert.throws(() => withEnv("XDG_RUNTIME_DIR", value, () => registryDirectory("user")), TypeError);
    assert.throws(() => registryDirectory("global" as never), TypeError);
  });
});

describe("listRegistry", () => {
  test("a missing directory is empty", async () => {
    assert.deepEqual(await listRegistry({ directory: join(dir(), "nope") }), []);
  });

  test("sockets and symlinks to sockets, sorted; invalid names, dangling links and non-sockets skipped", async () => {
    const reg = sub("list");
    const elsewhere = sub("sockets");
    await mkdir(reg);
    await mkdir(elsewhere);
    const target = join(elsewhere, "svc.sock");
    const live = await liveSocket(target);
    try {
      await symlink(target, join(reg, "org.example.zeta")); // symlink → socket
      await staleSocket(join(reg, "org.example.alpha")); // a socket entry as is (connectability is not checked)
      await symlink(join(elsewhere, "missing"), join(reg, "org.example.dangling"));
      await writeFile(join(reg, "org.example.file"), "x");
      await writeFile(join(elsewhere, "plain"), "x");
      await symlink(join(elsewhere, "plain"), join(reg, "org.example.tofile"));
      await mkdir(join(reg, "org.example.dir"));
      await symlink(target, join(reg, "notaninterface")); // one component
      await symlink(target, join(reg, ".org.example.hidden"));
      await symlink(target, join(reg, "org.example.bad..name"));
      const entries = await listRegistry({ directory: reg });
      assert.deepEqual(entries, [
        {
          interface: "org.example.alpha",
          address: `unix:${join(reg, "org.example.alpha")}`,
          target: join(reg, "org.example.alpha"),
        },
        {
          interface: "org.example.zeta",
          address: `unix:${join(reg, "org.example.zeta")}`,
          target: await realpathOf(target),
        },
      ]);
    } finally {
      await live.close();
    }
  });

  test("an entry path too long for sun_path is addressed by its target (listRegistry and resolveInterface)", async () => {
    const reg = join(sub("long"), "x".repeat(110));
    await mkdir(reg, { recursive: true });
    const target = join(dir(), "long-target.sock");
    const live = await liveSocket(target);
    try {
      await symlink(target, join(reg, "org.example.long"));
      const real = await realpathOf(target);
      const [entry] = await listRegistry({ directory: reg });
      assert.equal(entry?.address, `unix:${real}`);
      const address = await resolveInterface("org.example.long", { directory: reg, resolver: false });
      assert.equal(address, `unix:${real}`);
      const conn = await connect(address);
      await conn.close();
    } finally {
      await live.close();
    }
  });

  test("invalid options are TypeErrors", async () => {
    await assert.rejects(listRegistry({ directory: "" }), TypeError);
    await assert.rejects(listRegistry({ scope: "auto" as never }), TypeError);
  });
});

describe("bindRegistry", () => {
  test("creates the directory and one symlink per interface to the absolute socket path; unbind removes them", async () => {
    const reg = join(sub("bind"), "nested", "registry");
    const sock = join(sub("s"), "x.sock");
    const binding = await bindRegistry(sock, ["org.example.one", "org.example.two"], { directory: reg });
    assert.ok(lstatSync(reg).isDirectory());
    assert.deepEqual(binding.entries, [join(reg, "org.example.one"), join(reg, "org.example.two")]);
    for (const entry of binding.entries) assert.equal(readlinkSync(entry), sock);
    await binding.unbind();
    await binding.unbind(); // idempotent
    assert.deepEqual(readdirSync(reg), []);
  });

  test("a relative socket path and directory are made absolute", async () => {
    const reg = sub("rel");
    const binding = await bindRegistry(relative(process.cwd(), join(dir(), "rel.sock")), ["org.example.rel"], {
      directory: relative(process.cwd(), reg),
    });
    assert.deepEqual(binding.entries, [join(reg, "org.example.rel")]);
    assert.equal(readlinkSync(join(reg, "org.example.rel")), join(dir(), "rel.sock"));
    await binding.unbind();
  });

  test("an entry already pointing at our socket is adopted (and removed on unbind)", async () => {
    const reg = sub("adopt");
    await mkdir(reg);
    const sock = join(dir(), "adopt.sock");
    await symlink(sock, join(reg, "org.example.adopted"));
    const binding = await bindRegistry(sock, ["org.example.adopted"], { directory: reg });
    assert.deepEqual(binding.entries, [join(reg, "org.example.adopted")]);
    await binding.unbind();
    assert.deepEqual(readdirSync(reg), []);
  });

  test("stale entries are replaced atomically: dangling link, refusing socket, link to a refusing socket", async () => {
    const reg = sub("stale");
    await mkdir(reg);
    const sock = join(dir(), "stale-ours.sock");
    await symlink(join(dir(), "gone.sock"), join(reg, "org.example.dangling"));
    await staleSocket(join(reg, "org.example.socket"));
    const old = join(sub("old"), "old.sock");
    await mkdir(join(old, ".."), { recursive: true });
    await staleSocket(old);
    await symlink(old, join(reg, "org.example.oldlink"));
    const names = ["org.example.dangling", "org.example.socket", "org.example.oldlink"];
    const binding = await bindRegistry(sock, names, { directory: reg });
    for (const name of names) assert.equal(readlinkSync(join(reg, name)), sock, name);
    assert.deepEqual(readdirSync(reg).sort(), [...names].sort(), "no temporary entries left");
    await binding.unbind();
    assert.deepEqual(readdirSync(reg), []);
  });

  test("a live socket of another service, a file or a directory: EEXIST naming the entry; created ones rolled back", async () => {
    const reg = sub("conflict");
    await mkdir(reg);
    const sock = join(dir(), "conflict-ours.sock");
    const otherPath = join(sub("other"), "other.sock");
    await mkdir(join(otherPath, ".."));
    const other = await liveSocket(otherPath);
    try {
      await symlink(otherPath, join(reg, "org.example.live"));
      await writeFile(join(reg, "org.example.file"), "x");
      await mkdir(join(reg, "org.example.dir"));
      await symlink(sock, join(reg, "org.example.mine")); // adopted, so not rolled back
      for (const blocker of ["org.example.live", "org.example.file", "org.example.dir"]) {
        const entry = join(reg, blocker);
        await assert.rejects(
          bindRegistry(sock, ["org.example.first", "org.example.mine", blocker, "org.example.last"], {
            directory: reg,
          }),
          (e: unknown) => {
            assert.equal((e as { code?: unknown }).code, "EEXIST");
            assert.equal((e as { path?: unknown }).path, entry);
            assert.ok((e as Error).message.includes(entry));
            return true;
          },
          blocker,
        );
        assert.deepEqual(
          readdirSync(reg).sort(),
          ["org.example.dir", "org.example.file", "org.example.live", "org.example.mine"],
          blocker,
        );
      }
      assert.equal(readlinkSync(join(reg, "org.example.live")), otherPath, "the live entry is untouched");
      assert.equal(readlinkSync(join(reg, "org.example.mine")), sock);
    } finally {
      await other.close();
    }
  });

  test("unbind leaves entries that are no longer ours alone", async () => {
    const reg = sub("foreign");
    const sock = join(dir(), "foreign-ours.sock");
    const binding = await bindRegistry(sock, ["org.example.relinked", "org.example.file", "org.example.gone"], {
      directory: reg,
    });
    await unlink(join(reg, "org.example.relinked"));
    await symlink(join(dir(), "someone-else.sock"), join(reg, "org.example.relinked"));
    await unlink(join(reg, "org.example.file"));
    await writeFile(join(reg, "org.example.file"), "x");
    await unlink(join(reg, "org.example.gone"));
    await binding.unbind();
    assert.deepEqual(readdirSync(reg).sort(), ["org.example.file", "org.example.relinked"]);
    assert.equal(await readlink(join(reg, "org.example.relinked")), join(dir(), "someone-else.sock"));
  });

  test("a symlink spelled differently (relative) that resolves to our live socket is adopted, kept at unbind", async () => {
    const reg = sub("relative");
    const sock = join(dir(), "rel-live.sock");
    const listener = await listen(`unix:${sock}`);
    try {
      await mkdir(reg, { recursive: true });
      const entry = join(reg, "org.example.rel");
      await symlink(relative(reg, sock), entry);
      // Not taken for "another service listening on it": it is our own socket.
      const binding = await bindRegistry(sock, ["org.example.rel"], { directory: reg });
      assert.deepEqual(binding.entries, [entry]);
      assert.equal(await readlink(entry), relative(reg, sock), "adopted as it is, not replaced");
      await binding.unbind();
      // Removal needs the exact spelling (no realpath matching): it may be another binder's link to the socket.
      assert.equal(await readlink(entry), relative(reg, sock), "a differently spelled entry is left in place");
    } finally {
      await listener.close();
    }
  });

  test("directories it creates are 0755 whatever the umask", async () => {
    const base = sub("umask");
    const reg = join(base, "a", "b", "registry");
    const saved = process.umask(0o077);
    try {
      const binding = await bindRegistry(join(dir(), "umask.sock"), ["org.example.umask"], { directory: reg });
      await binding.unbind();
    } finally {
      process.umask(saved);
    }
    for (const d of [base, join(base, "a"), join(base, "a", "b"), reg])
      assert.equal(lstatSync(d).mode & 0o777, 0o755, d);
  });

  test("invalid or duplicate interface names are TypeErrors before the filesystem is touched", async () => {
    const reg = sub("invalid");
    for (const bad of [["../escape.x"], ["org.example/x"], ["single"], [""], [".."], [5], "org.example.x"])
      await assert.rejects(bindRegistry(join(dir(), "s"), bad as never, { directory: reg }), TypeError, String(bad));
    await assert.rejects(
      bindRegistry(join(dir(), "s"), ["org.example.d", "org.example.d"], { directory: reg }),
      TypeError,
    );
    await assert.rejects(bindRegistry("", ["org.example.d"], { directory: reg }), TypeError);
    await assert.rejects(bindRegistry(join(dir(), "s"), ["org.example.d"], { directory: "" }), TypeError);
    await assert.rejects(bindRegistry(join(dir(), "s"), ["org.example.d"], { scope: "auto" as never }), TypeError);
    assert.throws(() => lstatSync(reg), { code: "ENOENT" });
  });
});

describe("serve(listen(unix), {registry}) end to end", () => {
  test("entries appear, resolve and connect; shutdown removes them before the socket", async () => {
    const reg = sub("e2e");
    const path = join(sub("e2e-sock"), "svc.sock");
    await mkdir(join(path, ".."));
    const server = createServer({ onError: () => undefined });
    server.addInterface(IDL_A, { Ping: () => ({ n: 1 }) });
    server.addInterface(IDL_B, { Ping: () => ({}) });
    const listener = await listen(`unix:${path}`);
    await server.serve(listener, { registry: { directory: reg } });
    const entries = await listRegistry({ directory: reg });
    assert.deepEqual(
      entries.map((e) => [e.interface, e.target]),
      [
        ["org.example.rega", await realpathOf(path)],
        ["org.example.regb", await realpathOf(path)],
      ],
    );
    const address = await resolveInterface("org.example.rega", { directory: reg, resolver: false });
    assert.equal(address, `unix:${join(reg, "org.example.rega")}`);
    const conn = await connect(address);
    assert.deepEqual(await conn.call("org.example.rega.Ping"), { n: 1 });
    await conn.close();
    await server.shutdown();
    assert.deepEqual(readdirSync(reg), []);
    assert.throws(() => lstatSync(path), { code: "ENOENT" });
  });

  test("the accept loop ending (listener closed directly) removes the entries", async () => {
    const reg = sub("loop");
    const server = createServer({ onError: () => undefined });
    server.addInterface(IDL_A, { Ping: () => ({ n: 2 }) });
    const listener = await listen(join(dir(), `loop-${String(++seq)}.sock`));
    await server.serve(listener, { registry: { directory: reg } });
    assert.deepEqual(readdirSync(reg), ["org.example.rega"]);
    await listener.close();
    for (let i = 0; i < 50 && readdirSync(reg).length > 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(readdirSync(reg), []);
    await server.shutdown();
  });

  test("a conflict rejects serve(), leaves nothing behind and closes the listener", async () => {
    const reg = sub("e2e-conflict");
    await mkdir(reg);
    await writeFile(join(reg, "org.example.regb"), "x");
    const server = createServer({ onError: () => undefined });
    server.addInterface(IDL_A, { Ping: () => ({ n: 3 }) });
    server.addInterface(IDL_B, { Ping: () => ({}) });
    const path = join(dir(), `conflict-${String(++seq)}.sock`);
    const listener = await listen(path);
    await assert.rejects(server.serve(listener, { registry: { directory: reg } }), { code: "EEXIST" });
    assert.deepEqual(readdirSync(reg), ["org.example.regb"]);
    assert.throws(() => lstatSync(path), { code: "ENOENT" }, "the listener was closed");
    await server.shutdown();
  });

  test("tcp, abstract and stdio listeners have no bindRegistry; merged ones delegate to a unix member", async () => {
    const server = createServer({ onError: () => undefined });
    server.addInterface(IDL_A, { Ping: () => ({ n: 4 }) });
    const tcp = await listen("tcp:127.0.0.1:0");
    const unix = await listen(join(dir(), `merged-${String(++seq)}.sock`));
    try {
      assert.equal(tcp.bindRegistry, undefined);
      assert.equal("bindRegistry" in listenStdio(), false);
      assert.equal(typeof unix.bindRegistry, "function");
      assert.throws(() => server.serve(tcp, { registry: true }), OperationNotSupportedError);
      assert.throws(() => server.serve(mergeListeners([tcp]), { registry: true }), OperationNotSupportedError);
      assert.throws(() => server.serve(listenStdio(), { registry: true }), OperationNotSupportedError);
      const reg = sub("merged");
      const merged = mergeListeners([tcp, unix]);
      await server.serve(merged, { registry: { directory: reg } });
      assert.equal(readlinkSync(join(reg, "org.example.rega")), unix.address.slice("unix:".length));
      await server.shutdown();
      assert.deepEqual(readdirSync(reg), []);
    } finally {
      await tcp.close();
      await unix.close();
    }
  });

  test(
    "abstract sockets (Linux) have no bindRegistry",
    { skip: process.platform !== "linux" && "Linux-only" },
    async () => {
      const l = await listen(`unix:@varlink-js-reg-${String(process.pid)}`);
      try {
        assert.equal(l.bindRegistry, undefined);
      } finally {
        await l.close();
      }
    },
  );
});
