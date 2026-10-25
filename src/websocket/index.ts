// `varlink-js/websocket` entry point (DESIGN.md §4.12): WebSocket mode client (UAPI "WebSocket Mode").
export { fromWebSocket, type WebSocketChannelOptions, type WebSocketLike } from "./channel.ts";
export { connect, createPool, type WebSocketConnectOptions, type WebSocketConstructorLike } from "./connect.ts";
