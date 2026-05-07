// V1 attempt-3 Phase 3 — Feed card — single card-shape that renders
// each of the 5 kinds with kind-specific tone (per for-you-feed.md L82+).
// Five kinds: ACTION REQUIRED / APPROVAL / SHIPPED / PROGRESS / OBSERVATION.
//
// V1 attempt-3 Phase 5 P5-1: "show context" affordance per content-drawer.md
// L42 — when card.source has a qitem_id, render an inline QueueItemTrigger
// that opens QueueItemViewer in the drawer with the underlying qitem.

import { VellumCard } from "../ui/vellum-card.js";
import { SectionHeader } from "../ui/section-header.js";
import { AuthorAgentTag } from "./AuthorAgentTag.js";
import { QueueItemTrigger } from "../drawer-triggers/QueueItemTrigger.js";
import type { QueueItemViewerData } from "../drawer-viewers/QueueItemViewer.js";
import type { FeedCard as FeedCardModel, FeedCardKind } from "../../lib/feed-classifier.js";

const KIND_LABEL: Record<FeedCardKind, string> = {
  "action-required": "ACTION REQUIRED",
  approval: "APPROVAL",
  shipped: "SHIPPED",
  progress: "PROGRESS",
  observation: "OBSERVATION",
};

const KIND_ACCENT: Record<FeedCardKind, string> = {
  "action-required": "border-l-4 border-l-tertiary",
  approval: "border-l-4 border-l-warning",
  shipped: "border-l-4 border-l-success",
  progress: "border-l-4 border-l-secondary",
  observation: "border-l-4 border-l-stone-300",
};

const KIND_TESTID: Record<FeedCardKind, string> = {
  "action-required": "feed-card-action",
  approval: "feed-card-approval",
  shipped: "feed-card-shipped",
  progress: "feed-card-progress",
  observation: "feed-card-observation",
};

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function extractQitemViewerData(card: FeedCardModel): QueueItemViewerData | null {
  const payload = (card.source.payload ?? {}) as Record<string, unknown>;
  const qitemId = asString(payload.qitem_id) ?? asString(payload.qitemId);
  if (!qitemId) return null;
  const tagsRaw = payload.tags;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.filter((t): t is string => typeof t === "string")
    : undefined;
  return {
    qitemId,
    source: asString(payload.source_session),
    destination: asString(payload.destination) ?? asString(payload.destination_session),
    state: asString(payload.state),
    tags,
    createdAt: card.createdAt,
    body: asString(payload.body) ?? card.body,
  };
}

export function FeedCard({ card }: { card: FeedCardModel }) {
  const qitemViewerData = extractQitemViewerData(card);
  return (
    <VellumCard
      as="article"
      testId={KIND_TESTID[card.kind]}
      accentClass={KIND_ACCENT[card.kind]}
      className="mb-3"
    >
      <div className="px-4 py-3">
        <SectionHeader tone={card.kind === "action-required" ? "alert" : "muted"}>
          {KIND_LABEL[card.kind]}
        </SectionHeader>
        <h3 className="mt-1 font-mono text-sm text-stone-900 truncate">
          {card.title}
        </h3>
        {card.body ? (
          <p className="mt-2 font-mono text-xs text-on-surface-variant whitespace-pre-line">
            {card.body}
          </p>
        ) : null}
        <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[10px] text-on-surface-variant">
          <div className="flex items-center gap-2 min-w-0">
            {card.authorSession ? (
              <AuthorAgentTag authorSession={card.authorSession} rigId={card.rigId} />
            ) : (
              <span className="truncate">{card.source.type}</span>
            )}
            {qitemViewerData ? (
              <QueueItemTrigger
                data={qitemViewerData}
                testId={`feed-card-show-context-${card.id}`}
                className="font-mono text-[10px] uppercase tracking-wide text-stone-700 hover:text-stone-900 underline"
              >
                show context
              </QueueItemTrigger>
            ) : null}
          </div>
          <time dateTime={card.createdAt} className="shrink-0">
            {card.createdAt ? card.createdAt.slice(11, 19) : ""}
          </time>
        </div>
      </div>
    </VellumCard>
  );
}
