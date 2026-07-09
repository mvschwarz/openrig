import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { withHostParam } from "../lib/host-param.js";
import { useSelectedHostId } from "./useHosts.js";

export interface RigSummary {
  id: string;
  name: string;
  nodeCount: number;
  hasServices?: boolean;
  latestSnapshotAt: string | null;
  latestSnapshotId: string | null;
  /** OPR.0.4.3.22 — rig-level lifecycle folded from per-node states
   *  (running / recoverable / stopped / degraded / attention_required). The
   *  daemon /api/rigs/summary route already enriches this; carried here so UI
   *  surfaces can choose the right operator action without a second round trip. */
  lifecycleState?: "running" | "recoverable" | "stopped" | "degraded" | "attention_required";
}

async function fetchSummary(hostId: string): Promise<RigSummary[]> {
  // OPR.0.4.6.MH2 FR-2 — the selected host rides the query envelope; the
  // local daemon's read-through returns the origin shape verbatim. Local
  // keeps today's bare path unchanged (withHostParam is identity for local).
  const res = await fetch(withHostParam("/api/rigs/summary", hostId));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useRigSummary() {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["rigs", "summary", hostId],
    queryFn: () => fetchSummary(hostId),
    // FR-6: keep the previous host's view (truthfully labeled by the
    // indicator) while the newly selected host's data crosses the network.
    placeholderData: keepPreviousData,
  });
}
