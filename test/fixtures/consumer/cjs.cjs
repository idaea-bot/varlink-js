"use strict";
const assert = require("node:assert/strict");

const subpaths = [
  "varlink-js",
  "varlink-js/node",
  "varlink-js/websocket",
  "varlink-js/http",
  "varlink-js/idl",
  "varlink-js/codegen",
  "varlink-js/testing",
];
for (const subpath of subpaths) {
  const ns = require(subpath);
  assert.equal(Object.prototype.toString.call(ns), "[object Module]", subpath);
}
assert.equal(require("varlink-js/package.json").name, "varlink-js");
assert.throws(() => require("varlink-js/dist/index.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });

console.log("cjs: ok");
