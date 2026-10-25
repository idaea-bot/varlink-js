// fromNodeStreams (DESIGN.md §4.1, §5.8): a ByteChannel over a Readable + Writable pair.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import { ConnectionClosedError } from "../../../src/core/errors/index.ts";
import { fromNodeStreams } from "../../../src/node/index.ts";
import { turns } from "./helpers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

function streams(): { input: PassThrough; output: PassThrough } {
  return { input: new PassThrough(), output: new PassThrough() };
}

/** Everything written to `output` until it ends. */
async function drain(output: PassThrough): Promise<string> {
  let text = "";
  for await (const chunk of output) text += dec(chunk as Uint8Array);
  return text;
}

describe("fromNodeStreams over PassThrough streams", () => {
  test("reads in order, then null after the readable ended", async () => {
    const { input, output } = streams();
    const ch = fromNodeStreams(input, output);
    input.write("ab");
    input.write("cd");
    input.end();
    let text = "";
    for (;;) {
      const chunk = await ch.read();
      if (chunk === null) break;
      text += dec(chunk.bytes);
    }
    assert.equal(text, "abcd");
    assert.equal(await ch.read(), null);
    ch.close();
    await ch.closed;
  });

  test("the readable is paused: nothing is consumed before read()", async () => {
    const { input, output } = streams();
    const ch = fromNodeStreams(input, output);
    input.write("x");
    await turns(3);
    assert.equal(input.isPaused(), true);
    assert.equal(dec((await ch.read())?.bytes ?? new Uint8Array()), "x");
    ch.close();
  });

  test("write() resolves on the callback; end() half-closes (reading goes on)", async () => {
    const { input, output } = streams();
    const ch = fromNodeStreams(input, output);
    const written = drain(output);
    await ch.write(enc("hello "));
    await ch.write(enc("world"));
    await ch.end();
    assert.equal(await written, "hello world");
    await assert.rejects(ch.write(enc("late")), ConnectionClosedError);
    input.end("still readable");
    assert.equal(dec((await ch.read())?.bytes ?? new Uint8Array()), "still readable");
    assert.equal(await ch.read(), null);
    ch.close();
    await ch.closed;
  });

  test("close(): pending read gives null, writes reject, both destroyed, onClose once, idempotent", async () => {
    const { input, output } = streams();
    let hook = 0;
    const ch = fromNodeStreams(input, output, {
      onClose: () => {
        hook++;
      },
    });
    const pending = ch.read();
    ch.close();
    ch.close();
    assert.equal(await pending, null);
    assert.equal(await ch.read(), null);
    await assert.rejects(ch.write(enc("x")), ConnectionClosedError);
    await ch.closed;
    assert.equal(input.destroyed && output.destroyed, true);
    assert.equal(hook, 1);
  });

  test("closed waits for an async onClose; its failure is swallowed", async () => {
    const { input, output } = streams();
    let finished = false;
    const ch = fromNodeStreams(input, output, {
      onClose: async () => {
        await turns(2);
        finished = true;
        throw new Error("ignored");
      },
    });
    ch.close();
    await ch.closed;
    assert.equal(finished, true);
  });

  test("closed resolves (and onClose runs) when both streams close on their own", async () => {
    const { input, output } = streams();
    let hook = 0;
    const ch = fromNodeStreams(input, output, {
      onClose: () => {
        hook++;
      },
    });
    input.destroy();
    output.destroy();
    await ch.closed;
    assert.equal(hook, 1);
    assert.equal(await ch.read(), null);
  });

  test("a readable error rejects one read, then null; a write error rejects that write", async () => {
    const { input, output } = streams();
    const ch = fromNodeStreams(input, output);
    const boom = new Error("boom");
    input.destroy(boom);
    await assert.rejects(ch.read(), (e) => e === boom);
    assert.equal(await ch.read(), null);
    const wboom = new Error("wboom");
    output.destroy(wboom);
    await assert.rejects(ch.write(enc("x")));
    ch.close();
    await ch.closed;
  });

  test("concurrent read() is a TypeError", async () => {
    const { input, output } = streams();
    const ch = fromNodeStreams(input, output);
    const first = ch.read();
    await assert.rejects(ch.read(), TypeError);
    ch.close();
    assert.equal(await first, null);
  });

  test("onClose must be a function", () => {
    const { input, output } = streams();
    assert.throws(() => fromNodeStreams(input, output, { onClose: 1 as unknown as () => void }), TypeError);
  });
});

describe("fromNodeStreams over a child's stdout/stdin (cat)", () => {
  test("echo, half-close, EOF, closed after the child's pipes closed", async () => {
    const child = spawn("cat", [], { stdio: ["pipe", "pipe", "inherit"] });
    const exited = new Promise((r) => child.once("exit", r));
    const ch = fromNodeStreams(child.stdout, child.stdin);
    await ch.write(enc("ping"));
    assert.equal(dec((await ch.read())?.bytes ?? new Uint8Array()), "ping");
    await ch.end();
    // cat sees EOF on its stdin, flushes and exits: we read EOF.
    assert.equal(await ch.read(), null);
    await exited;
    await ch.closed;
  });

  test("close() destroys the pipes: cat exits on EOF", async () => {
    const child = spawn("cat", [], { stdio: ["pipe", "pipe", "inherit"] });
    const exited = new Promise((r) => child.once("exit", r));
    const ch = fromNodeStreams(child.stdout, child.stdin);
    ch.close();
    await ch.closed;
    assert.equal(await exited, 0);
  });

  test("writing to a dead child rejects (EPIPE), never crashes", async () => {
    const child = spawn("/bin/sh", ["-c", "exit 0"], { stdio: ["pipe", "pipe", "inherit"] });
    const ch = fromNodeStreams(child.stdout, child.stdin);
    await new Promise((r) => child.once("exit", r));
    assert.equal(await ch.read(), null);
    let failures = 0;
    for (let i = 0; i < 20 && failures === 0; i++)
      await ch.write(new Uint8Array(65536)).catch(() => {
        failures++;
      });
    assert.equal(failures, 1);
    ch.close();
    await ch.closed;
  });
});
