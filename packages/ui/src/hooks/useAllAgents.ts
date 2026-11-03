// C10: agents across all rigs (no single daemon endpoint exists — fan out
// over usePsEntries + per-rig /api/rigs/:id/nodes, sharing the exact
// queryKey shape of useNodeInventory so SSE invalidation refreshes it).
import { useQueries } from "@tanstack/react-query";
import { useSelectedHostId } from "./useHosts.js";
import { usePsEntries } from "./usePsEntries.js";
import { fetchNodeInventory, type NodeInventoryEntry } from "./useNodeInventory.js";

export interface AgentRow extends NodeInventoryEntry {}

export function useAllAgents(): { agents: AgentRow[]; isLoading: boolean; error: Error | null } {
  const hostId = useSelectedHostId();
  const ps = usePsEntries();
  const results = useQueries({
    queries: (ps.data ?? []).map((r) => ({
      queryKey: ["rig", r.rigId, "nodes", hostId],
      queryFn: () => fetchNodeInventory(r.rigId, hostId),
      staleTime: 15_000,
    })),
  });
  const agents = results.flatMap((q) => ((q.data ?? []) as NodeInventoryEntry[]).filter((n) => n.nodeKind === "agent"));
  const isLoading = ps.isLoading || results.some((q) => q.isLoading);
  const firstError = results.find((q) => q.error)?.error as Error | undefined;
  return { agents, isLoading, error: firstError ?? (ps.error as Error | null) ?? null };
}
