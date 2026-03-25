import { useQuery } from "@tanstack/react-query";

export interface RigSummary {
  id: string;
  name: string;
  nodeCount: number;
  latestSnapshotAt: string | null;
  latestSnapshotId: string | null;
}

async function fetchSummary(): Promise<RigSummary[]> {
  const res = await fetch("/api/rigs/summary");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useRigSummary() {
  return useQuery({
    queryKey: ["rigs", "summary"],
    queryFn: fetchSummary,
  });
}
