// Helpers for the docs tests: repo paths, running examples as child processes, markdown fences.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root. */
export const ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** A repo-relative file's text. */
export function readRepoFile(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** The outcome of a finished child process. */
export interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Generous bound for one child process (CI machines can be slow). */
export const CHILD_TIMEOUT_MS = 20_000;

function describeRun(what: string, r: RunResult): string {
  return `${what}: code ${String(r.code)}, signal ${String(r.signal)}\n--- stdout\n${r.stdout}--- stderr\n${r.stderr}`;
}

/** Waits for `child` to exit, collecting its output; SIGKILLs it after `timeoutMs`. */
function finished(child: ChildProcess, timeoutMs: number, out: { stdout: string; stderr: string }): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout: out.stdout, stderr: out.stderr });
    });
  });
}

function spawnExample(file: string, args: readonly string[], cwd: string): ChildProcess {
  return spawn(process.execPath, [join(ROOT, file), ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function collect(child: ChildProcess): { stdout: string; stderr: string } {
  const out = { stdout: "", stderr: "" };
  child.stdout?.setEncoding("utf8").on("data", (s: string) => (out.stdout += s));
  child.stderr?.setEncoding("utf8").on("data", (s: string) => (out.stderr += s));
  return out;
}

/** Runs a repo-relative example to completion with `process.execPath`. */
export async function runExample(file: string, args: readonly string[] = [], cwd: string = ROOT): Promise<RunResult> {
  const child = spawnExample(file, args, cwd);
  return finished(child, CHILD_TIMEOUT_MS, collect(child));
}

/** Like {@link runExample}, but fails unless the exit code is 0; returns stdout. */
export async function runExampleOk(file: string, args: readonly string[] = []): Promise<string> {
  const r = await runExample(file, args);
  if (r.code !== 0) throw new Error(describeRun(file, r));
  return r.stdout;
}

/** A running example server. */
export interface RunningServer {
  /** The address from its `Listening on <address>` line. */
  readonly address: string;
  /** Output so far. */
  output(): { stdout: string; stderr: string };
  /** Sends `signal` (default SIGTERM) and waits for the exit. */
  stop(signal?: NodeJS.Signals): Promise<RunResult>;
}

/** Starts a server example and waits for its `Listening on <address>` line. */
export async function startServer(
  file: string,
  args: readonly string[] = [],
  cwd: string = ROOT,
): Promise<RunningServer> {
  const child = spawnExample(file, args, cwd);
  const out = collect(child);
  let exited = false;
  const done = new Promise<RunResult>((resolvePromise) => {
    child.once("close", (code, signal) => {
      exited = true;
      resolvePromise({ code, signal, stdout: out.stdout, stderr: out.stderr });
    });
  });
  const stop = async (signal: NodeJS.Signals = "SIGTERM"): Promise<RunResult> => {
    if (!exited) child.kill(signal);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, CHILD_TIMEOUT_MS);
    try {
      return await done;
    } finally {
      clearTimeout(timer);
    }
  };
  const address = await new Promise<string>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${file} did not print "Listening on" in time\n${out.stdout}${out.stderr}`));
    }, CHILD_TIMEOUT_MS);
    const onData = (): void => {
      const m = /^Listening on (.+)$/m.exec(out.stdout);
      if (m?.[1] === undefined) return;
      cleanup();
      resolvePromise(m[1]);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error(`${file} exited before listening\n${out.stdout}${out.stderr}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("close", onClose);
    };
    child.stdout?.on("data", onData);
    child.once("close", onClose);
  }).catch(async (e: unknown) => {
    await stop("SIGKILL");
    throw e;
  });
  return { address, output: () => ({ ...out }), stop };
}

/** One fenced code block of a markdown file. */
export interface Fence {
  /** The info string's first word (`ts`, `sh`, …), lowercased. */
  readonly lang: string;
  /** The content between the fences (no trailing newline after the last line). */
  readonly code: string;
  /** 1-based line of the opening fence. */
  readonly line: number;
  /** The `<!-- snippet: … -->` value on the line before the fence (blank lines skipped), if any. */
  readonly snippet: string | undefined;
}

/** The fenced code blocks (``` only) of a markdown text. */
export function fences(markdown: string): Fence[] {
  const lines = markdown.split("\n");
  const result: Fence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\S*)/.exec(lines[i] ?? "");
    if (open === null) continue;
    let end = i + 1;
    while (end < lines.length && lines[end] !== "```") end++;
    if (end >= lines.length) throw new Error(`unterminated code fence at line ${String(i + 1)}`);
    let prev = i - 1;
    while (prev >= 0 && (lines[prev] ?? "").trim() === "") prev--;
    const marker = /^<!-- snippet: (.+?) -->$/.exec((lines[prev] ?? "").trim());
    result.push({
      lang: (open[1] ?? "").toLowerCase(),
      code: lines.slice(i + 1, end).join("\n"),
      line: i + 1,
      snippet: marker?.[1],
    });
    i = end;
  }
  return result;
}
