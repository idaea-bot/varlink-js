// Every `exports` subpath in package.json has a matching placeholder module under src/ that loads.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import * as codegen from "../../src/codegen/index.ts";
import * as http from "../../src/http/index.ts";
import * as idl from "../../src/idl/index.ts";
import * as root from "../../src/index.ts";
import * as node from "../../src/node/index.ts";
import * as testing from "../../src/testing/index.ts";
import * as websocket from "../../src/websocket/index.ts";

interface ExportTarget {
  types: string;
  default: string;
}
interface PackageJson {
  version: string;
  type: string;
  sideEffects: boolean;
  engines: { node: string };
  bin: Record<string, string>;
  exports: Record<string, ExportTarget | string>;
}

// npm scripts and CI run tests from the repository root.
const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as PackageJson;

const modules: Record<string, object> = {
  ".": root,
  "./node": node,
  "./websocket": websocket,
  "./http": http,
  "./idl": idl,
  "./codegen": codegen,
  "./testing": testing,
};

test("package.json exports map matches DESIGN.md §8", () => {
  assert.deepEqual(Object.keys(pkg.exports).sort(), [...Object.keys(modules), "./package.json"].sort());
  assert.equal(pkg.exports["./package.json"], "./package.json");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.sideEffects, false);
  assert.equal(pkg.engines.node, ">=22.12");
});

test("every subpath points at dist/ output of an existing src/ module", () => {
  for (const [subpath, ns] of Object.entries(modules)) {
    const target = pkg.exports[subpath];
    assert.ok(typeof target === "object", subpath);
    const stem = subpath === "." ? "index" : `${subpath.slice(2)}/index`;
    assert.deepEqual(target, { types: `./dist/${stem}.d.ts`, default: `./dist/${stem}.js` }, subpath);
    // "types" must come first for TypeScript's conditional export resolution.
    assert.deepEqual(Object.keys(target), ["types", "default"], subpath);
    assert.ok(existsSync(resolve(`src/${stem}.ts`)), `src/${stem}.ts`);
    assert.equal(typeof ns, "object", subpath);
  }
});

test("varlink-js/idl exports the IDL API (M1)", () => {
  assert.equal(typeof idl.parseInterface, "function");
  assert.equal(typeof idl.formatInterface, "function");
});

test("varlink-js exports the types and errors API (M2)", () => {
  assert.equal(typeof root.compileInterface, "function");
  assert.equal(typeof root.jsonCodec.decode, "function");
  assert.equal(typeof root.VarlinkError, "function");
  assert.equal(typeof root.createErrorRegistry, "function");
  assert.equal("parseInterface" in root, false); // the IDL API lives in varlink-js/idl
});

test("varlink-js exports the handler-facing protocol API, varlink-js/testing the channels (M3)", () => {
  assert.equal(typeof root.streamOf, "function");
  assert.equal(root.DEFAULT_MAX_MESSAGE_SIZE, 16 * 1024 * 1024);
  for (const internal of ["ServerSession", "ClientSession", "Framer", "dispatchCall", "encodeCall"])
    assert.equal(internal in root, false, internal); // core-internal until M4
  assert.equal(typeof testing.pair, "function");
  assert.equal(typeof testing.faulty, "function");
});

test("varlink-js exports the RPC layer and the address parser; sessions stay internal (M4)", () => {
  for (const fn of ["createConnection", "createPool", "createServer", "parseAddress", "formatAddress"] as const)
    assert.equal(typeof root[fn], "function", fn);
  for (const cls of ["Connection", "Pool", "Server"] as const) assert.equal(typeof root[cls], "function", cls);
  assert.deepEqual(root.parseAddress("unix:@x"), { kind: "unix-abstract", name: "x" });
  for (const internal of ["ServerSession", "ClientSession", "Framer", "dispatchCall", "encodeCall", "decodeReply"])
    assert.equal(internal in root, false, internal);
});

test("varlink-js/codegen exports generate(); the root entry the typed-client runtime generated code uses (M6)", () => {
  assert.deepEqual(Object.keys(codegen).sort(), ["GENERATOR_VERSION", "generate", "generateFromService"]);
  assert.equal(typeof codegen.generate, "function");
  assert.equal(typeof codegen.generateFromService, "function");
  assert.equal(codegen.GENERATOR_VERSION, pkg.version);
  for (const fn of ["createClient", "freezeDescriptor", "isVarlinkError"] as const)
    assert.equal(typeof root[fn], "function", fn);
  assert.equal(typeof root.VarlinkError, "function");
  // Types only (checked by tsc): what generated code names through `$vjs.`.
  const types: [
    root.TypedClient<root.InterfaceDescriptor>,
    root.TypedMethod<root.MethodDescriptor>,
    root.VarlinkErrorOptions,
    root.Handlers<root.InterfaceDescriptor>,
    root.JsonValue,
  ][] = [];
  assert.deepEqual(types, []);
  // The generated built-ins are internal (rpc uses them), not a subpath.
  assert.equal("OrgVarlinkService" in root, false);
});

test("varlink-js/node exports the socket adapter (M4)", () => {
  assert.deepEqual(Object.keys(node).sort(), ["connect", "createPool", "fromNodeSocket", "listen"]);
  for (const fn of ["connect", "createPool", "fromNodeSocket", "listen"] as const)
    assert.equal(typeof node[fn], "function", fn);
  assert.equal("createServer" in node, false); // createServer stays in the root entry
});

test("bin points at the compiled CLI entry", () => {
  assert.deepEqual(pkg.bin, { "varlink-js": "./dist/cli/main.js" });
  assert.ok(existsSync(resolve("src/cli/main.ts")));
});

test("varlink-js/websocket and varlink-js/http export the bridge clients (M10)", () => {
  assert.deepEqual(Object.keys(websocket).sort(), ["connect", "createPool", "fromWebSocket"]);
  assert.deepEqual(Object.keys(http).sort(), ["HttpBridgeError", "HttpClient", "createHttpClient"]);
});
