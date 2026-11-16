// Real ssh (DESIGN.md §4.6, §5.8): ssh-unix: and ssh-exec: against a host given by the environment.
// VARLINK_SSH_HOST: the ssh destination (keys/agent set up, no prompts). VARLINK_SSH_SOCKET: remote path of a running
// varlink server (ssh-unix:). VARLINK_SSH_EXEC: remote command line of a service that serves on stdio when
// SYSTEMD_VARLINK_LISTEN=- (ssh-exec:). Each test skips when its variable is unset.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { connect } from "../../../src/node/index.ts";

const host = process.env.VARLINK_SSH_HOST;
const socket = process.env.VARLINK_SSH_SOCKET;
const exec = process.env.VARLINK_SSH_EXEC;

async function info(address: string): Promise<string[]> {
  const conn = await connect(address, { timeout: 10_000, spawn: { stderr: "inherit" } });
  try {
    return (await conn.getInfo()).interfaces;
  } finally {
    await conn.close();
    await conn.closed;
  }
}

describe("ssh transports", { skip: host === undefined ? "VARLINK_SSH_HOST not set" : false }, () => {
  test("ssh-unix:", { skip: socket === undefined ? "VARLINK_SSH_SOCKET not set" : false }, async () => {
    assert.ok((await info(`ssh-unix:${String(host)}:${String(socket)}`)).includes("org.varlink.service"));
  });

  test("ssh-exec:", { skip: exec === undefined ? "VARLINK_SSH_EXEC not set" : false }, async () => {
    assert.ok((await info(`ssh-exec:${String(host)}:${String(exec)}`)).includes("org.varlink.service"));
  });
});
