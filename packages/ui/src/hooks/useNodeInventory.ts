import { useQuery } from "@tanstack/react-query";

export interface AgentActivitySummary {
  state: "running" | "needs_input" | "idle" | "unknown";
  reason: string;
  evidenceSource: string;
  sampledAt: string;
  evidence?: string | null;
  staleness?: number | null;
}

export interface CurrentQitemSummary {
  qitemId: string;
  bodyExcerpt: string;
  tier: string | null;
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
}

async function fetchNodeInventory(rigId: string): Promise<NodeInventoryEntry[]> {
  const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/nodes`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useNodeInventory(rigId: string | null) {
  return useQuery({
    queryKey: ["rig", rigId, "nodes"],
    queryFn: () => fetchNodeInventory(rigId!),
    enabled: !!rigId,
    refetchInterval: 30_000,
  });
}
