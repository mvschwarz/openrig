import { useQuery } from "@tanstack/react-query";

export interface NodeDetailPeer {
  logicalId: string;
  canonicalSessionName: string | null;
  runtime: string | null;
}

export interface NodeDetailEdge {
  kind: string;
  to?: { logicalId: string; sessionName: string | null };
  from?: { logicalId: string; sessionName: string | null };
}

export interface NodeDetailTranscript {
  enabled: boolean;
  path: string | null;
  tailCommand: string | null;
}

export interface NodeDetailCompactSpec {
  name: string | null;
  version: string | null;
  profile: string | null;
  skillCount: number;
  guidanceCount: number;
}

export interface NodeDetailData {
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
  model: string | null;
  agentRef: string | null;
  profile: string | null;
  resolvedSpecName: string | null;
  resolvedSpecVersion: string | null;
  cwd: string | null;
  startupFiles: Array<{ path: string; deliveryHint: string; required: boolean }>;
  startupActions: Array<{ type: string; value: string }>;
  recentEvents: Array<{ type: string; createdAt: string }>;
  infrastructureStartupCommand: string | null;
  peers: NodeDetailPeer[];
  edges: { outgoing: NodeDetailEdge[]; incoming: NodeDetailEdge[] };
  transcript: NodeDetailTranscript;
  compactSpec: NodeDetailCompactSpec;
  contextUsage?: {
    availability: string;
    reason?: string | null;
    usedPercentage?: number | null;
    remainingPercentage?: number | null;
    contextWindowSize?: number | null;
    totalInputTokens?: number | null;
    totalOutputTokens?: number | null;
    currentUsage?: string | null;
    source?: string | null;
    sampledAt?: string | null;
    fresh?: boolean;
  };
}

async function fetchNodeDetail(rigId: string, logicalId: string): Promise<NodeDetailData> {
  const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(logicalId)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useNodeDetail(rigId: string | null, logicalId: string | null) {
  return useQuery({
    queryKey: ["rig", rigId, "nodes", logicalId],
    queryFn: () => fetchNodeDetail(rigId!, logicalId!),
    enabled: !!rigId && !!logicalId,
    refetchInterval: 30_000, // Refetch every 30s for context usage updates
  });
}
