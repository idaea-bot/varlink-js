// varlink-js-native (DESIGN.md §4.15): loads build/varlink_native.node if it was built and this runtime can load
// it (Node on Linux; macOS for development). Never throws at import time: `isAvailable()` and `loadError` say
// whether it loaded, and every other export throws an Error with code `ERR_VARLINK_NATIVE_UNAVAILABLE` if not.
// Pass the module to varlink-js/node: `connect(address, { native })`, `listen(address, { native })`.
/* global process */
import { createRequire } from "node:module";

/** @type {Record<string, unknown> | undefined} */
let binding;
/** @type {Error | undefined} */
let failure;

if (process.versions.bun !== undefined || "Deno" in globalThis) {
  failure = new Error("varlink-js-native needs Node (Bun and Deno lack the libuv access the addon uses)");
} else {
  try {
    binding = /** @type {Record<string, unknown>} */ (createRequire(import.meta.url)("./build/varlink_native.node"));
  } catch (e) {
    failure = new Error(
      "varlink-js-native is not built (run `npm run build` in its directory; Linux, or macOS for development)",
      { cause: e },
    );
  }
}

/** Why the addon did not load, or undefined if it did. */
export const loadError = failure;

/** Whether the addon loaded. */
export function isAvailable() {
  return binding !== undefined;
}

/**
 * @param {string} name
 * @returns {(...args: unknown[]) => unknown}
 */
function fn(name) {
  return (...args) => {
    if (binding === undefined)
      throw Object.assign(new Error(failure?.message ?? "varlink-js-native is not available", { cause: failure }), {
        code: "ERR_VARLINK_NATIVE_UNAVAILABLE",
      });
    return /** @type {(...a: unknown[]) => unknown} */ (binding[name])(...args);
  };
}

/** The kernel's per-message fd limit (SCM_MAX_FD). */
export const SCM_MAX_FD = 253;

export const connect = fn("connect");
export const adopt = fn("adopt");
export const dup = fn("dup");
export const close = fn("close");
export const setCloexec = fn("setCloexec");
export const isUnixSocket = fn("isUnixSocket");
export const setPassRights = fn("setPassRights");
export const release = fn("release");
export const stats = fn("stats");
export const pipe = fn("pipe");
export const setXattr = fn("setXattr");
export const removeXattr = fn("removeXattr");
export const setPathXattr = fn("setPathXattr");
export const memfdSealed = fn("memfdSealed");
export const eventfd = fn("eventfd");
export const pidfdOpen = fn("pidfdOpen");
