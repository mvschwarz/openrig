import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { withHostParam } from "../lib/host-param.js";
import { useSelectedHostId } from "./useHosts.js";

interface GraphData {
  nodes: unknown[];
  edges: unknown[];
}

async function fetchGraph(rigId: string, hostId: string): Promise<GraphData> {
  // OPR.0.4.6.MH2 FR-2 — selected-host envelope; origin shape verbatim;
  // local path unchanged (withHostParam is identity for local).
  const res = await fetch(withHostParam(`/api/rigs/${encodeURIComponent(rigId)}/graph`, hostId));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useRigGraph(rigId: string) {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["rig", rigId, "graph", hostId],
    queryFn: () => fetchGraph(rigId, hostId),
    enabled: !!rigId,
    refetchInterval: 30_000, // Refetch every 30s for context usage updates
    placeholderData: keepPreviousData,
  });
}
