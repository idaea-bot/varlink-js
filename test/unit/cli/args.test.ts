// Command line, usage errors, help/version and the JSON output formats of the CLI (DESIGN.md §4.14).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { parseCommandLine, parseTimeout } from "../../../src/cli/args.ts";
import { escapeControls } from "../../../src/cli/io.ts";
import { formatJson } from "../../../src/cli/json.ts";
import { USAGE } from "../../../src/cli/run.ts";
import { jsonCodec } from "../../../src/index.ts";
import { runCli } from "./helpers.ts";

const SEE_HELP = "See 'varlink-js --help'.\n";
const version = (
  JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

describe("help and version", () => {
  test("--help, -h, help: usage on stdout, exit 0 (also with a command or a bad option)", async () => {
    for (const argv of [["--help"], ["-h"], ["help"], ["call", "--help"], ["info", "--bogus", "-h"], ["nope", "-h"]]) {
      const r = await runCli(argv);
      assert.equal(r.code, 0, argv.join(" "));
      assert.equal(r.stdout, USAGE);
      assert.equal(r.stderr, "");
    }
  });

  test("--version, -V: the package version", async () => {
    for (const argv of [["--version"], ["-V"], ["info", "-V"]]) {
      const r = await runCli(argv);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, `${version}\n`);
    }
  });
});

describe("usage errors: one line, the help hint, exit 1", () => {
  const cases: [string[], RegExp][] = [
    [[], /^Command verb required\.$/],
    [["frobnicate"], /^Unknown command verb 'frobnicate'\.$/],
    [["call", "--upgrade", "a", "b.c.D"], /--upgrade/],
    [["info", "--more", "a"], /--more/],
    [["call", "--timeout"], /--timeout/],
    [["call", "--more=yes", "a", "b.c.D"], /--more/],
    [["call", "--j", "a", "b.c.D"], /^Unknown option '--j'$/],
    [["call", "--E", "a", "b.c.D"], /^Unknown option '--E'$/],
    [["call", "--json=fancy", "a", "b.c.D"], /^Unknown argument to --json= switch: 'fancy'/],
    [["call", "--timeout=0", "a", "b.c.D"], /^Timeout cannot be zero\.$/],
    [["call", "--timeout=0ms", "a", "b.c.D"], /^Timeout cannot be zero\.$/],
    [["call", "--timeout=soon", "a", "b.c.D"], /^Failed to parse --timeout= parameter 'soon'\.$/],
    [["call", "--graceful=nope", "a", "b.c.D"], /^Not a valid Varlink error name: nope$/],
    [["call", "--more", "--collect", "a", "b.c.D"], /mutually exclusive/],
    [["call", "-E", "--oneway", "a", "b.c.D"], /mutually exclusive/],
    [["call", "--collect", "--oneway", "a", "b.c.D"], /mutually exclusive/],
    [["call", "a"], /^Too few arguments\.$/],
    [["call", "a", "b.c.D", "{}", "extra"], /^Too many arguments\.$/],
    [["format", "--check", "-i", "x"], /mutually exclusive/],
    [["codegen", "--ints=huge", "x"], /^Unknown argument to --ints=: 'huge'/],
    [["certify", "both", "a"], /^Unknown certify role 'both'/],
  ];
  for (const [argv, message] of cases)
    test(argv.join(" ") || "(nothing)", async () => {
      const r = await runCli(argv);
      assert.equal(r.code, 1);
      assert.equal(r.stdout, "");
      const [line, hint, rest] = r.stderr.split("\n");
      assert.match(line ?? "", message);
      assert.equal(`${hint ?? ""}\n`, SEE_HELP);
      assert.equal(rest, "");
    });

  test("control characters in the offending argument are escaped", async () => {
    const r = await runCli([`bad\x1b[2Jverb`]);
    assert.equal(r.stderr, `Unknown command verb 'bad\\x1b[2Jverb'.\n${SEE_HELP}`);
  });
});

describe("parseCommandLine", () => {
  test("global options before or after the command", () => {
    const a = parseCommandLine(["-j", "call", "unix:/x", "a.b.C", "-q"]);
    const b = parseCommandLine(["call", "-jq", "unix:/x", "a.b.C"]);
    for (const c of [a, b]) {
      assert.equal(c.command, "call");
      assert.deepEqual(c.args, ["unix:/x", "a.b.C"]);
      assert.equal(c.json, "auto");
      assert.equal(c.quiet, true);
    }
    const c = parseCommandLine(["--json", "pretty", "info", "unix:/x"]);
    assert.equal(c.command, "info");
    assert.equal(c.json, "pretty");
    assert.deepEqual(c.args, ["unix:/x"]);
  });

  test("-E is --more --timeout=infinity; later options win", () => {
    assert.deepEqual(
      [parseCommandLine(["call", "-E", "a", "b.c.D"])].map((c) => [c.mode, c.timeout]),
      [["more", null]],
    );
    const later = parseCommandLine(["call", "-E", "--timeout=5", "a", "b.c.D"]);
    assert.equal(later.timeout, 5000);
    const earlier = parseCommandLine(["call", "--timeout=5", "-E", "a", "b.c.D"]);
    assert.equal(earlier.timeout, null);
    assert.equal(parseCommandLine(["call", "--more", "-E", "a", "b.c.D"]).mode, "more");
  });

  test("--graceful is repeatable, sorted and unique; -- ends the options", () => {
    const c = parseCommandLine(["call", "--graceful=z.y.X", "--graceful", "a.b.C", "--graceful=z.y.X", "a", "b.c.D"]);
    assert.deepEqual(c.graceful, ["a.b.C", "z.y.X"]);
    const d = parseCommandLine(["call", "a", "b.c.D", "--", "-q"]);
    assert.deepEqual(d.args, ["a", "b.c.D", "-q"]);
    assert.equal(d.quiet, false);
    assert.deepEqual(parseCommandLine(["format", "-"]).args, ["-"]);
  });

  test("--timeout values", () => {
    assert.equal(parseTimeout("1"), 1000);
    assert.equal(parseTimeout("1.5"), 1500);
    assert.equal(parseTimeout("1.5s"), 1500);
    assert.equal(parseTimeout("500ms"), 500);
    assert.equal(parseTimeout("250us"), 0.25);
    assert.equal(parseTimeout("2sec"), 2000);
    assert.equal(parseTimeout("2min"), 120_000);
    assert.equal(parseTimeout("1h"), 3_600_000);
    assert.equal(parseTimeout(".5"), 500);
    assert.equal(parseTimeout("infinity"), null);
    assert.equal(parseTimeout(""), null);
    for (const bad of ["-1", "1d", "1 2", "abc", "1e3", "0", "0.0s"]) assert.throws(() => parseTimeout(bad), bad);
  });
});

describe("JSON output (sd-json formats)", () => {
  const value = jsonCodec.decode(
    '{"empty":{},"list":[],"nested":{"a":[{},[]],"b":{"c":{}}},"s":"q\\"b\\\\s/\\u0001\\u001f\\n\\t\\u007f\\u009bé€😀","big":18446744073709551615,"neg":-9223372036854775808,"f":1.5,"e":1e300,"tiny":5e-324,"t":true,"n":null,"i":-3}',
  );

  test('pretty: TAB indentation, `"key" : value`, empty containers inline, final newline', () => {
    assert.equal(
      formatJson(value, "pretty"),
      [
        "{",
        '\t"empty" : {},',
        '\t"list" : [],',
        '\t"nested" : {',
        '\t\t"a" : [',
        "\t\t\t{},",
        "\t\t\t[]",
        "\t\t],",
        '\t\t"b" : {',
        '\t\t\t"c" : {}',
        "\t\t}",
        "\t},",
        '\t"s" : "q\\"b\\\\s/\\u0001\\u001f\\n\\t\u007f\u009bé€😀",',
        '\t"big" : 18446744073709551615,',
        '\t"neg" : -9223372036854775808,',
        '\t"f" : 1.5,',
        '\t"e" : 1e+300,',
        '\t"tiny" : 5e-324,',
        '\t"t" : true,',
        '\t"n" : null,',
        '\t"i" : -3',
        "}",
        "",
      ].join("\n"),
    );
  });

  test("short: minimal JSON and a newline", () => {
    assert.equal(
      formatJson(value, "short"),
      '{"empty":{},"list":[],"nested":{"a":[{},[]],"b":{"c":{}}},"s":"q\\"b\\\\s/\\u0001\\u001f\\n\\t\u007f\u009bé€😀","big":18446744073709551615,"neg":-9223372036854775808,"f":1.5,"e":1e+300,"tiny":5e-324,"t":true,"n":null,"i":-3}\n',
    );
  });

  test("the systemd 255 example, byte for byte", () => {
    assert.equal(
      formatJson({ vendor: "The systemd Project", interfaces: ["io.systemd", "org.varlink.service"] }, "pretty"),
      '{\n\t"vendor" : "The systemd Project",\n\t"interfaces" : [\n\t\t"io.systemd",\n\t\t"org.varlink.service"\n\t]\n}\n',
    );
  });

  test("JSON-SEQ records: RS, the JSON, LF; scalars and empty containers", () => {
    assert.equal(formatJson({ a: 1 }, "short", true), '\x1e{"a":1}\n');
    assert.equal(formatJson({ a: [] }, "pretty", true), '\x1e{\n\t"a" : []\n}\n');
    assert.equal(formatJson({}, "pretty"), "{}\n");
    assert.equal(formatJson([], "short"), "[]\n");
    assert.equal(formatJson(undefined, "short"), "null\n");
    assert.equal(formatJson("x", "pretty"), '"x"\n');
    assert.equal(formatJson(123n, "short"), "123\n");
  });

  test("lone surrogates are escaped (well-formed JSON.stringify)", () => {
    assert.equal(formatJson({ s: "\ud800" }, "short"), '{"s":"\\ud800"}\n');
  });
});

describe("escapeControls", () => {
  test("C0, DEL and C1 as \\xNN; kept characters stay", () => {
    assert.equal(escapeControls("a\x00\x1b[0m\x7f\x85\x9fé\n\t"), "a\\x00\\x1b[0m\\x7f\\x85\\x9fé\\x0a\\x09");
    assert.equal(escapeControls("a\nb\tc\rd", "\n\t"), "a\nb\tc\\x0dd");
  });
});

describe("internal errors", () => {
  test("one line, exit 1; the stack only with VARLINK_JS_DEBUG", async () => {
    const throwing = {
      [Symbol.asyncIterator]: () => {
        throw new RangeError("boom");
      },
    };
    const r = await runCli(["call", "unix:/x", "a.b.C"], { stdin: throwing });
    assert.equal(r.code, 1);
    assert.equal(r.stderr, "varlink-js: internal error: boom\n");
    const d = await runCli(["call", "unix:/x", "a.b.C"], { stdin: throwing, env: { VARLINK_JS_DEBUG: "1" } });
    assert.equal(d.code, 1);
    assert.match(d.stderr, /^varlink-js: internal error: boom\nRangeError: boom\n\s+at /);
  });
});
