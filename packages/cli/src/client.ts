import fs from "node:fs";
import path from "node:path";
import { ConfigStore } from "./config-store.js";
import { readOpenRigEnv } from "./openrig-compat.js";
import { fetchWithTimeout, FetchTimeoutError } from "./fetch-with-timeout.js";

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
  // A4 HTTP-path origin-triple carry: on a REMOTE-targeting client, compose the origin TRIPLE
  // (member@rig@<this host's selfHostId>) at stamp time so the remote daemon's wrapPaneEnvelope
  // renders the ORIGIN host, not the destination's (its preserve branch fires on a 3-part sender).
  // The identity stays DERIVED — env session + THIS host's own selfHostId — never a caller-supplied
  // string (Rail 1 anti-forgery: `originSelfHostId` signals only THAT the client targets a remote host,
  // never WHO it is). An already-3-part origin (an upstream relay's triple) is preserved verbatim,
  // never re-stamped with this host's id (which would forge the origin). Local clients pass no
  // `originSelfHostId` and stamp the 2-part value, byte-identical to today.
  const value =
    originSelfHostId && originSelfHostId.length > 0 && session.split("@").length < 3
      ? `${session}@${originSelfHostId}`
      : session;
  return { [SENDER_IDENTITY_HEADER]: value };
}

/**
 * A4 — the SINGLE remote-origin construction point (shape b). Every remote-targeting client is built
 * HERE so the origin triple is stamped uniformly. Two structural laws the A4 grep-guard enforces:
 * (1) no remote site constructs a client by calling `clientFactory(<registry host>.url)` directly —
 * they all route through here; (2) `originSelfHostId` is ASSIGNED in exactly ONE place: this function
 * (the sole-assignment law, so pin 3 "no caller-supplied identity path" is structurally true).
 *
 * `originSelfHostId` is THIS host's own id (resolved fail-open via `fetchSelfHostId` on the LOCAL
 * daemon), NOT a caller-supplied identity — the caller only signals it targets a remote host. Preserves
 * the injected-mock `clientFactory` test seam: the client is built by the injected factory; this only
 * sets a field on it afterward (an injected mock harmlessly carries the extra property).
 */
export function remoteDaemonClient(
  clientFactory: (baseUrl: string) => DaemonClient,
  url: string,
  originSelfHostId?: string,
): DaemonClient {
  const client = clientFactory(url);
  client.originSelfHostId = originSelfHostId;
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
 * Bad-response: the daemon replied, but the body could not be read as JSON
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

export class DaemonClient {
  readonly baseUrl: string;
  private fetchImpl: typeof fetch = fetch;
  private timeoutMs = 5_000;
  /**
   * A4 HTTP-path origin-triple carry: THIS host's `selfHostId`, set ONLY when this client targets a
   * REMOTE host, so `senderIdentityHeaders` stamps the origin TRIPLE (member@rig@selfHostId) instead of
   * the 2-part local value. Undefined for local clients (2-part stamp, unchanged). Assigned in EXACTLY
   * ONE place — `remoteDaemonClient` — enforced by the A4 grep-guard (the sole-assignment law); this is
   * NOT a caller identity string (Rail 1: it is THIS host's derived id, never who the caller claims to
   * be). Public (not ctor-injected) to keep the injected-mock `clientFactory` test seam untouched.
   */
  originSelfHostId?: string;

  constructor(baseUrl?: string, options?: DaemonClientOptions) {
    if (baseUrl) {
      this.baseUrl = baseUrl;
    } else {
      const envUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL");
      if (envUrl) {
        this.baseUrl = envUrl;
      } else {
        // Resolve from config (env > file > defaults)
        const config = new ConfigStore().resolve();
        this.baseUrl = `http://${config.daemon.host}:${config.daemon.port}`;
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

  private async fetch(path: string, init: RequestInit, options?: DaemonRequestOptions): Promise<Response> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    if (options?.headers) {
      init = { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), ...options.headers } };
    }
    // P18 sender-provenance: stamp the seat-derived identity header LAST, so the transport — never a
    // caller-supplied header or a request body — decides the caller identity the channel of record records.
    // A4: a remote-targeting client (originSelfHostId set by remoteDaemonClient) stamps the origin TRIPLE;
    // local clients stamp the 2-part value, byte-identical to today.
    init = { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), ...senderIdentityHeaders(this.originSelfHostId) } };
    try {
      return await fetchWithTimeout(
        this.fetchImpl,
        `${this.baseUrl}${path}`,
        init,
        {
          timeoutMs,
          timeoutMessage: `Request to ${this.baseUrl}${path} timed out after ${timeoutMs}ms`,
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Slow-response (a timed-out request) is a DISTINCT class from no-connect:
      // the daemon may be up but saturated. Surface it as a subclass so callers
      // still catch DaemonConnectionError, but the CLI can say "slow, not stopped".
      if (err instanceof FetchTimeoutError) {
        throw new DaemonTimeoutError(`The OpenRig daemon at ${this.baseUrl} did not respond in time: ${msg}`);
      }
      throw new DaemonConnectionError(`Cannot connect to the OpenRig daemon at ${this.baseUrl}: ${msg}`);
    }
  }

  private async requestJson<T>(path: string, init: RequestInit, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    const res = await this.fetch(path, init, options);
    // Read the raw body once, THEN parse — so a truncated / unparseable response
    // (a real symptom under daemon saturation) surfaces as a typed
    // DaemonResponseError carrying the status + a bounded snippet, instead of a
    // raw SyntaxError bubbling to a cryptic (json) or silent (human) CLI exit.
    // A well-formed non-2xx body still parses and returns {status,data}; 204 has none.
    const text = await res.text();
    if (res.status === 204) return { status: res.status, data: undefined as T };
    try {
      return { status: res.status, data: JSON.parse(text) as T };
    } catch {
      throw new DaemonResponseError(res.status, text);
    }
  }

  private async requestText(path: string, init: RequestInit, options?: DaemonRequestOptions): Promise<DaemonResponse<string>> {
    const res = await this.fetch(path, init, options);
    const data = await res.text();
    return { status: res.status, data };
  }
}
