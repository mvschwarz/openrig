// Operator Surface Reconciliation v0 — steering workspace.
//
// Item 1 (HEADLINE): one-screen composed steering surface. Six panels
// rendered as a single scrollable viewport:
//   A. Priority stack (verbatim STEERING.md)
//   B. Roadmap rail (PL-XXX checklist + next-unchecked marker)
//   C. Product-specs in motion (PL-005 view consumer)
//   D. Lane rails (delivery-ready/mode-{0..3} top-N + health badges)
//   E. Loop state (PL-005 view consumer)
//   F. Compact health gates (rig ps + rig context summaries)
//
// Read-only at v0. Each panel surfaces operator-actionable affordances
// via copy-able command hints, never daemon writes.

import { Link } from "@tanstack/react-router";
import { useSteering } from "../../hooks/useSteering.js";
import { PriorityStackPanel } from "./PriorityStackPanel.js";
import { RoadmapRailPanel } from "./RoadmapRailPanel.js";
import { InMotionPanel } from "./InMotionPanel.js";
import { LaneRailsPanel } from "./LaneRailsPanel.js";
import { LoopStatePanel } from "./LoopStatePanel.js";
import { HealthGatesPanel } from "./HealthGatesPanel.js";

function isUnavailable(data: unknown): data is { unavailable: true; error: string; hint?: string } {
  return Boolean(data && typeof data === "object" && "unavailable" in (data as Record<string, unknown>));
}

export function SteeringWorkspace() {
  const steering = useSteering();
  return (
    <div
      data-testid="steering-workspace"
      className="flex h-full flex-col lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]"
    >
      <header className="border-b border-stone-200 bg-stone-50 px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">Workspace</div>
        <h1 className="font-headline text-xl font-bold tracking-tight text-stone-900">Steering</h1>
        <div className="mt-1 font-mono text-[10px] text-stone-500">
          One screen — what's the constraint, what's in motion, what does each loop need next?
        </div>
      </header>
      <main className="flex-1 min-h-0 overflow-y-auto bg-white p-4">
        {steering.isLoading && <div className="font-mono text-[10px] text-stone-400">Loading steering surface…</div>}
        {steering.isError && <div className="font-mono text-[10px] text-red-600" data-testid="steering-error">Error loading steering surface.</div>}
        {isUnavailable(steering.data) && (
          <div data-testid="steering-unavailable" className="font-mono text-[10px] text-stone-500">
            <div>Steering composer unavailable.</div>
            {steering.data.hint && <div className="mt-1 text-stone-400">{steering.data.hint}</div>}
            <div className="mt-3 font-mono text-[9px] text-stone-400">
              <Link to="/files" className="text-blue-700 underline">
                Open Files →
              </Link>{" "}
              to browse STEERING.md directly until the composer is configured.
            </div>
          </div>
        )}
        {steering.data && !isUnavailable(steering.data) && (
          <div className="space-y-4">
            <PriorityStackPanel priorityStack={steering.data.priorityStack} />
            <RoadmapRailPanel roadmapRail={steering.data.roadmapRail} />
            <InMotionPanel />
            <LaneRailsPanel laneRails={steering.data.laneRails} />
            <LoopStatePanel />
            <HealthGatesPanel />
            {steering.data.unavailableSources.length > 0 && (
              <UnavailableSourcesNotice sources={steering.data.unavailableSources} />
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function UnavailableSourcesNotice({ sources }: { sources: Array<{ section: string; reason: string; envVar?: string }> }) {
  return (
    <section
      data-testid="steering-unavailable-sources"
      className="border border-amber-300 bg-amber-50 p-3"
    >
      <div className="mb-2 font-mono text-[8px] uppercase tracking-[0.18em] text-amber-700">
        Some sections are unavailable
      </div>
      <ul className="space-y-1 font-mono text-[10px] text-amber-900">
        {sources.map((src) => (
          <li key={src.section} data-testid={`steering-unavailable-${src.section}`}>
            <span className="font-bold">{src.section}:</span> {src.reason}
            {src.envVar && <span className="ml-2 text-amber-600">(env: {src.envVar})</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
