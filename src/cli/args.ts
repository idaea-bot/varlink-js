// Command-line parsing (DESIGN.md §4.14) with node:util parseArgs: one options table per command. Options may come
// before or after the command (`varlink-js -j call …` and `varlink-js call -j …`), like varlinkctl: the command is
// found first (a lenient pass over the union of all tables, so string options' values are skipped), then the whole
// command line is parsed strictly with that command's table.
import { parseArgs } from "node:util";
import { isInterfaceName, isMemberName } from "../core/idl/index.ts";
import { escapeControls, UsageError } from "./io.ts";

interface OptionDef {
  readonly type: "boolean" | "string";
  readonly short?: string;
  readonly multiple?: boolean;
  /** Only the short form exists (`-j`, `-E`); parseArgs would also accept `--j`, so that spelling is rejected. */
  readonly shortOnly?: boolean;
}
type Table = Readonly<Record<string, OptionDef>>;

const GLOBAL: Table = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
  json: { type: "string" },
  j: { type: "boolean", short: "j", shortOnly: true },
  quiet: { type: "boolean", short: "q" },
};
const TIMEOUT: Table = { timeout: { type: "string" } };

/** The commands and their own options (the global ones are accepted by every command). */
const COMMANDS: Readonly<Record<string, Table>> = {
  help: {},
  info: TIMEOUT,
  "list-interfaces": TIMEOUT,
  "list-methods": TIMEOUT,
  introspect: TIMEOUT,
  call: {
    ...TIMEOUT,
    more: { type: "boolean" },
    E: { type: "boolean", short: "E", shortOnly: true },
    collect: { type: "boolean" },
    oneway: { type: "boolean" },
    graceful: { type: "string", multiple: true },
  },
  "validate-idl": {},
  format: { check: { type: "boolean" }, "in-place": { type: "boolean", short: "i" } },
  codegen: {
    ...TIMEOUT,
    output: { type: "string", short: "o" },
    ints: { type: "string" },
    "import-path": { type: "string" },
    address: { type: "string" },
  },
  bridge: TIMEOUT,
  certify: TIMEOUT,
};

/** `--json=` / `-j`: `auto` is pretty when stdout is a TTY, else short. */
export type JsonMode = "pretty" | "short" | "off" | "auto";
/** How `call` sends the call. */
export type CallMode = "single" | "more" | "collect" | "oneway";

/** The parsed command line. */
export interface CommandLine {
  /** `undefined` when no command was given. */
  readonly command: string | undefined;
  /** The positional arguments after the command. */
  readonly args: readonly string[];
  readonly help: boolean;
  readonly version: boolean;
  readonly quiet: boolean;
  /** `undefined`: neither `--json` nor `-j` given. */
  readonly json: JsonMode | undefined;
  /** Milliseconds; `null` = no timeout (`infinity`, empty, `-E`); `undefined` = the default. */
  readonly timeout: number | null | undefined;
  readonly mode: CallMode;
  /** `--graceful` error names, sorted and unique. */
  readonly graceful: readonly string[];
  readonly check: boolean;
  readonly inPlace: boolean;
  readonly output: string | undefined;
  readonly ints: "number" | "bigint" | undefined;
  readonly importPath: string | undefined;
  readonly address: string | undefined;
}

type ParseArgsOptions = Record<string, { type: "boolean" | "string"; short?: string; multiple?: boolean }>;

function forParseArgs(...tables: Table[]): ParseArgsOptions {
  const out: ParseArgsOptions = {};
  for (const table of tables)
    for (const [name, def] of Object.entries(table))
      out[name] = {
        type: def.type,
        ...(def.short === undefined ? {} : { short: def.short }),
        ...(def.multiple === true ? { multiple: true } : {}),
      };
  return out;
}

/** The union of every table, for finding the command. */
const ALL = forParseArgs(GLOBAL, ...Object.values(COMMANDS));

/** parseArgs' message up to its first sentence (it goes on with hints about `--`), escaped. */
function shortMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const end = message.indexOf(". ");
  return escapeControls(end < 0 ? message.replace(/\.$/, "") : message.slice(0, end));
}

const NS_PER_US = 1000n;
const NS_PER_S = 1_000_000_000n;

/**
 * systemd's parse_sec unit table (time-util.c's extract_multiplier), in its order: the first suffix the text starts
 * with wins (so `ms` is milliseconds, `m` minutes, `M` months), in nanoseconds per unit. No `nsec`/`ns`:
 * those are parse_nsec's, and parse_sec rejects them (`2500ns` is EINVAL).
 */
const UNITS: readonly (readonly [string, bigint])[] = [
  ["seconds", NS_PER_S],
  ["second", NS_PER_S],
  ["sec", NS_PER_S],
  ["s", NS_PER_S],
  ["minutes", 60n * NS_PER_S],
  ["minute", 60n * NS_PER_S],
  ["min", 60n * NS_PER_S],
  ["months", 2_629_800n * NS_PER_S],
  ["month", 2_629_800n * NS_PER_S],
  ["M", 2_629_800n * NS_PER_S],
  ["msec", 1_000_000n],
  ["ms", 1_000_000n],
  ["m", 60n * NS_PER_S],
  ["hours", 3600n * NS_PER_S],
  ["hour", 3600n * NS_PER_S],
  ["hr", 3600n * NS_PER_S],
  ["h", 3600n * NS_PER_S],
  ["days", 86_400n * NS_PER_S],
  ["day", 86_400n * NS_PER_S],
  ["d", 86_400n * NS_PER_S],
  ["weeks", 604_800n * NS_PER_S],
  ["week", 604_800n * NS_PER_S],
  ["w", 604_800n * NS_PER_S],
  ["years", 31_557_600n * NS_PER_S],
  ["year", 31_557_600n * NS_PER_S],
  ["y", 31_557_600n * NS_PER_S],
  ["usec", NS_PER_US],
  ["us", NS_PER_US],
  ["μs", NS_PER_US], // U+03BC GREEK SMALL LETTER MU
  ["µs", NS_PER_US], // U+00B5 MICRO SIGN
];
/** systemd's USEC_INFINITY (2⁶⁴ − 1): sums at or above it are out of range. */
const USEC_INFINITY = 2n ** 64n - 1n;
/** parse_time's WHITESPACE: space, TAB, LF, CR. */
const WHITESPACE = /^[ \t\n\r]*/;
const TERM = /^(\d*)(?:(\.)(\d*))?/;

/**
 * systemd's parse_sec: a sum of terms `NUMBER[.DIGITS][ ]UNIT` (whitespace between terms allowed, `1min 30s`,
 * `1.5h`), a bare number being seconds; whole microseconds, each term and fraction digit rounded down like
 * parse_time. `undefined` when it does not parse or is out of range.
 */
function parseSec(text: string): bigint | "infinity" | undefined {
  let p = text.slice(WHITESPACE.exec(text)?.[0].length ?? 0);
  if (p.startsWith("infinity")) return p.slice(8).replace(WHITESPACE, "") === "" ? "infinity" : undefined;
  let total = 0n;
  let something = false;
  for (;;) {
    p = p.slice(WHITESPACE.exec(p)?.[0].length ?? 0);
    if (p === "") return something ? total : undefined;
    const m = TERM.exec(p);
    const [all = "", whole = "", dot, digits = ""] = m ?? [];
    // Like strtoll: digits (none only before a dot); "3." and "3.s" are rejected below.
    if (whole === "" && dot === undefined) return undefined;
    if (dot !== undefined && digits === "") return undefined;
    p = p.slice(all.length);
    const afterSpace = p.slice(WHITESPACE.exec(p)?.[0].length ?? 0);
    const unit = UNITS.find(([suffix]) => afterSpace.startsWith(suffix));
    // No unit: seconds, but only at the end or before whitespace ("12.34.56" is rejected, "12.34 .56" is not).
    if (unit === undefined && afterSpace === p && p !== "") return undefined;
    if (unit !== undefined) p = afterSpace.slice(unit[0].length);
    const perUnit = unit?.[1] ?? NS_PER_S;
    // In microseconds like parse_time (nanosecond terms are rounded down); each fraction digit d at position i adds
    // d × ⌊unit / 10^i⌋ µs.
    total += (BigInt(whole === "" ? "0" : whole) * perUnit) / NS_PER_US;
    let m10 = perUnit / NS_PER_US;
    for (const d of digits) {
      m10 /= 10n;
      total += BigInt(d) * m10;
    }
    if (total >= USEC_INFINITY) return undefined;
    something = true;
  }
}

/**
 * Parses a `--timeout=` value like varlinkctl: empty = none (`null`), else systemd's parse_sec ({@link parseSec};
 * `infinity` = none). Returns milliseconds: the whole microseconds / 1000 (fractional below 1 ms; the timers round
 * that up to 1 ms).
 *
 * @throws {UsageError} for anything else, and for zero microseconds ("Timeout cannot be zero.").
 */
export function parseTimeout(text: string): number | null {
  if (text === "") return null;
  const us = parseSec(text);
  if (us === undefined) throw new UsageError(`Failed to parse --timeout= parameter '${escapeControls(text)}'.`);
  if (us === "infinity") return null;
  if (us === 0n) throw new UsageError("Timeout cannot be zero.");
  return Number(us) / 1000;
}

/** Whether `s` is `interface.Member` with a valid interface name and member name (UAPI "Names"). */
export function isQualifiedName(s: string): boolean {
  const dot = s.lastIndexOf(".");
  return dot > 0 && isInterfaceName(s.slice(0, dot)) && isMemberName(s.slice(dot + 1));
}

/**
 * Parses `argv` (without the node and script paths).
 *
 * @throws {UsageError} for an unknown command or option, a missing or unexpected option value, an invalid `--json`,
 *   `--timeout`, `--graceful` or `--ints` value, or more than one of `--more`/`-E`, `--collect` and `--oneway`.
 */
export function parseCommandLine(argv: readonly string[]): CommandLine {
  // Pass 1: find the command. Lenient, so an unknown option does not hide it (pass 2 reports it).
  const loose = parseArgs({ args: [...argv], options: ALL, strict: false, allowPositionals: true, tokens: true });
  const command = loose.positionals[0];
  const looseNames = new Set(loose.tokens.flatMap((t) => (t.kind === "option" ? [t.rawName] : [])));
  const wantsHelp = looseNames.has("--help") || looseNames.has("-h");
  const wantsVersion = looseNames.has("--version") || looseNames.has("-V");
  const table = command === undefined ? {} : COMMANDS[command];
  if (table === undefined) {
    if (wantsHelp || wantsVersion) return { ...EMPTY, command: undefined, help: wantsHelp, version: wantsVersion };
    throw new UsageError(`Unknown command verb '${escapeControls(command ?? "")}'.`);
  }

  // Pass 2: strictly, with this command's table.
  let parsed: ReturnType<typeof parseArgs<{ options: ParseArgsOptions; allowPositionals: true; tokens: true }>>;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: forParseArgs(GLOBAL, table),
      strict: true,
      allowPositionals: true,
      tokens: true,
    });
  } catch (e) {
    if (wantsHelp || wantsVersion) return { ...EMPTY, command, help: wantsHelp, version: wantsVersion };
    throw new UsageError(shortMessage(e));
  }

  const defs: Table = { ...GLOBAL, ...table };
  let help = false;
  let version = false;
  let quiet = false;
  let json: JsonMode | undefined;
  let timeout: number | null | undefined;
  const modes = new Set<CallMode>();
  let mode: CallMode = "single";
  const graceful = new Set<string>();
  let check = false;
  let inPlace = false;
  let output: string | undefined;
  let ints: "number" | "bigint" | undefined;
  let importPath: string | undefined;
  let address: string | undefined;
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (defs[token.name]?.shortOnly === true && token.rawName.startsWith("--"))
      throw new UsageError(`Unknown option '${escapeControls(token.rawName)}'`);
    const value = token.value ?? "";
    switch (token.name) {
      case "help":
        help = true;
        break;
      case "version":
        version = true;
        break;
      case "quiet":
        quiet = true;
        break;
      case "j":
        json = "auto";
        break;
      case "json":
        if (value !== "pretty" && value !== "short" && value !== "off")
          throw new UsageError(
            `Unknown argument to --json= switch: '${escapeControls(value)}' (expected pretty, short or off).`,
          );
        json = value;
        break;
      case "timeout":
        timeout = parseTimeout(value);
        break;
      case "more":
        modes.add("more");
        mode = "more";
        break;
      case "E":
        modes.add("more");
        mode = "more";
        timeout = null;
        break;
      case "collect":
        modes.add("collect");
        mode = "collect";
        break;
      case "oneway":
        modes.add("oneway");
        mode = "oneway";
        break;
      case "graceful":
        if (!isQualifiedName(value)) throw new UsageError(`Not a valid Varlink error name: ${escapeControls(value)}`);
        graceful.add(value);
        break;
      case "check":
        check = true;
        break;
      case "in-place":
        inPlace = true;
        break;
      case "output":
        output = value;
        break;
      case "ints":
        if (value !== "number" && value !== "bigint")
          throw new UsageError(`Unknown argument to --ints=: '${escapeControls(value)}' (expected number or bigint).`);
        ints = value;
        break;
      case "import-path":
        importPath = value;
        break;
      case "address":
        address = value;
        break;
    }
  }
  if (modes.size > 1) throw new UsageError("--more/-E, --collect and --oneway are mutually exclusive.");
  if (check && inPlace) throw new UsageError("--check and --in-place are mutually exclusive.");
  return {
    command,
    args: parsed.positionals.slice(1),
    help,
    version,
    quiet,
    json,
    timeout,
    mode,
    graceful: [...graceful].sort(),
    check,
    inPlace,
    output,
    ints,
    importPath,
    address,
  };
}

const EMPTY: CommandLine = {
  command: undefined,
  args: [],
  help: false,
  version: false,
  quiet: false,
  json: undefined,
  timeout: undefined,
  mode: "single",
  graceful: [],
  check: false,
  inPlace: false,
  output: undefined,
  ints: undefined,
  importPath: undefined,
  address: undefined,
};
