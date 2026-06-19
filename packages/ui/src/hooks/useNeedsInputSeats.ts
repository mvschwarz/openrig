import { useQuery } from "@tanstack/react-query";
import { getActivityStateWithSource } from "../lib/activity-visuals.js";
import type { NodeInventoryEntry } from "./useNodeInventory.js";

export interface NeedsInputSeatEntry {
  logicalId: string;
  sessionName?: string | null;
  source: string;
  eventAt?: string | null;
  sampledAt?: string;
  rigId?: string;
}

export function useNeedsInputSeats() {
  return useQuery<NeedsInputSeatEntry[]>({
    queryKey: ["needs-input-seats"],
    queryFn: async () => {
      const psRes = await fetch("/api/ps");
      if (!psRes.ok) return [];
      const rigs = (await psRes.json()) as Array<{ rigId: string }>;
      const allSeats: NeedsInputSeatEntry[] = [];
      for (const rig of rigs) {
        let nodes: NodeInventoryEntry[];
        try {
          const nodesRes = await fetch(`/api/rigs/${encodeURIComponent(rig.rigId)}/nodes`);
          if (!nodesRes.ok) continue;
          nodes = (await nodesRes.json()) as NodeInventoryEntry[];
        } catch {
          continue;
        }
        for (const node of nodes) {
          const { state, source } = getActivityStateWithSource(node.agentActivity, node.terminalActive);
          if (state === "needs_input") {
            allSeats.push({
              logicalId: node.logicalId,
              sessionName: node.canonicalSessionName,
              source,
              eventAt: node.agentActivity?.eventAt,
              sampledAt: node.agentActivity?.sampledAt,
              rigId: rig.rigId,
            });
          }
        }
      }
      return allSeats;
    },
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
}
