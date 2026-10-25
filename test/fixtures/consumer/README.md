# Consumer fixture

Installs the packed `varlink-js` tarball into a temporary directory outside the repository and checks it
the way a user would see it (DESIGN.md §7.2, F10/F11):

- `esm.js`: static ESM import of every `exports` subpath, `varlink-js/package.json`, deep imports rejected,
  and `require(x) === import(x)` for every subpath (one module graph, F11).
- `cjs.cjs`: `require()` of every subpath (unflagged `require(esm)`, Node >= 22.12).
- `types-web.ts` (`tsconfig.web.json`: `lib` es2022 + dom, no `@types/node`): `.`, `/websocket`, `/http`, `/idl` resolve under
  `tsc --module nodenext` and their `.d.ts` need no Node types; deep imports are type errors.
- `types-node.ts` + `types.cts` (`tsconfig.node.json`, with `@types/node`): `/node`, `/codegen`, `/testing` from
  ESM, and every subpath from CJS (`import x = require(...)`).
- the `varlink-js` bin runs (`--version`).
- the tarball contains `.js`, `.d.ts`, `.js.map`, `.d.ts.map` for every subpath, `src/` for the maps, and no test files.

Run with `npm run test:consumer` (packs first), or `node test/fixtures/consumer/run.js --tarball x.tgz [--no-tsc]`.
