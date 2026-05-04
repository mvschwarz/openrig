// Slice Story View v0 + v1 — Story tab.
//
// Chronological narrative across the slice's lifecycle. Each row = one
// event with timestamp, actor session, optional spec-driven phase tag,
// summary, and a click-to-expand JSON detail view.
//
// v1 dimension #2: when the slice is bound to a workflow_instance,
// events group under spec-declared phase headings (the spec's step
// labels). When unbound (or for events that don't trace back through
// a workflow_step_trail — doc edits, proof packets), events render in
// a single chronological flow without phase grouping.
//
// v0's hardcoded RSI-v2 phase taxonomy ("discovery"/"product-lab"/...)
// is GONE — the only phase tags that show are the ones the spec
// declares. A spec for code review work would phase
// Spec → Implementation → Code Review → Deploy → Monitor; a deployment
// spec would phase Build → Test → Stage → Prod. Same Story tab.

import { useMemo, useState } from "react";
import type { PhaseDefinition, StoryEvent } from "../../../hooks/useSlices.js";

// Stable color palette assigned by phase index — first phase declared
// in the spec gets emerald, second amber, etc. Order is the spec's
// declared step order so RSI v2 sees its own consistent coloring.
// Cycles after eight phases (more than any v0/v1 spec is expected to
// declare); operator-authored specs with 9+ phases would see colors
// repeat — acceptable v1 fallback.
const PHASE_PALETTE: string[] = [
  "bg-amber-100 text-amber-800 border-amber-300",
  "bg-violet-100 text-violet-800 border-violet-300",
  "bg-emerald-100 text-emerald-800 border-emerald-300",
  "bg-sky-100 text-sky-800 border-sky-300",
  "bg-rose-100 text-rose-800 border-rose-300",
  "bg-fuchsia-100 text-fuchsia-800 border-fuchsia-300",
  "bg-cyan-100 text-cyan-800 border-cyan-300",
  "bg-orange-100 text-orange-800 border-orange-300",
];
const UNTAGGED_CLASS = "bg-stone-100 text-stone-700 border-stone-300";

export function StoryTab({
  events,
  phaseDefinitions,
}: {
  events: StoryEvent[];
  phaseDefinitions: PhaseDefinition[] | null;
}) {
  // Build phase id → display label + color class map from the bound
  // spec's declared phases. Unbound (or untagged events) use the
  // stone palette + the literal phase id (when present) as the label.
  const phaseMeta = useMemo(() => {
    const map = new Map<string, { label: string; colorClass: string }>();
    if (phaseDefinitions) {
      phaseDefinitions.forEach((p, idx) => {
        map.set(p.id, {
          label: p.label,
          colorClass: PHASE_PALETTE[idx % PHASE_PALETTE.length]!,
        });
      });
    }
    return map;
  }, [phaseDefinitions]);

  if (events.length === 0) {
    return <div className="p-4 font-mono text-[10px] text-stone-400" data-testid="story-empty">No events captured for this slice yet.</div>;
  }

  return (
    <div data-testid="story-tab" className="divide-y divide-stone-100">
      {events.map((event, idx) => (
        <StoryRow
          key={`${event.ts}-${event.kind}-${idx}`}
          event={event}
          phaseMeta={phaseMeta}
        />
      ))}
    </div>
  );
}

function StoryRow({
  event,
  phaseMeta,
}: {
  event: StoryEvent;
  phaseMeta: Map<string, { label: string; colorClass: string }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const tsShort = event.ts.length > 19 ? event.ts.slice(0, 19) : event.ts;
  const meta = event.phase ? phaseMeta.get(event.phase) : undefined;
  const phaseLabel = meta?.label ?? event.phase ?? "untagged";
  const phaseClass = meta?.colorClass ?? UNTAGGED_CLASS;
  return (
    <div className="px-4 py-2 hover:bg-stone-50">
      <button
        type="button"
        data-testid={`story-row-${event.kind}`}
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left"
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] text-stone-500 shrink-0">{tsShort}</span>
          <span
            data-testid={`story-row-phase-${event.kind}`}
            data-phase-id={event.phase ?? "untagged"}
            className={`inline-block border px-1 font-mono text-[8px] uppercase tracking-[0.10em] ${phaseClass}`}
          >
            {phaseLabel}
          </span>
          <span className="font-mono text-[10px] text-stone-700 truncate">{event.kind}</span>
          {event.actorSession && (
            <span className="font-mono text-[9px] text-stone-400 shrink-0">{event.actorSession}</span>
          )}
        </div>
        <div className="ml-[88px] font-mono text-[10px] text-stone-800">{event.summary}</div>
      </button>
      {expanded && event.detail && (
        <pre data-testid={`story-row-detail-${event.kind}`} className="ml-[88px] mt-1 overflow-x-auto bg-stone-50 p-2 font-mono text-[9px] text-stone-700">
          {JSON.stringify(event.detail, null, 2)}
        </pre>
      )}
    </div>
  );
}
