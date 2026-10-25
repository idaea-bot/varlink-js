// `varlink-js/node` entry point (DESIGN.md §4.7, §4.11, §5.8): Node sockets (unix, unix:@, tcp, inherited fds),
// spawned transports (exec:, ssh-*:, bridge), socket activation and stdio serving.
// M8 phase B adds the registry and the resolver.
export {
  listenAuto,
  listenFromEnv,
  listenStdio,
  mergeListeners,
  type ActivationOptions,
  type ListenAutoOptions,
} from "./activation.ts";
export { connect, type ConnectOptions } from "./connect.ts";
export { listen, type ListenOptions, type NodeListener } from "./listen.ts";
export { createPool } from "./pool.ts";
export { fromNodeSocket } from "./socket.ts";
export { fromNodeStreams, type NodeStreamsOptions } from "./spawn-channel.ts";
export {
  connectBridge,
  connectExec,
  type ExecOptions,
  type ExecProcessOptions,
  type SpawnOptions,
  type SpawnProcessOptions,
} from "./spawn.ts";
