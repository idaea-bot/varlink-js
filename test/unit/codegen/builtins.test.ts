// The generated built-in interfaces (DESIGN.md §4.13): sources equal the core constants, committed modules are up to
// date, the IDLs bind in either ints mode, and the rpc layer uses them. Names are derived from the constants, so
// renaming INTERNAL_ERROR_INTERFACE without regenerating fails here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { generate } from "../../../src/codegen/index.ts";
import {
  ExpectedMoreError,
  ExpectedUpgradeError,
  INTERNAL_ERROR_INTERFACE,
  INTERNAL_ERROR_INTERFACE_IDL,
  InterfaceNotFoundError,
  InternalError,
  InvalidParameterError,
  MethodNotFoundError,
  MethodNotImplementedError,
  ORG_VARLINK_SERVICE,
  ORG_VARLINK_SERVICE_IDL,
  PermissionDeniedError,
} from "../../../src/core/errors/index.ts";
import type { Type } from "../../../src/core/idl/index.ts";
import { parseInterface } from "../../../src/core/idl/index.ts";
import { InternalErrorInterface, OrgVarlinkService } from "../../../src/interfaces/index.ts";
import { BUILTIN_INTERFACES, outputPath, sourcePath } from "../../../scripts/gen-interfaces.ts";
import { COMMITTED, UPDATE } from "./committed.ts";
import { firstDiff } from "./helpers.ts";

function mentionsInt(type: Type): boolean {
  switch (type.kind) {
    case "int":
      return true;
    case "struct":
      return type.fields.some((f) => mentionsInt(f.type));
    case "array":
    case "map":
    case "nullable":
      return mentionsInt(type.element);
    default:
      return false;
  }
}

describe("built-in interfaces", () => {
  test("are org.varlink.service and INTERNAL_ERROR_INTERFACE, with sources equal to the core constants", () => {
    assert.deepEqual(BUILTIN_INTERFACES, [ORG_VARLINK_SERVICE, INTERNAL_ERROR_INTERFACE]);
    assert.equal(readFileSync(sourcePath(ORG_VARLINK_SERVICE), "utf8"), ORG_VARLINK_SERVICE_IDL);
    assert.equal(readFileSync(sourcePath(INTERNAL_ERROR_INTERFACE), "utf8"), INTERNAL_ERROR_INTERFACE_IDL);
    for (const name of BUILTIN_INTERFACES) assert.ok(existsSync(outputPath(name)), outputPath(name));
  });

  test("contain no int, so they bind in either ints mode (bindDescriptor)", () => {
    for (const idl of [ORG_VARLINK_SERVICE_IDL, INTERNAL_ERROR_INTERFACE_IDL]) {
      const iface = parseInterface(idl);
      for (const m of iface.members) {
        const types = m.kind === "method" ? [m.input, m.output] : [m.type];
        assert.equal(types.some(mentionsInt), false, `${iface.name}.${m.name}`);
      }
    }
  });

  test("descriptors carry the constants' names and point at the core error classes", () => {
    assert.equal(OrgVarlinkService.name, ORG_VARLINK_SERVICE);
    assert.equal(OrgVarlinkService.idl, ORG_VARLINK_SERVICE_IDL);
    assert.deepEqual(Object.keys(OrgVarlinkService.methods), ["GetInfo", "GetInterfaceDescription"]);
    assert.deepEqual(OrgVarlinkService.errors, {
      InterfaceNotFound: InterfaceNotFoundError,
      MethodNotFound: MethodNotFoundError,
      MethodNotImplemented: MethodNotImplementedError,
      InvalidParameter: InvalidParameterError,
      PermissionDenied: PermissionDeniedError,
      ExpectedMore: ExpectedMoreError,
      ExpectedUpgrade: ExpectedUpgradeError,
    });
    assert.equal(OrgVarlinkService.InvalidParameter, InvalidParameterError);
    assert.equal(InternalErrorInterface.name, INTERNAL_ERROR_INTERFACE);
    assert.equal(InternalErrorInterface.idl, INTERNAL_ERROR_INTERFACE_IDL);
    assert.deepEqual(InternalErrorInterface.errors, { InternalError });
    assert.deepEqual(Object.keys(InternalErrorInterface.methods), []);
    assert.ok(Object.isFrozen(OrgVarlinkService) && Object.isFrozen(OrgVarlinkService.methods.GetInfo));
  });

  test("the generator derives the built-in exception from the constants", () => {
    const renamed = INTERNAL_ERROR_INTERFACE_IDL.replace(INTERNAL_ERROR_INTERFACE, "io.example.renamed");
    // Under another name the interface is an ordinary one: a class is generated.
    assert.match(generate(renamed).code, /export class InternalError extends \$vjs\.VarlinkError/);
    assert.doesNotMatch(generate(INTERNAL_ERROR_INTERFACE_IDL).code, /export class/);
  });

  test("importing rpc's service.ts (or a generated built-in) first in a fresh process works (no import cycle)", () => {
    // A script file with absolute module URLs, so it runs the same under Node, Deno and Bun (the Runtimes job).
    const dir = mkdtempSync(join(tmpdir(), "vjs-cycle-"));
    try {
      const url = (path: string): string => JSON.stringify(new URL(`../../../${path}`, import.meta.url).href);
      for (const first of ["src/rpc/service.ts", "src/interfaces/index.ts", "src/rpc/typed-client.ts"]) {
        const script = [
          `await import(${url(first)});`,
          `const { createServer } = await import(${url("src/index.ts")});`,
          `const { OrgVarlinkService } = await import(${url("src/interfaces/index.ts")});`,
          `createServer();`,
          `if (OrgVarlinkService.methods.GetInfo.method !== "org.varlink.service.GetInfo") throw new Error("bad");`,
          ``,
        ].join("\n");
        const file = join(dir, "first.mts");
        writeFileSync(file, script);
        const args = "deno" in process.versions ? ["run", "-A", "--no-check", file] : [file];
        execFileSync(process.execPath, args, { stdio: "pipe" });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("committed generated modules", () => {
  for (const file of COMMITTED) {
    test(`${file.path} is up to date (npm run gen:interfaces / UPDATE_SNAPSHOTS=1 npm test)`, () => {
      const expected = file.code();
      if (UPDATE) {
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, expected);
      }
      const actual = readFileSync(file.path, "utf8");
      assert.ok(actual === expected, `${file.path} is stale: ${firstDiff(actual, expected)}`);
    });
  }
});
