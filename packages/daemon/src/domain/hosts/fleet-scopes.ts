// #3093 first increment — the FLEET PROJECTS READ-VIEW (read-only).
//
// The local daemon fans out server-side to each registered host's shipped
// GET /api/scopes?counts=1 (the cheap Projects-list form of the existing
// scopes read model) over the registered HTTP+bearer transport, and returns
// ONE host-attributed payload. The local leg invokes the SAME counts
// projection the local route serves (injected at the route wiring). The
// existing local /api/scopes routes are untouched; writes never fan out.
//
// Composite identity is the law here (the maintainer's binding constraint):
// every mission row and every slice row carries its origin `hostId`, its
// `hostLabel` (the registry label the operator configured) and its `project`
// context beside the NATIVE ids, and consumers key rows on
// (hostId, mission, slice) — identical native ids on two hosts are two rows
// and must never collapse.
//
// Honesty (mirrors the P4 fanout contract's posture, without extending the
// cross-PRD AggregatedPayload contract): every registered HTTP host appears
// in `hosts` on EVERY call with an explicit status — ok, stale,
// unreachable, auth-failed, unsupported (the remote daemon predates the
// scopes read), or unsupported-transport (an SSH-declared entry) — plus the
// observation time of THIS call and the last time a read from that host
// SUCCEEDED. A failed read serves that host's last-known missions marked
// stale (never a fresh-looking empty list); a slow read is bounded by the
// per-host deadline and never stalls the local rows.
//
// This is NOT a revision/cursor platform: no snapshot consistency across
// hosts, no execution federation — each host's rows are that host's own
// answer, observed at its own time.

import { getSelfHostId, LOCAL_HOST_ID, resolvesToLocalHost } from "./fanout-contract.js";
import type { HostRegistryLoadResult } from "./hosts-registry-reader.js";
import { resolveHost } from "./hosts-registry-reader.js";
import { remoteJsonRequest } from "./remote-daemon-http.js";

/** The fleet read deadline class: per host (same 5s class as the read-through
 *  and the attention aggregator — a poll, not a bootstrap). */
export const FLEET_SCOPES_HOST_TIMEOUT_MS = 5_000;
/** The whole-view deadline: a fleet read never takes longer than this, however
 *  many hosts are registered. Legs still running past it report honestly. */
export const FLEET_SCOPES_VIEW_DEADLINE_MS = 10_000;
/** Fixed fan-out cap (same posture as the attention aggregator). */
export const FLEET_SCOPES_CONCURRENCY = 4;

export type FleetScopesStatusKind =
  | "ok"
  | "stale"
  | "unreachable"
  | "auth-failed"
  | "unsupported"
  | "unavailable"
  | "unsupported-transport";

export interface FleetScopesHostStatus {
  hostId: string;
  status: FleetScopesStatusKind;
  /** When THIS call's observation of the host completed (every status, including failures). */
  observedAt: string;
  /** When a read from this host last succeeded — null when it never has. Honest staleness basis. */
  lastSuccessAt: string | null;
  /** Honest failure detail for non-ok statuses. */
  error?: string;
}

/** One slice row as its ORIGIN host served it (native fields untouched), plus the
 *  host attribution and project context that make its identity composite. */
export interface FleetScopesSlice {
  hostId: string;
  hostLabel: string;
  project: string | null;
  mission: string;
  dirName: string;
  id: string | null;
  displayName: string;
  status: string | null;
  stage: string | null;
  locks: { spec: { by: string; at: string } | null; delivery: { by: string; at: string } | null };
  error?: string;
  sourcePath?: string;
}

export interface FleetScopesMission {
  hostId: string;
  hostLabel: string;
  project: string | null;
  mission: string;
  error?: string;
  slices: FleetScopesSlice[];
}

export interface FleetScopesPayload {
  missions: FleetScopesMission[];
  hosts: FleetScopesHostStatus[];
  /** Registry entries not read because they name this daemon (read once, as local). */
  skipped: Array<{ hostId: string; reason: string }>;
  /** `read` or why the registry could not be read (then no remote legs ran). */
  registry: { state: "read" } | { state: "unreadable"; error: string };
  observedAt: string;
}

/** The local leg's shape (the counts projection the local route serves).
 *  `error` marks the whole local leg failed (no root configured, or the
 *  directory read itself failed): the local host is then reported with its
 *  own failure state and NO missions — never as a healthy empty host. */
export interface LocalScopesCounts {
  project: string | null;
  missions: Array<{ mission: string; error?: string; slices: Array<Record<string, unknown>> }>;
  error?: string;
}

export interface FleetScopesDeps {
  /** The SAME counts projection the local GET /api/scopes?counts=1 serves. */
  listLocalScopes: () => LocalScopesCounts;
  /** S11's shared registry reader — injected at the route wiring. */
  loadRegistry: () => HostRegistryLoadResult;
  selfHostId?: string | null;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
  /** Test overrides; production uses the constants above. */
  timeoutMs?: number;
  viewDeadlineMs?: number;
  concurrency?: number;
  now?: () => string;
  /** Last-known-good store. Production shares the module singleton; tests inject their own. */
  cache?: Map<string, { at: string; missions: FleetScopesMission[]; project: string | null }>;
}

/** The production last-known-good store: hostId → the missions that host last
 *  served successfully, and when. Memory-only (a restart starts fresh — that
 *  is honest: no data, not stale data). */
const fleetScopesCache = new Map<string, { at: string; missions: FleetScopesMission[]; project: string | null }>();

interface HostOutcome {
  status: FleetScopesHostStatus;
  missions: FleetScopesMission[];
}

function stampRows(hostId: string, hostLabel: string, project: string | null, local: LocalScopesCounts["missions"][number]): FleetScopesMission {
  return {
    hostId,
    hostLabel,
    project,
    mission: local.mission,
    ...(local.error ? { error: local.error } : {}),
    slices: (local.slices ?? []).map((s) => {
      const slice = { ...s, hostId, hostLabel, project, mission: local.mission } as FleetScopesSlice;
      return slice;
    }),
  };
}

/** Best-effort shape check of a remote counts payload: an object whose
 *  `missions` is an array of objects with a string `mission` and an array
 *  `slices`. Anything else is the remote's own 200-with-garbage — surfaced as
 *  unreachable with the reason, never half-parsed rows. */
function remoteCounts(payload: unknown): { ok: true; missions: LocalScopesCounts["missions"] } | { ok: false; reason: string } {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "response is not an object" };
  const missions = (payload as Record<string, unknown>)["missions"];
  if (!Array.isArray(missions)) return { ok: false, reason: "response carries no missions array" };
  for (const m of missions) {
    if (m === null || typeof m !== "object" || Array.isArray(m)) return { ok: false, reason: "a mission row is not an object" };
    const row = m as Record<string, unknown>;
    if (typeof row["mission"] !== "string") return { ok: false, reason: "a mission row carries no mission name" };
    if (row["slices"] !== undefined && !Array.isArray(row["slices"])) return { ok: false, reason: `mission ${row["mission"]} carries a non-array slices list` };
    for (const s of (row["slices"] as unknown[] | undefined) ?? []) {
      if (s === null || typeof s !== "object" || Array.isArray(s)) return { ok: false, reason: `mission ${row["mission"]} carries a slice row that is not an object` };
      const slice = s as Record<string, unknown>;
      if (typeof slice["dirName"] !== "string") return { ok: false, reason: `mission ${row["mission"]} carries a slice row with no dirName` };
      if (typeof slice["displayName"] !== "string") return { ok: false, reason: `slice ${slice["dirName"]} carries no displayName` };
      if (!slice["locks"] || typeof slice["locks"] !== "object" || Array.isArray(slice["locks"])) return { ok: false, reason: `slice ${slice["dirName"]} carries no locks object` };
    }
  }
  return { ok: true, missions: missions as LocalScopesCounts["missions"] };
}

async function readHostScopes(
  hostId: string,
  label: string,
  reg: HostRegistryLoadResult,
  deps: FleetScopesDeps,
  budgetMs: number,
  nowFn: () => string,
): Promise<HostOutcome> {
  const cache = deps.cache ?? fleetScopesCache;
  // Cached rows are re-stamped with the CURRENT host id and label on the way
  // out: the view groups by host id, so rows stamped with an old registry id
  // would vanish after a rename instead of reading stale under the new id.
  const fromCache = (key: string, status: FleetScopesStatusKind, error: string): HostOutcome => {
    const at = nowFn();
    const cached = cache.get(key);
    if (cached) return {
      status: { hostId, status: "stale", observedAt: at, lastSuccessAt: cached.at, error },
      missions: cached.missions.map((m) => ({
        ...m, hostId, hostLabel: label,
        slices: m.slices.map((sl) => ({ ...sl, hostId, hostLabel: label })),
      })),
    };
    return { status: { hostId, status, observedAt: at, lastSuccessAt: null, error }, missions: [] };
  };
  if (!reg.ok) return fromCache(hostId, "unreachable", reg.error);
  const resolved = resolveHost(reg.registry, hostId);
  if (!resolved.ok) return fromCache(hostId, "unreachable", resolved.error);
  // Key the last-known-good store by the resolved address, not the registry
  // alias: an alias repointed elsewhere must not serve the old host's rows.
  const cacheKey = resolved.host.transport === "http" && resolved.host.url ? resolved.host.url : hostId;
  if (resolved.host.transport !== "http") {
    return fromCache(
      hostId,
      "unsupported-transport",
      `host '${hostId}' is SSH-declared; the fleet Projects read requires an http-transport registry entry (url; bearer optional)`,
    );
  }
  const res = await remoteJsonRequest(resolved.host, "/api/scopes?counts=1", {
    method: "GET",
    timeoutMs: Math.min(deps.timeoutMs ?? FLEET_SCOPES_HOST_TIMEOUT_MS, budgetMs),
    fetchImpl: deps.fetchImpl,
    env: deps.env,
    readFile: deps.readFile,
  });
  if (res.ok) {
    const counts = remoteCounts(res.payload);
    if (!counts.ok) return fromCache(cacheKey, "unreachable", `remote scopes read answered HTTP ${res.status} but ${counts.reason}`);
    // The counts read carries the selected project (null when the host serves its
    // default workspace); the row's project context is that id, never invented.
    const rawProject = (res.payload as Record<string, unknown>)["project"];
    const project = rawProject && typeof rawProject === "object" && typeof (rawProject as Record<string, unknown>)["id"] === "string"
      ? ((rawProject as Record<string, unknown>)["id"] as string)
      : null;
    const missions = counts.missions.map((m) => stampRows(hostId, label, project, m));
    const done = nowFn();
    cache.set(cacheKey, { at: done, missions, project });
    return { status: { hostId, status: "ok", observedAt: done, lastSuccessAt: done }, missions };
  }
  switch (res.kind) {
    case "bearer":
      return fromCache(cacheKey, "auth-failed", res.detail);
    case "http":
      if (res.status === 401 || res.status === 403) return fromCache(cacheKey, "auth-failed", `HTTP ${res.status}${res.detail ? `: ${res.detail}` : ""}`);
      if (res.status === 404) return fromCache(cacheKey, "unsupported", `HTTP 404: the remote daemon does not serve the scopes read model`);
      return fromCache(cacheKey, "unreachable", `HTTP ${res.status}${res.detail ? `: ${res.detail}` : ""}`);
    case "timeout":
      return fromCache(
        cacheKey,
        "unreachable",
        res.phase === "body"
          ? `read timed out: response headers arrived (HTTP ${res.status}) but the body never completed`
          : `read timed out after ${Math.min(deps.timeoutMs ?? FLEET_SCOPES_HOST_TIMEOUT_MS, budgetMs)}ms`,
      );
    case "network":
      return fromCache(cacheKey, "unreachable", res.detail);
  }
}

/** One merged fleet Projects payload: local ALWAYS included (stamped with the
 *  daemon's self id, or the `local` positional sentinel before boot resolves
 *  it), every registered host reported on every call. */
export async function aggregateFleetScopes(deps: FleetScopesDeps): Promise<FleetScopesPayload> {
  const now = deps.now ?? (() => new Date().toISOString());
  const selfId = deps.selfHostId ?? getSelfHostId() ?? LOCAL_HOST_ID;
  const observedAt = now();

  const local = deps.listLocalScopes();
  // The local host is one leg with its own failure state: a failed local read
  // never hides the remote hosts, and never reads as a healthy empty host.
  const hosts: FleetScopesHostStatus[] = [local.error
    ? { hostId: selfId, status: "unavailable", observedAt, lastSuccessAt: null, error: local.error }
    : { hostId: selfId, status: "ok", observedAt, lastSuccessAt: observedAt }];
  const missions: FleetScopesMission[] = local.error ? [] : local.missions.map((m) => stampRows(selfId, selfId, local.project, m));
  const skipped: FleetScopesPayload["skipped"] = [];

  const reg = deps.loadRegistry();
  if (!reg.ok) {
    // Registry unreadable: no remote legs ran; the local rows are complete and
    // the payload says why nothing else is shown.
    return { missions, hosts, skipped, registry: { state: "unreadable", error: reg.error }, observedAt };
  }

  const entries = reg.registry.hosts.filter((h) => {
    // Entries that name this daemon are read once, as the local rows above.
    const namesSelf = h.hostId !== undefined && h.hostId === selfId;
    if (namesSelf || resolvesToLocalHost(h.id, selfId)) {
      skipped.push({ hostId: h.id, reason: "this entry names this daemon, which is read once as local" });
      return false;
    }
    return true;
  });

  const deadline = Date.now() + (deps.viewDeadlineMs ?? FLEET_SCOPES_VIEW_DEADLINE_MS);
  const cap = deps.concurrency ?? FLEET_SCOPES_CONCURRENCY;
  let cursor = 0;
  const outcomes: Array<{ hostId: string; label: string; outcome: HostOutcome | null }> = entries.map((h) => ({ hostId: h.id, label: h.id, outcome: null }));

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= entries.length) return;
      const entry = entries[i]!;
      const remaining = deadline - Date.now();
      // A leg that cannot start inside the view deadline reports honestly
      // instead of stretching the read — stale when last-known rows exist.
      if (remaining <= 0) {
        // Same resolved-address key as the main path, so a warm entry under a
        // repointed alias is found; its rows re-stamp with the current id.
        const resolved0 = resolveHost(reg.registry, entry.id);
        const key0 = resolved0.ok && resolved0.host.transport === "http" && resolved0.host.url ? resolved0.host.url : entry.id;
        const cached = (deps.cache ?? fleetScopesCache).get(key0);
        outcomes[i]!.outcome = cached
          ? { status: { hostId: entry.id, status: "stale", observedAt: now(), lastSuccessAt: cached.at, error: "fleet view deadline exceeded before this host was read" },
              missions: cached.missions.map((m) => ({ ...m, hostId: entry.id, hostLabel: entry.id, slices: m.slices.map((sl) => ({ ...sl, hostId: entry.id, hostLabel: entry.id })) })) }
          : { status: { hostId: entry.id, status: "unreachable", observedAt: now(), lastSuccessAt: null, error: "fleet view deadline exceeded before this host was read" }, missions: [] };
        continue;
      }
      // Each request is bounded by the time REMAINING in the view, so a late
      // host cannot stretch the read past the deadline by a full timeout.
      outcomes[i]!.outcome = await readHostScopes(entry.id, entry.id, reg, deps, remaining, now);
    }
  };
  await Promise.all(Array.from({ length: Math.min(cap, entries.length) }, () => worker()));

  for (const o of outcomes) {
    if (!o.outcome) continue;
    hosts.push(o.outcome.status);
    missions.push(...o.outcome.missions);
  }
  return { missions, hosts, skipped, registry: { state: "read" }, observedAt };
}

/** Test seam: forget the last-known-good rows (tests start clean). */
export function resetFleetScopesCacheForTests(): void {
  fleetScopesCache.clear();
}
