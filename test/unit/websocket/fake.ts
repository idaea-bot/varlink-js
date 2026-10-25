// A scripted WebSocket for the channel unit tests: tests emit events and inspect what was sent and closed.
import type { WebSocketLike } from "../../../src/websocket/index.ts";

export class FakeWebSocket implements WebSocketLike {
  readyState = 1;
  binaryType = "blob";
  bufferedAmount = 0;
  /** Behave like the WHATWG API: close() codes other than 1000 and 3000–4999 throw InvalidAccessError. */
  strictCodes = false;
  sendThrows: Error | undefined;
  /** close() does not get its close event automatically (the test emits it, or never). */
  holdClose = false;
  readonly sent: Uint8Array[] = [];
  readonly closes: { code: number | undefined; reason: string | undefined }[] = [];
  readonly #listeners = new Map<string, Set<(event: unknown) => void>>();

  send(data: Uint8Array): void {
    if (this.sendThrows !== undefined) throw this.sendThrows;
    if (this.readyState !== 1) throw new Error("InvalidStateError");
    this.sent.push(new Uint8Array(data));
  }

  close(code?: number, reason?: string): void {
    if (this.strictCodes && code !== undefined && code !== 1000 && (code < 3000 || code > 4999))
      throw new DOMException("invalid close code", "InvalidAccessError");
    this.closes.push({ code, reason });
    if (this.readyState < 2) this.readyState = 2;
    // The peer answers the closing handshake (a microtask later) unless the test scripts it.
    if (!this.holdClose)
      queueMicrotask(() => {
        if (this.readyState !== 3) this.closed(code ?? 1005, reason ?? "", true);
      });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.#listeners.get(type);
    if (set === undefined) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  listenerCount(): number {
    let n = 0;
    for (const set of this.#listeners.values()) n += set.size;
    return n;
  }

  emit(type: string, event: unknown): void {
    for (const l of [...(this.#listeners.get(type) ?? [])]) l(event);
  }

  message(data: unknown): void {
    this.emit("message", { data });
  }

  /** The `close` event (readyState CLOSED). */
  closed(code: number, reason = "", wasClean = true): void {
    this.readyState = 3;
    this.emit("close", { code, reason, wasClean });
  }

  error(): void {
    this.emit("error", { type: "error" });
  }
}

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
export const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
