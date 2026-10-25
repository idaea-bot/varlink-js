// `varlink-js call` in-process (DESIGN.md §4.14): every mode and option against the test service over unix and tcp,
// error replies, local failures, timeouts, int precision, stdin parameters, signals, EPIPE and escaping.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ESC, RS, rawServer, runCli, startFixture, waitFor, type Fixture } from "./helpers.ts";

let fx: Fixture;
before(async () => {
  fx = await startFixture();
});
after(async () => {
  await fx.close();
});

const BIG = '{"max":9223372036854775807,"min":-9223372036854775808,"u":18446744073709551615}';

for (const transport of ["unix", "tcp"] as const) {
  describe(`call over ${transport}`, () => {
    const addr = (): string => (transport === "unix" ? fx.unix : fx.tcp);

    test("one reply, short JSON when stdout is not a TTY", async () => {
      const r = await runCli(["call", addr(), "org.example.cli.Echo", '{"value":{"a":[1,2.5,"x"]}}']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, '{"value":{"a":[1,2.5,"x"]}}\n');
      assert.equal(r.stderr, "");
    });

    test("pretty JSON (sd-json format) when stdout is a TTY", async () => {
      const r = await runCli(["call", addr(), "org.example.cli.Echo", '{"value":{"a":[1,{}],"b":[]}}'], {
        stdoutTTY: true,
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, '{\n\t"value" : {\n\t\t"a" : [\n\t\t\t1,\n\t\t\t{}\n\t\t],\n\t\t"b" : []\n\t}\n}\n');
    });

    test("--more: JSON-SEQ, one record per reply, each written on its own", async () => {
      const r = await runCli(["call", "--more", addr(), "org.example.cli.Count", '{"n":3}']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, `${RS}{"i":0}\n${RS}{"i":1}\n${RS}{"i":2}\n`);
      assert.equal(r.io.stdoutChunks.length, 3);
    });

    test("--collect: one JSON array, not SEQ", async () => {
      const r = await runCli(["call", addr(), "org.example.cli.Count", '{"n":3}', "--collect"]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, '[{"i":0},{"i":1},{"i":2}]\n');
    });

    test("--oneway: written, nothing printed, exit 0", async () => {
      const text = `oneway-${transport}`;
      const r = await runCli(["call", "--oneway", addr(), "org.example.cli.Log", JSON.stringify({ text })]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "");
      await waitFor(() => fx.logged.includes(text));
    });

    test("int precision: 64-bit extremes round-trip exactly through call, --more and --collect", async () => {
      const single = await runCli(["call", addr(), "org.example.cli.Echo", `{"value":${BIG}}`]);
      assert.equal(single.code, 0, single.stderr);
      assert.equal(single.stdout, `{"value":${BIG}}\n`);
      const more = await runCli(["call", "--more", addr(), "org.example.cli.Count", `{"n":2,"value":${BIG}}`]);
      assert.equal(more.code, 0, more.stderr);
      assert.equal(more.stdout, `${RS}{"i":0,"value":${BIG}}\n${RS}{"i":1,"value":${BIG}}\n`);
      const collect = await runCli(["call", "--collect", addr(), "org.example.cli.Count", `{"n":2,"value":${BIG}}`]);
      assert.equal(collect.code, 0, collect.stderr);
      assert.equal(collect.stdout, `[{"i":0,"value":${BIG}},{"i":1,"value":${BIG}}]\n`);
      const pretty = await runCli(["call", addr(), "org.example.cli.Echo", `{"value":${BIG}}`, "--json=pretty"]);
      assert.match(pretty.stdout, /"u" : 18446744073709551615\n/);
      assert.match(pretty.stdout, /"min" : -9223372036854775808,\n/);
    });
  });
}

describe("call: parameters", () => {
  test("from stdin when PARAMETERS is absent or '-'", async () => {
    const a = await runCli(["call", fx.unix, "org.example.cli.Echo"], { stdin: `{"value":${BIG}}` });
    assert.equal(a.code, 0, a.stderr);
    assert.equal(a.stdout, `{"value":${BIG}}\n`);
    const b = await runCli(["call", fx.unix, "org.example.cli.Echo", "-"], { stdin: ' {"value": "x"} \n' });
    assert.equal(b.stdout, '{"value":"x"}\n');
  });

  test("empty or whitespace-only stdin (or argument) means {}", async () => {
    const a = await runCli(["call", fx.unix, "org.example.cli.Count"], { stdin: " \n\t" });
    // Count without n: InvalidParameter, which proves {} was sent.
    assert.equal(a.code, 1);
    assert.match(a.stderr, /org\.varlink\.service\.InvalidParameter/);
    assert.equal(a.stdout, '{"parameter":"n"}\n');
    const b = await runCli(["call", fx.unix, "org.example.cli.Preview", ""]);
    assert.equal(b.code, 0, b.stderr);
    assert.equal(b.stdout, "{}\n");
  });

  test("the stdin notice on a TTY, not with -q", async () => {
    const a = await runCli(["call", fx.unix, "org.example.cli.Preview"], { stdin: "{}", stdinTTY: true });
    assert.equal(a.code, 0);
    assert.equal(
      a.stderr,
      "Expecting method call parameter JSON object on standard input. (Provide empty string or {} for no parameters.)\n",
    );
    const b = await runCli(["call", "-q", fx.unix, "org.example.cli.Preview"], { stdin: "{}", stdinTTY: true });
    assert.equal(b.stderr, "");
    assert.equal(b.stdout, "");
  });

  test("not an object, or not JSON: exit 1 before connecting", async () => {
    for (const p of ["[1]", "null", "1", '"x"', "{", "{} {}"]) {
      const r = await runCli(["call", "unix:/nonexistent/x", "org.example.cli.Echo", p]);
      assert.equal(r.code, 1, p);
      assert.match(r.stderr, /^Failed to parse parameters at <argv>: /, p);
      assert.equal(r.stdout, "");
    }
    const s = await runCli(["call", "unix:/nonexistent/x", "a.b.C"], { stdin: "[]" });
    assert.match(s.stderr, /^Failed to parse parameters at <stdin>: not a JSON object\n$/);
    const u = await runCli(["call", "unix:/nonexistent/x", "a.b.C"], { stdin: new Uint8Array([0x7b, 0xff, 0x7d]) });
    assert.match(u.stderr, /not valid UTF-8/);
  });

  test("an invalid method name is rejected before connecting", async () => {
    for (const m of ["Echo", "org.example.cli.echo", "org..x.Y", ".A", "org.example.cli."]) {
      const r = await runCli(["call", "unix:/nonexistent/x", m, "{}"]);
      assert.equal(r.code, 1, m);
      assert.match(r.stderr, /^Not a valid qualified method name: /, m);
    }
  });

  test("an invalid address", async () => {
    const r = await runCli(["call", "nonsense", "a.b.C", "{}"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /invalid varlink address/);
  });
});

describe("call: error replies", () => {
  test("parameters on stdout, `Method call M() failed: NAME` on stderr, exit 1", async () => {
    const r = await runCli([
      "call",
      fx.unix,
      "org.example.cli.Fail",
      '{"error":"org.example.other.Broken","parameters":{"why":"x"}}',
    ]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '{"why":"x"}\n');
    assert.equal(r.stderr, "Method call org.example.cli.Fail() failed: org.example.other.Broken\n");
  });

  test("-q suppresses the parameters, not the message", async () => {
    const r = await runCli(["call", "-q", fx.unix, "org.example.cli.Fail", '{"error":"org.example.other.Broken"}']);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "Method call org.example.cli.Fail() failed: org.example.other.Broken\n");
  });

  test("ExpectedMore gets varlinkctl's message", async () => {
    const r = await runCli(["call", fx.unix, "org.example.cli.Monitor", "{}"]);
    assert.equal(r.code, 1);
    assert.equal(
      r.stderr,
      "Method call org.example.cli.Monitor() failed: called without 'more' flag, but flag needs to be set.\n",
    );
    assert.equal(r.stdout, "{}\n");
  });

  test("an error reply ends --more with a SEQ record and exit 1", async () => {
    const r = await runCli([
      "call",
      "--more",
      fx.unix,
      "org.example.cli.Fail",
      '{"error":"org.example.other.Broken","parameters":{"a":1}}',
    ]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, `${RS}{"a":1}\n`);
  });

  test("an error reply in --collect prints its parameters (not an array)", async () => {
    const r = await runCli(["call", "--collect", fx.unix, "org.example.cli.Fail", '{"error":"org.example.other.X"}']);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "{}\n");
    assert.equal(r.stderr, "Method call org.example.cli.Fail() failed: org.example.other.X\n");
  });

  test("--graceful: that error is success, still printed, logged unless -q", async () => {
    const args = ["call", fx.unix, "org.example.cli.Fail", '{"error":"org.example.other.Fine","parameters":{"k":2}}'];
    const r = await runCli([...args, "--graceful=org.example.other.Fine", "--graceful=org.example.other.Else"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '{"k":2}\n');
    assert.equal(r.stderr, "Method call org.example.cli.Fail() returned expected error: org.example.other.Fine\n");
    const q = await runCli([...args, "--graceful", "org.example.other.Fine", "-q"]);
    assert.equal(q.code, 0);
    assert.equal(q.stdout, "");
    assert.equal(q.stderr, "");
    const other = await runCli([...args, "--graceful=org.example.other.Else"]);
    assert.equal(other.code, 1);
    const more = await runCli([...args, "--more", "--graceful=org.example.other.Fine"]);
    assert.equal(more.code, 0);
    assert.equal(more.stdout, `${RS}{"k":2}\n`);
    const collect = await runCli([...args, "--collect", "--graceful=org.example.other.Fine"]);
    assert.equal(collect.code, 0);
    assert.equal(collect.stdout, '{"k":2}\n');
  });

  test("peer-controlled error names cannot inject control characters into stderr", async () => {
    const evil = `org.example.${ESC}[2J${String.fromCharCode(0x9b)}Evil`;
    const raw = await rawServer([JSON.stringify({ error: evil, parameters: { t: `${ESC}x` } })]);
    try {
      const r = await runCli(["call", raw.address, "a.b.C", "{}"]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, "Method call a.b.C() failed: org.example.\\x1b[2J\\x9bEvil\n");
      assert.ok(!r.stderr.includes(ESC));
      // JSON output escapes it itself.
      assert.equal(r.stdout, '{"t":"\\u001bx"}\n');
    } finally {
      await raw.close();
    }
  });
});

describe("call: local failures", () => {
  test("connect refused: `Failed to connect to ADDRESS: …`, exit 1", async () => {
    const r = await runCli(["call", "unix:/nonexistent/dir/sock", "a.b.C", "{}"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^Failed to connect to unix:\/nonexistent\/dir\/sock: .*ENOENT/);
  });

  test("exec: goes to varlink-js/node's connect; a failure is one line, exit 1", async () => {
    // Before M8 the adapter cannot dial exec: (connect fails); after M8 /bin/true starts and exits without serving
    // (the call fails). Either way: one line, no stack, exit 1.
    const r = await runCli(["call", "exec:/bin/true", "a.b.C", "{}"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^(Failed to connect to exec:\/bin\/true|Method call a\.b\.C\(\) failed): [^\n]*\n$/);
  });

  test("--timeout=0.2 against a handler that never answers: exit 1 quickly", async () => {
    const start = Date.now();
    const r = await runCli(["call", "--timeout=0.2", fx.unix, "org.example.cli.Hang", "{}"]);
    assert.equal(r.code, 1);
    assert.ok(Date.now() - start < 10_000, `took ${String(Date.now() - start)} ms`);
    assert.equal(r.stderr, "Method call org.example.cli.Hang() failed: timed out after 0.2s\n");
  });

  test("--timeout bounds the whole --more call (sd-varlink semantics), units accepted", async () => {
    const start = Date.now();
    const r = await runCli(["call", "--more", "--timeout=150ms", fx.unix, "org.example.cli.Monitor", "{}"]);
    assert.equal(r.code, 1);
    assert.ok(Date.now() - start < 10_000);
    assert.ok(r.stdout.startsWith(`${RS}{"i":0}\n`));
    assert.match(r.stderr, /^Method call org\.example\.cli\.Monitor\(\) failed: timed out after 0\.15s\n$/);
  });

  test("a peer that breaks the protocol", async () => {
    const raw = await rawServer(["not json"]);
    try {
      const r = await runCli(["call", raw.address, "a.b.C", "{}"]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /^Method call a\.b\.C\(\) failed: /);
    } finally {
      await raw.close();
    }
  });

  test("a peer that disconnects", async () => {
    const raw = await rawServer([]);
    try {
      const p = runCli(["call", raw.address, "a.b.C", "{}"]);
      // Disconnect only once the call arrived (a fixed delay could close before the connect on a slow runner).
      await waitFor(() => raw.received() > 0);
      await raw.close();
      const r = await p;
      assert.equal(r.code, 1);
      assert.match(r.stderr, /^Method call a\.b\.C\(\) failed: /);
    } finally {
      await raw.close();
    }
  });
});

describe("call: signals and EPIPE", () => {
  test("SIGINT during -E: the connection is closed and run returns 130", async () => {
    const controller = new AbortController();
    const ended = fx.monitorsEnded;
    const p = runCli(["call", "-E", fx.unix, "org.example.cli.Monitor", "{}"], {
      signal: controller.signal,
      onStdout: (text) => {
        if (text.split(RS).length > 3) controller.abort("SIGINT");
      },
    });
    const r = await p;
    assert.equal(r.code, 130);
    assert.equal(r.stderr, "");
    await waitFor(() => fx.monitorsEnded > ended);
  });

  test("SIGTERM gives 143", async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort("SIGTERM");
    }, 50);
    const r = await runCli(["call", fx.unix, "org.example.cli.Hang", "{}"], { signal: controller.signal });
    assert.equal(r.code, 143);
  });

  test("a signal while reading stdin parameters", async () => {
    const controller = new AbortController();
    const never: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
    };
    setTimeout(() => {
      controller.abort("SIGINT");
    }, 20);
    const r = await runCli(["call", fx.unix, "a.b.C"], { stdin: never, signal: controller.signal });
    assert.equal(r.code, 130);
  });

  test("stdout EPIPE during --more: stops quietly, closes the connection, exit 0", async () => {
    const ended = fx.monitorsEnded;
    const r = await runCli(["call", "--more", fx.unix, "org.example.cli.Monitor", "{}"], { stdoutBreaksAfter: 2 });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    assert.equal(r.stdout, `${RS}{"i":0}\n${RS}{"i":1}\n`);
    await waitFor(() => fx.monitorsEnded > ended);
  });

  test("stdout EPIPE on a single reply: exit 0", async () => {
    const r = await runCli(["call", fx.unix, "org.example.cli.Preview", "{}"], { stdoutBreaksAfter: 0 });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
  });
});
