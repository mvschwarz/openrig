import { useQuery } from "@tanstack/react-query";

interface GraphData {
  nodes: unknown[];
  edges: unknown[];
}

async function fetchGraph(rigId: string): Promise<GraphData> {
  const res = await fetch(`/api/rigs/${rigId}/graph`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useRigGraph(rigId: string) {
  return useQuery({
    queryKey: ["rig", rigId, "graph"],
    queryFn: () => fetchGraph(rigId),
    enabled: !!rigId,
  });
}
