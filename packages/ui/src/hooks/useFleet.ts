// OPR.0.4.6.MH5 — UI mirror of the composed-fleet read contract (sibling of
// useReview; ONE aggregate endpoint, BOTH founder-locked surfaces — the
// /fleet route page and the FLEET band — consume THIS hook, so the two
// surfaces can never drift on the one-count identity).
//
// D-6 + arch R1.1 (the FS-1 enablement tie, BINDING): the poll cadence is a
// BOUNDED, NAMED CONSTANT with a stated FLOOR no tighter than the shipped
// feed's cadence class — never an unbounded or magic interval. The shipped
// feed class (useAttentionItems/useReview) is staleTime 15s +
// refetchOnWindowFocus "always"; the fleet adds a bounded background
// interval at 2× that floor (N hosts × composed read × M open tabs is the
// daemon-wedge amplifier class the FS-1 perf incident established — the
// per-host read deadline bounds one poll, THIS constant bounds the poll
// rate). SSE liveness = named follow-up (D-6); enable-at-scale is FS-1
// release-validation, not this cadence.

import { useQuery } from "@tanstack/react-query";

// --- Contract mirror (packages/daemon/src/domain/review/types.ts, MH5 block) ---

import type { NeedsYouItem } from "./useReview.js";
import type { AttentionHostStatus } from "./useAttentionItems.js";

/** The shipped NeedsYouItem + the fleet host dimension + the Q4 one-count
 *  key + the inspectable provenance (FR-3). */
export interface FleetNeedsYouItem extends NeedsYouItem {
  hostId: string;
  /** `${hostId}|${identity}` — rendered VERBATIM on the expanded drawer. */
  fleetKey: string;
  /** Altitudes this identity was visible from on its host (what the
   *  fan-out actually read — v1 reads each host's rig root). */
  seenFrom: string[];
}

/** Counts are PRESENT ONLY when the host's composed set was read (status
 *  ok) — an unreachable host's items are ABSENT, not zero. */
export interface FleetHostRollup {
  hostId: string;
  kind: "local" | "remote";
  status: AttentionHostStatus;
  needsYouCount?: number;
  exceptionsByKind?: Array<{ kind: string; count: number }>;
  seatCount?: number;
  rigCount?: number;
  topLine?: string;
}

export interface ComposedFleetRollup {
  needsYouCount: number;
  exceptionCount: number;
  exceptionsByKind: Array<{ kind: string; count: number }>;
  hostCount: number;
  unreachableCount: number;
}

export interface FleetSettledRow {
  fromSession: string;
  toSession: string;
  summary: string | null;
  closedAtIso: string;
  qitemId: string;
  hostId: string;
}

export interface ComposedFleet {
  rollup: ComposedFleetRollup;
  needsYou: { items: FleetNeedsYouItem[]; provenance: string };
  hosts: FleetHostRollup[];
  settled: FleetSettledRow[];
  settledProvenance: string;
  /** Present ONLY when the registry exists but failed to load (honest,
   *  never a silently-local-only fleet). */
  registryError?: string;
  composedAt: string;
}

// --- R1.1: the BOUNDED NAMED poll cadence ---

/** The feed-cadence-class FLOOR (the shipped attention/review staleTime).
 *  FLEET_POLL_INTERVAL_MS must never be set below this. */
export const FLEET_POLL_FLOOR_MS = 15_000;

/** The fleet background poll interval — bounded + named (arch R1.1). 2× the
 *  feed floor: the fleet read fans out to N hosts server-side, so it polls
 *  HALF as often as a single-host read class refreshes. */
export const FLEET_POLL_INTERVAL_MS = 30_000;

export const FLEET_QUERY_KEY = ["review", "fleet"] as const;

async function fetchFleet(): Promise<ComposedFleet> {
  const res = await fetch("/api/review/fleet");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ComposedFleet;
}

/** The ONE fleet read both locked surfaces share. `enabled` lets the
 *  AMBIENT band gate the FETCH (not just the render) on fleet existence —
 *  a single-host operator's /agents page issues ZERO new fleet reads (the
 *  FS-1 amplifier discipline); the /fleet route always reads (explicit
 *  zoom intent). */
export function useFleet(opts: { enabled?: boolean } = {}) {
  return useQuery<ComposedFleet>({
    queryKey: FLEET_QUERY_KEY,
    queryFn: fetchFleet,
    enabled: opts.enabled ?? true,
    staleTime: FLEET_POLL_FLOOR_MS,
    refetchInterval: FLEET_POLL_INTERVAL_MS,
    // HG-8 (banked): the string variant — boolean `true` is gated by the
    // staleness predicate and can skip focus refetches inside the window.
    refetchOnWindowFocus: "always",
  });
}
