// Slice Story View v0 — Story tab.
//
// Chronological narrative across the RSI loop: Discovery → Product Lab
// → Delivery → Lifecycle → QA. Each row = one event with timestamp,
// actor session, phase tag, summary, and a click-to-expand JSON detail
// view (the daemon may attach a `detail` blob with before/after state
// or queue tier).

import { useState } from "react";
import type { StoryEvent } from "../../../hooks/useSlices.js";

const PHASE_COLORS: Record<StoryEvent["phase"], string> = {
  discovery: "bg-amber-100 text-amber-800 border-amber-300",
  "product-lab": "bg-violet-100 text-violet-800 border-violet-300",
  delivery: "bg-emerald-100 text-emerald-800 border-emerald-300",
  lifecycle: "bg-sky-100 text-sky-800 border-sky-300",
  qa: "bg-rose-100 text-rose-800 border-rose-300",
  other: "bg-stone-100 text-stone-700 border-stone-300",
};

export function StoryTab({ events }: { events: StoryEvent[] }) {
  if (events.length === 0) {
    return <div className="p-4 font-mono text-[10px] text-stone-400" data-testid="story-empty">No events captured for this slice yet.</div>;
  }
  return (
    <div data-testid="story-tab" className="divide-y divide-stone-100">
      {events.map((event, idx) => (
        <StoryRow key={`${event.ts}-${event.kind}-${idx}`} event={event} />
      ))}
    </div>
  );
}

function StoryRow({ event }: { event: StoryEvent }) {
  const [expanded, setExpanded] = useState(false);
  const tsShort = event.ts.length > 19 ? event.ts.slice(0, 19) : event.ts;
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
          <span className={`inline-block border px-1 font-mono text-[8px] uppercase tracking-[0.10em] ${PHASE_COLORS[event.phase]}`}>
            {event.phase}
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
