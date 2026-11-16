// The server's per-UID accounting (M11, DESIGN.md §5.4) over in-memory channels that claim peer credentials: opt-in
// like SD_VARLINK_SERVER_ACCOUNT_UID (no counting without maxConnectionsPerUid), the limit, and refusals when the
// credentials cannot be read or name an invalid UID (sd-varlink.c:3492-3505, 3568-3570). Runs on every runtime.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ConnectionClosedError, type ByteChannel, type PeerCredentials } from "../../../src/index.ts";
import { createConnection, createServer, type ServerErrorReason } from "../../../src/rpc/index.ts";
import { pair } from "../../../src/testing/index.ts";

const T = { timeout: 20_000 };

/** The server end of a pair, claiming `peer` (a function that may throw). */
function withPeer(channel: ByteChannel, peer: () => PeerCredentials): ByteChannel {
  return {
    read: () => channel.read(),
    write: (chunk) => channel.write(chunk),
    end: () => channel.end(),
    close: (reason) => {
      channel.close(reason);
    },
    get closed() {
      return channel.closed;
    },
    capabilities: { peer },
  };
}

function setup(maxConnectionsPerUid?: number): {
  dial: (peer: () => PeerCredentials) => ReturnType<typeof createConnection>;
  reasons: ServerErrorReason[];
  server: ReturnType<typeof createServer>;
} {
  const reasons: ServerErrorReason[] = [];
  const server = createServer({
    onError: (_e, info) => reasons.push(info.reason),
    ...(maxConnectionsPerUid === undefined ? {} : { maxConnectionsPerUid }),
  });
  return {
    server,
    reasons,
    dial: (peer) => {
      const [client, served] = pair();
      void server.handle(withPeer(served, peer));
      return createConnection(client);
    },
  };
}

const uid = (n: number) => (): PeerCredentials => ({ uid: n, gid: n, pid: 1 });

describe("per-UID accounting", () => {
  test("off by default: any number of connections of one UID", T, async () => {
    const { dial, reasons, server } = setup();
    // More than sd-varlink's 128 (the value it uses when ACCOUNT_UID is set): still nothing counted.
    const conns = Array.from({ length: 130 }, () => dial(uid(1000)));
    for (const c of conns) assert.ok((await c.getInfo()).interfaces.length > 0);
    assert.deepEqual(reasons, []);
    await server.shutdown({ graceful: false });
  });

  test("with a limit: the UID's next connection is refused, others are not affected", T, async () => {
    const { dial, reasons, server } = setup(1);
    const first = dial(uid(1000));
    await first.getInfo();
    await assert.rejects(dial(uid(1000)).getInfo(), ConnectionClosedError);
    assert.deepEqual(reasons, ["connection-limit"]);
    await dial(uid(1001)).getInfo();
    await server.shutdown({ graceful: false });
  });

  test(
    "with a limit: credentials that cannot be read, or an invalid UID, are refused (connection-refused)",
    T,
    async () => {
      const { dial, reasons, server } = setup(5);
      await assert.rejects(
        dial(() => {
          throw new Error("EBADF");
        }).getInfo(),
        ConnectionClosedError,
      );
      await assert.rejects(dial(uid(0xffffffff)).getInfo(), ConnectionClosedError);
      // The 16-bit -1, which systemd's uid_is_valid rejects too (user-util.c:60-62).
      await assert.rejects(dial(uid(0xffff)).getInfo(), ConnectionClosedError);
      await assert.rejects(dial(uid(-1)).getInfo(), ConnectionClosedError);
      assert.deepEqual(reasons, [
        "connection-refused",
        "connection-refused",
        "connection-refused",
        "connection-refused",
      ]);
      // root is limited like anyone else (sd-varlink does not exempt it), but valid.
      await dial(uid(0)).getInfo();
      await server.shutdown({ graceful: false });
    },
  );

  test("without a limit, unreadable credentials just mean no ctx.peer", T, async () => {
    const { dial, reasons, server } = setup();
    await dial(() => {
      throw new Error("EBADF");
    }).getInfo();
    assert.deepEqual(reasons, []);
    await server.shutdown({ graceful: false });
  });
});
