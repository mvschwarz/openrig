import { useQuery } from "@tanstack/react-query";

export interface PsEntry {
  rigId: string;
  name: string;
  nodeCount: number;
  runningCount: number;
  status: "running" | "partial" | "stopped";
  uptime: string | null;
  latestSnapshot: string | null;
}

async function fetchPsEntries(): Promise<PsEntry[]> {
  const res = await fetch("/api/ps");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function usePsEntries() {
  return useQuery({
    queryKey: ["ps"],
    queryFn: fetchPsEntries,
  });
}
