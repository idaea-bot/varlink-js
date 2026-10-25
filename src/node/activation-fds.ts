// The fd numbers socket activation passed to this process (DESIGN.md §5.8), shared by activation.ts (which records
// them) and spawn.ts (which keeps them from our children). A module of its own: activation.ts → listen.ts →
// registry.ts → connect.ts → spawn.ts would be an import cycle.

/**
 * varlink-js-private hint a connected-mode `exec:` sets for its child: fd 3 is a connected socketpair end.
 * `listenFromEnv` reads it only in `accept: "auto"` mode and only where `/proc` says nothing about the fd (without
 * the native addon nothing else can tell a connected socket from a listening one), and unsets it with `LISTEN_*`.
 */
export const ACTIVATION_HINT_ENV = "VARLINK_JS_ACTIVATION";

const fds = new Set<number>();

/** Records the activation fds 3 … 3 + count − 1 (internal; `listenFromEnv` calls it). */
export function recordActivationFds(first: number, count: number): void {
  for (let i = 0; i < count; i++) fds.add(first + i);
}

/**
 * Every fd number `listenFromEnv` saw in `LISTEN_FDS` (selected by name or not), ascending (internal). Node cannot
 * set `FD_CLOEXEC` on them, so the spawners cover them with `/dev/null` in their children.
 */
export function inheritedActivationFds(): readonly number[] {
  return [...fds].sort((a, b) => a - b);
}
