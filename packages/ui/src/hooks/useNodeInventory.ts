import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { withHostParam } from "../lib/host-param.js";
import { useSelectedHostId } from "./useHosts.js";

export interface AgentActivitySummary {
  state: "running" | "needs_input" | "idle" | "unknown";
  reason: string;
  evidenceSource: string;
  sampledAt: string;
  eventAt?: string | null;
  evidence?: string | null;
  staleness?: number | null;
  stale?: boolean;
  fallback?: boolean;
}

export interface CurrentQitemSummary {
  qitemId: string;
  bodyExcerpt: string;
  tier: string | null;
}

/**
 * OPR.0.4.3.19 — the seat liveness identity verdict (third axis) as it arrives
 * on the /nodes + /graph payloads. A `mismatch`/`pane_missing` verdict must
 * down-rank the seat away from active/running in every UI surface; the daemon
 * already synthesizes graph startupStatus=attention_required for the ring, and
 * the activity DOT consumes this verdict directly (getActivityStateWithSource)
 * so it cannot silently ignore it.
 */
export interface SeatIdentityVerdictSummary {
  verdict: "verified" | "mismatch" | "pane_missing" | "tmux_unavailable";
  evidenceSource?: string | null;
  reason?: string | null;
  evidence?: {
    registeredPane?: string | null;
    observedPid?: number | null;
    observedCommand?: string | null;
    matchedLayer?: number | null;
  } | null;
  sessionName?: string | null;
  observedAt?: string;
}

export interface NodeInventoryEntry {
  rigId: string;
  rigName: string;
  logicalId: string;
  podId: string | null;
  podNamespace?: string | null;
  canonicalSessionName: string | null;
  nodeKind: "agent" | "infrastructure";
  runtime: string | null;
  sessionStatus: string | null;
  startupStatus: "pending" | "ready" | "attention_required" | "failed" | null;
  restoreOutcome: string;
  tmuxAttachCommand: string | null;
  resumeCommand: string | null;
  latestError: string | null;
  contextUsage?: {
    usedPercentage: number | null;
    remainingPercentage: number | null;
    contextWindowSize: number | null;
    availability: string | null;
    sampledAt: string | null;
    fresh: boolean;
    totalInputTokens?: number | null;
    totalOutputTokens?: number | null;
  };
  // PL-019: agent activity attached daemon-side via attachAgentActivity.
  agentActivity?: AgentActivitySummary | null;
  // PL-019: in-progress qitems joined daemon-side on node-detail responses.
  currentQitems?: CurrentQitemSummary[];
  terminalActive?: boolean | null;
  hasAssignedWork?: boolean;
  pendingWorkCount?: number;
  // OPR.0.4.3.19 — liveness identity verdict (third axis). null/absent when
  // never observed; mismatch/pane_missing down-ranks the seat non-green.
  identityVerdict?: SeatIdentityVerdictSummary | null;
  agentRef?: string | null;
  profile?: string | null;
  codexConfigProfile?: string | null;
}

async function fetchNodeInventory(rigId: string, hostId: string): Promise<NodeInventoryEntry[]> {
  // OPR.0.4.6.MH2 FR-2 — selected-host envelope; origin shape verbatim;
  // local path unchanged (withHostParam is identity for local).
  const res = await fetch(withHostParam(`/api/rigs/${encodeURIComponent(rigId)}/nodes`, hostId));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useNodeInventory(rigId: string | null) {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["rig", rigId, "nodes", hostId],
    queryFn: () => fetchNodeInventory(rigId!, hostId),
    enabled: !!rigId,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}
