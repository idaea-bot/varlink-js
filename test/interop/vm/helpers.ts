// Shared helpers for the VM interop tests: tool lookup, skip reasons, bounded child processes.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";

/** Every child and wait is bounded by this (ms). */
export const TIMEOUT: number = 10_000;

/** The fixture service (run with node). */
export const FIXTURE: string = resolve(import.meta.dirname, "fixture-server.ts");

/** The absolute path of an executable on PATH, or undefined. */
export function which(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const path = join(dir, bin);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // next
    }
  }
  return undefined;
}

/** A `skip` value: false when on Linux with every binary on PATH, else the reason. */
export function needs(...bins: string[]): string | false {
  if (process.platform !== "linux") return `Linux-only (this is ${process.platform})`;
  const missing = bins.filter((b) => which(b) === undefined);
  return missing.length === 0 ? false : `needs ${missing.join(", ")} on PATH`;
}

/** systemd's version from `<tool> --version` (first line `systemd NNN (…)`), or 0. */
export async function systemdVersion(tool: string): Promise<number> {
  try {
    const { stdout } = await run(tool, ["--version"]);
    return Number(/^systemd (\d+)/.exec(stdout)?.[1] ?? "0");
  } catch {
    return 0;
  }
}

/** Runs a command to completion (killed with SIGKILL after {@link TIMEOUT}); rejects on a non-zero exit. */
export function run(
  cmd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: TIMEOUT, killSignal: "SIGKILL", env: env ?? process.env },
      (error, stdout, stderr) => {
        if (error !== null) {
          const failure: Error = Object.assign(error, { stdout, stderr });
          reject(failure);
        } else resolve({ stdout, stderr });
      },
    );
  });
}

/** A spawned child that is always killed by `stop()`; `exited` resolves with its exit code (or signal). */
export interface Child {
  readonly child: ChildProcess;
  readonly exited: Promise<number | string>;
  readonly stderr: () => string;
  stop(): Promise<void>;
}

export function start(cmd: string, args: readonly string[]): Child {
  const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
  const exited = new Promise<number | string>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve(code ?? signal ?? "unknown");
    });
    child.once("error", (e) => {
      resolve(String(e));
    });
  });
  return {
    child,
    exited,
    stderr: () => stderr,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}

/** Resolves with `p`, or rejects after {@link TIMEOUT}. */
export async function within<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out waiting for ${what}`));
        }, TIMEOUT);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Polls until `path` exists (bounded by {@link TIMEOUT}). */
export async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** An executable `#!/bin/sh` wrapper running the fixture with this node and the given flags (exec: needs a path). */
export async function fixtureWrapper(dir: string, flags: readonly string[] = []): Promise<string> {
  const path = join(dir, `fixture-${String(Math.random()).slice(2, 8)}.sh`);
  const quoted = [process.execPath, FIXTURE, ...flags].map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" ");
  await writeFile(path, `#!/bin/sh\nexec ${quoted} "$@"\n`);
  await chmod(path, 0o755);
  return path;
}
