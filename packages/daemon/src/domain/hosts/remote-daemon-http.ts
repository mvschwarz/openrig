// OPR.0.4.4.15 — the SHARED daemon→daemon HTTP core (arch cell 1, RATIFIED).
//
// Extracted from topology/remote-up-leaf.ts so the P4 aggregation fan-out
// does not mint a second copy of security-adjacent transport code (bearer
// resolution + bounded-abort discipline + status classification). The
// up-leaf is now a thin consumer that FORMATS this module's structured
// result into its shipped error strings (its tests byte-preserved).
//
// DEADLINE IS A REQUIRED ARGUMENT (arch sharpening, no module default):
// the up-leaf passes its 120s long-running rig-up budget at ITS call-site;
// the attention aggregator passes its 5s read-class deadline at ITS
// call-site. A buried default would invite the next consumer to silently
// inherit the wrong class.
//
// The G-R2B1-1 discipline is structural here: ONE deadline armed through
// the WHOLE exchange — request AND body parse (2xx or error body). A host
// that sends headers and never finishes the body yields a structured
// timeout, never a hung caller. The body race is explicit against the
// signal (a hand-built/proxied Response is not necessarily wired to the
// controller — no trust in fetch internals).

import { readFileSync } from "node:fs";
import type { HttpHostEntry } from "./hosts-registry-reader.js";

export interface RemoteJsonDeps {
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
}

export interface RemoteJsonOptions extends RemoteJsonDeps {
  method: "GET" | "POST";
  body?: unknown;
  /** REQUIRED — the caller names its deadline class explicitly. */
  timeoutMs: number;
}

export type RemoteJsonFailureKind = "bearer" | "timeout" | "network" | "http";

export interface RemoteJsonFailure {
  ok: false;
  kind: RemoteJsonFailureKind;
  /** For kind=timeout: whether the deadline fired before headers
   *  ("request") or while reading the body ("body"). */
  phase?: "request" | "body";
  /** HTTP status when headers arrived (kind=http, or kind=timeout/phase=body). */
  status?: number;
  /** Bearer message / network error message / remote error text (may be ""). */
  detail: string;
}

export type RemoteJsonResult = { ok: true; status: number; payload: unknown } | RemoteJsonFailure;

export interface RemoteRawOptions extends RemoteJsonDeps {
  /** REQUIRED — the caller names its deadline class explicitly. */
  timeoutMs: number;
}

// OPR.0.4.6.MH2 FR-2/FR-7 — the read-through's transport leg. Verbatim
// passthrough means STATUS + CONTENT-TYPE + BODY (arch P3): the origin's own
// 404/500 IS the answer, so unlike remoteJsonRequest this variant returns the
// full body TEXT for EVERY origin status and never collapses error bodies to
// a detail string. Failure kinds stay transport-only (bearer/timeout/network)
// — an origin that ANSWERED is always ok:true here. Text-only by design: the
// v1 read allowlist carries JSON endpoints; binary surfaces (proof-asset)
// are deliberately not allowlisted.
export type RemoteRawResult =
  | { ok: true; status: number; contentType: string; bodyText: string }
  | { ok: false; kind: Exclude<RemoteJsonFailureKind, "http">; phase?: "request" | "body"; status?: number; detail: string };

/** Mirrors the CLI's resolveRemoteBearer (host-registry.ts): exactly-one of
 *  bearer_env / bearer_file, resolved at call time. */
function resolveBearer(host: HttpHostEntry, deps: RemoteJsonDeps): { ok: true; token: string } | { ok: false; detail: string } {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  if (host.bearer_env) {
    const token = env[host.bearer_env]?.trim();
    if (token) return { ok: true, token };
    return { ok: false, detail: `bearer env var ${host.bearer_env} is not set or empty for host ${host.id}` };
  }
  if (host.bearer_file) {
    try {
      const token = readFile(host.bearer_file).trim();
      if (token) return { ok: true, token };
      return { ok: false, detail: `bearer file ${host.bearer_file} is empty for host ${host.id}` };
    } catch {
      return { ok: false, detail: `bearer file ${host.bearer_file} not readable for host ${host.id}` };
    }
  }
  return { ok: false, detail: `host ${host.id} has no bearer_env or bearer_file configured` };
}

/** One bounded daemon→daemon JSON exchange. The single deadline covers
 *  request + body; every outcome is structured — this function never hangs
 *  and never throws. */
export async function remoteJsonRequest(host: HttpHostEntry, path: string, opts: RemoteJsonOptions): Promise<RemoteJsonResult> {
  const bearer = resolveBearer(host, opts);
  if (!bearer.ok) return { ok: false, kind: "bearer", detail: bearer.detail };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${host.url.replace(/\/$/, "")}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: opts.method,
      headers: {
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${bearer.token}`,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) return { ok: false, kind: "timeout", phase: "request", detail: "" };
    return { ok: false, kind: "network", detail: (err as Error).message };
  }

  // Body parse under the SAME still-armed deadline, raced explicitly.
  const abortRace = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(new Error("body read aborted"));
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });

  let payload: unknown;
  let bodyTimedOut = false;
  try {
    payload = await Promise.race([res.json(), abortRace]);
  } catch {
    if (controller.signal.aborted) bodyTimedOut = true;
    // else: non-JSON body — payload stays undefined; status is the honest detail
  } finally {
    clearTimeout(timer);
  }

  if (bodyTimedOut) return { ok: false, kind: "timeout", phase: "body", status: res.status, detail: "" };
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, payload };

  const remoteError = payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
    ? (payload as { error: string }).error
    : "";
  return { ok: false, kind: "http", status: res.status, detail: remoteError };
}

/** One bounded daemon→daemon GET, body passed through as text for ANY origin
 *  status (arch P3 verbatim rule). Same bearer resolution + single-deadline +
 *  explicit body race discipline as remoteJsonRequest; never hangs, never
 *  throws. */
export async function remoteRawRequest(host: HttpHostEntry, path: string, opts: RemoteRawOptions): Promise<RemoteRawResult> {
  const bearer = resolveBearer(host, opts);
  if (!bearer.ok) return { ok: false, kind: "bearer", detail: bearer.detail };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${host.url.replace(/\/$/, "")}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${bearer.token}` },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) return { ok: false, kind: "timeout", phase: "request", detail: "" };
    return { ok: false, kind: "network", detail: (err as Error).message };
  }

  const abortRace = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(new Error("body read aborted"));
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });

  let bodyText = "";
  let bodyTimedOut = false;
  try {
    bodyText = await Promise.race([res.text(), abortRace]);
  } catch {
    if (controller.signal.aborted) bodyTimedOut = true;
  } finally {
    clearTimeout(timer);
  }

  if (bodyTimedOut) return { ok: false, kind: "timeout", phase: "body", status: res.status, detail: "" };
  return { ok: true, status: res.status, contentType: res.headers.get("content-type") ?? "application/json", bodyText };
}
