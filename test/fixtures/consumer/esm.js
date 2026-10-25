import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as root from "varlink-js";
import * as codegen from "varlink-js/codegen";
import * as http from "varlink-js/http";
import * as idl from "varlink-js/idl";
import * as node from "varlink-js/node";
import * as testing from "varlink-js/testing";
import * as websocket from "varlink-js/websocket";

const require = createRequire(import.meta.url);
const namespaces = {
  "varlink-js": root,
  "varlink-js/node": node,
  "varlink-js/websocket": websocket,
  "varlink-js/http": http,
  "varlink-js/idl": idl,
  "varlink-js/codegen": codegen,
  "varlink-js/testing": testing,
};
for (const [subpath, ns] of Object.entries(namespaces)) {
  assert.equal(Object.prototype.toString.call(ns), "[object Module]", subpath);
  // One module graph (F11): require(esm) must hand out the very same namespace object as import.
  assert.equal(require(subpath), ns, `${subpath}: require() and import gave different module instances`);
}

const pkg = require("varlink-js/package.json");
assert.equal(pkg.name, "varlink-js");
assert.equal(pkg.type, "module");

await assert.rejects(import("varlink-js/dist/index.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
await assert.rejects(import("varlink-js/src/index.ts"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });

console.log("esm: ok");
