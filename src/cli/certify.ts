// `certify server ADDRESS` and `certify client ADDRESS` (DESIGN.md §4.14): the org.varlink.certification service
// and client of certification.ts (M5), as CLI commands.
import { connect, listen } from "../node/index.ts";
import {
  createCertificationServer,
  describeError as describeCertError,
  runCertificationClient,
} from "./certification.ts";
import { deadline, expectArgs, failureReason, parseAddressArg, type Context } from "./context.ts";
import { aborted, CliError, describeError, UsageError } from "./io.ts";

/** `certify server ADDRESS`: listens until io.signal aborts (SIGINT/SIGTERM), then shuts down gracefully, exit 0. */
async function server(ctx: Context, address: string): Promise<number> {
  const spec = parseAddressArg(address);
  const { server } = await createCertificationServer({
    onError: (error, info) => {
      const where = info.method === undefined ? "" : ` in ${info.method}`;
      void ctx.err(`certification server: ${info.reason}${where}: ${describeCertError(error)}`);
    },
  });
  let listening: Awaited<ReturnType<typeof listen>>;
  try {
    listening = await listen(spec);
  } catch (e) {
    throw new CliError(`Failed to listen on ${address}: ${describeError(e)}`);
  }
  try {
    server.serve(listening);
    await ctx.out(`Listening on ${listening.address}\n`);
    await aborted(ctx.io.signal);
  } finally {
    await server.shutdown();
  }
  return 0;
}

/** `certify client ADDRESS`: runs the certification client; `--timeout` bounds the whole run. */
async function client(ctx: Context, address: string): Promise<number> {
  const spec = parseAddressArg(address);
  const dl = deadline(ctx);
  try {
    let conn: Awaited<ReturnType<typeof connect>>;
    try {
      conn = await connect(spec, { validateReplies: "throw", timeout: 0, signal: dl.signal, onError: () => undefined });
    } catch (e) {
      throw new CliError(`Failed to connect to ${address}: ${failureReason(e, dl)}`);
    }
    // runCertificationClient takes no signal: the deadline (or a signal) closes the connection under it.
    const onAbort = (): void => {
      void conn.close(dl.signal.reason);
    };
    dl.signal.addEventListener("abort", onAbort, { once: true });
    // The log callback is synchronous: lines are written in order behind it; the first write failure is kept.
    let lines: Promise<void> = Promise.resolve();
    let writeError: Error | undefined;
    try {
      await runCertificationClient(conn, (line) => {
        if (!ctx.cli.quiet)
          lines = lines
            .then(() => (writeError === undefined ? ctx.out(`${line}\n`) : undefined))
            .catch((e: unknown) => {
              writeError ??= e instanceof Error ? e : new Error(String(e));
            });
      });
      await lines;
      if (writeError !== undefined) throw writeError;
    } catch (e) {
      await lines;
      if (writeError !== undefined) throw writeError;
      throw new CliError(
        `Certification failed: ${dl.timedOut ? describeError(dl.signal.reason) : describeCertError(e)}`,
      );
    } finally {
      dl.signal.removeEventListener("abort", onAbort);
      await conn.close();
    }
  } finally {
    dl.dispose();
  }
  if (!ctx.cli.quiet) await ctx.out("Certification passed\n");
  return 0;
}

/** `certify server|client ADDRESS`. */
export async function certify(ctx: Context): Promise<number> {
  expectArgs(ctx, 2, 2);
  const [role, address = ""] = ctx.cli.args;
  if (role === "server") return server(ctx, address);
  if (role === "client") return client(ctx, address);
  throw new UsageError(`Unknown certify role '${role ?? ""}' (expected server or client).`);
}
