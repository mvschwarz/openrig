// OPR.0.4.3.22 — fetch the READ-ONLY per-seat launch plan
// (POST /api/rigs/:id/launch-plan). The launch/recovery modal fetches this
// BEFORE any mutation (plan-before-action, AC-3). The endpoint is read-only by
// construction (mutated:false) — it never restores or fresh-primes. Passing
// freshLogicalIds forecasts the fresh-primed plan for an explicit fresh choice.

import { useMutation } from "@tanstack/react-query";
import type { SeatTokenState, SeatIntendedAction } from "./useRigStatus.js";

export interface LaunchPlanNode {
  logicalId: string;
  intendedAction: SeatIntendedAction;
  reason?: string;
  tokenState: SeatTokenState;
  provenance?: string | null;
  lastVerified?: string | null;
  freshRequired: boolean;
  runtimePrompt?: string;
}

export interface LaunchPlan {
  status: "plan";
  mode: "restore";
  rigId: string;
  rigName: string;
  snapshot: { id: string; kind: string; createdAt: string } | null;
  wouldCaptureCurrentState: boolean;
  nodes: LaunchPlanNode[];
  mutated: false;
}

async function fetchLaunchPlan(rigId: string, freshLogicalIds?: string[]): Promise<LaunchPlan> {
  const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/launch-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(freshLogicalIds ? { freshLogicalIds } : {}),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Launch plan failed (HTTP ${res.status})`);
  }
  return res.json();
}

/** Fetch the read-only launch plan on demand (e.g. when the modal opens or the
 *  operator toggles the policy). Mutation shape so it's imperative, not a
 *  background poll — but it NEVER mutates the rig (the daemon route is read-only). */
export function useLaunchPlan(rigId: string) {
  return useMutation({
    mutationFn: (freshLogicalIds?: string[]) => fetchLaunchPlan(rigId, freshLogicalIds),
  });
}
