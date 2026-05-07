// Slice Story View v1.
//
// Shows the slice lifecycle as a newest-first connected step tree. Each step
// keeps the spec-defined phase chip and expandable detail from the prior flat
// timeline, while adding visible flow cues for event-to-event handoff reading.

import { useMemo, useState } from "react";
import type {
  PhaseDefinition,
  QueueItemDetail,
  StoryEvent,
} from "../../../hooks/useSlices.js";

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
  queueItemsById,
}: {
  events: StoryEvent[];
  phaseDefinitions: PhaseDefinition[] | null;
  queueItemsById?: Map<string, QueueItemDetail>;
}) {
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

  const sortedEvents = useMemo(
    () => [...events].sort((a, b) => timestampSortValue(b.ts) - timestampSortValue(a.ts)),
    [events],
  );

  if (events.length === 0) {
    return <div className="p-4 font-mono text-[10px] text-stone-400" data-testid="story-empty">No events captured for this slice yet.</div>;
  }

  return (
    <div data-testid="story-tab" className="space-y-0">
      <div data-testid="story-step-tree" data-order="newest-first" className="relative border border-outline-variant bg-white/20 p-3">
        {sortedEvents.map((event, idx) => (
          <StoryStepCard
            key={`${event.ts}-${event.kind}-${idx}`}
            event={event}
            phaseMeta={phaseMeta}
            isLast={idx === sortedEvents.length - 1}
            queueItem={event.qitemId ? queueItemsById?.get(event.qitemId) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function timestampSortValue(ts: string): number {
  const value = Date.parse(ts);
  return Number.isFinite(value) ? value : 0;
}

function detailString(detail: Record<string, unknown> | null, keys: string[]): string | null {
  if (!detail) return null;
  for (const key of keys) {
    const value = detail[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function flowLabel(event: StoryEvent): { source: string | null; target: string | null } {
  const source =
    detailString(event.detail, ["fromSession", "sourceSession", "source", "actorSession"]) ??
    event.actorSession;
  const target = detailString(event.detail, ["toSession", "destinationSession", "targetSession", "target"]);
  return { source, target };
}

function eventBody(event: StoryEvent, queueItem: QueueItemDetail | undefined): string {
  const detailBody = detailString(event.detail, ["body", "content", "message"]);
  return queueItem?.body ?? detailBody ?? event.summary;
}

function previewText(text: string, maxLines = 12): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n... ${lines.length - maxLines} more lines`;
}

function StoryStepCard({
  event,
  phaseMeta,
  isLast,
  queueItem,
}: {
  event: StoryEvent;
  phaseMeta: Map<string, { label: string; colorClass: string }>;
  isLast: boolean;
  queueItem?: QueueItemDetail;
}) {
  const [expanded, setExpanded] = useState(false);
  const tsShort = event.ts.length > 19 ? event.ts.slice(0, 19) : event.ts;
  const meta = event.phase ? phaseMeta.get(event.phase) : undefined;
  const phaseLabel = meta?.label ?? event.phase ?? "untagged";
  const phaseClass = meta?.colorClass ?? UNTAGGED_CLASS;
  const flow = flowLabel(event);
  const primaryBody = eventBody(event, queueItem);
  const bodyIsQitem = Boolean(queueItem?.body);

  return (
    <div className="relative pl-9 pb-3 last:pb-0">
      {!isLast && (
        <div
          data-testid={`story-step-connector-${event.kind}`}
          className="absolute left-[14px] top-7 bottom-0 w-px bg-outline-variant"
        />
      )}
      <div
        data-testid={`story-step-dot-${event.kind}`}
        className="absolute left-[8px] top-4 h-3 w-3 border border-outline-variant bg-white shadow-[1px_1px_0_rgba(46,52,46,0.12)]"
      />
      <button
        type="button"
        data-testid={`story-row-${event.kind}`}
        onClick={() => setExpanded((v) => !v)}
        className="w-full border border-outline-variant bg-white/30 px-3 py-2 text-left hard-shadow hover:bg-white/40"
      >
        <div className="flex items-center gap-2">
          <span
            data-testid={`story-row-phase-${event.kind}`}
            data-phase-id={event.phase ?? "untagged"}
            className={`inline-block border px-1 font-mono text-[8px] uppercase tracking-[0.10em] ${phaseClass}`}
          >
            {phaseLabel}
          </span>
          <span className="font-mono text-[10px] text-stone-700 truncate">{event.kind}</span>
          <span className="ml-auto shrink-0 font-mono text-[9px] text-stone-500">{tsShort}</span>
        </div>
        <pre
          data-testid={`story-row-body-${event.kind}`}
          data-source={bodyIsQitem ? "qitem" : "event"}
          className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-stone-950"
        >
          {previewText(primaryBody)}
        </pre>
        <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[9px] text-stone-500">
          {event.qitemId ? (
            <span className="shrink-0 font-mono text-[8px] uppercase tracking-[0.10em] text-stone-400">
              {event.qitemId}
            </span>
          ) : null}
          {bodyIsQitem && event.summary !== primaryBody ? (
            <span data-testid={`story-row-summary-${event.kind}`} className="truncate">
              {event.summary}
            </span>
          ) : null}
        </div>
        {(flow.source || flow.target) && (
          <div data-testid={`story-step-flow-${event.kind}`} className="mt-1 flex items-center gap-2 font-mono text-[9px] text-stone-500">
            <span className="truncate">{flow.source ?? "unknown source"}</span>
            <span className="text-stone-400">-&gt;</span>
            <span className="truncate">{flow.target ?? "unresolved target"}</span>
          </div>
        )}
      </button>
      {expanded && event.detail && (
        <pre data-testid={`story-row-detail-${event.kind}`} className="mt-1 overflow-x-auto bg-stone-50 p-2 font-mono text-[9px] text-stone-700">
          {JSON.stringify(event.detail, null, 2)}
        </pre>
      )}
    </div>
  );
}
