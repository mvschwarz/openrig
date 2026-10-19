import { randomUUID } from "node:crypto";
import { validateConfig, DEFAULT_CONFIG } from "./config.js";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
export interface MatrixEvent {
  event_id: string;
  sender: string;
  type: string;
  content: {
    msgtype?: string; body?: string;
    "m.relates_to"?: { rel_type?: string; event_id?: string; key?: string; "m.in_reply_to"?: { event_id: string } };
  };
}
export interface SyncResponse {
  next_batch: string;
  rooms?: { join?: Record<string, { timeline?: { events?: MatrixEvent[]; limited?: boolean; prev_batch?: string } }> };
}
export interface MessagesResponse { chunk: MatrixEvent[]; end?: string }
export class MatrixApiError extends Error {
  constructor(public readonly status: number, public readonly errcode: string, detail: string, public readonly retryAfterMs?: number) {
    super(`Matrix ${errcode} (HTTP ${status}): ${detail}`);
    this.name = "MatrixApiError";
  }
}
export class MatrixTokenError extends MatrixApiError {
  constructor(status: number, errcode: string) {
    super(status, errcode, "access token is invalid or expired; run rig matrix setup with a valid bot access token");
    this.name = "MatrixTokenError";
  }
}
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export interface SendOptions { formattedBody?: string; threadRootEventId?: string; transactionId?: string; signal?: AbortSignal }
export class MatrixClient {
  private readonly baseUrl: string;
  constructor(private readonly config: { homeserverUrl: string; accessToken: string; deviceId?: string }, private readonly deps: {
    fetchImpl?: FetchImpl; sleep?: typeof abortableSleep; maxRateLimitRetries?: number;
  } = {}) {
    validateConfig({ ...DEFAULT_CONFIG, homeserverUrl: config.homeserverUrl });
    this.baseUrl = config.homeserverUrl.replace(/\/+$/, "") + "/_matrix/client/v3";
  }
  private async request<T>(method: string, endpoint: string, body?: unknown, signal?: AbortSignal, timeoutMs = 15000): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await (this.deps.fetchImpl ?? fetch)(this.baseUrl + endpoint, {
        method, headers: { Authorization: `Bearer ${this.config.accessToken}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: "error", // Never forward the bot token to another origin via a redirect.
      });
      let json: Record<string, unknown> | unknown[];
      try { json = await res.json() as Record<string, unknown>; }
      catch { throw new MatrixApiError(res.status, "M_INVALID_RESPONSE", "homeserver returned a non-JSON response"); }
      if (!json || typeof json !== "object") throw new MatrixApiError(res.status, "M_INVALID_RESPONSE", "homeserver returned an invalid JSON response");
      // /rooms/{roomId}/state returns an array; errors and other endpoints
      // return objects. Validate each successful endpoint's shape below.
      if (Array.isArray(json)) {
        if (res.ok) return json as T;
        throw new MatrixApiError(res.status, "M_INVALID_RESPONSE", "homeserver returned an invalid error response");
      }
      if (res.ok && !json.errcode) return json as T;
      const code = typeof json.errcode === "string" ? json.errcode : "M_HTTP_ERROR";
      if (res.status === 401 || code === "M_UNKNOWN_TOKEN" || code === "M_MISSING_TOKEN") throw new MatrixTokenError(res.status, code);
      const retry = typeof json.retry_after_ms === "number" && Number.isFinite(json.retry_after_ms) ? Math.max(0, json.retry_after_ms) : 1000 * 2 ** attempt;
      if ((code === "M_LIMIT_EXCEEDED" || res.status === 429) && attempt < (this.deps.maxRateLimitRetries ?? 3)) {
        await (this.deps.sleep ?? abortableSleep)(retry, signal);
        continue; // PUT transaction id and body are byte-identical on retries.
      }
      const detail = typeof json.error === "string" ? json.error.split(this.config.accessToken).join("[redacted]") : "request failed";
      throw new MatrixApiError(res.status, code, detail, code === "M_LIMIT_EXCEEDED" ? retry : undefined);
    }
  }
  private async sendEvent(roomId: string, type: string, content: unknown, opts: { transactionId?: string; signal?: AbortSignal }): Promise<{ event_id: string }> {
    const result = await this.request<{ event_id: string }>("PUT", `/rooms/${encodeURIComponent(roomId)}/send/${type}/${encodeURIComponent(opts.transactionId ?? randomUUID())}`, content, opts.signal);
    if (typeof result.event_id !== "string" || !result.event_id) throw new Error("Matrix send response is missing event_id");
    return result;
  }
  sendMessage(roomId: string, text: string, opts: SendOptions = {}): Promise<{ event_id: string }> {
    return this.sendEvent(roomId, "m.room.message", {
      msgtype: "m.text", body: text,
      ...(opts.formattedBody === undefined ? {} : { format: "org.matrix.custom.html", formatted_body: opts.formattedBody }),
      ...(opts.threadRootEventId ? { "m.relates_to": {
        rel_type: "m.thread", event_id: opts.threadRootEventId, is_falling_back: true,
        "m.in_reply_to": { event_id: opts.threadRootEventId },
      } } : {}),
    }, opts);
  }
  sendReaction(roomId: string, eventId: string, emoji: string, opts: { transactionId?: string; signal?: AbortSignal } = {}): Promise<{ event_id: string }> {
    return this.sendEvent(roomId, "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key: emoji } }, opts);
  }
  async sync(opts: { since?: string; timeoutMs: number; signal?: AbortSignal }): Promise<SyncResponse> {
    const query = new URLSearchParams({ timeout: String(opts.timeoutMs) });
    if (opts.since) query.set("since", opts.since);
    const page = await this.request<SyncResponse>("GET", `/sync?${query}`, undefined, opts.signal, opts.timeoutMs + 15000);
    if (typeof page.next_batch !== "string" || !page.next_batch) throw new Error("Matrix sync response is missing next_batch");
    return page;
  }
  async whoami(signal?: AbortSignal): Promise<{ user_id: string; device_id?: string }> {
    const result = await this.request<{ user_id: string; device_id?: string }>("GET", "/account/whoami", undefined, signal);
    if (typeof result.user_id !== "string" || !result.user_id) throw new Error("Matrix whoami response is missing user_id");
    return result;
  }
  async joinRoom(roomIdOrAlias: string, signal?: AbortSignal): Promise<{ room_id: string }> {
    const result = await this.request<{ room_id: string }>("POST", `/join/${encodeURIComponent(roomIdOrAlias)}`, {}, signal);
    if (typeof result.room_id !== "string" || !result.room_id.startsWith("!")) throw new Error("Matrix join response is missing room_id");
    return result;
  }
  async getJoinedRooms(signal?: AbortSignal): Promise<{ joined_rooms: string[] }> {
    const result = await this.request<{ joined_rooms: string[] }>("GET", "/joined_rooms", undefined, signal);
    if (!Array.isArray(result.joined_rooms) || result.joined_rooms.some((room) => typeof room !== "string")) throw new Error("Matrix joined_rooms response is invalid");
    return result;
  }
  async getRoomState(roomId: string, signal?: AbortSignal): Promise<Array<{ type: string; state_key: string; content: Record<string, unknown> }>> {
    const result = await this.request<Array<{ type: string; state_key: string; content: Record<string, unknown> }>>("GET", `/rooms/${encodeURIComponent(roomId)}/state`, undefined, signal);
    if (!Array.isArray(result) || result.some((event) => !event || typeof event.type !== "string" || !event.content || typeof event.content !== "object")) throw new Error("Matrix room state response is invalid");
    return result;
  }
  async messages(roomId: string, opts: { from: string; to: string; signal?: AbortSignal }): Promise<MessagesResponse> {
    const query = new URLSearchParams({ from: opts.from, to: opts.to, dir: "f", limit: "100" });
    const result = await this.request<MessagesResponse>("GET", `/rooms/${encodeURIComponent(roomId)}/messages?${query}`, undefined, opts.signal);
    if (!Array.isArray(result.chunk) || (result.end !== undefined && typeof result.end !== "string")) throw new Error("Matrix history response is invalid");
    return result;
  }
}
