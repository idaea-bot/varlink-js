// `varlink-js/node` entry point (DESIGN.md §4.7, §4.11): Node sockets (unix, unix:@, tcp, inherited fds).
// M8 adds exec:/ssh-*: spawning, socket activation from the environment and the registry.
export { connect, type ConnectOptions } from "./connect.ts";
export { listen, type ListenOptions, type NodeListener } from "./listen.ts";
export { createPool } from "./pool.ts";
export { fromNodeSocket } from "./socket.ts";
