// OPR.0.4.6.2 (FR-5) — the saved-views + openable-rigs list for the terminal
// launcher. GET /api/terminal/views → { saved, rigs } (the C3 canonical route).
// Saved views are provider-agnostic and read at launch; derived views (rig /
// mission / slice) are computed live and never appear here.

import { useQuery } from "@tanstack/react-query";
import { withHostParam } from "../lib/host-param.js";
import { useSelectedHostId } from "./useHosts.js";

export interface SavedViewMemberDto {
  seat: string;
  label?: string;
  host?: string;
  tmuxSession?: string;
  readOnly?: boolean;
}

export interface SavedViewDto {
  id: string;
  name: string;
  members: SavedViewMemberDto[];
}

export interface TerminalViewsResponse {
  saved: SavedViewDto[];
  /** Rig names openable as per-rig derived views. */
  rigs: string[];
}

async function fetchTerminalViews(hostId: string): Promise<TerminalViewsResponse> {
  const res = await fetch(withHostParam("/api/terminal/views", hostId));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useTerminalViews() {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["terminal", "views", hostId],
    queryFn: () => fetchTerminalViews(hostId),
    refetchInterval: 30_000,
  });
}
