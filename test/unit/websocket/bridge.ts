// Test fixture (dev-only): a small UAPI HTTP bridge (UAPI "Transport: HTTP") on node:http, forwarding to a varlink
// backend. WebSocket mode is a hand-written RFC 6455 server side; simple HTTP mode issues each call over a fresh
// varlink Connection to the backend. Fault-injection knobs let the client tests script the bridge's behaviour. Runs
// unchanged on Node, Bun and Deno (all three emit `upgrade` on node:http servers).
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { ByteChannel } from "../../../src/core/protocol/index.ts";
import { parseInterface } from "../../../src/idl/index.ts";
import { isVarlinkError, jsonCodec } from "../../../src/index.ts";
import { createConnection, type Connection } from "../../../src/rpc/index.ts";

/** How the bridge frames service→client bytes in WebSocket mode. */
export type Framing =
  /** One varlink message (with its NUL) per frame, as UAPI recommends. */
  | "message"
  /** Every message cut into several frames, the first one 1 byte long. */
  | "split"
  /** Bytes batched for a moment and sent in frames that hold several messages (cut anywhere). */
  | "coalesce";

/** Behaviour switches; tests change them between requests. */
export interface BridgeKnobs {
  framing: Framing;
  /** Every request (also the WebSocket upgrade) must carry this header, else 401. */
  requiredHeader: { name: string; value: string } | undefined;
  /** The WebSocket upgrade request is never answered. */
  stallHandshake: boolean;
  /** `?more=true`: send `200` and the headers before the first reply (errors then become records). */
  earlyStreamHeaders: boolean;
  /** `?more=true`: answer `application/json` with the last reply (a bridge whose method replied once). */
  streamAsJson: boolean;
  /** `?more=true`: destroy the response after this many records. */
  dropAfterRecords: number | undefined;
  /** Wait this long before handling a simple-mode request. */
  delayMs: number;
  /** `GET health` answers 200 if true, else 503. */
  healthy: boolean;
  /** Scripted raw response: return true when the request was handled. */
  respond: ((req: IncomingMessage, res: ServerResponse, path: string) => boolean | Promise<boolean>) | undefined;
}

/** One HTTP request the bridge received. */
export interface RequestLog {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: IncomingMessage["headers"];
  /** For calls: the varlink method and the service it was sent to. */
  service?: string;
  varlinkMethod?: string;
  body?: string;
}

export interface BridgeOptions {
  /** Opens a connection to the varlink service (one per WebSocket and per simple-mode request). */
  backend: (service: string) => Promise<ByteChannel>;
  /** The services the bridge serves (others are 404). */
  services: readonly string[];
  /** Path prefix of the base URL; default "/waldo/". */
  prefix?: string;
}

const RS = "\x1e";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The HTTP status for a varlink error (UAPI "Simple HTTP Mode"). */
export function statusFor(error: string): number {
  switch (error) {
    case "org.varlink.service.InvalidParameter":
    case "org.varlink.service.ExpectedMore":
    case "org.varlink.service.ExpectedUpgrade":
      return 400;
    case "org.varlink.service.InterfaceNotFound":
    case "org.varlink.service.MethodNotFound":
      return 404;
    case "org.varlink.service.MethodNotImplemented":
      return 501;
    case "org.varlink.service.PermissionDenied":
      return 403;
    default:
      return 500;
  }
}

function defaultKnobs(): BridgeKnobs {
  return {
    framing: "message",
    requiredHeader: undefined,
    stallHandshake: false,
    earlyStreamHeaders: false,
    streamAsJson: false,
    dropAfterRecords: undefined,
    delayMs: 0,
    healthy: true,
    respond: undefined,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent || res.destroyed) return;
  const body = jsonCodec.encode(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}

/** Writes and waits for room (drain) or the response's end. */
function write(res: ServerResponse, data: string | Uint8Array): Promise<void> {
  if (res.destroyed) return Promise.resolve();
  if (res.write(data)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A running bridge. */
export class Bridge {
  /** `http://127.0.0.1:<port>/waldo/` */
  readonly base: string;
  readonly origin: string;
  readonly prefix: string;
  readonly knobs: BridgeKnobs = defaultKnobs();
  readonly requests: RequestLog[] = [];
  /** `Sec-WebSocket-Protocol` of each upgrade request (undefined if absent). */
  readonly wsProtocols: (string | undefined)[] = [];
  /** Simple-mode responses closed before they were complete (by the client, or by dropAfterRecords). */
  abortedResponses = 0;
  readonly #server: Server;
  readonly #options: BridgeOptions;
  readonly #sockets = new Set<Duplex>();
  readonly #peers = new Set<WsPeer>();
  readonly #abortWaiters: (() => void)[] = [];
  #closing = false;

  constructor(server: Server, port: number, options: BridgeOptions) {
    this.#server = server;
    this.#options = options;
    this.prefix = options.prefix ?? "/waldo/";
    this.origin = `http://127.0.0.1:${String(port)}`;
    this.base = this.origin + this.prefix;
    server.on("connection", (socket: Socket) => {
      this.#track(socket);
    });
    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      this.#handle(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { message: "bridge failure" });
        else res.destroy();
      });
    });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.#upgrade(req, socket, head).catch(() => {
        socket.destroy();
      });
    });
  }

  /** Back to the default knobs (and an empty request log). */
  reset(): void {
    Object.assign(this.knobs, defaultKnobs());
    this.requests.length = 0;
    this.wsProtocols.length = 0;
  }

  /** The WebSocket endpoint of `service` with `scheme` (`ws` or `http`). */
  wsUrl(service: string, scheme: "ws" | "http" = "ws"): string {
    return `${this.base.replace(/^http/, scheme)}ws/services/${service}`;
  }

  /** Open WebSocket sessions. */
  get webSockets(): number {
    return this.#peers.size;
  }

  /** Resolves when the next simple-mode response is closed early by the client. */
  nextAbortedResponse(): Promise<void> {
    return new Promise((resolve) => this.#abortWaiters.push(resolve));
  }

  /** Server-initiated clean close of every WebSocket (close frame 1000 or `code`). */
  closeWebSockets(code = 1000, reason = ""): void {
    for (const p of this.#peers) p.close(code, reason);
  }

  /** Drops every WebSocket's TCP connection without a close frame (the client sees 1006). */
  killWebSockets(): void {
    for (const p of this.#peers) p.kill();
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const p of this.#peers) p.kill();
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  #track(socket: Duplex): void {
    if (this.#sockets.has(socket)) return;
    this.#sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.#sockets.delete(socket);
    });
  }

  async #backend(service: string): Promise<Connection | undefined> {
    try {
      const channel = await this.#options.backend(service);
      return createConnection(channel, { timeout: 0, onError: () => undefined });
    } catch {
      return undefined;
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.origin);
    const log: RequestLog = {
      method: req.method ?? "",
      path: url.pathname,
      query: url.search,
      headers: req.headers,
    };
    this.requests.push(log);
    res.on("close", () => {
      if (res.writableFinished) return;
      this.abortedResponses++;
      for (const w of this.#abortWaiters.splice(0)) w();
    });
    if (!url.pathname.startsWith(this.prefix)) {
      sendJson(res, 404, { message: "not found" });
      return;
    }
    const path = url.pathname.slice(this.prefix.length);
    const respond = this.knobs.respond;
    if (respond !== undefined && (await respond(req, res, path))) return;
    const required = this.knobs.requiredHeader;
    if (required !== undefined && req.headers[required.name.toLowerCase()] !== required.value) {
      sendJson(res, 401, { message: "authentication required" });
      return;
    }
    if (this.knobs.delayMs > 0) await sleep(this.knobs.delayMs);
    const segments = path.split("/").map((s) => decodeURIComponent(s));
    const [first, second, third] = segments;
    if (req.method === "GET" && path === "health") {
      if (this.knobs.healthy) sendJson(res, 200, {});
      else sendJson(res, 503, { message: "unhealthy" });
      return;
    }
    if (req.method === "GET" && first === "services") {
      if (segments.length === 1) {
        sendJson(res, 200, { services: this.#options.services });
        return;
      }
      if (second === undefined || !this.#options.services.includes(second) || segments.length > 3) {
        sendJson(res, 404, { message: "unknown service" });
        return;
      }
      await this.#withBackend(res, second, async (conn) => {
        if (third === undefined) return conn.getInfo();
        const iface = parseInterface(await conn.getInterfaceDescription(third));
        return { methods: iface.members.filter((m) => m.kind === "method").map((m) => m.name) };
      });
      return;
    }
    if (req.method === "POST" && first === "call" && (segments.length === 2 || segments.length === 3)) {
      const method = (segments.length === 2 ? second : third) ?? "";
      const dot = method.lastIndexOf(".");
      const service =
        segments.length === 3
          ? (second ?? "")
          : (url.searchParams.get("service") ?? (dot > 0 ? method.slice(0, dot) : ""));
      log.service = service;
      log.varlinkMethod = method;
      const raw = (await readBody(req)).toString("utf8");
      log.body = raw;
      let parameters: unknown = {};
      try {
        if (raw.trim() !== "") parameters = jsonCodec.decode(raw);
      } catch {
        sendJson(res, 400, { message: "the request body is not JSON" });
        return;
      }
      if (!isObject(parameters)) {
        sendJson(res, 400, { message: "the request body is not a JSON object" });
        return;
      }
      if (!this.#options.services.includes(service)) {
        sendJson(res, 404, { message: "unknown service" });
        return;
      }
      if (url.searchParams.get("more") === "true") await this.#stream(res, service, method, parameters);
      else await this.#withBackend(res, service, (conn) => conn.call(method, parameters));
      return;
    }
    sendJson(res, 404, { message: "not found" });
  }

  /** Runs one request over a fresh backend connection, mapping the outcome to a response. */
  async #withBackend(res: ServerResponse, service: string, run: (conn: Connection) => Promise<unknown>): Promise<void> {
    const conn = await this.#backend(service);
    if (conn === undefined) {
      sendJson(res, 502, { message: "cannot connect to the service" });
      return;
    }
    this.#watch(res, conn);
    try {
      sendJson(res, 200, await run(conn));
    } catch (e) {
      if (isVarlinkError(e)) sendJson(res, statusFor(e.error), { error: e.error, parameters: e.parameters });
      else sendJson(res, 502, { message: "the connection to the service failed" });
    } finally {
      await conn.close();
    }
  }

  /** A response the client closes early closes the backend connection. */
  #watch(res: ServerResponse, conn: Connection): void {
    res.on("close", () => {
      if (!res.writableFinished) void conn.close();
    });
  }

  async #stream(res: ServerResponse, service: string, method: string, parameters: Record<string, unknown>) {
    const conn = await this.#backend(service);
    if (conn === undefined) {
      sendJson(res, 502, { message: "cannot connect to the service" });
      return;
    }
    this.#watch(res, conn);
    const head = (): void => {
      if (!res.headersSent) res.writeHead(200, { "content-type": "application/json-seq" });
    };
    if (this.knobs.earlyStreamHeaders) {
      head();
      res.flushHeaders();
    }
    let records = 0;
    let last: Record<string, unknown> | undefined;
    try {
      for await (const reply of conn.stream(method, parameters)) {
        if (res.destroyed) return;
        if (this.knobs.streamAsJson) {
          last = reply;
          continue;
        }
        head();
        await write(res, `${RS}${jsonCodec.encode(reply)}\n`);
        records++;
        const drop = this.knobs.dropAfterRecords;
        if (drop !== undefined && records >= drop) {
          await sleep(20); // let the records reach the client first
          res.destroy();
          return;
        }
      }
      if (this.knobs.streamAsJson) sendJson(res, 200, last ?? {});
      else {
        head();
        res.end();
      }
    } catch (e) {
      if (res.destroyed) return;
      if (!res.headersSent) {
        if (isVarlinkError(e)) sendJson(res, statusFor(e.error), { error: e.error, parameters: e.parameters });
        else sendJson(res, 502, { message: "the connection to the service failed" });
        return;
      }
      const record = isVarlinkError(e)
        ? { error: e.error, parameters: e.parameters }
        : { error: "the connection to the service failed" };
      await write(res, `${RS}${jsonCodec.encode(record)}\n`);
      res.end();
    } finally {
      await conn.close();
    }
  }

  async #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    this.#track(socket);
    const url = new URL(req.url ?? "/", this.origin);
    this.requests.push({ method: "UPGRADE", path: url.pathname, query: url.search, headers: req.headers });
    const reject = (status: number, text: string, message: string): void => {
      const body = JSON.stringify({ message });
      socket.end(
        `HTTP/1.1 ${String(status)} ${text}\r\nContent-Type: application/json\r\nContent-Length: ${String(body.length)}\r\nConnection: close\r\n\r\n${body}`,
      );
    };
    const path = url.pathname.startsWith(this.prefix) ? url.pathname.slice(this.prefix.length) : "";
    const match = /^ws\/services\/([^/]+)$/.exec(path);
    const service = match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
    const required = this.knobs.requiredHeader;
    if (required !== undefined && req.headers[required.name.toLowerCase()] !== required.value) {
      reject(401, "Unauthorized", "authentication required");
      return;
    }
    if (service === undefined || !this.#options.services.includes(service)) {
      reject(404, "Not Found", "unknown service");
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || req.headers["sec-websocket-version"] !== "13") {
      reject(400, "Bad Request", "not a WebSocket handshake");
      return;
    }
    const protocols = req.headers["sec-websocket-protocol"];
    this.wsProtocols.push(protocols);
    if (this.knobs.stallHandshake) return; // never answered; destroyed by close()
    let channel: ByteChannel;
    try {
      channel = await this.#options.backend(service);
    } catch {
      reject(502, "Bad Gateway", "cannot connect to the service");
      return;
    }
    if (this.#closing || socket.destroyed) {
      channel.close();
      return;
    }
    const accept = createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    const selected = protocols?.split(",")[0]?.trim();
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        (selected === undefined || selected === "" ? "" : `Sec-WebSocket-Protocol: ${selected}\r\n`) +
        "\r\n",
    );
    const peer = new WsPeer(socket, channel, this.knobs.framing, () => {
      this.#peers.delete(peer);
    });
    this.#peers.add(peer);
    peer.start(head);
  }
}

/** One WebSocket session: RFC 6455 framing on `socket`, bytes relayed to and from the backend `channel`. */
class WsPeer {
  readonly #socket: Duplex;
  readonly #channel: ByteChannel;
  readonly #framing: Framing;
  readonly #onGone: () => void;
  readonly #chunks: Buffer[] = [];
  #total = 0;
  #closeSent = false;
  #gone = false;
  #closeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Client→backend writes in flight (the socket is paused while there are any). */
  #pendingWrites = 0;
  #writeChain: Promise<void> = Promise.resolve();
  /** Service→client bytes not yet framed ("message"/"split": a partial message; "coalesce": a batch). */
  #out: Buffer = Buffer.alloc(0);
  #flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(socket: Duplex, channel: ByteChannel, framing: Framing, onGone: () => void) {
    this.#socket = socket;
    this.#channel = channel;
    this.#framing = framing;
    this.#onGone = onGone;
  }

  start(head: Buffer): void {
    this.#socket.on("data", (d: Buffer) => {
      this.#onData(d);
    });
    this.#socket.on("close", () => {
      this.#finish();
    });
    if (head.length > 0) this.#onData(head);
    void this.#pump();
  }

  /** Server-initiated close: a close frame, then the TCP connection ends once the client answered (or 1 s). */
  close(code: number, reason: string): void {
    this.#sendClose(code, reason);
  }

  kill(): void {
    this.#socket.destroy();
    this.#finish();
  }

  #finish(): void {
    if (this.#gone) return;
    this.#gone = true;
    if (this.#closeTimer !== undefined) clearTimeout(this.#closeTimer);
    if (this.#flushTimer !== undefined) clearTimeout(this.#flushTimer);
    this.#channel.close();
    this.#onGone();
  }

  #onData(d: Buffer): void {
    this.#chunks.push(d);
    this.#total += d.length;
    for (;;) {
      const size = this.#frameSize();
      if (size === undefined || this.#total < size.total) return;
      const frame = this.#take(size.total);
      if (!size.masked) {
        this.#sendClose(1002, "unmasked client frame");
        return;
      }
      const payload = frame.subarray(size.headerLength);
      const mask = frame.subarray(size.headerLength - 4, size.headerLength);
      for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0);
      this.#onFrame(size.opcode, payload);
    }
  }

  /** The size of the frame at the head of the input, once its header is complete. */
  #frameSize(): { total: number; headerLength: number; opcode: number; masked: boolean } | undefined {
    if (this.#total < 2) return undefined;
    const h = this.#peek(Math.min(this.#total, 14));
    const b0 = h[0] ?? 0;
    const b1 = h[1] ?? 0;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (h.length < 4) return undefined;
      length = h.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (h.length < 10) return undefined;
      length = Number(h.readBigUInt64BE(2));
      offset = 10;
    }
    const headerLength = offset + (masked ? 4 : 0);
    return { total: headerLength + length, headerLength, opcode: b0 & 0x0f, masked };
  }

  #peek(n: number): Buffer {
    const first = this.#chunks[0];
    if (first !== undefined && first.length >= n) return first;
    return Buffer.concat(this.#chunks, this.#total).subarray(0, n);
  }

  #take(n: number): Buffer {
    const all =
      this.#chunks.length === 1 ? (this.#chunks[0] ?? Buffer.alloc(0)) : Buffer.concat(this.#chunks, this.#total);
    this.#chunks.length = 0;
    const frame = Buffer.from(all.subarray(0, n)); // a copy: unmasked in place
    const rest = all.subarray(n);
    this.#total = rest.length;
    if (rest.length > 0) this.#chunks.push(rest);
    return frame;
  }

  #onFrame(opcode: number, payload: Buffer): void {
    switch (opcode) {
      case 0x0: // continuation
      case 0x1: // text
      case 0x2: // binary: text and binary are treated identically, frames are concatenated
        if (payload.length > 0) this.#toBackend(payload);
        return;
      case 0x8: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : undefined;
        if (!this.#closeSent) this.#sendClose(code ?? 1000, "");
        this.#socket.end();
        // The client is done sending: end the backend connection once the relayed bytes are written.
        void this.#writeChain.then(async () => {
          await this.#channel.end().catch(() => undefined);
          this.#channel.close();
        });
        return;
      }
      case 0x9:
        this.#sendFrame(0xa, payload);
        return;
      default: // pong and reserved opcodes: ignored
        return;
    }
  }

  #toBackend(payload: Buffer): void {
    this.#pendingWrites++;
    this.#socket.pause();
    const bytes = new Uint8Array(payload);
    this.#writeChain = this.#writeChain
      .then(() => this.#channel.write(bytes))
      .catch(() => {
        this.#sendClose(1011, "backend write failed");
      })
      .finally(() => {
        if (--this.#pendingWrites === 0) this.#socket.resume();
      });
  }

  async #pump(): Promise<void> {
    try {
      for (;;) {
        const chunk = await this.#channel.read();
        if (chunk === null) break;
        await this.#relay(Buffer.from(chunk.bytes));
      }
      this.#flush();
      this.#sendClose(1000, "");
    } catch {
      this.#flush();
      this.#sendClose(1011, "backend failed");
    }
  }

  /** Frames service→client bytes according to the framing mode; waits for the socket to drain. */
  async #relay(bytes: Buffer): Promise<void> {
    if (this.#gone || this.#closeSent) return;
    this.#out = this.#out.length === 0 ? bytes : Buffer.concat([this.#out, bytes]);
    if (this.#framing === "coalesce") {
      this.#flushTimer ??= setTimeout(() => {
        this.#flushTimer = undefined;
        this.#flush();
      }, 5);
      return;
    }
    let drained = true;
    for (;;) {
      const nul = this.#out.indexOf(0);
      if (nul < 0) break;
      const message = this.#out.subarray(0, nul + 1);
      this.#out = this.#out.subarray(nul + 1);
      if (this.#framing === "message") drained = this.#sendFrame(0x2, message) && drained;
      else {
        // 1 byte, then the rest in up to three pieces.
        const pieces = [message.subarray(0, 1)];
        const rest = message.subarray(1);
        const step = Math.max(1, Math.ceil(rest.length / 3));
        for (let i = 0; i < rest.length; i += step) pieces.push(rest.subarray(i, i + step));
        for (const p of pieces) drained = this.#sendFrame(0x2, p) && drained;
      }
    }
    if (!drained) await this.#drain();
  }

  /** Sends everything buffered as one frame (a coalesced batch, or a trailing partial message at EOF). */
  #flush(): void {
    if (this.#out.length === 0 || this.#closeSent || this.#gone) return;
    const out = this.#out;
    this.#out = Buffer.alloc(0);
    this.#sendFrame(0x2, out);
  }

  #drain(): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        this.#socket.off("drain", done);
        this.#socket.off("close", done);
        resolve();
      };
      this.#socket.on("drain", done);
      this.#socket.on("close", done);
    });
  }

  #sendFrame(opcode: number, payload: Uint8Array): boolean {
    if (this.#gone || this.#socket.destroyed) return true;
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    return this.#socket.write(Buffer.concat([header, payload]));
  }

  #sendClose(code: number, reason: string): void {
    if (this.#closeSent || this.#gone) return;
    this.#closeSent = true;
    const r = Buffer.from(reason, "utf8");
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this.#sendFrame(0x8, payload);
    // Wait for the client's close frame (it ends the socket), but not forever.
    this.#closeTimer = setTimeout(() => {
      this.kill();
    }, 1000);
  }
}

/** Starts a bridge on 127.0.0.1 (a free port). */
export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no tcp address");
  return new Bridge(server, address.port, options);
}
