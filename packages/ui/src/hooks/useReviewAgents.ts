// OPR.0.4.6.2 (FR-5) — the live agent roster for a derived mission/slice view.
// GET /api/review/agents?scope=mission:<id>|slice:<id> → the agents working
// that scope (the same band the composed-review UI reads). The terminal
// launcher uses it to preview a derived view's roster before opening; the
// authoritative partition still comes from the open POST.

import { useQuery } from "@tanstack/react-query";
import { withHostParam } from "../lib/host-param.js";
import { useSelectedHostId } from "./useHosts.js";

export interface ReviewAgentRow {
  sessionName: string;
  agentName: string;
  /** "active" | "parked" | "idle" | "unknown" — the state glyph. */
  stateGlyph: string;
  runtime: string;
  slices: string[];
}

export interface ReviewAgentsBand {
  scope: string;
  rows: ReviewAgentRow[];
}

async function fetchReviewAgents(scope: string, hostId: string): Promise<ReviewAgentsBand> {
  const res = await fetch(withHostParam(`/api/review/agents?scope=${encodeURIComponent(scope)}`, hostId));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Fetch the roster for a mission:/slice: scope. Pass null to stay idle (disabled). */
export function useReviewAgents(scope: string | null) {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["review", "agents", scope, hostId],
    queryFn: () => fetchReviewAgents(scope as string, hostId),
    enabled: !!scope,
  });
}
