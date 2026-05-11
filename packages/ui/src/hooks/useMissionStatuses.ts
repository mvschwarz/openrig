// Slice 18 §3.5 — durable mission status lookup.
//
// Fans out GET /api/missions/:missionId per discovered mission and
// returns a Map<missionId, status>. The storytelling preview gates
// on status === "complete" so a mission whose frontmatter says
// "complete" hides even on a fresh browser/localStorage-clear.
//
// One react-query query per missionId — small N (the storytelling
// band caps at the first 2 missions today) so the fan-out is cheap.
// React-query handles caching + dedupe.

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";

interface MissionDetailResponse {
  missionId: string;
  status?: string | null;
}

export interface UseMissionStatusesResult {
  statuses: Map<string, string | null>;
  isLoading: boolean;
}

export function useMissionStatuses(missionIds: string[]): UseMissionStatusesResult {
  const queries = useQueries({
    queries: missionIds.map((id) => ({
      queryKey: ["mission-status", id] as const,
      queryFn: async (): Promise<string | null> => {
        const res = await fetch(`/api/missions/${encodeURIComponent(id)}`);
        if (!res.ok) return null;
        const body = (await res.json()) as MissionDetailResponse;
        return typeof body.status === "string" && body.status.length > 0 ? body.status : null;
      },
      enabled: id.length > 0,
      staleTime: 30_000,
    })),
  });

  return useMemo(() => {
    const statuses = new Map<string, string | null>();
    let isLoading = false;
    for (let i = 0; i < missionIds.length; i++) {
      const id = missionIds[i]!;
      const result = queries[i];
      statuses.set(id, result?.data ?? null);
      if (result?.isPending) isLoading = true;
    }
    return { statuses, isLoading };
  }, [missionIds, queries]);
}
