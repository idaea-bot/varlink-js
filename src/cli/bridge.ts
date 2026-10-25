// `bridge ADDRESS` (DESIGN.md §4.14): a raw byte proxy between stdio and a socket, so `varlink-js bridge unix:/run/x`
// can serve as the command of python/rust/libvarlink `--bridge`. stdin → socket (stdin EOF half-closes the socket's
// write side; reading goes on), socket → stdout (one chunk at a time, each write awaited: backpressure both ways).
import type { Socket } from "node:net";
import { openSocket } from "../node/connect.ts";
import { deadline, expectArgs, failureReason, parseAddressArg, type Context } from "./context.ts";
import { abortable, CliError, describeError } from "./io.ts";

function writeSocket(socket: Socket, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(chunk, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Pipes until the peer's EOF (resolves), a socket error, a stdout failure or an abort (rejects). */
function pipe(ctx: Context, socket: Socket, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // An object, so that TypeScript does not narrow the flag inside the async closures below.
    const state = { done: false };
    let lastWrite: Promise<void> = Promise.resolve();
    const finish = (error?: unknown): void => {
      if (state.done) return;
      state.done = true;
      signal?.removeEventListener("abort", onAbort);
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

    socket.on("data", (chunk: Uint8Array) => {
      socket.pause();
      lastWrite = ctx.out(chunk).then(
        () => {
          if (!state.done) socket.resume();
        },
        (e: unknown) => {
          finish(e);
        },
      );
    });
    socket.on("end", () => {
      void lastWrite.then(() => {
        finish();
      });
    });
    socket.on("error", (e) => {
      finish(new CliError(`bridge: ${describeError(e)}`));
    });
    socket.on("close", () => {
      // After `end` this is the normal close; otherwise the socket was destroyed without an EOF.
      void lastWrite.then(() => {
        finish(new CliError("bridge: the connection closed unexpectedly"));
      });
    });

    void (async () => {
      const input = ctx.io.stdin[Symbol.asyncIterator]();
      try {
        for (;;) {
          const r = await abortable(input.next(), signal);
          if (state.done) return;
          if (r.done === true) break;
          await writeSocket(socket, r.value);
        }
        socket.end();
      } catch (e) {
        if (!state.done) finish(signal?.aborted === true ? signal.reason : new CliError(`bridge: ${describeError(e)}`));
      }
    })();
  });
}

/** `bridge ADDRESS`. */
export async function bridge(ctx: Context): Promise<number> {
  expectArgs(ctx, 1, 1);
  const [address = ""] = ctx.cli.args;
  const spec = parseAddressArg(address);
  if (spec.kind !== "unix" && spec.kind !== "unix-abstract" && spec.kind !== "tcp")
    throw new CliError(`${spec.kind} addresses are not supported by bridge (unix:, unix:@ and tcp: are).`);
  // The timeout bounds the connect phase only: a bridge lives as long as its peers.
  const dl = deadline(ctx);
  let socket: Socket;
  try {
    socket = await openSocket(spec, 0, dl.signal);
  } catch (e) {
    throw new CliError(`Failed to connect to ${address}: ${failureReason(e, dl)}`);
  } finally {
    dl.dispose();
  }
  try {
    await pipe(ctx, socket, ctx.io.signal);
    return 0;
  } finally {
    socket.destroy();
  }
}
