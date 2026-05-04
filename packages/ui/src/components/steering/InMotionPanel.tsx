// Operator Surface Reconciliation v0 — Product-Specs in Motion panel.
//
// Item 1C: composes PL-005 Mission Control's `recently-active` view
// + filters to qitems whose body or destination references
// `product-specs/` PRDs. Per PRD § Item 1C, the matching strategy is
// driver-picked: we use a body-text-substring match against the
// "product-specs/" path fragment + a tag-based match when the qitem's
// tags include "spec" / "prd" / "review". Heuristic kept local to v0;
// a stricter "PRDs in motion" surface would need a typed view added
// to PL-005, which is out of scope here.

import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "../../hooks/useWorkspace.js";
import { WorkspaceKindBadge } from "../WorkspaceKindBadge.js";

interface MissionControlRow {
  qitemId: string;
  sourceSession?: string;
  destinationSession?: string;
  body?: string;
  state?: string;
  tier?: string | null;
  tsUpdated?: string;
  tags?: string[];
  // Phone-friendly model 9 fields are exposed by Phase A views:
  rigName?: string;
  plainEnglishPhase?: string;
  oneLineNextAction?: string;
  pendingHumanDecision?: string;
  readCost?: string;
  lastUpdate?: string;
  confidenceFreshness?: string;
  evidenceLinkPath?: string;
}

interface MissionControlViewResponse {
  viewName: string;
  rows: MissionControlRow[];
}

async function fetchRecentlyActive(): Promise<MissionControlViewResponse> {
  const res = await fetch("/api/mission-control/views/recently-active");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as MissionControlViewResponse;
}

function isSpecRelated(row: MissionControlRow): boolean {
  const body = row.body ?? "";
  const dest = row.destinationSession ?? "";
  if (body.includes("product-specs/")) return true;
  if (body.toLowerCase().includes("prd")) return true;
  if (dest.includes("planner") || dest.includes("steward") || dest.includes("librarian")) return true;
  if (row.tags?.some((t) => /\b(spec|prd|review)\b/i.test(t))) return true;
  return false;
}

export function InMotionPanel() {
  const workspace = useWorkspace();
  const view = useQuery({
    queryKey: ["mission-control", "views", "recently-active"],
    queryFn: fetchRecentlyActive,
    staleTime: 30_000,
  });
  return (
    <section
      data-testid="steering-in-motion"
      className="border border-stone-300 bg-white"
    >
      <header className="flex items-baseline justify-between border-b border-stone-200 bg-stone-50 px-3 py-2">
        <div className="flex items-baseline gap-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-700">
            Product-specs in motion
          </div>
          {/* PL-007: PRDs live in knowledge canon — surface the kind on
           *  the panel header so the operator-context row is typed. */}
          {workspace.data?.knowledgeKind && (
            <WorkspaceKindBadge kind={workspace.data.knowledgeKind} compact />
          )}
        </div>
        <div className="font-mono text-[9px] text-stone-500">
          via Mission Control · recently-active filtered to spec-related
        </div>
      </header>
      {view.isLoading && <div className="p-3 font-mono text-[10px] text-stone-400">Loading…</div>}
      {view.isError && (
        <div data-testid="steering-in-motion-error" className="p-3 font-mono text-[10px] text-red-600">
          Mission Control view unavailable. Configure PL-005 surfaces or check daemon.
        </div>
      )}
      {view.data && (() => {
        const filtered = view.data.rows.filter(isSpecRelated);
        if (filtered.length === 0) {
          return <div className="p-3 font-mono text-[10px] text-stone-400" data-testid="steering-in-motion-empty">No spec-related qitems in flight.</div>;
        }
        return (
          <ul className="divide-y divide-stone-100">
            {filtered.slice(0, 8).map((row) => (
              <li
                key={row.qitemId}
                data-testid={`steering-in-motion-row-${row.qitemId}`}
                className="px-3 py-1.5"
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[9px] text-stone-500 shrink-0">{(row.tsUpdated ?? "").slice(0, 19)}</span>
                  <span className="font-mono text-[10px] text-stone-800 truncate">
                    {row.body ?? row.qitemId}
                  </span>
                  {row.destinationSession && (
                    <span className="ml-auto font-mono text-[8px] text-stone-400 shrink-0">
                      → {row.destinationSession}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        );
      })()}
    </section>
  );
}
