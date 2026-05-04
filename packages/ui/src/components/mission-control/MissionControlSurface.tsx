// PL-005 Phase A: Mission Control top-level surface.
//
// Per slice § Mission Control as integrated product UI inside the
// existing shell: this is a single surface with tab navigation across
// the 7 views. NOT a new managed app; NOT a re-implementation of the
// dashboard at the same architecture level.

import { useState } from "react";
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

const VIEW_LABELS: Record<MissionControlViewName, string> = {
  "my-queue": "My queue",
  "human-gate": "Human gate",
  fleet: "Fleet",
  "active-work": "Active work",
  "recent-ships": "Recent ships",
  "recently-active": "Recently active",
  "recent-observations": "Observations",
};

export function MissionControlSurface() {
  const [activeView, setActiveView] = useState<MissionControlViewName>("my-queue");
  return (
    <div data-testid="mc-surface" className="flex h-full flex-col">
      <header className="border-b border-stone-200 bg-stone-50 p-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">
          Mission Control
        </div>
        <h1 className="font-headline text-xl font-bold tracking-tight text-stone-900">
          Queue observability
        </h1>
        <nav data-testid="mc-tab-nav" className="mt-2 flex flex-wrap gap-1">
          {MISSION_CONTROL_VIEWS.map((view) => (
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
        {activeView === "my-queue" ? <MyQueueView /> : null}
        {activeView === "human-gate" ? <HumanGateView /> : null}
        {activeView === "fleet" ? <FleetView /> : null}
        {activeView === "active-work" ? <ActiveWorkView /> : null}
        {activeView === "recent-ships" ? <RecentShipsView /> : null}
        {activeView === "recently-active" ? <RecentlyActiveView /> : null}
        {activeView === "recent-observations" ? <RecentObservationsView /> : null}
      </main>
    </div>
  );
}
