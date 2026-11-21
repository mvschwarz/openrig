// OPR.0.4.4.11 — the daemon-side remote single-rig leaf (FR-4).
//
// A host-placed topology entry launches by POSTing the SHIPPED remote-up
// surface: POST {host.url}/api/up with the same body shape the CLI's
// --host path sends. Since OPR.0.4.4.15 this is a THIN CONSUMER of the
// shared daemon→daemon transport core (domain/hosts/remote-daemon-http.ts
// — arch cell 1: ONE copy of the security-adjacent bearer/bounded-abort/
// classification code for the whole P3/P4 family). This module keeps its
// shipped error-string surface byte-for-byte; only the transport plumbing
// moved. The failure classes remain the EXISTING ones ([permission-gate] /
// [remote-command-failed] / [remote-daemon-unreachable]) — no new taxonomy
// (FR-4 negative AC).

import type { HttpHostEntry } from "../hosts/hosts-registry-reader.js";
import { remoteJsonRequest } from "../hosts/remote-daemon-http.js";

export interface RemoteUpLeafDeps {
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
  /** Bounded remote-up deadline (rev1-r2 R2-B1). Defaults to the
   *  long-running rig-up budget — remote bootstrap legitimately runs
   *  minutes, but never forever. Passed EXPLICITLY to the shared core
   *  (the deadline class is this call-site's decision, per the arch
   *  required-argument sharpening). */
  timeoutMs?: number;
}

/** Matches the CLI's LONG_RUNNING_UP_TIMEOUT_MS for standalone remote ups. */
export const REMOTE_UP_TIMEOUT_MS = 120_000;

function bootstrapFailureDetails(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const reasons = new Set<string>();
  const seats: string[] = [];
  if ("stages" in payload && Array.isArray(payload.stages)) {
    for (const stage of payload.stages) {
      if (!stage || typeof stage !== "object" || !("detail" in stage)) continue;
      const detail = stage.detail;
      if (!detail || typeof detail !== "object" || !("nodes" in detail) || !Array.isArray(detail.nodes)) continue;
      for (const node of detail.nodes) {
        if (!node || typeof node !== "object" || node.status !== "failed" || typeof node.logicalId !== "string" || typeof node.error !== "string") continue;
        seats.push(`${node.logicalId}: ${node.error}`);
        reasons.add(node.error);
      }
    }
  }
  const errors = "errors" in payload && Array.isArray(payload.errors)
    ? payload.errors.filter((error): error is string => typeof error === "string" && !reasons.has(error))
    : [];
  return [...seats, ...errors].join("; ");
}

export interface RemoteUpBody {
  sourceRef: string;
  autoApprove?: boolean;
  nonInterruptive?: boolean;
}

/** POST the placed entry to the remote daemon's shipped /api/up. Returns the
 *  launcher's normalized {ok, error?} shape; the remote daemon's own error
 *  text rides through verbatim where available. Never hangs: the shared
 *  core holds ONE deadline through request AND body parse (the G-R2B1-1
 *  class is structurally closed there). */
export async function remoteUpLeaf(
  body: RemoteUpBody,
  host: HttpHostEntry,
  deps: RemoteUpLeafDeps = {},
): Promise<{ ok: boolean; error?: string }> {
  const timeoutMs = deps.timeoutMs ?? REMOTE_UP_TIMEOUT_MS;
  const url = `${host.url.replace(/\/$/, "")}/api/up`;
  const res = await remoteJsonRequest(host, "/api/up", {
    method: "POST",
    body,
    timeoutMs,
    fetchImpl: deps.fetchImpl,
    env: deps.env,
    readFile: deps.readFile,
  });
  if (res.ok) {
    // A 2xx is not a full success: /api/up answers 200 with the bootstrap
    // outcome in the body (completed | partial | failed | …). A partial or
    // failed bootstrap — one seat failed to launch — must report a failed
    // entry with the failed-seat reason, so a sequential topology cannot
    // claim all rigs launched; the walk's per-entry reporting keeps the
    // surviving siblings running.
    const payload = (res.payload ?? {}) as { status?: unknown; errors?: unknown };
    const status = typeof payload.status === "string" ? payload.status : "completed";
    if (status === "partial" || status === "failed") {
      const errors = bootstrapFailureDetails(res.payload);
      return { ok: false, error: `[remote-command-failed] remote up on host ${host.id} answered HTTP ${res.status} with status ${status}${errors ? `: ${errors}` : ""}` };
    }
    return { ok: true };
  }

  switch (res.kind) {
    case "bearer":
      return { ok: false, error: `[permission-gate] ${res.detail}` };
    case "timeout":
      // R2-B1 / G-R2B1-1: a stalled remote /api/up — before OR after
      // headers — is a STRUCTURED per-entry failure, never a hung walk.
      return res.phase === "body"
        ? {
            ok: false,
            error: `[remote-daemon-unreachable] POST ${url} timed out after ${timeoutMs}ms for host ${host.id}: response headers arrived (HTTP ${res.status}) but the error body never completed`,
          }
        : {
            ok: false,
            error: `[remote-daemon-unreachable] POST ${url} timed out after ${timeoutMs}ms for host ${host.id}: the remote daemon never settled the request within the rig-up budget`,
          };
    case "network":
      return { ok: false, error: `[remote-daemon-unreachable] POST ${url} failed for host ${host.id}: ${res.detail}` };
    case "http": {
      // Same classification vocabulary as the CLI transport (classifyHttpFailedStep).
      const status = res.status ?? 0;
      const cls = status === 401 || status === 403 ? "permission-gate" : status >= 400 && status < 600 ? "remote-command-failed" : "remote-daemon-unreachable";
      const errors = [res.detail, bootstrapFailureDetails(res.payload)].filter(Boolean).join("; ");
      const detail = errors ? `HTTP ${res.status}: ${errors}` : `HTTP ${res.status}`;
      return { ok: false, error: `[${cls}] remote up on host ${host.id} failed: ${detail}` };
    }
  }
}
