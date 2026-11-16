// ESM consumer of the runtime-agnostic subpaths, checked with tsc nodenext and NO @types/node:
// their public .d.ts must not mention Node-only types (browsers, Deno and Bun consumers).
import * as m0 from "varlink-js";
import * as m1 from "varlink-js/websocket";
import * as m2 from "varlink-js/http";
import * as m3 from "varlink-js/idl";
// @ts-expect-error deep imports are not part of the public API
import * as deep from "varlink-js/dist/index.js";

export const all: object[] = [m0, m1, m2, m3, deep];
