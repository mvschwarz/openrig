// PL-007 Workspace Primitive v0 — UI hook for the typed workspace block.
//
// Surfaces /api/whoami's `workspace` field (when the rig declares one)
// so consumer surfaces (Files, Progress, Slices, Specs, Steering) can
// render workspace-kind labels without re-deriving topology.
//
// The workspace block is null when:
//   - the daemon has no workspace_json on the rigs row (legacy rig)
//   - the daemon predates PL-007 (cross-CLI-version drift; UI degrades
//     gracefully — surfaces simply skip the badge column)
//
// Defensive: every consumer must Array.isArray-guard `repos[]` before
// iteration (founder rule for cross-CLI drift).
//
// Note: /api/whoami requires either nodeId or sessionName query param.
// In a UI session that has no node identity (browser tab not bound to
// a managed seat), the workspace block is unavailable; consumers should
// treat null as "no badges", not as an error.

import { useQuery } from "@tanstack/react-query";
import type { WorkspaceKindLabel } from "../components/WorkspaceKindBadge.js";

export interface WhoamiWorkspaceUI {
  workspaceRoot: string;
  activeRepo: string | null;
  repos: Array<{ name: string; path: string; kind: WorkspaceKindLabel }>;
  knowledgeRoot: string | null;
  knowledgeKind: WorkspaceKindLabel | null;
}

interface WhoamiSnapshot {
  workspace?: WhoamiWorkspaceUI | null;
}

async function fetchWorkspace(): Promise<WhoamiWorkspaceUI | null> {
  // Try sessionName from URL first (when the UI is opened with a seat
  // context query), else fall back to a generic any-session attempt that
  // returns null when ambiguous. v0: UI workspace is best-effort.
  const url = new URL(window.location.href);
  const sessionName = url.searchParams.get("session");
  const params = new URLSearchParams();
  if (sessionName) params.set("sessionName", sessionName);
  // No identifier → daemon returns 400; we degrade gracefully to null.
  if (params.toString() === "") return null;
  const res = await fetch(`/api/whoami?${params.toString()}`);
  if (!res.ok) return null;
  const body = await res.json().catch(() => null) as WhoamiSnapshot | null;
  if (!body || typeof body !== "object") return null;
  const ws = body.workspace;
  if (!ws || typeof ws !== "object") return null;
  // Defensive Array.isArray guard for cross-CLI drift
  if (!Array.isArray(ws.repos)) {
    return { ...ws, repos: [] };
  }
  return ws;
}

export function useWorkspace() {
  return useQuery({
    queryKey: ["workspace", "whoami"],
    queryFn: fetchWorkspace,
    staleTime: 60_000,
  });
}
