import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

// ACP v1 is JSON-RPC 2.0 over newline-delimited JSON on the agent's stdio. This peer covers what an OpenRig client
// needs (a few outgoing requests, incoming requests and notifications); the official SDK would add a dependency for
// a handful of methods, so swap to it only if the method set grows.

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** An error the agent returned, with its original code, message and data kept for the record. */
export class JsonRpcRequestError extends Error {
  constructor(readonly method: string, readonly error: JsonRpcErrorObject) {
    super(`${method} failed: ${error.code} ${error.message}`);
    this.name = "JsonRpcRequestError";
  }
}

/** The connection ended before the agent answered; the request's effect is unknown. */
export class JsonRpcTransportClosed extends Error {
  constructor(readonly method: string) {
    super(`${method}: the agent's connection closed before it answered`);
    this.name = "JsonRpcTransportClosed";
  }
}

export type JsonRpcId = number | string;
export type IncomingRequestHandler = (params: unknown, id: JsonRpcId) => Promise<unknown>;
export type NotificationHandler = (params: unknown) => void;
/** Every packet in both directions, in order; lines that aren't JSON arrive as `in-text`. */
export type PacketRecorder = (direction: "out" | "in" | "in-text", packet: unknown) => void;

export class StdioJsonRpcPeer {
  private nextId = 0;
  private readonly pending = new Map<JsonRpcId, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly requestHandlers = new Map<string, IncomingRequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private ended = false;
  private readonly lines: ReturnType<typeof createInterface>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly record: PacketRecorder = () => {}) {
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.receive(line));
    this.exited = new Promise((resolve) => child.once("close", (code, signal) => {
      this.ended = true;
      for (const [id, request] of this.pending) {
        this.pending.delete(id);
        request.reject(new JsonRpcTransportClosed(request.method));
      }
      resolve({ code, signal });
    }));
    child.stdin.on("error", () => { /* EPIPE after the agent exits; pending requests reject on close */ });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.ended) return Promise.reject(new JsonRpcTransportClosed(method));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.ended) this.send({ jsonrpc: "2.0", method, params });
  }

  onRequest(method: string, handler: IncomingRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Close the agent's stdin (detach) and wait for the process to exit, up to `timeoutMs`. */
  async end(timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null } | "still-running"> {
    this.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"still-running">((resolve) => { timer = setTimeout(() => resolve("still-running"), timeoutMs); });
    try { return await Promise.race([this.exited, timeout]); } finally { clearTimeout(timer); }
  }

  /** Drop this side's hold on the agent (its pipes and process handle) without signalling it, so a detached agent that
   *  keeps running doesn't keep the caller's process alive. */
  release(): void {
    this.lines.close();
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) stream.destroy();
    this.child.unref();
  }

  private send(packet: Record<string, unknown>): void {
    this.record("out", packet);
    this.child.stdin.write(`${JSON.stringify(packet)}\n`);
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    let packet: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      packet = parsed as Record<string, unknown>;
    } catch {
      this.record("in-text", line);
      return;
    }
    this.record("in", packet);
    const { id, method } = packet;
    if (typeof method === "string" && (typeof id === "number" || typeof id === "string")) {
      void this.answer(method, id, packet.params);
    } else if (typeof method === "string") {
      this.notificationHandlers.get(method)?.(packet.params);
    } else if (typeof id === "number" || typeof id === "string") {
      const request = this.pending.get(id);
      if (!request) return; // a reply to nothing we asked; already recorded
      this.pending.delete(id);
      if (packet.error && typeof packet.error === "object") request.reject(new JsonRpcRequestError(request.method, packet.error as JsonRpcErrorObject));
      else request.resolve(packet.result);
    }
  }

  private async answer(method: string, id: JsonRpcId, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Client does not handle ${method}` } });
      return;
    }
    try {
      const result = await handler(params, id);
      if (!this.ended) this.send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -32603;
      if (!this.ended) this.send({ jsonrpc: "2.0", id, error: { code, message: (error as Error).message } });
    }
  }
}
