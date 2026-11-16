# varlink-js-native

Optional Node-API addon for varlink-js (DESIGN.md §4.15): file descriptor passing (`SCM_RIGHTS`), peer credentials
(`SO_PEERCRED`, `SO_PEERPIDFD`) and sd-varlink's `user.varlink` socket xattr for unix-domain varlink connections.
Private, never published; no prebuilds yet.

- Supported: Linux (glibc; musl untested), Node ≥ 22.12. **macOS is a development target only, not supported at
  runtime**: it builds and its tests run (no pidfd, no xattr), but its kernel differs in ways the channel does not
  handle, e.g. a `sendmsg` with fds to a peer whose buffer is full fails with `EMSGSIZE` instead of `EAGAIN`, which
  ends the connection instead of waiting (DESIGN.md §4.15). Windows, Bun and Deno: not available (`isAvailable()` is
  false and varlink-js behaves as without the addon).
- Build: `npm run build` (a C compiler; `CC`, `NODE_INCLUDE_DIR`, `CFLAGS` override the defaults), test: `npm test`.
- Use: pass the module to varlink-js/node.

```ts
import * as native from "varlink-js-native";
import { connect, listen } from "varlink-js/node";

const conn = await connect("unix:/run/example.sock", { native });
await conn.call("com.example.Write", {}, { fds: [fileHandle] }); // the library duplicates the fds it sends
const { parameters, fds } = await conn.call("com.example.Open", {}, { acceptFds: true }); // you own `fds`

// createServer({ allowFdPassingInput: true, … }): pass the same to listen(), so the listening socket's SO_PASSRIGHTS
// (Linux ≥ 6.16) matches before anything is accepted.
server.serve(await listen("unix:/run/example.sock", { native, allowFdPassingInput: true })); // ctx.peer, ctx.fds, ctx.pushFds()
```

The `varlink-js` CLI loads it for `call --push-fd=` and `call --exec` (`VARLINK_JS_NATIVE=<path to index.js>`
overrides where it is looked for).
