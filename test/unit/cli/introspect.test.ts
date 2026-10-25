// `info`, `list-interfaces`, `list-methods`, `introspect` in-process (DESIGN.md §4.14), text and JSON, plus one call
// each over the WebSocket and simple HTTP mode bridge fixture of test/unit/websocket.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startBridge, type Bridge } from "../websocket/bridge.ts";
import { SERVICE, startBackend, type Backend } from "../websocket/service.ts";
import { ESC, EXPERIMENTAL_IDL, IDL, RS, rawServer, runCli, startFixture, type Fixture } from "./helpers.ts";
import { formatInterface, parseInterface } from "../../../src/idl/index.ts";

let fx: Fixture;
before(async () => {
  fx = await startFixture();
});
after(async () => {
  await fx.close();
});

const INTERFACES = ["io.github.pzmarzly.varlinkjs", "org.example.cli", "org.example.preview", "org.varlink.service"];

describe("info", () => {
  test("text: varlinkctl's vertical table, interfaces sorted, continuation lines aligned", async () => {
    const r = await runCli(["info", fx.unix]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stdout,
      [
        "    Vendor: varlink-js tests",
        "   Product: cli fixture",
        "   Version: 1",
        "       URL: https://example.org/",
        "Interfaces: io.github.pzmarzly.varlinkjs",
        "            org.example.cli",
        "            org.example.preview",
        "            org.varlink.service",
        "",
      ].join("\n"),
    );
  });

  test("-j / --json=: the whole reply object", async () => {
    const short = await runCli(["info", fx.tcp, "--json=short"]);
    const reply = JSON.parse(short.stdout) as { vendor: string; interfaces: string[] };
    assert.equal(reply.vendor, "varlink-js tests");
    assert.equal(short.stdout.split("\n").length, 2);
    const pretty = await runCli(["-j", "info", fx.tcp], { stdoutTTY: true });
    assert.ok(pretty.stdout.startsWith('{\n\t"vendor" : "varlink-js tests",\n'), pretty.stdout);
    const auto = await runCli(["info", fx.tcp, "-j"]);
    assert.equal(auto.stdout, short.stdout);
    const off = await runCli(["info", fx.tcp, "--json=off"]);
    assert.ok(off.stdout.startsWith("    Vendor: "));
  });

  test("list-interfaces: sorted names; JSON: the interfaces array", async () => {
    const r = await runCli(["list-interfaces", fx.unix]);
    assert.equal(r.stdout, INTERFACES.join("\n") + "\n");
    const j = await runCli(["list-interfaces", fx.unix, "--json=short"]);
    assert.deepEqual([...(JSON.parse(j.stdout) as string[])].sort(), INTERFACES);
  });

  test("peer-controlled text is escaped in the table", async () => {
    const info = { vendor: `v${ESC}[31m`, product: "p\n2", version: "1", url: "u", interfaces: ["a.b"] };
    const raw = await rawServer([JSON.stringify({ parameters: info })]);
    try {
      const r = await runCli(["info", raw.address]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.stdout.includes("    Vendor: v\\x1b[31m\n"));
      assert.ok(r.stdout.includes("   Product: p\\x0a2\n"));
      assert.ok(!r.stdout.includes(ESC));
    } finally {
      await raw.close();
    }
  });

  test("an invalid GetInfo reply fails in text mode", async () => {
    const raw = await rawServer([JSON.stringify({ parameters: { vendor: 1 } })]);
    try {
      const r = await runCli(["info", raw.address]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /^Invalid org\.varlink\.service\.GetInfo\(\) reply: /);
    } finally {
      await raw.close();
    }
  });

  test("argument count and connect failures", async () => {
    const none = await runCli(["info"]);
    assert.equal(none.code, 1);
    assert.equal(none.stderr, "Too few arguments.\nSee 'varlink-js --help'.\n");
    const many = await runCli(["info", "a", "b"]);
    assert.equal(many.stderr, "Too many arguments.\nSee 'varlink-js --help'.\n");
    const refused = await runCli(["info", "unix:/nonexistent/x"]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^Failed to connect to unix:\/nonexistent\/x: /);
  });
});

describe("list-methods", () => {
  test("all interfaces, sorted and unique; (experimental) only on a TTY", async () => {
    const r = await runCli(["list-methods", fx.unix]);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trimEnd().split("\n");
    assert.deepEqual(lines, [...lines].sort());
    assert.ok(lines.includes("org.example.cli.Echo"));
    assert.ok(lines.includes("org.example.cli.Preview"));
    assert.ok(lines.includes("org.varlink.service.GetInfo"));
    const tty = await runCli(["list-methods", fx.unix], { stdoutTTY: true });
    const ttyLines = tty.stdout.trimEnd().split("\n");
    assert.ok(ttyLines.includes("org.example.cli.Preview (experimental)"));
    assert.ok(ttyLines.includes("org.example.preview.Try (experimental)"));
    assert.ok(ttyLines.includes("org.example.cli.Echo"));
  });

  test("given interfaces; JSON: one array", async () => {
    const r = await runCli(["list-methods", fx.unix, "org.example.preview", "org.example.preview"]);
    assert.equal(r.stdout, "org.example.preview.Try\n");
    const j = await runCli(["list-methods", fx.unix, "org.example.cli", "--json=short"]);
    assert.equal(
      j.stdout,
      '["org.example.cli.Count","org.example.cli.Echo","org.example.cli.Fail","org.example.cli.Hang","org.example.cli.Log","org.example.cli.Monitor","org.example.cli.Preview"]\n',
    );
  });

  test("invalid interface names are rejected before connecting", async () => {
    const r = await runCli(["list-methods", "unix:/nonexistent/x", "org.example.cli", "nope"]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, "Not a valid Varlink interface name: 'nope'\n");
  });

  test("an unknown interface: the error reply's name", async () => {
    const r = await runCli(["list-methods", fx.unix, "org.example.missing"]);
    assert.equal(r.code, 1);
    assert.equal(
      r.stderr,
      "Method call org.varlink.service.GetInterfaceDescription() failed: org.varlink.service.InterfaceNotFound\n",
    );
  });
});

describe("introspect", () => {
  test("one interface: the canonical formatting", async () => {
    const r = await runCli(["introspect", fx.unix, "org.example.cli"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, formatInterface(parseInterface(IDL)));
  });

  test("several: separated by a blank line; none = all", async () => {
    const r = await runCli(["introspect", fx.unix, "org.example.preview", "org.example.cli"]);
    assert.equal(
      r.stdout,
      `${formatInterface(parseInterface(EXPERIMENTAL_IDL))}\n${formatInterface(parseInterface(IDL))}`,
    );
    const all = await runCli(["introspect", fx.unix]);
    assert.equal(all.code, 0, all.stderr);
    assert.equal(all.stdout.match(/^interface /gm)?.length, INTERFACES.length);
  });

  test("JSON: the reply object; JSON-SEQ for more than one", async () => {
    const one = await runCli(["introspect", fx.unix, "org.example.preview", "--json=short"]);
    assert.equal(one.stdout, `${JSON.stringify({ description: EXPERIMENTAL_IDL })}\n`);
    const two = await runCli(["introspect", fx.unix, "org.example.preview", "org.example.preview", "--json=short"]);
    const record = `${RS}${JSON.stringify({ description: EXPERIMENTAL_IDL })}\n`;
    assert.equal(two.stdout, record + record);
  });

  test("an unparsable description: warned on stderr, printed raw (escaped)", async () => {
    const description = `interface a.b\nbroken ${ESC}stuff`;
    const raw = await rawServer([JSON.stringify({ parameters: { description } })]);
    try {
      const r = await runCli(["introspect", raw.address, "a.b"]);
      assert.equal(r.code, 0);
      assert.match(
        r.stderr,
        /^Failed to parse returned interface description at 2:1, showing raw interface description: /,
      );
      assert.equal(r.stdout, "interface a.b\nbroken \\x1bstuff\n");
    } finally {
      await raw.close();
    }
    const raw2 = await rawServer([JSON.stringify({ parameters: { description } })]);
    try {
      const r = await runCli(["list-methods", raw2.address, "a.b"]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /^Failed to parse returned interface description at 2:1: /);
    } finally {
      await raw2.close();
    }
  });
});

describe("WebSocket and simple HTTP mode", () => {
  let backend: Backend;
  let bridge: Bridge;
  let single: Bridge;
  before(async () => {
    backend = startBackend();
    bridge = await startBridge({ backend: () => backend.connect(), services: [SERVICE, "org.varlink.service"] });
    single = await startBridge({ backend: () => backend.connect(), services: [SERVICE] });
  });
  after(async () => {
    await bridge.close();
    await single.close();
    await backend.stop();
  });

  test("call over WebSocket mode", async () => {
    const r = await runCli(["call", bridge.wsUrl(SERVICE), `${SERVICE}.Echo`, '{"text":"hi"}']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '{"text":"hi"}\n');
  });

  test("call and --more over simple HTTP mode; --oneway is refused clearly", async () => {
    const r = await runCli(["call", bridge.base, `${SERVICE}.Echo`, '{"text":"hi"}']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '{"text":"hi"}\n');
    const more = await runCli(["call", "--more", bridge.base, `${SERVICE}.Count`, '{"n":2}']);
    assert.equal(more.stdout, `${RS}{"i":0}\n${RS}{"i":1}\n`);
    const oneway = await runCli(["call", "--oneway", bridge.base, `${SERVICE}.Log`, '{"text":"x"}']);
    assert.equal(oneway.code, 1);
    assert.match(oneway.stderr, /simple HTTP mode has no oneway calls/);
  });

  test("info over simple HTTP mode: the bridge's only service, else a clear error", async () => {
    const r = await runCli(["list-interfaces", single.base]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.split("\n").includes(SERVICE));
    const many = await runCli(["info", bridge.base]);
    assert.equal(many.code, 1);
    assert.match(many.stderr, /simple HTTP mode cannot tell which service to ask/);
    const named = await runCli(["introspect", bridge.base, SERVICE]);
    assert.equal(named.code, 0, named.stderr);
    assert.match(named.stdout, /^interface org\.example\.ws\n/);
  });
});
