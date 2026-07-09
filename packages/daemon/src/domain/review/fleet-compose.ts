// OPR.0.4.6.MH5 — the daemon-side FLEET composer (the ONE net-new core).
//
// Arch Q1 (ruled): each host's OWN composer is authoritative for its own
// time-derived ▲/● set — this module fans out each registered host's
// ALREADY-COMPOSED rig root (`GET /api/review/rig`, the parameterless
// host-wide altitude root) and only UNIONS + HOST-DIMENSIONS + COUNTS.
// It never recomputes exception truth (no clock, no thresholds, no random
// here — cross-host clock skew can never distort a ▲).
//
// Arch Q2/Q3 (ruled): FLEET is a SIBLING aggregate — the local composer
// files stay pure; THIS module is the ONLY review-domain place that
// imports hosts/transport (the C1 boundary, pinned mechanical by the C5
// import-audit test). One daemon-side composer; every consumer (UI now,
// TUI/CLI follow-ups) reads the same one.
//
// Arch Q4 (ruled): the one-count Set on `${hostId}|${identity}` lives HERE
// — the one place. Within-host N-altitude duplicates collapse to one fleet
// row (seenFrom records the altitudes actually read); two hosts' same-shaped
// identities stay two rows. An MH-3-forwarded qitem lives in its ORIGIN
// host's DB only (source closed on handoff), so no fleet double-count by
// construction.
//
// D-7: per-host reads run concurrently under the named read-class deadline
// (the attention-aggregator discipline) — a slow host degrades to its honest
// per-host status; the glance NEVER stalls on the slowest host. The LOCAL
// host joins via the in-process composer directly (D-1 — one fleet member
// with zero self-transport).

import type {
  AgentRow,
  ComposedFleet,
  ComposedFleetRollup,
  ComposedRigAgents,
  FleetHostRollup,
  FleetNeedsYouItem,
  FleetSettledRow,
  NeedsYouItem,
  SettledRow,
} from "./types.js";
import type { PerHostStatus } from "../hosts/fanout-contract.js";
import { LOCAL_HOST_ID } from "../hosts/fanout-contract.js";
import type { HostRegistryLoadResult } from "../hosts/hosts-registry-reader.js";
import { resolveHost } from "../hosts/hosts-registry-reader.js";
import { remoteJsonRequest } from "../hosts/remote-daemon-http.js";

/** The fleet aggregation READ deadline class (per-host bound) — same class
 *  as the shipped feed aggregation (a poll, not a bootstrap). Named here,
 *  passed explicitly at the call-site (D-7). */
export const FLEET_READ_TIMEOUT_MS = 5_000;

/** Fixed fan-out cap — a poll across a handful of hosts (the shipped
 *  aggregator's v1 posture; adaptive throttling out of scope). */
export const FLEET_FANOUT_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// The PURE union core (exported for the C5 vectors). No clock, no random,
// no I/O — same inputs, byte-identical output, invariant to input order.
// ---------------------------------------------------------------------------

/** One altitude read of a host's composed needs-you rows. Production (D-1)
 *  supplies exactly one entry per reachable host — its rig root — so
 *  seenFrom renders `rig`; the union machinery is correct for any scoped
 *  set (the C5 3-altitude vector feeds slice+mission+rig). */
export interface ScopedNeedsYou {
  scope: string;
  items: NeedsYouItem[];
}

/** One reachable fleet member's contribution to the union. */
export interface FleetHostInput {
  hostId: string;
  kind: "local" | "remote";
  scopedNeedsYou: ScopedNeedsYou[];
  agents: AgentRow[];
  settled: SettledRow[];
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** Total order over deduped fleet rows: priority rank, then age, then the
 *  fleet key — a TOTAL tiebreak, so permuting the inputs can never change
 *  the output order (the C5 permutation-stability vector). */
function compareFleetRows(a: FleetNeedsYouItem, b: FleetNeedsYouItem): number {
  const ra = PRIORITY_RANK[a.priority ?? "normal"] ?? 2;
  const rb = PRIORITY_RANK[b.priority ?? "normal"] ?? 2;
  if (ra !== rb) return ra - rb;
  const aa = a.ageIso ?? "9999";
  const ba = b.ageIso ?? "9999";
  if (aa !== ba) return aa < ba ? -1 : 1;
  return a.fleetKey < b.fleetKey ? -1 : a.fleetKey > b.fleetKey ? 1 : 0;
}

/** The BR-1 session grammar is member@rig (the @host form never exists in
 *  session strings) — distinct rig names across a host's agent rows is a
 *  structured parse of that grammar, never prose. */
function distinctRigCount(agents: AgentRow[]): number {
  const rigs = new Set<string>();
  for (const a of agents) {
    const at = a.sessionName.lastIndexOf("@");
    if (at > 0 && at < a.sessionName.length - 1) rigs.add(a.sessionName.slice(at + 1));
  }
  return rigs.size;
}

/** The worst line for a host — spoken-aloud, derived deterministically from
 *  its own deduped rows (already in total order; row 0 is the worst). */
function hostTopLine(rows: FleetNeedsYouItem[]): string {
  if (rows.length === 0) return "quiet";
  const worst = rows[0]!;
  return worst.derived ? `▲ ${worst.derived.kind} — ${worst.summary}` : `● ${worst.summary}`;
}

/** Union + host-dimension + count (the ONLY things the fleet root does).
 *  `statuses` must carry EVERY fleet member (omission-proof); `inputs`
 *  carries only the members whose composed set was actually read. */
export function unionFleet(
  inputs: FleetHostInput[],
  statuses: PerHostStatus[],
  composedAt: string,
  registryError?: string,
): ComposedFleet {
  // The Q4 one-count Set — the one place. Key = `${hostId}|${identity}`.
  const seen = new Map<string, FleetNeedsYouItem>();
  const perHostRows = new Map<string, FleetNeedsYouItem[]>();
  for (const host of inputs) {
    for (const scoped of host.scopedNeedsYou) {
      for (const item of scoped.items) {
        const fleetKey = `${host.hostId}|${item.identity}`;
        const existing = seen.get(fleetKey);
        if (existing) {
          if (!existing.seenFrom.includes(scoped.scope)) existing.seenFrom.push(scoped.scope);
          continue;
        }
        const row: FleetNeedsYouItem = { ...item, hostId: host.hostId, fleetKey, seenFrom: [scoped.scope] };
        seen.set(fleetKey, row);
        if (!perHostRows.has(host.hostId)) perHostRows.set(host.hostId, []);
        perHostRows.get(host.hostId)!.push(row);
      }
    }
  }
  const rows = [...seen.values()].sort(compareFleetRows);
  for (const hostRows of perHostRows.values()) hostRows.sort(compareFleetRows);

  // Rollup math computed FROM the deduped rows (header-math-checkable).
  const byKind = new Map<string, number>();
  let needsYouCount = 0;
  let exceptionCount = 0;
  for (const r of rows) {
    if (r.derived) {
      exceptionCount += 1;
      byKind.set(r.derived.kind, (byKind.get(r.derived.kind) ?? 0) + 1);
    } else {
      needsYouCount += 1;
    }
  }
  const rollup: ComposedFleetRollup = {
    needsYouCount,
    exceptionCount,
    exceptionsByKind: [...byKind.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([kind, count]) => ({ kind, count })),
    hostCount: statuses.length,
    unreachableCount: statuses.filter((s) => s.status !== "ok").length,
  };

  // HOSTS band rows: statuses order (local first, then registry order);
  // counts present ONLY on read members (absent-not-zero on failures).
  const inputByHost = new Map(inputs.map((h) => [h.hostId, h]));
  const hosts: FleetHostRollup[] = statuses.map((status) => {
    const input = inputByHost.get(status.hostId);
    const base: FleetHostRollup = {
      hostId: status.hostId,
      kind: status.hostId === LOCAL_HOST_ID ? "local" : "remote",
      status,
    };
    if (!input || status.status !== "ok") return base;
    const hostRows = perHostRows.get(status.hostId) ?? [];
    const hostKinds = new Map<string, number>();
    let hostNeedsYou = 0;
    for (const r of hostRows) {
      if (r.derived) hostKinds.set(r.derived.kind, (hostKinds.get(r.derived.kind) ?? 0) + 1);
      else hostNeedsYou += 1;
    }
    return {
      ...base,
      needsYouCount: hostNeedsYou,
      exceptionsByKind: [...hostKinds.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([kind, count]) => ({ kind, count })),
      seatCount: input.agents.length,
      rigCount: distinctRigCount(input.agents),
      topLine: hostTopLine(hostRows),
    };
  });

  // SETTLED minimal (D-5), host-chipped, deterministic order (closed-at
  // desc, then qitem id — a total tiebreak).
  const settled: FleetSettledRow[] = inputs
    .flatMap((h) => h.settled.map((s) => ({ ...s, hostId: h.hostId })))
    .sort((a, b) => (a.closedAtIso !== b.closedAtIso ? (a.closedAtIso > b.closedAtIso ? -1 : 1) : a.qitemId < b.qitemId ? -1 : 1));

  const composingCount = statuses.filter((s) => s.status === "ok").length;
  return {
    rollup,
    needsYou: {
      items: rows,
      provenance: `fleet union of each host's own composed set · counted once per identity+host · ${composingCount}/${statuses.length} hosts composing${rollup.unreachableCount > 0 ? " (a failed host's items are ABSENT, not zero)" : ""}`,
    },
    hosts,
    settled,
    settledProvenance: settled.length === 0 ? `0 settled handoffs across ${composingCount} composing hosts` : `today's closed handoffs across ${composingCount} composing hosts`,
    ...(registryError !== undefined ? { registryError } : {}),
    composedAt,
  };
}

// ---------------------------------------------------------------------------
// The fan-out shell (the transport-touching part; mirrors the shipped
// attention-aggregator's per-host outcome discipline, G9).
// ---------------------------------------------------------------------------

export interface FleetComposeDeps {
  /** D-1: the LOCAL host joins in-process — zero self-transport. */
  composeLocalRig: () => ComposedRigAgents;
  /** S11's shared reader — the fleet enumerates EVERY registered host. */
  loadRegistry: () => HostRegistryLoadResult;
  /** Registry presence probe (a missing registry = a single-host operator —
   *  clean local-only fleet; an unreadable one is surfaced honestly). */
  registryExists: () => boolean;
  /** View-time fact, passed in — the composer itself is clock-free. */
  nowIso: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
  /** Test override; production uses FLEET_READ_TIMEOUT_MS. */
  timeoutMs?: number;
  concurrency?: number;
}

interface PerHostOutcome {
  status: PerHostStatus;
  input: FleetHostInput | null;
}

/** Minimal structural check on a remote's composed payload — a 200 carrying
 *  the wrong shape degrades to the honest per-host status, never a crash
 *  and never silently-empty "ok" data. */
function parseComposedRig(payload: unknown): ComposedRigAgents | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const needsYou = p["needsYou"] as Record<string, unknown> | undefined;
  const agents = p["agents"] as Record<string, unknown> | undefined;
  if (!needsYou || !Array.isArray(needsYou["items"])) return null;
  if (!agents || !Array.isArray(agents["rows"])) return null;
  if (!Array.isArray(p["settled"])) return null;
  return payload as ComposedRigAgents;
}

async function readHostComposedRig(hostId: string, reg: HostRegistryLoadResult, deps: FleetComposeDeps): Promise<PerHostOutcome> {
  if (!reg.ok) {
    return { status: { hostId, status: "unreachable", error: reg.error }, input: null };
  }
  const resolved = resolveHost(reg.registry, hostId);
  if (!resolved.ok) {
    return { status: { hostId, status: "unreachable", error: resolved.error }, input: null };
  }
  if (resolved.host.transport !== "http") {
    return {
      status: { hostId, status: "unsupported-transport", error: `host '${hostId}' is SSH-declared; the fleet composed read requires an http-transport registry entry (url + bearer)` },
      input: null,
    };
  }
  const res = await remoteJsonRequest(resolved.host, "/api/review/rig", {
    method: "GET",
    timeoutMs: deps.timeoutMs ?? FLEET_READ_TIMEOUT_MS,
    fetchImpl: deps.fetchImpl,
    env: deps.env,
    readFile: deps.readFile,
  });
  if (res.ok) {
    const composed = parseComposedRig(res.payload);
    if (!composed) {
      return { status: { hostId, status: "unreachable", error: "remote /api/review/rig returned a malformed composed payload", failedStep: "remote-command-failed" }, input: null };
    }
    return {
      status: { hostId, status: "ok" },
      input: {
        hostId,
        kind: "remote",
        scopedNeedsYou: [{ scope: "rig", items: composed.needsYou.items }],
        agents: composed.agents.rows,
        settled: composed.settled,
      },
    };
  }
  switch (res.kind) {
    case "bearer":
      return { status: { hostId, status: "auth-failed", error: res.detail, failedStep: "permission-gate" }, input: null };
    case "http":
      if (res.status === 401 || res.status === 403) {
        return { status: { hostId, status: "auth-failed", error: `HTTP ${res.status}${res.detail ? `: ${res.detail}` : ""}`, failedStep: "permission-gate" }, input: null };
      }
      return { status: { hostId, status: "unreachable", error: `HTTP ${res.status}${res.detail ? `: ${res.detail}` : ""}`, failedStep: "remote-command-failed" }, input: null };
    case "timeout":
      return {
        status: {
          hostId,
          status: "unreachable",
          error: res.phase === "body" ? `read timed out: response headers arrived (HTTP ${res.status}) but the body never completed` : `read timed out after ${deps.timeoutMs ?? FLEET_READ_TIMEOUT_MS}ms`,
          failedStep: "remote-daemon-unreachable",
        },
        input: null,
      };
    case "network":
      return { status: { hostId, status: "unreachable", error: res.detail, failedStep: "remote-daemon-unreachable" }, input: null };
  }
}

/** ONE composed fleet: local always included (in-process, D-1), every
 *  registered host fanned out concurrently under the named deadline (D-7),
 *  per-host status complete by construction, union deduped on the Q4 key. */
export async function composeFleet(deps: FleetComposeDeps): Promise<ComposedFleet> {
  const local = deps.composeLocalRig();
  const localInput: FleetHostInput = {
    hostId: LOCAL_HOST_ID,
    kind: "local",
    scopedNeedsYou: [{ scope: "rig", items: local.needsYou.items }],
    agents: local.agents.rows,
    settled: local.settled,
  };
  const statuses: PerHostStatus[] = [{ hostId: LOCAL_HOST_ID, status: "ok" }];
  const inputs: FleetHostInput[] = [localInput];

  if (!deps.registryExists()) {
    // No registry file = a single-host operator: a clean local-only fleet
    // (the C4 band renders nothing new in this state).
    return unionFleet(inputs, statuses, deps.nowIso);
  }

  const reg = deps.loadRegistry();
  if (!reg.ok) {
    // The registry EXISTS but cannot be read/parsed: there is no host list
    // to attribute per-host statuses to — surface the error honestly at the
    // payload level, never a silently-local-only fleet.
    return unionFleet(inputs, statuses, deps.nowIso, reg.error);
  }

  const hostIds = reg.registry.hosts.map((h) => h.id);
  const outcomes = new Array<PerHostOutcome>(hostIds.length);
  let next = 0;
  const cap = Math.max(1, Math.min(deps.concurrency ?? FLEET_FANOUT_CONCURRENCY, Math.max(hostIds.length, 1)));
  const workers = Array.from({ length: cap }, async () => {
    while (true) {
      const i = next;
      if (i >= hostIds.length) return;
      next += 1;
      outcomes[i] = await readHostComposedRig(hostIds[i]!, reg, deps);
    }
  });
  await Promise.all(workers);

  // Registry order preserved (deterministic payload).
  for (const outcome of outcomes) {
    statuses.push(outcome.status);
    if (outcome.input) inputs.push(outcome.input);
  }
  return unionFleet(inputs, statuses, deps.nowIso);
}
