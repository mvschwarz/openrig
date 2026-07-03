// OPR.0.4.3.22 — the composed rig-status object (GET /api/rigs/:id/status).
//
// Mirrors the daemon `composeRigStatus` fold: a rig's status is COMPOSED from
// backend signals (ps-lifecycle + restore-plan + restore-check + kernel-status),
// NEVER inferred from pane text or /healthz. `src[]` is the composed provenance.
// The per-seat truths are preserved (the LOCK: no global-fresh flip).

import { useQuery } from "@tanstack/react-query";

export type RigAggStatus = "up" | "partial" | "down" | "blocked" | "unknown";
export type SeatTokenState = "present" | "missing" | "stale" | "unverified";
export type SeatIntendedAction = "resume-original" | "fresh-primed" | "awaiting-decision";

export interface RigStatusSeat {
  logicalId: string;
  runtime: string | null;
  lifecycleState: "running" | "detached" | "recoverable" | "attention_required";
  tokenState: SeatTokenState;
  intendedAction: SeatIntendedAction;
  freshRequired: boolean;
  blocked: boolean;
  provenance?: string | null;
  lastVerified?: string | null;
  reason?: string;
  runtimePrompt?: string;
}

export interface RigStatusObject {
  rigId: string;
  rigName: string;
  isKernel: boolean;
  status: RigAggStatus;
  seatsTotal: number;
  seatsRunning: number;
  recoverable: boolean;
  perSeat: RigStatusSeat[];
  src: string[];
}

async function fetchRigStatus(rigId: string): Promise<RigStatusObject> {
  const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/status`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useRigStatus(rigId: string | undefined) {
  return useQuery({
    queryKey: ["rig", rigId, "status"],
    queryFn: () => fetchRigStatus(rigId!),
    enabled: !!rigId,
    // Status folds restore-check (some filesystem probing) — poll gently, not
    // at the 3s ps cadence.
    refetchInterval: 10_000,
  });
}
