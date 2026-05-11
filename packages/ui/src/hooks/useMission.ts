// V0.3.1 slice 12 walk-item 1 — mission scope data hook.
//
// Wraps GET /api/missions/:missionId, the aggregated mission metadata
// route that returns missionPath + filtered SliceListEntry[]. Pairs
// with useScopeMarkdown for README / PROGRESS content via
// /api/files/read.

import { useQuery } from "@tanstack/react-query";
import type { SliceListEntry } from "./useSlices.js";

export interface MissionDataResponse {
  missionId: string;
  /** Absolute filesystem path of the mission folder. */
  missionPath: string;
  /** Slices in this mission (SliceListEntry[] filtered). */
  slices: SliceListEntry[];
}

export interface MissionUnavailable {
  unavailable: true;
  error: string;
  hint?: string;
}

async function fetchMission(missionId: string): Promise<MissionDataResponse | MissionUnavailable> {
  const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}`);
  if (res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
    return {
      unavailable: true,
      error: body.error ?? "missions_route_unavailable",
      hint: body.hint,
    };
  }
  if (res.status === 404) {
    return {
      unavailable: true,
      error: "mission_not_found",
    };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as MissionDataResponse;
}

export function useMission(missionId: string | null) {
  return useQuery({
    queryKey: ["mission", "detail", missionId],
    queryFn: () => fetchMission(missionId!),
    enabled: !!missionId,
    staleTime: 30_000,
    // V0.3.1 slice 17 workspace-state-correctness pattern: refetch on
    // window focus so the operator who creates a slice folder + comes
    // back to the tab sees the new slice without a manual refresh.
    refetchOnWindowFocus: true,
  });
}
