// Command line, usage errors, help/version and the JSON output formats of the CLI (DESIGN.md §4.14).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { parseCommandLine, parseTimeout } from "../../../src/cli/args.ts";
import { abortable, escapeControls } from "../../../src/cli/io.ts";
import { formatJson } from "../../../src/cli/json.ts";
import { USAGE } from "../../../src/cli/run.ts";
import { jsonCodec } from "../../../src/index.ts";
import { ESC, RLO, runCli } from "./helpers.ts";

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

  test("--timeout values: systemd's parse_sec", () => {
    const cases: [string, number | null][] = [
      ["1", 1000],
      ["1.5", 1500],
      ["1.5s", 1500],
      ["500ms", 500],
      ["500 msec", 500],
      ["250us", 0.25],
      ["250usec", 0.25],
      [`5${String.fromCharCode(0xb5)}s`, 0.005],
      [`5${String.fromCharCode(0x3bc)}s`, 0.005],
      ["2sec", 2000],
      ["30seconds", 30_000],
      ["1second", 1000],
      ["2min", 120_000],
      ["5m", 300_000],
      ["2minutes", 120_000],
      ["1minute", 60_000],
      ["1h", 3_600_000],
      ["1hr", 3_600_000],
      ["2hours", 7_200_000],
      ["1.5h", 5_400_000],
      ["1d", 86_400_000],
      ["2days", 172_800_000],
      ["1w", 604_800_000],
      ["1week", 604_800_000],
      ["1M", 2_629_800_000],
      ["1month", 2_629_800_000],
      ["1y", 31_557_600_000],
      ["1years", 31_557_600_000],
      ["1min 30s", 90_000],
      ["1min30s", 90_000],
      ["  1h 1m 1s 1ms  ", 3_661_001],
      ["1 2", 3000],
      ["12.34 .56", 12_900],
      ["12.34s.56", 12_900],
      [".5", 500],
      ["0.0000015s", 0.001],
      ["infinity", null],
      [" infinity ", null],
      ["", null],
    ];
    for (const [text, ms] of cases) assert.equal(parseTimeout(text), ms, text);
    for (const bad of [
      "-1",
      "abc",
      "1e3",
      "3.",
      "3.s",
      ".",
      "1 x",
      "12.34.56",
      "5mins",
      " ",
      "infinity 1",
      "+",
      "2500ns",
      "999ns",
      "1500nsec",
    ])
      assert.throws(() => parseTimeout(bad), /^UsageError: Failed to parse --timeout= parameter/, bad);
    // Out of range (parse_time's ERANGE): a whole part above 2⁶³ − 1 (strtoll), or at or above ⌊(2⁶⁴ − 1) / unit
    // in µs⌋, checked per term before adding; and a sum at or above 2⁶⁴ − 1 µs.
    for (const big of [
      "18446744073709551615us",
      "18446744073709551614us",
      "9300000000000000000us",
      "9223372036854775808us",
      "584542y",
      "584542.5y",
      "307445734561min",
      "9223372036854775807us 9223372036854775808us",
    ])
      assert.throws(() => parseTimeout(big), /Failed to parse/, big);
    assert.equal(parseTimeout("9223372036854775807us"), Number(9223372036854775807n) / 1000);
    assert.equal(parseTimeout("584541y"), Number(584541n * 31_557_600_000_000n) / 1000);
    assert.equal(parseTimeout("584541.9y"), Number(584541n * 31_557_600_000_000n + 28_401_840_000_000n) / 1000);
    assert.equal(parseTimeout("307445734560min"), Number(307445734560n * 60_000_000n) / 1000);
    // Two terms below the limits whose sum is 2⁶⁴ − 2 µs: still in range.
    assert.equal(parseTimeout("9223372036854775807us 9223372036854775807us"), Number(18446744073709551614n) / 1000);
    // Zero after rounding down to whole microseconds.
    for (const zero of ["0", "0.0s", "0ms", "0.0000001", "0.5us", "0 0"])
      assert.throws(() => parseTimeout(zero), /^UsageError: Timeout cannot be zero\.$/, zero);
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

  test("U+2028, U+2029 and the bidi controls as \\uNNNN; other non-ASCII stays", () => {
    const bidi = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
    for (const code of [0x2028, 0x2029, ...bidi]) {
      const c = String.fromCharCode(code);
      assert.equal(escapeControls(`a${c}b`), `a\\u${code.toString(16).padStart(4, "0")}b`, code.toString(16));
      assert.equal(escapeControls(c, c), c);
    }
    const others = `é€😀${String.fromCharCode(0xa0, 0x200d, 0x2027, 0x202f, 0x2065, 0x206a)}`;
    assert.equal(escapeControls(others), others);
  });
});

describe("abortable", () => {
  test("an already-aborted signal: rejects with its reason; the promise's later rejection is not unhandled", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const controller = new AbortController();
      controller.abort("SIGINT");
      let fail: (e: Error) => void = () => undefined;
      const later = new Promise<never>((_resolve, reject) => {
        fail = reject;
      });
      await assert.rejects(abortable(later, controller.signal), (e) => e === "SIGINT");
      fail(new Error("late failure"));
      for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", listener);
    }
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

  test("the VARLINK_JS_DEBUG stack is escaped too (newlines kept)", async () => {
    const throwing = {
      [Symbol.asyncIterator]: () => {
        throw new RangeError(`a${ESC}[2Jb${RLO}c`);
      },
    };
    const d = await runCli(["call", "unix:/x", "a.b.C"], { stdin: throwing, env: { VARLINK_JS_DEBUG: "1" } });
    assert.equal(d.code, 1);
    assert.match(d.stderr, /^varlink-js: internal error: a\\x1b\[2Jb\\u202ec\nRangeError: a\\x1b\[2Jb\\u202ec\n\s+at /);
    assert.ok(!d.stderr.includes(ESC) && !d.stderr.includes(RLO));
  });
});
