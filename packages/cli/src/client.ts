import fs from "node:fs";
import path from "node:path";
import { ConfigStore } from "./config-store.js";
import { getOpenRigHome, readOpenRigEnv } from "./openrig-compat.js";
import { fetchWithTimeout, FetchTimeoutError } from "./fetch-with-timeout.js";
import { readLocalOrigin } from "./local-origin.js";

export function terminalAuthHeaders(): Record<string, string> {
  const token = resolveTerminalToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** The header carrying the caller's seat identity, derived ONCE at the transport chokepoint. */
export const SENDER_IDENTITY_HEADER = "X-OpenRig-Session";

/**
 * P18 sender-provenance — derive the caller's identity from the seat ENV (never a request-body
 * claim). Routes that record authorship into the channel of record read ONLY this header, so a
 * buggy/stale caller cannot write false history by fat-fingering or stale-copying a body field.
 * Absent env ⇒ no header ⇒ the daemon DELIVERS and labels the write `claimed:v1` (P18 deliver-and-label;
 * a write with no actor at all is 400 actor_required — parameter completeness, not a refusal). One
 * chokepoint: `DaemonClient.fetch` stamps this on every request; callers never set it by hand.
 */
export function senderIdentityHeaders(originSelfHostId?: string): Record<string, string> {
  const session = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME")?.trim();
  if (!session) return {};
  // Preserve qualified senders; append only a locally derived instance id.
  const value =
    originSelfHostId && originSelfHostId.length > 0 && session.split("@").length < 3
      ? `${session}@${originSelfHostId}`
      : session;
  return { [SENDER_IDENTITY_HEADER]: value };
}

/** Construct registered remote clients with the origin derived from this instance's durable store. */
export function remoteDaemonClient(
  clientFactory: (baseUrl: string) => DaemonClient,
  url: string,
  originSelfHostId?: string,
): DaemonClient {
  const client = clientFactory(url);
  client.originSelfHostId = originSelfHostId;
  client.remoteTarget = true;
  return client;
}

function resolveTerminalToken(): string | null {
  const env = process.env.OPENRIG_TERMINAL_BEARER_TOKEN?.trim();
  if (env) return env;
  try {
    const homeDir = process.env.OPENRIG_HOME ?? path.join(process.env.HOME ?? "", ".openrig");
    const tokenPath = path.join(homeDir, "terminal-token");
    const token = fs.readFileSync(tokenPath, "utf-8").trim();
    return token || null;
  } catch {
    return null;
  }
}

export class DaemonConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonConnectionError";
  }
}

/**
 * Slow-response: the request reached its bound without a reply. A SUBCLASS of
 * DaemonConnectionError so existing callers still catch it, but distinguishable
 * so the CLI can render "slow, not stopped" instead of daemon-down language.
 */
export class DaemonTimeoutError extends DaemonConnectionError {
  constructor(message: string) {
    super(message);
    this.name = "DaemonTimeoutError";
  }
}

/**
 * Bad-response: the daemon replied, but the body could not be read or parsed as JSON
 * (truncated / unparseable / non-JSON — a real symptom under daemon saturation).
 * DISTINCT from a stopped or unreachable daemon: the request WAS delivered and
 * the outcome is unknown, so this must never render as daemon-not-running.
 */
export class DaemonResponseError extends Error {
  readonly status: number;
  readonly bodySnippet: string;
  constructor(status: number, body: string) {
    super(`The daemon returned an unreadable response (HTTP ${status}).`);
    this.name = "DaemonResponseError";
    this.status = status;
    this.bodySnippet = body.slice(0, 200);
  }
}

export interface DaemonResponse<T = unknown> {
  status: number;
  data: T;
}

interface DaemonRequestOptions {
  timeoutMs?: number;
  /** Per-call header overrides (e.g., `Authorization: Bearer ...`). */
  headers?: Record<string, string>;
}

interface DaemonClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Routing state published by daemon start, not a health check or sibling-home discovery. */
function localDaemonUrl(): string | undefined {
  try {
    // Resolve at construction time: embedders may change OPENRIG_HOME after import.
    const state = JSON.parse(fs.readFileSync(path.join(getOpenRigHome(), "daemon.json"), "utf-8"));
    if (!state || !Number.isSafeInteger(state.pid) || state.pid <= 0
      || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535
      || (state.host !== undefined && (typeof state.host !== "string" || !state.host.trim()))) return undefined;
    // A stale PID must not redirect reads or writes to another configured daemon.
    // Keep the recorded endpoint; the request decides reachability, even after exit.
    return `http://${state.host ?? "127.0.0.1"}:${state.port}`;
  } catch {
    return undefined;
  }
}

export class DaemonClient {
  readonly baseUrl: string;
  private fetchImpl: typeof fetch = fetch;
  private timeoutMs = 5_000;
  /** Set by remoteDaemonClient; absent origin is labelled explicitly on remote requests. */
  originSelfHostId?: string;
  remoteTarget = false;
  private identity?: Promise<Record<string, string>>;
  private originUnknown = false;

  private async identityHeaders(): Promise<Record<string, string>> {
    const localHeaders = senderIdentityHeaders();
    const session = localHeaders[SENDER_IDENTITY_HEADER];
    if (!session || session.split("@").length >= 3) return localHeaders;
    const directTarget = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL");
    if (!this.remoteTarget && !directTarget) return localHeaders;
    const origin = this.originSelfHostId ?? readLocalOrigin();
    if (!origin) {
      this.originUnknown = true;
      return { ...localHeaders, "X-OpenRig-Origin-Unknown": "true" };
    }
    if (!this.remoteTarget) {
      // Loopback may be a forwarded endpoint. Only matching instance identity proves locality.
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const target = await Promise.race([
          (async () => {
            const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/healthz`, { signal: controller.signal });
            return res.ok ? (await res.json() as { selfHostId?: unknown }).selfHostId : undefined;
          })(),
          new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), Math.min(this.timeoutMs, 1000)); }),
        ]);
        if (target === origin) return localHeaders;
      } catch { /* Unproved locality: carry the known origin, never the endpoint's identity. */ }
      finally { clearTimeout(timer); controller.abort(); }
    }
    return senderIdentityHeaders(origin);
  }

  constructor(baseUrl?: string, options?: DaemonClientOptions) {
    if (baseUrl) {
      this.baseUrl = baseUrl;
    } else {
      const envUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL");
      if (envUrl) {
        this.baseUrl = envUrl;
      } else {
        // --port/--host can differ from configured startup defaults. Match the
        // lifecycle-aware commands by preferring this home's recorded endpoint.
        const localUrl = localDaemonUrl();
        if (localUrl) {
          this.baseUrl = localUrl;
        } else {
          const config = new ConfigStore().resolve(); // env > file > defaults
          this.baseUrl = `http://${config.daemon.host}:${config.daemon.port}`;
        }
      }
    }

    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.timeoutMs = options?.timeoutMs ?? 5_000;
  }

  async get<T = unknown>(path: string, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    return this.requestJson<T>(path, { method: "GET" }, options);
  }

  async getText(path: string, options?: DaemonRequestOptions): Promise<DaemonResponse<string>> {
    return this.requestText(path, { method: "GET" }, options);
  }

  async post<T = unknown>(path: string, body?: unknown, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    return this.requestJson<T>(path, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, options);
  }

  async postText<T = unknown>(path: string, text: string, contentType = "text/yaml", extraHeaders?: Record<string, string>, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    return this.requestJson<T>(path, {
      method: "POST",
      headers: { "Content-Type": contentType, ...extraHeaders },
      body: text,
    }, options);
  }

  async postExpectText(path: string, body?: unknown, options?: DaemonRequestOptions): Promise<DaemonResponse<string>> {
    return this.requestText(path, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, options);
  }

  async delete<T = unknown>(path: string, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    return this.requestJson<T>(path, {
      method: "DELETE",
      headers: options?.headers,
    }, options);
  }

  async put<T = unknown>(path: string, body?: unknown, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    const baseHeaders: Record<string, string> = body !== undefined ? { "Content-Type": "application/json" } : {};
    const headers = { ...baseHeaders, ...(options?.headers ?? {}) };
    return this.requestJson<T>(path, {
      method: "PUT",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, options);
  }

  private async fetch(path: string, init: RequestInit, options?: DaemonRequestOptions, consumeResponse?: (response: Response) => Promise<void>): Promise<Response> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    if (options?.headers) {
      init = { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), ...options.headers } };
    }
    // P18 sender-provenance: stamp the seat-derived identity header LAST, so the transport — never a
    // caller-supplied header or a request body — decides the caller identity the channel of record records.
    // Known remote or unproved direct endpoints carry origin; proven local requests remain bare.
    this.identity ??= this.identityHeaders();
    init = { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), ...await this.identity } };
    let responseStatus: number | undefined;
    try {
      const response = await fetchWithTimeout(
        this.fetchImpl,
        `${this.baseUrl}${path}`,
        init,
        {
          timeoutMs,
          consumeResponse: consumeResponse ? async (response) => {
            responseStatus = response.status;
            await consumeResponse(response);
          } : undefined,
          timeoutMessage: `Request to ${this.baseUrl}${path} timed out after ${timeoutMs}ms`,
        },
      );
      if (response.ok && this.originUnknown) {
        console.error("Origin instance unknown: local durable identity is unavailable; delivery continues with origin-unknown provenance.");
        this.originUnknown = false;
      }
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Slow-response (a timed-out request) is a DISTINCT class from no-connect:
      // the daemon may be up but saturated. Surface it as a subclass so callers
      // still catch DaemonConnectionError, but the CLI can say "slow, not stopped".
      if (err instanceof FetchTimeoutError) {
        throw new DaemonTimeoutError(`The OpenRig daemon at ${this.baseUrl} did not respond in time: ${msg}`);
      }
      // Headers prove that the daemon received the request, but not that a write
      // finished. A dropped body must preserve unknown-outcome guidance.
      if (responseStatus !== undefined) throw new DaemonResponseError(responseStatus, "");
      throw new DaemonConnectionError(`Cannot connect to the OpenRig daemon at ${this.baseUrl}: ${msg}`);
    }
  }

  private async requestJson<T>(path: string, init: RequestInit, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    let text = "";
    const res = await this.fetch(path, init, options, async (response) => { text = await response.text(); });
    // Read the raw body once, THEN parse — so a truncated / unparseable response
    // (a real symptom under daemon saturation) surfaces as a typed
    // DaemonResponseError carrying the status + a bounded snippet, instead of a
    // raw SyntaxError bubbling to a cryptic (json) or silent (human) CLI exit.
    // A well-formed non-2xx body still parses and returns {status,data}; 204 has none.
    if (res.status === 204) return { status: res.status, data: undefined as T };
    try {
      return { status: res.status, data: JSON.parse(text) as T };
    } catch {
      throw new DaemonResponseError(res.status, text);
    }
  }

  private async requestText(path: string, init: RequestInit, options?: DaemonRequestOptions): Promise<DaemonResponse<string>> {
    let data = "";
    const res = await this.fetch(path, init, options, async (response) => { data = await response.text(); });
    return { status: res.status, data };
  }
}
