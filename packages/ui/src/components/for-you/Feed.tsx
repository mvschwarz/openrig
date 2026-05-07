// V1 attempt-3 Phase 3 — For You feed surface per for-you-feed.md.
//
// PRIMARY UX = the feed itself. Subscriptions are NOT dominating
// (per for-you-feed.md L134-L140 LOAD-BEARING SC-16) — the explore
// sidebar holds subscription affordances; the feed is the centerpiece.
//
// V1 attempt-3 Phase 5 P5-3: feed cards are filtered by the live
// subscription state from /api/config (5 feed.subscriptions.* keys).
// action_required cards are always visible (forced ON per L145);
// observation cards visible only when audit_log is ON (default OFF).
// Lens chips remain a transient ad-hoc filter on top of subscription-
// filtered cards.

import { useState, useMemo } from "react";
import { cn } from "../../lib/utils.js";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { useActivityFeed } from "../../hooks/useActivityFeed.js";
import { classifyFeed, type FeedCardKind } from "../../lib/feed-classifier.js";
import {
  useFeedSubscriptions,
  isCardKindSubscribed,
} from "../../hooks/useFeedSubscriptions.js";
import { FeedCard } from "./FeedCard.js";

const LENS_CHIPS: Array<{ id: FeedCardKind | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "action-required", label: "Action req" },
  { id: "approval", label: "Approvals" },
  { id: "shipped", label: "Shipped" },
  { id: "progress", label: "Progress" },
  { id: "observation", label: "Audit" },
];

const HISTORY_LIMIT = 50; // per for-you-feed.md L182

export function Feed() {
  const { events } = useActivityFeed();
  const [lens, setLens] = useState<FeedCardKind | "all">("all");
  const subs = useFeedSubscriptions();

  const cards = useMemo(() => {
    const classified = classifyFeed(events);
    // Filter by subscription state FIRST so the feed honors operator
    // configuration, then apply the transient lens filter on top.
    const subscribed = classified.filter((c) =>
      isCardKindSubscribed(c.kind, subs.state),
    );
    const sliced = subscribed.slice(0, HISTORY_LIMIT);
    return lens === "all" ? sliced : sliced.filter((c) => c.kind === lens);
  }, [events, lens, subs.state]);

  return (
    <div data-testid="for-you-feed" className="mx-auto w-full max-w-[720px] px-6 py-8">
      <header className="border-b border-outline-variant pb-4 mb-4">
        <SectionHeader tone="muted">Attention</SectionHeader>
        <h1 className="font-headline text-headline-md font-bold tracking-tight uppercase text-stone-900 mt-1">
          For You
        </h1>
      </header>

      {/* Lens chips — transient filter, doesn't persist (per L156+). Div not
          nav so SC-1 left-chrome count stays at exactly 2. */}
      <div
        data-testid="feed-lens-chips"
        role="toolbar"
        aria-label="Feed filters"
        className="flex flex-wrap gap-1 mb-4"
      >
        {LENS_CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            data-testid={`feed-lens-${c.id}`}
            data-active={lens === c.id}
            onClick={() => setLens(c.id)}
            className={cn(
              "px-2 py-1 border font-mono text-[9px] uppercase tracking-wide",
              lens === c.id
                ? "border-stone-900 bg-stone-900 text-stone-50"
                : "border-outline-variant text-on-surface-variant hover:bg-stone-100",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      {cards.length === 0 ? (
        <EmptyState
          label="ALL CAUGHT UP"
          description="Nothing needs you right now. Activity from the topology will surface here."
          variant="card"
          testId="for-you-empty"
        />
      ) : (
        <div data-testid="for-you-feed-cards">
          {cards.map((c) => (
            <FeedCard key={c.id} card={c} />
          ))}
        </div>
      )}
    </div>
  );
}
