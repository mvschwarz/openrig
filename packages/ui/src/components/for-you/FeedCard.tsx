// V1 attempt-3 Phase 3 — Feed card — single card-shape that renders
// each of the 5 kinds with kind-specific tone (per for-you-feed.md L82+).
// Five kinds: ACTION REQUIRED / APPROVAL / SHIPPED / PROGRESS / OBSERVATION.

import { VellumCard } from "../ui/vellum-card.js";
import { SectionHeader } from "../ui/section-header.js";
import { AuthorAgentTag } from "./AuthorAgentTag.js";
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

export function FeedCard({ card }: { card: FeedCardModel }) {
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
        <div className="mt-3 flex items-center justify-between font-mono text-[10px] text-on-surface-variant">
          {card.authorSession ? (
            <AuthorAgentTag authorSession={card.authorSession} rigId={card.rigId} />
          ) : (
            <span>{card.source.type}</span>
          )}
          <time dateTime={card.createdAt}>
            {card.createdAt ? card.createdAt.slice(11, 19) : ""}
          </time>
        </div>
      </div>
    </VellumCard>
  );
}
