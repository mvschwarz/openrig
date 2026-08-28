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
  ok: boolean; // Slack-level ok (json.ok === true AND 2xx)
  status: number;
  grantedScopes: string[]; // parsed from x-oauth-scopes response header (item 5)
  json: Record<string, unknown>;
  error?: string;
}

/** S10 shape-fix — the per-method REQUEST SHAPE. Slack's read methods (conversations.info /
 *  history / replies) reject a JSON POST with `invalid_arguments` (operator-measured live);
 *  their supported shape is GET with URL-query args. Write/JSON methods (auth.test,
 *  apps.connections.open, chat.postMessage, files.completeUploadExternal) keep JSON POST
 *  byte-identically — the default, so no existing caller changes shape implicitly. */
export type WebApiRequestShape = "json-post" | "get-query";

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
      return { ok, status: res.status, grantedScopes, json, error: ok ? undefined : String(json.error ?? `http ${res.status}`) };
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
  const r = await callWebApi("files.getUploadURLExternal", token, { filename, length }, fetchImpl, timeoutMs);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, uploadUrl: r.json.upload_url as string, fileId: r.json.file_id as string };
}

/** Leg 2: POST the raw bytes to the pre-signed upload URL (octet-stream, no auth header). */
export async function uploadBytesExternal(
  uploadUrl: string,
  bytes: Uint8Array,
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
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
  const r = await callWebApi("files.completeUploadExternal", token, body, fetchImpl, timeoutMs);
  return { ok: r.ok, error: r.error };
}

/** S10 (H) — read recent message TEXTS for reconcile-by-marker: a timeout is an AMBIGUOUS
 *  outcome (the post may have landed), so before any resend the sender searches for the
 *  embedded row-id marker. threadTs set → conversations.replies (a threaded reply lives in its
 *  thread, not channel history); absent → conversations.history. Read-only; bounded. */
export async function fetchRecentMessageTexts(
  token: string,
  channel: string,
  threadTs: string | undefined,
  fetchImpl: FetchImpl = defaultFetch,
  limit = 100,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; texts: string[]; error?: string }> {
  const method = threadTs ? "conversations.replies" : "conversations.history";
  const body: Record<string, unknown> = threadTs ? { channel, ts: threadTs, limit } : { channel, limit };
  const r = await callWebApi(method, token, body, fetchImpl, timeoutMs, "get-query");
  if (!r.ok) return { ok: false, texts: [], error: r.error };
  const messages = (r.json.messages ?? []) as { text?: string }[];
  return { ok: true, texts: messages.map((m) => String(m.text ?? "")) };
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
