// `call --upgrade ADDRESS METHOD [PARAMETERS]` (DESIGN.md §4.14, §5.6), after varlinkctl's varlink_call_and_upgrade
// (systemd src/varlinkctl/varlinkctl.c): the upgrade call, then a raw byte pipe between stdin/stdout and the upgraded
// connection with socket-forward semantics (src/shared/socket-forward.c): each direction half-closes its write side
// at its EOF, a disconnect counts as that direction's end (not as an error), and the command is done once both are.
import { isVarlinkError, isVarlinkLocalError } from "../core/errors/index.ts";
import type { ByteChannel } from "../core/protocol/index.ts";
import { failureReason, withTarget, type Context } from "./context.ts";
import { abortable, BrokenPipeError, CliError, describeError, isDisconnectCode } from "./io.ts";

/**
 * Whether a channel failure means the peer went away: an errno in systemd's ERRNO_IS_DISCONNECT set (Node's `code`,
 * {@link isDisconnectCode}), or the library's ConnectionClosedError (io.systemd.Disconnected: what the socket,
 * spawn/ssh and WebSocket channels reject with once the connection is gone), on the error or along its `cause` chain
 * — unless some error on that chain is marked `local: true` (the WebSocket channel's own failures: receive limit,
 * unsupported or unreadable data; not the Close guard timeout, which is the peer's), which are failures, not the
 * stream's end. Never throws.
 */
export function isDisconnect(error: unknown): boolean {
  let e = error;
  let disconnect = false;
  for (let depth = 0; depth < 8 && typeof e === "object" && e !== null; depth++) {
    try {
      if ((e as { local?: unknown }).local === true) return false;
      if (isVarlinkLocalError(e, "io.systemd.Disconnected") || isDisconnectCode((e as { code?: unknown }).code))
        disconnect = true;
      e = (e as { cause?: unknown }).cause;
    } catch {
      return false;
    }
  }
  return disconnect;
}

/**
 * Pipes stdin → `channel` (stdin's EOF ends the channel's write side) and `channel` → stdout (one chunk at a time,
 * each write awaited: backpressure both ways), like socket-forward:
 * - a disconnect ({@link isDisconnect}) while writing to `channel` ends stdin → channel quietly (stdin is no longer
 *   read); while reading from `channel` it counts as that direction's EOF;
 * - when channel → stdout ends, stdout is ended (`io.stdout.end`), so a downstream reader sees EOF at once, while
 *   stdin → channel goes on until stdin's EOF.
 *
 * Resolves once both directions are done; rejects on any other transport failure (a CliError), a stdout failure
 * (BrokenPipeError or CliError, as is: either stops both directions) or io.signal (its reason).
 */
export function pipeUpgraded(ctx: Context, channel: ByteChannel): Promise<void> {
  const signal = ctx.io.signal;
  return new Promise<void>((resolve, reject) => {
    // An object, so that TypeScript does not narrow the flags inside the async closures below.
    const state = { done: false, stdinReleased: false, upDone: false, downDone: false };
    const input = ctx.io.stdin[Symbol.asyncIterator]();
    /** Stops reading stdin before its EOF, so an in-process caller is left with no pending read. */
    const releaseStdin = (): void => {
      if (state.stdinReleased) return;
      state.stdinReleased = true;
      try {
        void input.return?.().catch(() => undefined);
      } catch {
        // Nothing more to release.
      }
    };
    const finish = (error?: unknown): void => {
      if (state.done) return;
      state.done = true;
      signal?.removeEventListener("abort", onAbort);
      releaseStdin();
      if (error === undefined) resolve();
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- whatever failed, as is
      else reject(error);
    };
    const onAbort = (): void => {
      finish(signal?.reason);
    };
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const transportFailed = (e: unknown): CliError => new CliError(`Upgraded connection failed: ${describeError(e)}`);
    const maybeDone = (): void => {
      if (state.upDone && state.downDone) finish();
    };

    // stdin → channel.
    void (async () => {
      for (;;) {
        let r: IteratorResult<Uint8Array>;
        try {
          r = await abortable(input.next(), signal);
        } catch (e) {
          finish(
            signal?.aborted === true
              ? signal.reason
              : new CliError(`Failed to read standard input: ${describeError(e)}`),
          );
          return;
        }
        if (state.done) return;
        if (r.done === true) {
          // stdin's EOF: nothing left to release.
          state.stdinReleased = true;
          break;
        }
        try {
          await channel.write(r.value);
        } catch (e) {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- may change during the await
          if (state.done) return;
          if (!isDisconnect(e)) {
            finish(transportFailed(e));
            return;
          }
          // The peer is gone: this direction is over (socket-forward closes both of its ends); stdin is not read on.
          releaseStdin();
          state.upDone = true;
          maybeDone();
          return;
        }
      }
      // Half-close; a peer that is gone already shows up on the reading side.
      await channel.end().catch(() => undefined);
      state.upDone = true;
      maybeDone();
    })();

    // channel → stdout.
    void (async () => {
      for (;;) {
        let chunk: Awaited<ReturnType<ByteChannel["read"]>>;
        try {
          chunk = await channel.read();
        } catch (e) {
          if (state.done) return;
          if (!isDisconnect(e)) {
            finish(transportFailed(e));
            return;
          }
          // A disconnect is this direction's EOF.
          chunk = null;
        }
        if (state.done) return;
        if (chunk === null) break;
        try {
          await ctx.out(chunk.bytes);
        } catch (e) {
          // BrokenPipeError (EPIPE: the command stops quietly, exit 0, as everywhere in the CLI) or a CliError. Both
          // directions stop, unlike socket-forward (DESIGN.md §4.14): a service that echoes would otherwise block on
          // output nobody reads while we go on feeding it stdin.
          finish(e instanceof BrokenPipeError || e instanceof CliError ? e : new CliError(describeError(e)));
          return;
        }
      }
      // EOF for stdout's reader now, not at the command's end (socket-forward closes stdout here too).
      try {
        await ctx.io.stdout.end?.();
      } catch {
        // Best effort: the reader then sees EOF when the process exits.
      }
      state.downDone = true;
      maybeDone();
    })();
  });
}

/**
 * The upgrade call on a fresh target, then the byte pipe. `--timeout` bounds the connect and the upgrade call (until
 * the confirming reply), not the stream. The reply's parameters are not printed (varlinkctl passes
 * ret_parameters=NULL). An error reply is `Upgrade via METHOD() failed with error: NAME` (exit 1).
 */
export function callUpgrade(
  ctx: Context,
  address: string,
  method: string,
  parameters: Record<string, unknown>,
): Promise<number> {
  return withTarget(ctx, address, async (target, dl) => {
    let channel: ByteChannel;
    try {
      channel = await target.upgrade(method, parameters);
    } catch (e) {
      if (e instanceof CliError) throw e;
      if (isVarlinkError(e)) throw new CliError(`Upgrade via ${method}() failed with error: ${e.error}`);
      throw new CliError(`Failed to upgrade connection via ${method}(): ${failureReason(e, dl)}`);
    }
    // The deadline covered the connect and the upgrade call; the stream lives as long as its two sides.
    dl.dispose();
    try {
      await pipeUpgraded(ctx, channel);
      return 0;
    } finally {
      // The connection is finished: the channel owns the transport (an exec: child is stopped and awaited here).
      channel.close();
      await channel.closed;
    }
  });
}
