// PL-005 Phase A: Mission Control top-level surface.
//
// Per slice § Mission Control as integrated product UI inside the
// existing shell: this is a single surface with tab navigation across
// the 7 views. NOT a new managed app; NOT a re-implementation of the
// dashboard at the same architecture level.

import { useEffect, useState } from "react";
import {
  MISSION_CONTROL_VIEWS,
  type MissionControlViewName,
} from "./hooks/useMissionControlView.js";
import { MyQueueView } from "./views/MyQueueView.js";
import { HumanGateView } from "./views/HumanGateView.js";
import { FleetView } from "./views/FleetView.js";
import { ActiveWorkView } from "./views/ActiveWorkView.js";
import { RecentShipsView } from "./views/RecentShipsView.js";
import { RecentlyActiveView } from "./views/RecentlyActiveView.js";
import { RecentObservationsView } from "./views/RecentObservationsView.js";
import { AuditHistoryView } from "./views/AuditHistoryView.js";
import { primeMissionControlBearerTokenFromUrl } from "./missionControlAuth.js";

// PL-005 Phase B: UI-side tab union extends Phase A's 7 daemon view
// names with an "audit-history" tab that consumes a different daemon
// endpoint (/api/mission-control/audit, not /views/:name). The daemon
// MISSION_CONTROL_VIEWS enum is unchanged (Phase A surface no-touch).
type MissionControlTabName = MissionControlViewName | "audit-history";

const VIEW_LABELS: Record<MissionControlTabName, string> = {
  "my-queue": "My queue",
  "human-gate": "Human gate",
  fleet: "Fleet",
  "active-work": "Active work",
  "recent-ships": "Recent ships",
  "recently-active": "Recently active",
  "recent-observations": "Observations",
  "audit-history": "Audit history",
};

const ALL_TABS: MissionControlTabName[] = [...MISSION_CONTROL_VIEWS, "audit-history"];

function initialViewFromUrl(): MissionControlTabName {
  if (typeof window === "undefined") return "my-queue";
  const requested = new URL(window.location.href).searchParams.get("view");
  if (requested && (ALL_TABS as string[]).includes(requested)) {
    return requested as MissionControlTabName;
  }
  return new URL(window.location.href).searchParams.has("qitem") ? "human-gate" : "my-queue";
}

function highlightedQitemFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get("qitem");
}

export function MissionControlSurface() {
  const [activeView, setActiveView] = useState<MissionControlTabName>(() => initialViewFromUrl());
  const [highlightedQitemId] = useState<string | null>(() => highlightedQitemFromUrl());

  useEffect(() => {
    primeMissionControlBearerTokenFromUrl();
  }, []);

  return (
    <div
      data-testid="mc-surface"
      className="flex h-full flex-col lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]"
    >
      <header className="border-b border-stone-200 bg-stone-50 p-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">
          Mission Control
        </div>
        <h1 className="font-headline text-xl font-bold tracking-tight text-stone-900">
          Queue observability
        </h1>
        <nav data-testid="mc-tab-nav" className="mt-2 flex flex-wrap gap-1">
          {ALL_TABS.map((view) => (
            <button
              key={view}
              type="button"
              data-testid={`mc-tab-${view}`}
              data-active={activeView === view}
              onClick={() => setActiveView(view)}
              className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] ${
                activeView === view
                  ? "border-stone-700 bg-stone-700 text-white"
                  : "border-stone-300 text-stone-700 hover:bg-stone-100"
              }`}
            >
              {VIEW_LABELS[view]}
            </button>
          ))}
        </nav>
      </header>
      <main data-testid="mc-active-view" className="min-h-0 flex-1 overflow-y-auto">
        {activeView === "my-queue" ? <MyQueueView highlightedQitemId={highlightedQitemId} /> : null}
        {activeView === "human-gate" ? <HumanGateView highlightedQitemId={highlightedQitemId} /> : null}
        {activeView === "fleet" ? <FleetView /> : null}
        {activeView === "active-work" ? <ActiveWorkView highlightedQitemId={highlightedQitemId} /> : null}
        {activeView === "recent-ships" ? <RecentShipsView highlightedQitemId={highlightedQitemId} /> : null}
        {activeView === "recently-active" ? <RecentlyActiveView highlightedQitemId={highlightedQitemId} /> : null}
        {activeView === "recent-observations" ? <RecentObservationsView highlightedQitemId={highlightedQitemId} /> : null}
        {activeView === "audit-history" ? <AuditHistoryView /> : null}
      </main>
    </div>
  );
}
