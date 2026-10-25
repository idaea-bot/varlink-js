// The service registry directory (UAPI.20 "Service Registry Directory", DESIGN.md §4.6, §5.4) and the
// org.varlink.resolver client. Reference: systemd varlinkctl.c verb_list_registry (2336319d, :1182-1260).
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readlink, realpath, rename, stat, symlink, unlink } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { formatAddress, parseAddress } from "../core/address/parse.ts";
import { safeQuote, ValidationError } from "../core/errors/local.ts";
import { InterfaceNotFoundError } from "../core/errors/standard.ts";
import { isVarlinkError } from "../core/errors/varlink-error.ts";
import { isInterfaceName } from "../core/idl/names.ts";
import { DEFAULT_TIMEOUT, type CallOptions, type Connection } from "../rpc/connection.ts";
import type { RegistryBindOptions, RegistryBinding } from "../rpc/server.ts";
import { checkMode, checkTimeout } from "../rpc/util.ts";
import { connect } from "./connect.ts";

/** Which registry: the system one (`/run/varlink/registry`) or the user's (`$XDG_RUNTIME_DIR/varlink/registry`). */
export type RegistryScope = "system" | "user";

/** One usable entry of a registry directory. */
export interface RegistryEntry {
  /** The interface name (the entry's file name). */
  readonly interface: string;
  /**
   * `unix:<entry path>`: connectable through the symlink, and short; `unix:<target>` instead if the entry path does
   * not fit in sun_path (over 103 bytes, 107 on Linux) and the target does.
   */
  readonly address: string;
  /** The socket the entry resolves to (the entry itself, or its symlink chased). */
  readonly target: string;
}

/** Options for {@link listRegistry}. */
export interface ListRegistryOptions {
  /** Default `"system"`; ignored if `directory` is given. */
  scope?: RegistryScope;
  /** A registry directory to read instead of the scope's. */
  directory?: string;
}

/** Options for {@link resolveInterface}. */
export interface ResolveOptions {
  /** `"auto"` (default): the system registry, then the user's if `XDG_RUNTIME_DIR` is set. Ignored with `directory`. */
  scope?: RegistryScope | "auto";
  /** The only registry directory to look in. */
  directory?: string;
  /** The `org.varlink.resolver` address asked last; default {@link DEFAULT_RESOLVER_ADDRESS}; `false` = none. */
  resolver?: string | false;
  /** Bounds the connect and the call to the resolver (ms, 0 = none); default 45 000. */
  timeout?: number;
  /** Aborts the resolver connect and call (rejects with its reason). */
  signal?: AbortSignal;
}

/** `org.varlink.resolver.GetInfo` result. */
export interface ResolverInfo {
  vendor: string;
  product: string;
  version: string;
  url: string;
  interfaces: string[];
}

/** Where {@link resolveInterface} asks `org.varlink.resolver` by default. */
export const DEFAULT_RESOLVER_ADDRESS = "unix:/run/org.varlink.resolver";

/** The `org.varlink.resolver` IDL (as varlink's stdinterfaces ship it), e.g. to implement a resolver. */
export const ORG_VARLINK_RESOLVER_IDL: string = `# Interface to resolve reverse-domain interface names to
# service addresses
interface org.varlink.resolver

# Get a list of all resolvable interfaces and information
# about the resolver's identity.
method GetInfo() -> (
  vendor: string,
  product: string,
  version: string,
  url: string,
  interfaces: []string
)

# Resolve an interface name to a registered varlink service address
method Resolve(interface: string) -> (address: string)

error InterfaceNotFound (interface: string)
`;

const RESOLVER_INTERFACE_NOT_FOUND = "org.varlink.resolver.InterfaceNotFound";

function codeOf(e: unknown): unknown {
  return typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
}

function checkScope(scope: unknown): RegistryScope {
  return checkMode(scope, "scope", ["system", "user"], "system");
}

function checkDirectory(directory: unknown): string | undefined {
  if (directory === undefined) return undefined;
  if (typeof directory !== "string" || directory === "") throw new TypeError("directory must be a non-empty string");
  return directory;
}

/** `XDG_RUNTIME_DIR` if it is set and absolute. */
function runtimeDir(): string | undefined {
  const dir = process.env.XDG_RUNTIME_DIR;
  return dir !== undefined && isAbsolute(dir) ? dir : undefined;
}

/**
 * The registry directory of a scope (systemd `runtime_directory_generic(scope, "varlink/registry")`):
 * `/run/varlink/registry`, or `$XDG_RUNTIME_DIR/varlink/registry` for `"user"`.
 *
 * @throws {TypeError} for `"user"` without an absolute `XDG_RUNTIME_DIR`, or an invalid scope.
 */
export function registryDirectory(scope: RegistryScope = "system"): string {
  if (checkScope(scope) === "system") return "/run/varlink/registry";
  const dir = runtimeDir();
  if (dir === undefined) throw new TypeError("the user registry needs an absolute XDG_RUNTIME_DIR");
  return join(dir, "varlink", "registry");
}

/** Longest unix socket path `connect` takes: sun_path is 108 bytes on Linux, 104 elsewhere (less the NUL). */
const SUN_PATH_MAX = process.platform === "linux" ? 107 : 103;

/** The address of an entry: through the entry, or its target if only that fits in sun_path. */
function entryAddress(entry: string, target: string): string {
  const fits = (path: string): boolean => Buffer.byteLength(path) <= SUN_PATH_MAX;
  return formatAddress({ kind: "unix", path: fits(entry) || !fits(target) ? entry : target });
}

/** The socket an entry leads to (itself, or its symlink chased), or undefined (missing, dangling, not a socket). */
async function socketOf(entry: string): Promise<string | undefined> {
  try {
    const st = await lstat(entry);
    if (st.isSocket()) return entry;
    if (!st.isSymbolicLink() || !(await stat(entry)).isSocket()) return undefined;
    return await realpath(entry);
  } catch {
    return undefined;
  }
}

/**
 * The usable entries of a registry directory (like `varlinkctl list-registry`), sorted by interface: names that
 * are valid interface names and are a socket or a symlink to one. Everything else is skipped; a missing directory
 * gives `[]`. Like any registry reader, do not assume it is complete (UAPI.20). An entry's `address` goes through
 * the entry unless its path is too long for a unix socket address (then the target's, if that fits).
 *
 * @throws {TypeError} (as a rejection) for invalid options; other errors reading the directory reject as they are.
 */
export async function listRegistry(options?: ListRegistryOptions): Promise<RegistryEntry[]> {
  const directory = checkDirectory(options?.directory) ?? registryDirectory(checkScope(options?.scope));
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (e) {
    if (codeOf(e) === "ENOENT" || codeOf(e) === "ENOTDIR") return [];
    throw e;
  }
  const entries: RegistryEntry[] = [];
  for (const name of names.sort()) {
    if (!isInterfaceName(name)) continue;
    const path = join(directory, name);
    const target = await socketOf(path);
    if (target !== undefined) entries.push({ interface: name, address: entryAddress(path, target), target });
  }
  return entries;
}

function checkString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ValidationError([path], "type", "expected a string");
  return value;
}

/** The address kinds a resolver may answer with: sockets only (§4.6). */
const RESOLVABLE_KINDS: ReadonlySet<string> = new Set(["unix", "unix-abstract", "tcp"]);

/**
 * `org.varlink.resolver.Resolve`: the address a resolver registered for `iface`, checked: a string `parseAddress`
 * accepts, of a socket kind (`unix:`, abstract `unix:@`, `tcp:`), else a {@link ValidationError} for `address`.
 * Anything that `connect()` would spawn or reach otherwise (`exec:`, `ssh-unix:`, `ssh-exec:`, websocket, http) is
 * rejected, the kind named: a resolver (or whoever answers in its place) must not make `connect(await
 * resolveInterface(…))` run a local binary or a remote command. Error replies reject as usual (the resolver's
 * `org.varlink.resolver.InterfaceNotFound` as a VarlinkError of that name).
 */
export async function resolverResolve(conn: Connection, iface: string, options?: CallOptions): Promise<string> {
  const reply = await conn.call("org.varlink.resolver.Resolve", { interface: iface }, options);
  const address = checkString(reply.address, "address");
  let kind: string;
  try {
    kind = parseAddress(address).kind;
  } catch (e) {
    throw new ValidationError(["address"], "type", `not a varlink address: ${safeQuote(address)}`, { cause: e });
  }
  if (!RESOLVABLE_KINDS.has(kind))
    throw new ValidationError(
      ["address"],
      "type",
      `a resolver may only answer with a socket address (unix, unix-abstract, tcp), not kind ${kind}`,
    );
  return address;
}

/** `org.varlink.resolver.GetInfo`, its reply checked against the IDL ({@link ValidationError} if it does not match). */
export async function resolverGetInfo(conn: Connection, options?: CallOptions): Promise<ResolverInfo> {
  const reply = await conn.call("org.varlink.resolver.GetInfo", {}, options);
  const info: ResolverInfo = {
    vendor: checkString(reply.vendor, "vendor"),
    product: checkString(reply.product, "product"),
    version: checkString(reply.version, "version"),
    url: checkString(reply.url, "url"),
    interfaces: [],
  };
  if (!Array.isArray(reply.interfaces)) throw new ValidationError(["interfaces"], "type", "expected an array");
  (reply.interfaces as unknown[]).forEach((name, i) => {
    if (typeof name !== "string") throw new ValidationError(["interfaces", i], "type", "expected a string");
    info.interfaces.push(name);
  });
  return info;
}

/**
 * Finds a service implementing `name` (DESIGN.md §4.6) and returns its address: the registry entry
 * `<dir>/<name>` (a socket or a symlink to one → `unix:<entry path>`) in `directory`, or by `scope` (`"auto"`: the
 * system registry, then the user's if `XDG_RUNTIME_DIR` is set; `unix:<target>` instead if the entry path is too
 * long for a unix socket address and the socket's is not); then `org.varlink.resolver` at `resolver`, whose answer
 * must be a socket address (`unix:`, `tcp:`; see {@link resolverResolve}: never one that `connect()` would spawn).
 * Nothing found rejects with {@link InterfaceNotFoundError} (`cause`: the resolver's error, or why it could not be
 * reached). Abort and resolver errors other than "not found" (timeouts, invalid replies) reject as they are.
 *
 * @throws {TypeError} (as a rejection) for an invalid interface name or options.
 */
export async function resolveInterface(name: string, options?: ResolveOptions): Promise<string> {
  if (typeof name !== "string" || !isInterfaceName(name)) throw new TypeError("not a valid interface name");
  const directory = checkDirectory(options?.directory);
  const scope = checkMode(options?.scope, "scope", ["system", "user", "auto"], "auto");
  const resolver = options?.resolver ?? DEFAULT_RESOLVER_ADDRESS;
  if (resolver !== false && typeof resolver !== "string") throw new TypeError("resolver must be an address or false");
  if (resolver !== false) parseAddress(resolver);
  const timeout = checkTimeout(options?.timeout, "timeout", DEFAULT_TIMEOUT);
  const signal = options?.signal;
  const dirs: string[] = [];
  if (directory !== undefined) dirs.push(directory);
  else {
    if (scope !== "user") dirs.push(registryDirectory("system"));
    if (scope === "user") dirs.push(registryDirectory("user"));
    else if (scope === "auto" && runtimeDir() !== undefined) dirs.push(registryDirectory("user"));
  }
  for (const dir of dirs) {
    const path = join(dir, name);
    const target = await socketOf(path);
    if (target !== undefined) return entryAddress(path, target);
  }
  if (resolver === false) throw new InterfaceNotFoundError({ interface: name });
  let conn: Connection;
  try {
    conn = await connect(resolver, { timeout, ...(signal === undefined ? {} : { signal }) });
  } catch (e) {
    if (signal?.aborted === true) throw e;
    throw new InterfaceNotFoundError({ interface: name }, { cause: e });
  }
  try {
    return await resolverResolve(conn, name, signal === undefined ? {} : { signal });
  } catch (e) {
    // The resolver's own error, or a peer that does not implement org.varlink.resolver at all.
    if (isVarlinkError(e, RESOLVER_INTERFACE_NOT_FOUND) || InterfaceNotFoundError.is(e))
      throw new InterfaceNotFoundError({ interface: name }, { cause: e });
    throw e;
  } finally {
    await conn.close();
  }
}

/** One connect to a unix socket: accepted (or EAGAIN, a full backlog on Linux) = live; refused; vanished. */
function probeOnce(path: string): Promise<"live" | "refused" | "gone"> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ path });
    socket.once("connect", () => {
      socket.destroy();
      resolve("live");
    });
    socket.once("error", (error) => {
      socket.destroy();
      const code = codeOf(error);
      if (code === "ECONNREFUSED") resolve("refused");
      else if (code === "ENOENT" || code === "ENOTDIR") resolve("gone");
      else if (code === "EAGAIN") resolve("live");
      else reject(error);
    });
  });
}

/** Connects to a stale-looking socket this many times, this far apart, before replacing it (as listen() does). */
const PROBE_ATTEMPTS = 3;
const PROBE_INTERVAL_MS = 20;

/** Whether the socket behind an entry refused (or lost) every connect. */
async function isStaleSocket(path: string): Promise<boolean> {
  for (let i = 0; i < PROBE_ATTEMPTS; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
    if ((await probeOnce(path)) === "live") return false;
  }
  return true;
}

/** What is at a registry entry, from our point of view. */
type EntryState = "gone" | "ours" | "stale" | { conflict: string };

/** Whether the symlink `entry` leads to `target`: spelled the same, or resolving to the same file (`realpath`). */
async function linksTo(entry: string, target: string): Promise<boolean> {
  const link = await readlinkOf(entry);
  if (link === undefined) return false;
  if (link === target) return true;
  try {
    return (await realpath(entry)) === (await realpath(target));
  } catch {
    return false; // dangling, or the target is gone
  }
}

async function examine(entry: string, target: string): Promise<EntryState> {
  let st;
  try {
    st = await lstat(entry);
  } catch (e) {
    if (codeOf(e) === "ENOENT") return "gone";
    throw e;
  }
  if (st.isSymbolicLink()) {
    if (await linksTo(entry, target)) return "ours";
    try {
      st = await stat(entry);
    } catch (e) {
      if (codeOf(e) === "ENOENT" || codeOf(e) === "ENOTDIR") return "stale"; // dangling
      throw e;
    }
  }
  if (!st.isSocket()) return { conflict: "not a socket" };
  return (await isStaleSocket(entry)) ? "stale" : { conflict: "another service is listening on it" };
}

function entryInUse(entry: string, why: string): Error {
  return Object.assign(new Error(`registry entry ${entry} is in use (${why})`), { code: "EEXIST", path: entry });
}

/** Makes `entry` a symlink to `target`: `"created"` (also a stale entry replaced) or `"adopted"` (already ours). */
async function place(dir: string, name: string, entry: string, target: string): Promise<"created" | "adopted"> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await symlink(target, entry);
      return "created";
    } catch (e) {
      if (codeOf(e) !== "EEXIST") throw e;
    }
    const state = await examine(entry, target);
    if (state === "ours") return "adopted";
    if (state === "gone") continue;
    if (state !== "stale") throw entryInUse(entry, state.conflict);
    // Atomic replace: whoever connects sees the old entry or ours, never nothing.
    const tmp = join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
    await symlink(target, tmp);
    try {
      await rename(tmp, entry);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
    // Another binder may have replaced the stale entry right after us: then it is theirs, not "created".
    if ((await readlinkOf(entry)) === target) return "created";
  }
  throw entryInUse(entry, "it keeps changing");
}

/** `readlink`, or undefined if the entry is gone or no longer a symlink (EINVAL). */
async function readlinkOf(entry: string): Promise<string | undefined> {
  try {
    return await readlink(entry);
  } catch (e) {
    if (codeOf(e) === "ENOENT" || codeOf(e) === "EINVAL") return undefined;
    throw e;
  }
}

/**
 * Removes `entry` if it is still a symlink spelled exactly `target`. No realpath matching: a differently spelled
 * symlink (adopted because it resolved to our socket) may be someone else's, and stays.
 */
async function removeIfOurs(entry: string, target: string): Promise<void> {
  // Gone, no longer a symlink, or spelled otherwise: not ours (any more).
  if ((await readlinkOf(entry)) !== target) return;
  try {
    await unlink(entry);
  } catch (e) {
    if (codeOf(e) !== "ENOENT") throw e;
  }
}

/**
 * `mkdir -p dir`, the directories it created `chmod`ed to 0755 (whatever the umask: readers must get in). Each is
 * `lstat`ed first and left alone unless it is still a directory (not a symlink someone swapped in) that we own.
 */
async function makeDirectory(dir: string): Promise<void> {
  const first = await mkdir(dir, { recursive: true, mode: 0o755 });
  if (first === undefined) return;
  const created: string[] = [];
  for (let d = dir; ; d = dirname(d)) {
    created.unshift(d);
    if (d === first || dirname(d) === d) break;
  }
  const uid = process.getuid?.();
  for (const d of created) {
    const st = await lstat(d).catch(() => undefined);
    if (st?.isDirectory() !== true || (uid !== undefined && st.uid !== uid)) continue;
    await chmod(d, 0o755);
  }
}

/**
 * Publishes the unix socket at `socketPath` in a registry directory (DESIGN.md §5.4): one symlink
 * `<dir>/<interface>` → the absolute socket path per interface. `dir` is `options.directory`, else
 * {@link registryDirectory}`(options.scope ?? "system")`, created if missing (the directories created are `chmod`ed
 * to 0755 whatever the umask). An existing symlink that already leads to the socket (as spelled, or resolving to
 * the same file) is adopted; a stale one (dangling, or a socket refusing connects) is replaced atomically (symlink +
 * rename); anything else (a live socket of another service, a file, …) fails with an `EEXIST` error naming the
 * entry, and the entries this call created are removed again (all or nothing). `unbind()` (idempotent) removes
 * every entry that is still a symlink whose `readlink` is exactly the absolute socket path, leaving anything else
 * alone: an entry adopted because it resolved to the socket but is spelled differently (a relative symlink, say) is
 * left in place. `server.serve(listener,
 * {registry})` calls this through the listener (a `listen({fd})` listener's binding keeps its entries at unbind);
 * use it directly for listeners of your own.
 *
 * Caveats: on macOS/BSD a live socket whose backlog is full refuses connects (`ECONNREFUSED`) like a stale one,
 * so a busy service's entry may be taken for stale and replaced (as with `listen()`). `unbind()` checks the entry
 * with `readlink` and then unlinks it: an entry another binder puts in place between the two is removed (there is
 * no atomic compare-and-unlink); that binder's readers fall back as for any missing entry.
 *
 * @throws {TypeError} (as a rejection) for an invalid or duplicate interface name or invalid options.
 */
export async function bindRegistry(
  socketPath: string,
  interfaces: readonly string[],
  options?: RegistryBindOptions,
): Promise<RegistryBinding> {
  if (typeof socketPath !== "string" || socketPath === "") throw new TypeError("socketPath must be a non-empty string");
  if (!Array.isArray(interfaces)) throw new TypeError("interfaces must be an array of interface names");
  const names = new Set<string>();
  for (const name of interfaces as unknown[]) {
    // Validated before touching the filesystem: an interface name never contains "/" or "..".
    if (typeof name !== "string" || !isInterfaceName(name))
      throw new TypeError(`${typeof name === "string" ? safeQuote(name) : "a value"} is not a valid interface name`);
    if (names.has(name)) throw new TypeError(`interface ${name} is listed twice`);
    names.add(name);
  }
  const dir = resolve(checkDirectory(options?.directory) ?? registryDirectory(checkScope(options?.scope)));
  const target = resolve(socketPath);
  await makeDirectory(dir);
  const entries: string[] = [];
  const created: string[] = [];
  try {
    for (const name of names) {
      const entry = join(dir, name);
      if ((await place(dir, name, entry, target)) === "created") created.push(entry);
      entries.push(entry);
    }
  } catch (e) {
    await Promise.allSettled(created.map((entry) => removeIfOurs(entry, target)));
    throw e;
  }
  let unbinding: Promise<void> | undefined;
  return {
    entries: Object.freeze([...entries]),
    unbind: () => {
      unbinding ??= Promise.allSettled(entries.map((entry) => removeIfOurs(entry, target))).then((results) => {
        const failed = results.find((r) => r.status === "rejected");
        if (failed !== undefined) throw failed.reason;
      });
      return unbinding;
    },
  };
}
