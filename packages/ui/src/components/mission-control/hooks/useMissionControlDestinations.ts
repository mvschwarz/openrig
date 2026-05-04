// PL-005 Phase B: phone-friendly destination candidates for route/handoff.
import { useQuery } from "@tanstack/react-query";

export interface MissionControlDestination {
  sessionName: string;
  label: string;
  source: "topology" | "queue";
  rigName?: string | null;
  logicalId?: string | null;
  runtime?: string | null;
  status?: string | null;
}

export interface MissionControlDestinationsResult {
  destinations: MissionControlDestination[];
}

async function fetchDestinations(): Promise<MissionControlDestinationsResult> {
  const res = await fetch("/api/mission-control/destinations");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useMissionControlDestinations(enabled: boolean) {
  return useQuery({
    queryKey: ["mission-control", "destinations"],
    queryFn: fetchDestinations,
    enabled,
    staleTime: 30_000,
  });
}
