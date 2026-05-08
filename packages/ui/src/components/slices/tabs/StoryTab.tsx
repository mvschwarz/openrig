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
import { QueueItemTrigger } from "../../drawer-triggers/QueueItemTrigger.js";
import {
  DateChip,
  EventBadge,
  FlowChips,
  ProjectPill,
  TagPill,
  type ProjectToken,
} from "../../project/ProjectMetaPrimitives.js";

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
const PAGE_SIZE = 12;

export function StoryTab({
  events,
  phaseDefinitions,
  queueItemsById,
}: {
  events: StoryEvent[];
  phaseDefinitions: PhaseDefinition[] | null;
  queueItemsById?: Map<string, QueueItemDetail>;
}) {
  const [page, setPage] = useState(0);
  const phaseMeta = useMemo(() => {
    const map = new Map<string, { label: string; colorClass: string; token: ProjectToken }>();
    if (phaseDefinitions) {
      phaseDefinitions.forEach((p, idx) => {
        map.set(p.id, {
          label: p.label,
          colorClass: PHASE_PALETTE[idx % PHASE_PALETTE.length]!,
          token: { label: p.label, tone: (["warning", "info", "success", "neutral"] as const)[idx % 4]! },
        });
      });
    }
    return map;
  }, [phaseDefinitions]);

  const sortedEvents = useMemo(
    () => [...events].sort((a, b) => timestampSortValue(b.ts) - timestampSortValue(a.ts)),
    [events],
  );
  const totalPages = Math.max(1, Math.ceil(sortedEvents.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pagedEvents = sortedEvents.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  if (events.length === 0) {
    return <div className="p-4 font-mono text-[10px] text-stone-400" data-testid="story-empty">No events captured for this slice yet.</div>;
  }

  return (
    <div data-testid="story-tab" className="space-y-0">
      <div data-testid="story-step-tree" data-order="newest-first" className="relative border border-outline-variant bg-white/35 p-3 backdrop-blur-sm">
        {pagedEvents.map((event, idx) => (
          <StoryStepCard
            key={`${event.ts}-${event.kind}-${idx}`}
            event={event}
            phaseMeta={phaseMeta}
            isLast={idx === pagedEvents.length - 1}
            queueItem={event.qitemId ? queueItemsById?.get(event.qitemId) : undefined}
          />
        ))}
      </div>
      {totalPages > 1 ? (
        <div className="mt-3 flex items-center justify-between border border-outline-variant bg-white/35 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-stone-600">
          <button
            type="button"
            data-testid="story-page-prev"
            disabled={safePage === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            className="border border-outline-variant px-2 py-1 disabled:opacity-40"
          >
            Newer
          </button>
          <span data-testid="story-page-status">
            Page {safePage + 1} / {totalPages}
          </span>
          <button
            type="button"
            data-testid="story-page-next"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
            className="border border-outline-variant px-2 py-1 disabled:opacity-40"
          >
            Older
          </button>
        </div>
      ) : null}
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

function qitemViewerData(event: StoryEvent, queueItem: QueueItemDetail | undefined) {
  return {
    qitemId: event.qitemId ?? queueItem?.qitemId ?? "",
    source: queueItem?.sourceSession ?? flowLabel(event).source ?? undefined,
    destination: queueItem?.destinationSession ?? flowLabel(event).target ?? undefined,
    state: queueItem?.state ?? detailString(event.detail, ["state", "toState", "fromState"]) ?? undefined,
    tags: queueItem?.tags ?? undefined,
    createdAt: queueItem?.tsCreated ?? event.ts,
    body: queueItem?.body ?? eventBody(event, queueItem),
  };
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
  phaseMeta: Map<string, { label: string; colorClass: string; token: ProjectToken }>;
  isLast: boolean;
  queueItem?: QueueItemDetail;
}) {
  const meta = event.phase ? phaseMeta.get(event.phase) : undefined;
  const phaseLabel = meta?.label ?? event.phase ?? "untagged";
  const phaseClass = meta?.colorClass ?? UNTAGGED_CLASS;
  const phaseToken = meta?.token ?? { label: phaseLabel, tone: "neutral" as const };
  const flow = flowLabel(event);
  const scopeLabel = detailString(event.detail, ["sliceLabel", "sliceName"]);
  const primaryBody = eventBody(event, queueItem);
  const bodyIsQitem = Boolean(queueItem?.body);
  const rowBody = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid={`story-row-phase-${event.kind}`}
          data-phase-id={event.phase ?? "untagged"}
          className={`sr-only ${phaseClass}`}
        >
          {phaseLabel}
        </span>
        <ProjectPill token={phaseToken} compact />
        {scopeLabel ? <ProjectPill token={{ label: scopeLabel, tone: "neutral" }} compact /> : null}
        <EventBadge kind={event.kind} compact />
        <DateChip value={event.ts} />
      </div>
      <pre
        data-testid={`story-row-body-${event.kind}`}
        data-source={bodyIsQitem ? "qitem" : "event"}
        className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-stone-950"
      >
        {previewText(primaryBody)}
      </pre>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {event.qitemId ? <TagPill tag={event.qitemId} /> : null}
        {queueItem?.tags?.slice(0, 4).map((tag) => <TagPill key={tag} tag={tag} />)}
      </div>
      {bodyIsQitem && event.summary !== primaryBody ? (
        <div data-testid={`story-row-summary-${event.kind}`} className="mt-2 truncate font-mono text-[9px] text-stone-500">
          {event.summary}
        </div>
      ) : null}
      {(flow.source || flow.target) && (
        <div data-testid={`story-step-flow-${event.kind}`} className="mt-2">
          <FlowChips source={flow.source} destination={flow.target} muted />
        </div>
      )}
    </>
  );

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
      {event.qitemId ? (
        <QueueItemTrigger
          data={qitemViewerData(event, queueItem)}
          testId={`story-row-${event.kind}`}
          className="block w-full border border-outline-variant bg-white/45 px-3 py-2 text-left hard-shadow backdrop-blur-sm hover:bg-white/60"
        >
          {rowBody}
        </QueueItemTrigger>
      ) : (
        <div
          data-testid={`story-row-${event.kind}`}
          className="w-full border border-outline-variant bg-white/45 px-3 py-2 text-left hard-shadow backdrop-blur-sm"
        >
          {rowBody}
        </div>
      )}
      {event.detail && (
        <details className="mt-1">
          <summary className="cursor-pointer font-mono text-[9px] uppercase tracking-[0.12em] text-stone-500">
            Event detail
          </summary>
          <pre data-testid={`story-row-detail-${event.kind}`} className="mt-1 overflow-x-auto bg-stone-50 p-2 font-mono text-[9px] text-stone-700">
            {JSON.stringify(event.detail, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
