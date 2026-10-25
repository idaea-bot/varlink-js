// Varlink address strings (DESIGN.md §4.6, §4.11): parse into an AddressSpec and format back canonically.
// Runtime-agnostic: only `URL` for the URL forms.
import { safeQuote } from "../errors/local.ts";

/** A parsed varlink address. Resolving and connecting is the runtime adapters' job (§4.7). */
export type AddressSpec =
  /** AF_UNIX socket path (`unix:/abs`, `unix:rel`, bare `/abs`, `./rel`, `../rel`), as given. */
  | { readonly kind: "unix"; readonly path: string }
  /** Linux abstract socket (`unix:@name`); `name` excludes the `@`. */
  | { readonly kind: "unix-abstract"; readonly name: string }
  /** `tcp:host:port` or `tcp:[v6]:port`; `host` has no brackets. */
  | { readonly kind: "tcp"; readonly host: string; readonly port: number }
  /** `exec:path`: spawn with socket activation (§5.8). */
  | { readonly kind: "exec"; readonly path: string }
  /** `ssh-unix:host:/path` (alias `ssh:`): `ssh -W /path host`. */
  | { readonly kind: "ssh-unix"; readonly host: string; readonly path: string }
  /** `ssh-exec:host:cmdline`: varlink on the remote command's stdio. */
  | { readonly kind: "ssh-exec"; readonly host: string; readonly command: string }
  /** WebSocket mode: `ws://`, `wss://`, or `http(s)://…/ws/services/<svc>` (normalized by `URL`). */
  | { readonly kind: "websocket"; readonly url: string }
  /** Simple HTTP mode: any other `http(s)://` URL, the bridge base URL (normalized by `URL`). */
  | { readonly kind: "http"; readonly url: string };

const MAX_PORT = 65535;
const PORT = /^[0-9]{1,5}$/;
const URL_SCHEME = /^(?:https?|wss?):\/\//i;
const WS_SERVICE_PATH = /\/ws\/services\/[^/]+$/;

function invalid(input: string, why: string): never {
  throw new TypeError(`invalid varlink address ${safeQuote(input)}: ${why}`);
}

function parsePort(input: string, text: string): number {
  if (!PORT.test(text)) invalid(input, "the port must be a decimal number");
  const port = Number(text);
  if (port > MAX_PORT) invalid(input, `the port must be at most ${String(MAX_PORT)}`);
  return port;
}

function parseTcp(input: string, rest: string): AddressSpec {
  let host: string;
  let port: string;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close < 0) invalid(input, "unterminated [ in the host");
    host = rest.slice(1, close);
    if (!host.includes(":")) invalid(input, "a bracketed host must be an IPv6 address");
    if (host.includes("[")) invalid(input, "[ in the host");
    if (rest[close + 1] !== ":") invalid(input, "expected :port after the bracketed host");
    port = rest.slice(close + 2);
  } else {
    const colon = rest.lastIndexOf(":");
    if (colon < 0) invalid(input, "expected tcp:host:port");
    host = rest.slice(0, colon);
    port = rest.slice(colon + 1);
    if (host.includes("[") || host.includes("]")) invalid(input, "[ or ] in an unbracketed host");
  }
  if (host === "") invalid(input, "empty host");
  return { kind: "tcp", host, port: parsePort(input, port) };
}

function parseUrl(input: string): AddressSpec {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    invalid(input, "not a valid URL");
  }
  const scheme = url.protocol;
  if (scheme === "ws:" || scheme === "wss:" || WS_SERVICE_PATH.test(url.pathname))
    return { kind: "websocket", url: url.href };
  return { kind: "http", url: url.href };
}

function unixPath(input: string, path: string): AddressSpec {
  if (path === "") invalid(input, "empty socket path");
  if (path.includes("\0")) invalid(input, "NUL in the socket path");
  return { kind: "unix", path };
}

/**
 * Parses a varlink address (DESIGN.md §4.6). Everything after the first `;` is ignored (UAPI: room for future
 * extensions), except in URL forms, which are kept whole (a URL may contain `;`).
 *
 * @throws {TypeError} for an invalid address; the message quotes the input log-safely (control characters
 *   escaped, cut to 256 code units).
 */
export function parseAddress(address: string): AddressSpec {
  // Untyped callers may pass anything.
  if (typeof address !== "string") throw new TypeError("a varlink address must be a string");
  if (URL_SCHEME.test(address)) return parseUrl(address);
  const semi = address.indexOf(";");
  const s = semi < 0 ? address : address.slice(0, semi);
  if (s.startsWith("unix:")) {
    const rest = s.slice(5);
    if (rest.startsWith("@")) {
      const name = rest.slice(1);
      if (name === "") invalid(address, "empty abstract socket name");
      if (name.includes("\0")) invalid(address, "NUL in the abstract socket name");
      return { kind: "unix-abstract", name };
    }
    return unixPath(address, rest);
  }
  if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../")) return unixPath(address, s);
  if (s.startsWith("tcp:")) return parseTcp(address, s.slice(4));
  if (s.startsWith("exec:")) {
    const path = s.slice(5);
    if (path === "") invalid(address, "empty exec path");
    return { kind: "exec", path };
  }
  const ssh = s.startsWith("ssh-unix:") ? 9 : s.startsWith("ssh:") ? 4 : 0;
  if (ssh > 0) {
    // Host and path split at the first ':' (sd-varlink).
    const rest = s.slice(ssh);
    const colon = rest.indexOf(":");
    if (colon <= 0) invalid(address, "expected ssh-unix:host:/path");
    const path = rest.slice(colon + 1);
    if (!path.startsWith("/")) invalid(address, "the remote socket path must be absolute");
    if (path.includes("\0")) invalid(address, "NUL in the socket path");
    return { kind: "ssh-unix", host: rest.slice(0, colon), path };
  }
  if (s.startsWith("ssh-exec:")) {
    const rest = s.slice(9);
    const colon = rest.indexOf(":");
    if (colon <= 0) invalid(address, "expected ssh-exec:host:command");
    const command = rest.slice(colon + 1);
    if (command === "") invalid(address, "empty remote command");
    return { kind: "ssh-exec", host: rest.slice(0, colon), command };
  }
  return invalid(address, "unknown address syntax");
}

function render(spec: AddressSpec): string {
  switch (spec.kind) {
    case "unix":
      return `unix:${spec.path}`;
    case "unix-abstract":
      return `unix:@${spec.name}`;
    case "tcp":
      return spec.host.includes(":")
        ? `tcp:[${spec.host}]:${String(spec.port)}`
        : `tcp:${spec.host}:${String(spec.port)}`;
    case "exec":
      return `exec:${spec.path}`;
    case "ssh-unix":
      return `ssh-unix:${spec.host}:${spec.path}`;
    case "ssh-exec":
      return `ssh-exec:${spec.host}:${spec.command}`;
    case "websocket":
    case "http":
      return spec.url;
  }
}

function sameSpec(a: AddressSpec, b: AddressSpec): boolean {
  const ka = Object.keys(a);
  return (
    ka.length === Object.keys(b).length &&
    ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k])
  );
}

/**
 * The canonical string of `spec` (`unix:/path`, `unix:@name`, `tcp:host:port`, `tcp:[v6]:port`, `exec:…`,
 * `ssh-unix:host:/path`, `ssh-exec:host:cmd`, the URL). `parseAddress(formatAddress(x))` equals `x`.
 *
 * @throws {TypeError} if `spec` has no string form that parses back to it (e.g. a `;` that parsing would cut off,
 *   an `http` URL that names a WebSocket service path, a unix path starting with `@`).
 */
export function formatAddress(spec: AddressSpec): string {
  // Untyped callers may pass anything.
  const rawKind: unknown = spec.kind;
  const kind = safeQuote(String(rawKind));
  let out: string;
  let back: AddressSpec;
  try {
    out = render(spec);
    back = parseAddress(out);
  } catch (e) {
    throw new TypeError(`address spec of kind ${kind} has no valid string form`, { cause: e });
  }
  if (!sameSpec(spec, back)) throw new TypeError(`address spec of kind ${kind} has no string form that parses back`);
  return out;
}
