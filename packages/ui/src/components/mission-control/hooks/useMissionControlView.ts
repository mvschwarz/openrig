// PL-005 Phase A: hook to fetch one Mission Control view from the daemon.
import { useQuery } from "@tanstack/react-query";

export const MISSION_CONTROL_VIEWS = [
  "my-queue",
  "human-gate",
  "fleet",
  "active-work",
  "recent-ships",
  "recently-active",
  "recent-observations",
] as const;

export type MissionControlViewName = (typeof MISSION_CONTROL_VIEWS)[number];

export interface CompactStatusRow {
  rigOrMissionName: string;
  currentPhase: string | null;
  state: "active" | "idle" | "attention" | "blocked" | "degraded";
  nextAction: string | null;
  pendingHumanDecision: string | null;
  readCost: "full" | "skim/approve" | "summary-only" | null;
  lastUpdate: string;
  confidenceFreshness: string | null;
  evidenceLink: string | null;
  qitemId?: string | null;
  rawSourceRef?: string | null;
  qitemSummary?: string | null;
  qitemBody?: string | null;
}

export interface MissionControlViewResult {
  viewName: MissionControlViewName;
  rows: CompactStatusRow[];
  meta: {
    rowCount: number;
    rigsRunningStaleCli?: number;
    degradedFields?: string[];
    sourceFallback?: string;
  };
}

async function fetchView(
  viewName: MissionControlViewName,
  operatorSession?: string,
): Promise<MissionControlViewResult> {
  const params = new URLSearchParams();
  if (operatorSession) params.set("operatorSession", operatorSession);
  const qs = params.toString();
  const url = `/api/mission-control/views/${viewName}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useMissionControlView(
  viewName: MissionControlViewName,
  opts?: { operatorSession?: string; refetchInterval?: number },
) {
  return useQuery({
    queryKey: ["mission-control", "view", viewName, opts?.operatorSession ?? null],
    queryFn: () => fetchView(viewName, opts?.operatorSession),
    refetchInterval: opts?.refetchInterval ?? 5000,
  });
}
