// Address parser (DESIGN.md §4.6, §4.11): every syntax, invalid ones, canonical formatting and the round trip.
// Property runs use a fixed seed; VARLINK_FC_SEED / VARLINK_FC_RUNS override.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { formatAddress, parseAddress, type AddressSpec } from "../../../src/index.ts";

const SEED = Number(process.env.VARLINK_FC_SEED ?? 20261025);
const RUNS = Number(process.env.VARLINK_FC_RUNS ?? 200);

const VALID: [string, AddressSpec, string?][] = [
  ["unix:/run/x", { kind: "unix", path: "/run/x" }],
  ["unix:rel/./path", { kind: "unix", path: "rel/./path" }],
  ["/abs/path", { kind: "unix", path: "/abs/path" }, "unix:/abs/path"],
  ["./rel", { kind: "unix", path: "./rel" }, "unix:./rel"],
  ["../rel", { kind: "unix", path: "../rel" }, "unix:../rel"],
  ["unix:/run/x;mode=0600", { kind: "unix", path: "/run/x" }, "unix:/run/x"],
  ["unix:@name", { kind: "unix-abstract", name: "name" }],
  ["unix:@with space:and@at", { kind: "unix-abstract", name: "with space:and@at" }],
  ["tcp:127.0.0.1:8080", { kind: "tcp", host: "127.0.0.1", port: 8080 }],
  ["tcp:localhost:0", { kind: "tcp", host: "localhost", port: 0 }],
  ["tcp:h:65535", { kind: "tcp", host: "h", port: 65535 }],
  ["tcp:h:080", { kind: "tcp", host: "h", port: 80 }, "tcp:h:80"],
  ["tcp:[::1]:12345", { kind: "tcp", host: "::1", port: 12345 }],
  ["tcp:[fe80::1%eth0]:1", { kind: "tcp", host: "fe80::1%eth0", port: 1 }],
  ["tcp:h:1;ext", { kind: "tcp", host: "h", port: 1 }, "tcp:h:1"],
  ["exec:/usr/lib/systemd/systemd-pcrextend", { kind: "exec", path: "/usr/lib/systemd/systemd-pcrextend" }],
  ["exec:relative", { kind: "exec", path: "relative" }],
  ["ssh-unix:host:/run/x", { kind: "ssh-unix", host: "host", path: "/run/x" }],
  ["ssh:user@host:/run/x", { kind: "ssh-unix", host: "user@host", path: "/run/x" }, "ssh-unix:user@host:/run/x"],
  ["ssh-unix:h:/a:b", { kind: "ssh-unix", host: "h", path: "/a:b" }],
  ["ssh-exec:host:systemd-creds --json", { kind: "ssh-exec", host: "host", command: "systemd-creds --json" }],
  ["ws://h/x", { kind: "websocket", url: "ws://h/x" }],
  ["wss://h:8443/a;b", { kind: "websocket", url: "wss://h:8443/a;b" }],
  ["http://h/ws/services/io.systemd.Hostname", { kind: "websocket", url: "http://h/ws/services/io.systemd.Hostname" }],
  ["https://h/x/ws/services/svc", { kind: "websocket", url: "https://h/x/ws/services/svc" }],
  ["http://h", { kind: "http", url: "http://h/" }, "http://h/"],
  ["https://h/bridge;v=1", { kind: "http", url: "https://h/bridge;v=1" }],
  ["https://h/ws/services/", { kind: "http", url: "https://h/ws/services/" }],
  ["HTTP://H/x", { kind: "http", url: "http://h/x" }, "http://h/x"],
];

const INVALID: string[] = [
  "",
  "unix:",
  "unix:@",
  "unix:/a\0b",
  "unix:@a\0b",
  "/a\0",
  "rel/path",
  "tcp:",
  "tcp:host",
  "tcp::80",
  "tcp:h:",
  "tcp:h:65536",
  "tcp:h:-1",
  "tcp:h:+1",
  "tcp:h: 1",
  "tcp:h:1e3",
  "tcp:h:000080",
  "tcp:[::1]",
  "tcp:[::1]80",
  "tcp:[1.2.3.4]:80",
  "tcp:[::1:80",
  "tcp:a]b:80",
  "tcp:[]:80",
  "exec:",
  "ssh-unix:host",
  "ssh-unix::/x",
  "ssh-unix:host:relative",
  "ssh:host:",
  "ssh-exec:host",
  "ssh-exec:host:",
  "ssh-exec::cmd",
  "http://",
  "ws://[",
  "foo:bar",
  "varlink:/x",
];

describe("parseAddress", () => {
  for (const [input, spec] of VALID) {
    test(`valid: ${JSON.stringify(input)}`, () => {
      assert.deepEqual(parseAddress(input), spec);
    });
  }
  for (const input of INVALID) {
    test(`invalid: ${JSON.stringify(input)}`, () => {
      assert.throws(() => parseAddress(input), TypeError);
    });
  }

  test("the message quotes the input log-safely and cut to 256 code units", () => {
    assert.throws(
      () => parseAddress("bogus\n\u202e\x1b[31m"),
      (e: unknown) =>
        e instanceof TypeError &&
        e.message.includes("\\u000a\\u202e\\u001b") &&
        !["\n", "\u202e", "\x1b"].some((c) => e.message.includes(c)),
    );
    const long = `x${"a".repeat(5000)}`;
    assert.throws(
      () => parseAddress(long),
      (e: unknown) => e instanceof TypeError && e.message.length < 400 && e.message.includes("…"),
    );
  });

  test("a non-string is a TypeError", () => {
    assert.throws(() => parseAddress(5 as never), TypeError);
  });
});

describe("formatAddress", () => {
  for (const [input, spec, canonical] of VALID) {
    test(`canonical form of ${JSON.stringify(input)}`, () => {
      assert.equal(formatAddress(spec), canonical ?? input);
    });
  }

  test("specs without a string form that parses back are TypeErrors", () => {
    for (const spec of [
      { kind: "unix", path: "@x" },
      { kind: "unix", path: "/a;b" },
      { kind: "unix", path: "" },
      { kind: "tcp", host: "h", port: 70000 },
      { kind: "tcp", host: "h", port: 1.5 },
      { kind: "http", url: "https://h/ws/services/x" },
      { kind: "http", url: "not a url" },
      { kind: "ssh-unix", host: "a:b", path: "/x" },
      { kind: "nope" },
    ] as unknown as AddressSpec[])
      assert.throws(() => formatAddress(spec), TypeError, JSON.stringify(spec));
  });

  test("property: parseAddress(formatAddress(parseAddress(s))) equals parseAddress(s)", () => {
    const text = fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 });
    const noColonSemi = text.filter((s) => !s.includes(":") && !s.includes(";") && !s.includes("\0"));
    const host = noColonSemi.filter((s) => !/[[\]]/.test(s));
    const port = fc.integer({ min: 0, max: 65535 });
    const address = fc.oneof(
      text.map((s) => `unix:/${s}`),
      text.map((s) => `unix:@${s}`),
      text.map((s) => `./${s}`),
      fc.tuple(host, port).map(([h, p]) => `tcp:${h}:${String(p)}`),
      fc.tuple(fc.ipV6(), port).map(([h, p]) => `tcp:[${h}]:${String(p)}`),
      text.map((s) => `exec:${s}`),
      fc.tuple(noColonSemi, text).map(([h, p]) => `ssh-unix:${h}:/${p}`),
      fc.tuple(noColonSemi, text).map(([h, c]) => `ssh-exec:${h}:${c}`),
      fc.webUrl({ validSchemes: ["http", "https", "ws", "wss"] }),
    );
    fc.assert(
      fc.property(address, (s) => {
        let spec: AddressSpec;
        try {
          spec = parseAddress(s);
        } catch (e) {
          // Generated text may still be invalid (NUL, empty after the `;` cut): only TypeErrors are allowed.
          assert.ok(e instanceof TypeError);
          return;
        }
        assert.deepEqual(parseAddress(formatAddress(spec)), spec);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});
