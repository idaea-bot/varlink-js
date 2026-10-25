// org.varlink.resolver client and resolveInterface (DESIGN.md §4.6), against a JS resolver on a temp unix socket.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  InterfaceNotFoundError,
  isVarlinkError,
  ValidationError,
  VarlinkError,
} from "../../../src/core/errors/index.ts";
import {
  connect,
  listen,
  ORG_VARLINK_RESOLVER_IDL,
  resolveInterface,
  resolverGetInfo,
  resolverResolve,
  type NodeListener,
} from "../../../src/node/index.ts";
import { createServer, type Server } from "../../../src/rpc/index.ts";
import { tempDir } from "./helpers.ts";

const dir = tempDir();
// Unique names: on a Linux host /run/varlink/registry may exist and is searched by the "auto" scope.
const tag = randomBytes(4).toString("hex");
const KNOWN = `org.example.known${tag}`;
const UNKNOWN = `org.example.unknown${tag}`;

interface Resolver {
  server: Server;
  listener: NodeListener;
  address: string;
  resolves: string[];
}

async function startResolver(
  path: string,
  table: Record<string, unknown>,
  info?: Record<string, unknown>,
): Promise<Resolver> {
  const resolves: string[] = [];
  const server = createServer({ onError: () => undefined, validateReplies: "off" });
  server.addInterface(ORG_VARLINK_RESOLVER_IDL, {
    Resolve: (p: { interface: string }) => {
      resolves.push(p.interface);
      if (!(p.interface in table))
        throw new VarlinkError("org.varlink.resolver.InterfaceNotFound", { interface: p.interface });
      return { address: table[p.interface] };
    },
    GetInfo: () =>
      info ?? {
        vendor: "Example",
        product: "resolver",
        version: "1",
        url: "https://example.com",
        interfaces: Object.keys(table),
      },
  });
  const listener = await listen(path);
  server.serve(listener);
  return { server, listener, address: listener.address, resolves };
}

let good: Resolver;

describe("org.varlink.resolver", () => {
  before(async () => {
    good = await startResolver(join(dir(), "resolver"), {
      [KNOWN]: "unix:/run/known.sock",
      "org.example.tcp": "tcp:[::1]:5",
    });
  });
  after(async () => {
    await good.server.shutdown({ graceful: false });
  });

  describe("resolverResolve / resolverGetInfo", () => {
    test("a resolver's answers", async () => {
      const conn = await connect(good.address);
      try {
        assert.equal(await resolverResolve(conn, KNOWN), "unix:/run/known.sock");
        assert.equal(await resolverResolve(conn, "org.example.tcp"), "tcp:[::1]:5");
        await assert.rejects(resolverResolve(conn, UNKNOWN), (e: unknown) =>
          isVarlinkError(e, "org.varlink.resolver.InterfaceNotFound"),
        );
        assert.deepEqual(await resolverGetInfo(conn), {
          vendor: "Example",
          product: "resolver",
          version: "1",
          url: "https://example.com",
          interfaces: [KNOWN, "org.example.tcp"],
        });
      } finally {
        await conn.close();
      }
    });

    test("invalid replies are ValidationErrors", async () => {
      const bad = await startResolver(
        join(dir(), "bad-resolver"),
        { "org.example.num": 5, "org.example.junk": "not an address", "org.example.scheme": "gopher://x" },
        { vendor: "v", product: "p", version: "1", url: "u", interfaces: ["ok", 7] },
      );
      const conn = await connect(bad.address);
      try {
        for (const name of ["org.example.num", "org.example.junk", "org.example.scheme"])
          await assert.rejects(resolverResolve(conn, name), (e: unknown) => {
            assert.ok(e instanceof ValidationError, name);
            assert.equal(e.parameter, "address");
            return true;
          });
        await assert.rejects(
          resolverGetInfo(conn),
          (e: unknown) => e instanceof ValidationError && e.parameter === "interfaces.1",
        );
      } finally {
        await conn.close();
        await bad.server.shutdown({ graceful: false });
      }
    });

    test("only socket addresses: exec:, ssh-*, websocket and http answers are ValidationErrors naming the kind", async () => {
      const rejected = {
        "org.example.exec": ["exec:/bin/sh", "exec"],
        "org.example.sshunix": ["ssh-unix:host:/run/x.sock", "ssh-unix"],
        "org.example.sshexec": ["ssh-exec:host:rm -rf /", "ssh-exec"],
        "org.example.ws": ["ws://host/x", "websocket"],
        "org.example.wss": ["wss://host/x", "websocket"],
        "org.example.http": ["http://host/x", "http"],
        "org.example.https": ["https://host/x", "http"],
      } as const;
      const accepted = {
        "org.example.abs": "unix:@abs",
        "org.example.unix": "unix:/run/x.sock",
        "org.example.tcp": "tcp:h:1",
      };
      const table: Record<string, string> = { ...accepted };
      for (const [name, [address]] of Object.entries(rejected)) table[name] = address;
      const spoof = await startResolver(join(dir(), "spoof-resolver"), table);
      const conn = await connect(spoof.address);
      try {
        for (const [name, address] of Object.entries(accepted))
          assert.equal(await resolverResolve(conn, name), address, name);
        for (const [name, [, kind]] of Object.entries(rejected))
          await assert.rejects(resolverResolve(conn, name), (e: unknown) => {
            assert.ok(e instanceof ValidationError, name);
            assert.equal(e.parameter, "address");
            assert.ok(e.message.includes(`kind ${kind}`), e.message);
            return true;
          });
        // resolveInterface passes it on: nothing to connect() to that would spawn.
        await assert.rejects(
          resolveInterface("org.example.exec", { directory: join(dir(), "none"), resolver: spoof.address }),
          ValidationError,
        );
      } finally {
        await conn.close();
        await spoof.server.shutdown({ graceful: false });
      }
    });
  });

  describe("resolveInterface", () => {
    test("the registry entry wins; the resolver is not asked", async () => {
      const reg = join(dir(), "reg-wins");
      await mkdir(reg);
      await symlink(good.listener.address.slice("unix:".length), join(reg, KNOWN));
      const before = good.resolves.length;
      assert.equal(
        await resolveInterface(KNOWN, { directory: reg, resolver: good.address }),
        `unix:${join(reg, KNOWN)}`,
      );
      assert.equal(good.resolves.length, before);
    });

    test("not (usably) in the registry: the resolver's answer", async () => {
      const reg = join(dir(), "reg-dangling");
      await mkdir(reg);
      await symlink(join(dir(), "nothing-here"), join(reg, KNOWN));
      assert.equal(await resolveInterface(KNOWN, { directory: reg, resolver: good.address }), "unix:/run/known.sock");
      assert.equal(good.resolves.at(-1), KNOWN);
    });

    test("the resolver does not know it: InterfaceNotFoundError with the resolver's error as cause", async () => {
      await assert.rejects(
        resolveInterface(UNKNOWN, { directory: join(dir(), "none"), resolver: good.address }),
        (e: unknown) => {
          assert.ok(e instanceof InterfaceNotFoundError);
          assert.deepEqual(e.parameters, { interface: UNKNOWN });
          assert.ok(isVarlinkError(e.cause, "org.varlink.resolver.InterfaceNotFound"));
          return true;
        },
      );
    });

    test("resolver: false → InterfaceNotFoundError without a cause", async () => {
      await assert.rejects(
        resolveInterface(UNKNOWN, { directory: join(dir(), "none"), resolver: false }),
        (e: unknown) => {
          assert.ok(e instanceof InterfaceNotFoundError);
          assert.equal(e.cause, undefined);
          return true;
        },
      );
    });

    test("an unreachable resolver: InterfaceNotFoundError with the connect error as cause", async () => {
      await assert.rejects(
        resolveInterface(UNKNOWN, { directory: join(dir(), "none"), resolver: `unix:${join(dir(), "no-resolver")}` }),
        (e: unknown) => {
          assert.ok(e instanceof InterfaceNotFoundError);
          assert.equal((e.cause as { code?: unknown }).code, "ENOENT");
          return true;
        },
      );
    });

    test("a peer without org.varlink.resolver: InterfaceNotFoundError", async () => {
      const plain = createServer({ onError: () => undefined });
      const l = await listen(join(dir(), "plain"));
      plain.serve(l);
      try {
        await assert.rejects(
          resolveInterface(UNKNOWN, { directory: join(dir(), "none"), resolver: l.address }),
          (e: unknown) => e instanceof InterfaceNotFoundError && InterfaceNotFoundError.is(e.cause),
        );
      } finally {
        await plain.shutdown({ graceful: false });
      }
    });

    test("scope user: $XDG_RUNTIME_DIR/varlink/registry; auto looks there too", async () => {
      const runtime = join(dir(), "xdg");
      await mkdir(join(runtime, "varlink", "registry"), { recursive: true });
      const name = `org.example.user${tag}`;
      await symlink(good.listener.address.slice("unix:".length), join(runtime, "varlink", "registry", name));
      const saved = process.env.XDG_RUNTIME_DIR;
      process.env.XDG_RUNTIME_DIR = runtime;
      try {
        // Through the entry, unless its path does not fit in sun_path (macOS temp dirs are long): then the target.
        const entry = join(runtime, "varlink", "registry", name);
        const fits = Buffer.byteLength(entry) <= (process.platform === "linux" ? 107 : 103);
        const target = await realpath(good.listener.address.slice("unix:".length));
        const expected = `unix:${fits ? entry : target}`;
        assert.equal(await resolveInterface(name, { scope: "user", resolver: false }), expected);
        assert.equal(await resolveInterface(name, { resolver: false }), expected);
        await assert.rejects(resolveInterface(name, { scope: "system", resolver: false }), InterfaceNotFoundError);
      } finally {
        if (saved === undefined) Reflect.deleteProperty(process.env, "XDG_RUNTIME_DIR");
        else process.env.XDG_RUNTIME_DIR = saved;
      }
    });

    test("invalid names and options are TypeErrors; an aborted signal rejects with its reason", async () => {
      for (const bad of ["", "single", "../x.y", "org.example/x", 5])
        await assert.rejects(resolveInterface(bad as never, { resolver: false }), TypeError, String(bad));
      await assert.rejects(resolveInterface(KNOWN, { resolver: "nope:x" }), TypeError);
      await assert.rejects(resolveInterface(KNOWN, { resolver: 5 as never }), TypeError);
      await assert.rejects(resolveInterface(KNOWN, { scope: "global" as never }), TypeError);
      await assert.rejects(resolveInterface(KNOWN, { timeout: -1 }), RangeError);
      const reason = new Error("stop");
      await assert.rejects(
        resolveInterface(UNKNOWN, {
          directory: join(dir(), "none"),
          resolver: good.address,
          signal: AbortSignal.abort(reason),
        }),
        (e) => e === reason,
      );
    });
  });
});
