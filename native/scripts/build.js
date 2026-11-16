// Builds native/build/varlink_native.node from native/src/varlink_native.c without node-gyp (DESIGN.md §4.15):
// one compiler call against the running Node's headers. Linux is the supported platform; macOS builds for
// development. Fails loudly (exit 1, a message saying why) when the build is not possible.
//
// Environment: CC (default `cc`), NODE_INCLUDE_DIR (default <node prefix>/include/node), CFLAGS (appended).
/* global process */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src", "varlink_native.c");
const outDir = join(root, "build");
const output = join(outDir, "varlink_native.node");

/** @param {string} message */
function fail(message) {
  process.stderr.write(`varlink-js-native: build failed: ${message}\n`);
  process.exit(1);
}

if (process.platform !== "linux" && process.platform !== "darwin")
  fail(`unsupported platform ${process.platform} (Linux is supported; macOS builds for development)`);
if (process.versions.bun !== undefined || "Deno" in globalThis)
  fail("build with Node (the addon is Node-only: Bun and Deno lack the libuv access it needs)");

const includeDir = process.env.NODE_INCLUDE_DIR ?? resolve(process.execPath, "../../include/node");
if (!existsSync(join(includeDir, "node_api.h")) || !existsSync(join(includeDir, "uv.h")))
  fail(
    `Node headers not found in ${includeDir} (node_api.h, uv.h). Install a Node distribution that ships its ` +
      "headers, or set NODE_INCLUDE_DIR to their directory.",
  );

const cc = process.env.CC ?? "cc";
const args = [
  "-std=gnu11",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-fPIC",
  "-shared",
  "-fvisibility=hidden",
  `-I${includeDir}`,
];
// macOS: the napi_*/uv_* symbols come from the node binary at load time.
if (process.platform === "darwin") args.push("-undefined", "dynamic_lookup");
if (process.env.CFLAGS !== undefined && process.env.CFLAGS.trim() !== "")
  args.push(...process.env.CFLAGS.trim().split(/\s+/));
mkdirSync(outDir, { recursive: true });
const temporary = `${output}.${String(process.pid)}.tmp`;
args.push("-o", temporary, source);

process.stdout.write(`${cc} ${args.join(" ")}\n`);
const result = spawnSync(cc, args, { stdio: "inherit" });
if (result.error !== undefined) {
  rmSync(temporary, { force: true });
  fail(`could not run the C compiler '${cc}': ${result.error.message} (install gcc or clang, or set CC)`);
}
if (result.status !== 0) {
  rmSync(temporary, { force: true });
  fail(`${cc} exited with ${result.status === null ? `signal ${String(result.signal)}` : String(result.status)}`);
}
renameSync(temporary, output);
process.stdout.write(`varlink-js-native: built ${output}\n`);
