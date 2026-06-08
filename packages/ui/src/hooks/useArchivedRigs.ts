import { useQuery } from "@tanstack/react-query";
import type { RigSummary } from "./useRigSummary.js";

// OPR.0.3.3.19 - archived-only rig summaries for the explorer's "Archive"
// section. This is a SEPARATE query from useRigSummary (the default view) so
// the default tree/graph/table stay active-only; we do NOT client-filter the
// all-rigs list (multiple surfaces share useRigSummary). Mirrors the shipped
// stream-items archived precedent: a dedicated archived-only read.
async function fetchArchived(): Promise<RigSummary[]> {
  const res = await fetch("/api/rigs/summary?archived=only");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Fetches ONLY archived rigs. `enabled` lets the caller keep the fan-out lazy
 * (e.g. fetch only once the Archive section is expanded) so a collapsed
 * archive costs nothing.
 */
export function useArchivedRigs(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["rigs", "summary", "archived"],
    queryFn: fetchArchived,
    enabled: options?.enabled ?? true,
  });
}
