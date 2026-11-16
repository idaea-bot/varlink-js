// listen(…, { native }) with a stand-in addon (M11, DESIGN.md §4.15): a connection the addon cannot take over is
// refused (closed, reported to onError), never served as a plain socket without credentials (sd-varlink refuses a
// connection whose credentials it cannot get, sd-varlink.c:3568-3570); the listening socket gets SO_PASSRIGHTS per
// allowFdPassingInput. Runs without the real addon, on Node (Bun/Deno: no _handle.fd to hand over).
import assert from "node:assert/strict";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createServer } from "../../../src/index.ts";
import { listen, mergeListeners, type NativeAddon } from "../../../src/node/index.ts";
import { tempDir } from "./helpers.ts";

const T = { timeout: 20_000 };
const NODE = process.versions.bun === undefined && !("Deno" in globalThis);

function fakeAddon(log: string[]): NativeAddon {
  const no = (): never => {
    throw Object.assign(new Error("adopt EMFILE: too many open files"), { code: "EMFILE" });
  };
  return {
    isAvailable: () => true,
    connect: no,
    adopt: no,
    dup: no,
    close: () => undefined,
    setCloexec: () => undefined,
    isUnixSocket: () => true,
    setPassRights: (_fd, on) => {
      log.push(`passrights:${String(on)}`);
      return true;
    },
    setXattr: (_fd, value) => {
      log.push(`xattr:${value}`);
    },
    removeXattr: () => undefined,
    setPathXattr: (_path, value) => {
      log.push(`path-xattr:${value}`);
    },
  };
}

describe("listen with a native addon that cannot adopt", { skip: NODE ? false : "needs Node's pipe handles" }, () => {
  const dir = tempDir();

  test("the connection is refused and reported; nothing is yielded; SO_PASSRIGHTS set from the option", T, async () => {
    const log: string[] = [];
    const errors: unknown[] = [];
    const path = join(dir(), "n.sock");
    const listener = await listen(`unix:${path}`, {
      native: fakeAddon(log),
      fdPassingInputStrict: true,
      allowFdPassingInput: true,
      onError: (e) => errors.push(e),
    });
    const it = listener[Symbol.asyncIterator]();
    const next = it.next();
    const closed = await new Promise<boolean>((resolve) => {
      const s = netConnect(path);
      s.on("error", () => undefined);
      s.on("close", () => {
        resolve(true);
      });
      s.resume();
    });
    assert.equal(closed, true, "the client sees its connection closed");
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as { code?: string }).code, "EMFILE");
    await listener.close();
    assert.deepEqual(await next, { value: undefined, done: true }, "no channel was yielded");
    assert.deepEqual(log.slice(0, 2), ["passrights:true", "xattr:listen"]);
  });

  test("by default SO_PASSRIGHTS is left alone, as sd-varlink without FD_PASSING_INPUT_STRICT", T, async () => {
    const log: string[] = [];
    const listener = await listen(`unix:${join(dir(), "d.sock")}`, {
      native: fakeAddon(log),
      allowFdPassingInput: true,
    });
    await listener.close();
    assert.equal(
      log.some((l) => l.startsWith("passrights")),
      false,
    );
    assert.ok(log.includes("xattr:listen"));
  });

  test("serve() refuses a strict listener whose allowFdPassingInput differs from the server's (M1)", T, async () => {
    const strictOff = await listen(`unix:${join(dir(), "s0.sock")}`, {
      native: fakeAddon([]),
      fdPassingInputStrict: true,
      allowFdPassingInput: false,
    });
    const plain = await listen(`unix:${join(dir(), "s1.sock")}`, { native: fakeAddon([]), allowFdPassingInput: false });
    const withInput = createServer({ allowFdPassingInput: true });
    const withoutInput = createServer();
    try {
      assert.equal(strictOff.strictFdPassingInput, false);
      assert.equal(plain.strictFdPassingInput, undefined, "not strict: nothing to check");
      // listenFromEnv merges several: the setting goes along.
      const merged = mergeListeners([plain, strictOff]) as { strictFdPassingInput?: boolean };
      assert.equal(merged.strictFdPassingInput, false);
      assert.throws(
        () => {
          withInput.serve(strictOff);
        },
        (e: unknown) => e instanceof TypeError && /allowFdPassingInput false, the server has true/.test(e.message),
      );
      // Left alone: the matching server can still serve it; a non-strict listener is never refused.
      withoutInput.serve(strictOff);
      withInput.serve(plain);
    } finally {
      await withInput.shutdown({ graceful: false });
      await withoutInput.shutdown({ graceful: false });
    }
  });

  test("mergeListeners refuses strict sources that disagree on allowFdPassingInput", T, async () => {
    const off = await listen(`unix:${join(dir(), "m0.sock")}`, {
      native: fakeAddon([]),
      fdPassingInputStrict: true,
      allowFdPassingInput: false,
    });
    const on = await listen(`unix:${join(dir(), "m1.sock")}`, {
      native: fakeAddon([]),
      fdPassingInputStrict: true,
      allowFdPassingInput: true,
    });
    const on2 = await listen(`unix:${join(dir(), "m2.sock")}`, {
      native: fakeAddon([]),
      fdPassingInputStrict: true,
      allowFdPassingInput: true,
    });
    try {
      assert.throws(
        () => mergeListeners([on, off]),
        (e: unknown) => e instanceof TypeError && /different allowFdPassingInput values/.test(e.message),
      );
      // Agreeing strict sources merge, carrying their value.
      assert.equal((mergeListeners([on, on2]) as { strictFdPassingInput?: boolean }).strictFdPassingInput, true);
    } finally {
      await Promise.all([off.close(), on.close(), on2.close()]);
    }
  });
});
