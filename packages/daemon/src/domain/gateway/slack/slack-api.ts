// Slice-11 slack-connector — Slack HTTP client.
//
// `fetch`-based (http/https agnostic + injectable) matching the daemon's
// WebhookNotificationAdapter + its fake-fetch test pattern; every call is
// bounded by an explicit timeout with a structured failure result (never
// throws past the boundary, never hangs) — the remote-daemon-http discipline.
//
// Item 5 (the setup-scope trap): Slack's "Add New Webhook" grants ONLY the
// webhook scope; configured bot scopes are NOT granted until a full reinstall,
// with no warning. The ONLY proof of granted scopes is the `x-oauth-scopes`
// RESPONSE HEADER on a real API call — configured != granted. getGrantedScopes()
// reads exactly that header. Channel membership is likewise verified live
// (conversations.info.is_member) before declaring inbound ready.

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchImpl = (url, init) => fetch(url, init);
const DEFAULT_TIMEOUT_MS = 15000;

export interface HttpResult {
  ok: boolean; // transport+status ok (2xx)
  status: number;
  error?: string;
}

async function withTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await run(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Post to a Slack incoming webhook. Fail-VISIBLE (item 3): any non-2xx or
 * transport error returns ok:false with a bounded error string — the caller
 * logs loudly and does NOT mark the alert seen (so it retries, never a silent drop).
 *
 * S10: RETIRED from the production path — outbound posts via postChatMessage on the in-daemon
 * subsystem (a webhook cannot carry thread_ts). Kept as a tested generic client; no production
 * caller remains.
 */
export async function postWebhook(
  url: string,
  payload: unknown,
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HttpResult> {
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, status: res.status, error: `slack ${res.status}: ${text.slice(0, 160)}` };
      }
      return { ok: true, status: res.status };
    });
  } catch (e) {
    return { ok: false, status: 0, error: `webhook transport: ${(e as Error).message}` };
  }
}

export interface WebApiResult {
  retryAfterSeconds?: number;
  ok: boolean; // Slack-level ok (json.ok === true AND 2xx)
  status: number;
  grantedScopes: string[]; // parsed from x-oauth-scopes response header (item 5)
  json: Record<string, unknown>;
  error?: string;
}

/** S10 shape-fix — the per-method REQUEST SHAPE. Slack's read methods (conversations.info /
 *  history / replies) reject a JSON POST with `invalid_arguments` (operator-measured live);
 *  their supported shape is GET with URL-query args. The external-upload methods
 *  (files.getUploadURLExternal / files.completeUploadExternal) are sent "form-post": url-encoded
 *  fields, objects/arrays as JSON strings, which is how Slack's own Web API client sends every call.
 *  files.getUploadURLExternal answers a JSON body with `invalid_arguments` ("missing required
 *  field: length / filename") although its reference lists JSON. Write methods (auth.test,
 *  apps.connections.open, chat.postMessage) keep JSON POST byte-identically — the default, so no
 *  existing caller changes shape implicitly. */
export type WebApiRequestShape = "json-post" | "get-query" | "form-post";

/** Call a Slack Web API method (Bearer token) and surface the granted-scope header. */
export async function callWebApi(
  method: string,
  token: string,
  body: Record<string, unknown>,
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  shape: WebApiRequestShape = "json-post",
): Promise<WebApiResult> {
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      let res: Response;
      if (shape === "get-query") {
        // The read shape: args in the query string, Authorization only — no body, no
        // content-type (a body or JSON content-type is exactly what the endpoint rejects).
        const url = new URL(`https://slack.com/api/${method}`);
        for (const [k, v] of Object.entries(body)) {
          if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }
        res = await fetchImpl(url.toString(), {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
          signal,
        });
      } else if (shape === "form-post") {
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(body)) {
          if (v !== undefined && v !== null) form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
        }
        res = await fetchImpl(`https://slack.com/api/${method}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
          body: form.toString(),
          signal,
        });
      } else {
        res = await fetchImpl(`https://slack.com/api/${method}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(body),
          signal,
        });
      }
      const scopeHeader = res.headers.get("x-oauth-scopes") ?? "";
      const grantedScopes = scopeHeader
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      let json: Record<string, unknown> = {};
      try {
        json = (await res.json()) as Record<string, unknown>;
      } catch {
        /* non-JSON */
      }
      const ok = res.ok && json.ok === true;
      const retryAfter = Number(res.headers.get("retry-after"));
      return { ok, status: res.status, grantedScopes, json,
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}), error: ok ? undefined : String(json.error ?? `http ${res.status}`) };
    });
  } catch (e) {
    return { ok: false, status: 0, grantedScopes: [], json: {}, error: `web-api transport: ${(e as Error).message}` };
  }
}

/** Item 5: read the ACTUAL granted scopes from the response header (configured != granted). */
export async function getGrantedScopes(
  token: string,
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; granted: string[]; error?: string }> {
  const r = await callWebApi("auth.test", token, {}, fetchImpl, timeoutMs);
  return { ok: r.ok, granted: r.grantedScopes, error: r.error };
}

/** OPR.0.5.6.2 — authenticated private-file download (`url_private` + Bearer,
 *  the verified inbound mechanic from the human-layer design §4.1). Bounded:
 *  a body over `maxBytes` is refused, never truncated-and-stored. Slack's
 *  classic auth-failure mode returns an HTML login page with status 200 —
 *  detected by content-type and named, so garbage is never stored as the file.
 *  Errors are MESSAGES, not exceptions: the caller's failure-honesty contract
 *  needs a name per file, never a thrown loss of the whole event. */
export const INBOUND_FILE_MAX_BYTES = 26_214_400; // 25 MiB — bounded write per product limits

export async function downloadPrivateFile(
  url: string,
  token: string,
  fetchImpl: FetchImpl = fetch,
  timeoutMs = 30_000,
  maxBytes = INBOUND_FILE_MAX_BYTES,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal } as RequestInit);
      if (!res.ok) return { ok: false as const, error: `http ${res.status}` };
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        return { ok: false as const, error: "auth failure (Slack served an HTML page instead of the file)" };
      }
      // Enforce the bound while receiving, including chunked responses without
      // Content-Length. arrayBuffer() would allocate the entire oversized file
      // before checking the limit.
      if (!res.body) return { ok: true as const, bytes: new Uint8Array() };
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > maxBytes) {
            await reader.cancel().catch(() => {});
            return { ok: false as const, error: `exceeds size bound (${length} > ${maxBytes})` };
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { ok: true as const, bytes };
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message || "download failed" };
  }
}

export interface ScopeVerdict {
  ok: boolean;
  granted: string[];
  missing: string[];
  error?: string;
}

/** Item 5: verify the token actually HAS the required scopes (from the header, not config). */
export async function verifyScopes(
  token: string,
  required: string[],
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ScopeVerdict> {
  const g = await getGrantedScopes(token, fetchImpl, timeoutMs);
  if (!g.ok) return { ok: false, granted: g.granted, missing: required, error: g.error };
  const grantedSet = new Set(g.granted);
  const missing = required.filter((s) => !grantedSet.has(s));
  return { ok: missing.length === 0, granted: g.granted, missing };
}

/** Item 5: verify the bot is actually a MEMBER of the channel before inbound-ready. */
export async function verifyChannelMembership(
  token: string,
  channel: string,
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; isMember: boolean; name?: string; error?: string }> {
  const r = await callWebApi("conversations.info", token, { channel }, fetchImpl, timeoutMs, "get-query");
  if (!r.ok) return { ok: false, isMember: false, error: r.error };
  const ch = (r.json.channel ?? {}) as { is_member?: boolean; name?: string };
  return { ok: true, isMember: ch.is_member === true, name: ch.name };
}

/** Inbound Socket Mode: open a WebSocket URL via apps.connections.open (app-level xapp token). */
export async function openSocketConnection(
  appToken: string,
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const r = await callWebApi("apps.connections.open", appToken, {}, fetchImpl, timeoutMs);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, url: r.json.url as string };
}

// ── S10 outbound images — the EXTERNAL-UPLOAD flow (the only living upload path) ────────────
// `files.upload` was sunset 2025-11-12 and no longer functions (affordance-verified). The flow:
//   1. files.getUploadURLExternal (filename, length)  → { upload_url, file_id }
//   2. POST the raw bytes to upload_url (octet-stream)
//   3. files.completeUploadExternal ({ files, channel_id, thread_ts?, initial_comment? })
// Scope: files:write. thread_ts attaches the file INTO the conversation thread.

export async function getUploadURLExternal(
  token: string,
  filename: string,
  length: number,
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; uploadUrl?: string; fileId?: string; error?: string }> {
  const r = await callWebApi("files.getUploadURLExternal", token, { filename, length }, fetchImpl, timeoutMs, "form-post");
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, uploadUrl: r.json.upload_url as string, fileId: r.json.file_id as string };
}

/** Leg 2: POST the raw bytes to the pre-signed upload URL (octet-stream, no auth header). The
 *  default timeout grows with the size (a screen recording can be tens of MB): 15 s plus 1 s per 512 KiB. */
export async function uploadBytesExternal(
  uploadUrl: string,
  bytes: Uint8Array,
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS + Math.ceil(bytes.length / 524_288) * 1000,
): Promise<HttpResult> {
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      const res = await fetchImpl(uploadUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes as unknown as RequestInit["body"],
        signal,
      });
      if (!res.ok) return { ok: false, status: res.status, error: `upload ${res.status}` };
      return { ok: true, status: res.status };
    });
  } catch (e) {
    return { ok: false, status: 0, error: `upload transport: ${(e as Error).message}` };
  }
}

export async function completeUploadExternal(
  token: string,
  input: { files: { id: string; title?: string }[]; channelId: string; threadTs?: string; initialComment?: string },
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; error?: string }> {
  const body: Record<string, unknown> = { files: input.files, channel_id: input.channelId };
  if (input.threadTs) body.thread_ts = input.threadTs;
  if (input.initialComment) body.initial_comment = input.initialComment;
  const r = await callWebApi("files.completeUploadExternal", token, body, fetchImpl, timeoutMs, "form-post");
  return { ok: r.ok, error: r.error };
}

/** Search either history order (root newest-first; replies earliest-first) via
 * supported cursors under one total timeout and a finite page bound. A found
 * marker stops the scan; incomplete records partial evidence for the caller.
 * No timestamp cutoff is inferred from in-memory or durable attempt records. */
export async function fetchRecentMessageTexts(
  token: string,
  channel: string,
  threadTs: string | undefined,
  fetchImpl: FetchImpl = defaultFetch,
  limit = 100,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  reconcileMarker?: string,
): Promise<{ ok: boolean; texts: string[]; messages: { text: string; ts: string }[]; error?: string; incomplete?: string }> {
  const method = threadTs ? "conversations.replies" : "conversations.history";
  const messages: { text: string; ts: string }[] = [];
  const result = (ok: boolean, error?: string) => ({ ok, texts: messages.map((m) => m.text), messages, error });
  const deadline = performance.now() + timeoutMs;
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let usablePages = 0;
  // Partial history is evidence about the scan, never proof of absence. Preserve
  // the initial-request failure outcome; after a usable page let delivery warn
  // and retain main's at-least-once retry policy for human notifications.
  const incomplete = (reason: string) => usablePages === 0
    ? result(false, reason)
    : { ...result(true), incomplete: reason.slice(0, 160) };
  for (let page = 0; page < 10; page++) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) return incomplete("reconcile pagination exceeded its total timeout");
    const body: Record<string, unknown> = { channel, limit, ...(threadTs ? { ts: threadTs } : {}), ...(cursor ? { cursor } : {}) };
    const response = await callWebApi(method, token, body, fetchImpl, remainingMs, "get-query");
    if (!response.ok) return incomplete(response.error ?? "reconcile request failed");
    usablePages++;
    const pageMessages = (response.json.messages ?? []) as { text?: string; ts?: string }[];
    messages.push(...pageMessages.map((message) => ({ text: String(message.text ?? ""), ts: String(message.ts ?? "") })));
    if (reconcileMarker && messages.some((message) => message.text.includes(reconcileMarker))) return result(true);
    const metadata = response.json.response_metadata as { next_cursor?: unknown } | undefined;
    const nextCursor = typeof metadata?.next_cursor === "string" ? metadata.next_cursor.trim() : "";
    if (!nextCursor && response.json.has_more !== true) return result(true);
    if (!nextCursor) return incomplete("reconcile pagination has more messages but no next cursor");
    if (cursors.has(nextCursor)) return incomplete("reconcile pagination repeated a cursor");
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  return incomplete("reconcile pagination exceeded its 10-page bound");
}

export interface PostChatMessageInput {
  channel: string;
  text: string; // notification fallback — always set (affordance-verified: keep a text arg on all posts)
  blocks?: unknown[];
  /** Thread reply: the PARENT message's ts (never a reply's ts — the affordance discriminator). */
  thread_ts?: string;
}

export type PostChatMessageResult =
  | { ok: true; status: number; ts: string }
  | { ok: false; status: number; error?: string };

/** S10 — outbound posting via the Web API (`chat.postMessage`). The R2 native shape needs
 *  thread_ts, which an incoming webhook cannot carry — the webhook path retires with the relay.
 *  A1.2 identity rail: this function NEVER accepts per-message `username`/`icon_*` overrides —
 *  the app's own identity is the only outbound identity (the customize-absence proof leg).
 *  Returns the posted message's ts (the thread anchor for a NEW conversation root). */
export async function postChatMessage(
  token: string,
  input: PostChatMessageInput,
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<PostChatMessageResult> {
  const body: Record<string, unknown> = { channel: input.channel, text: input.text };
  if (input.blocks?.length) body.blocks = input.blocks;
  if (input.thread_ts) body.thread_ts = input.thread_ts;
  const r = await callWebApi("chat.postMessage", token, body, fetchImpl, timeoutMs);
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  const ts = typeof r.json.ts === "string" ? r.json.ts.trim() : "";
  if (!ts) {
    return { ok: false, status: r.status, error: "chat.postMessage returned ok without a message ts" };
  }
  return { ok: true, status: r.status, ts };
}
