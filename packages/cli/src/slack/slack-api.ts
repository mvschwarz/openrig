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

/** Call a Slack Web API method (Bearer token) and surface the granted-scope header. */
export async function callWebApi(
  method: string,
  token: string,
  body: Record<string, unknown>,
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<WebApiResult> {
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      const res = await fetchImpl(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
        signal,
      });
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
  const r = await callWebApi("conversations.info", token, { channel }, fetchImpl, timeoutMs);
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
