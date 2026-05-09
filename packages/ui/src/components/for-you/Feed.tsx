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
import {
  classifyFeed,
  type FeedCard as FeedCardModel,
  type FeedCardKind,
} from "../../lib/feed-classifier.js";
import {
  useQueueItemMap,
  useSliceDetails,
  useSlices,
  type QueueItemDetail,
  type SliceDetail,
  type SliceListEntry,
} from "../../hooks/useSlices.js";
import {
  useFeedSubscriptions,
  isCardKindSubscribed,
} from "../../hooks/useFeedSubscriptions.js";
import { FeedCard } from "./FeedCard.js";
import type { FeedActionOutcome, FeedProofPreview } from "./FeedCard.js";
import {
  useMissionControlAudit,
  type AuditEntry,
} from "../mission-control/hooks/useMissionControlAudit.js";
import type { MissionControlVerb } from "../mission-control/hooks/useMissionControlAction.js";

const LENS_CHIPS: Array<{ id: FeedCardKind | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "action-required", label: "Action req" },
  { id: "approval", label: "Approvals" },
  { id: "shipped", label: "Shipped" },
  { id: "progress", label: "Progress" },
  { id: "observation", label: "Audit" },
];

const HISTORY_LIMIT = 50; // per for-you-feed.md L182

const EMPTY_COPY: Record<FeedCardKind | "all", { label: string; description: string }> = {
  all: {
    label: "All caught up",
    description: "Nothing needs you right now. New human tasks, approvals, shipped proof, and progress updates will appear here.",
  },
  "action-required": {
    label: "No actions waiting",
    description: "When a queue item needs your response, it will appear here with approve, deny, and route controls.",
  },
  approval: {
    label: "No approvals waiting",
    description: "Closeout and ratification requests will collect here when work needs an explicit decision.",
  },
  shipped: {
    label: "No shipped proof yet",
    description: "Completed work with proof packets and screenshots will appear here when slices close.",
  },
  progress: {
    label: "No progress cards",
    description: "Fresh queue movement and project updates will appear here as work advances.",
  },
  observation: {
    label: "No audit cards",
    description: "Observation events are quiet right now. Turn the audit subscription on to watch more verbose activity.",
  },
};

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((item): item is string => typeof item === "string") : [];
}

function qitemIdForCard(card: FeedCardModel): string | null {
  const payload = (card.source.payload ?? {}) as Record<string, unknown>;
  return asString(payload.qitemId) ?? asString(payload.qitem_id) ?? null;
}

const FEED_ACTION_OUTCOME_VERBS = new Set<MissionControlVerb>([
  "approve",
  "deny",
  "route",
  "handoff",
  "hold",
  "drop",
]);

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function actionOutcomeFromAudit(row: AuditEntry): FeedActionOutcome | null {
  if (!row.qitemId) return null;
  const verb = row.actionVerb as MissionControlVerb;
  if (!FEED_ACTION_OUTCOME_VERBS.has(verb)) return null;
  const destinationSession =
    stringField(row.afterState, "handedOffTo") ??
    (stringField(row.afterState, "closureReason") === "handed_off_to"
      ? stringField(row.afterState, "closureTarget")
      : null);
  return {
    verb,
    actorSession: row.actorSession,
    actedAt: row.actedAt,
    state: stringField(row.afterState, "state"),
    destinationSession,
    reason: row.reason ?? stringField(row.afterState, "closureTarget"),
  };
}

function actionOutcomeMap(rows: AuditEntry[]): Map<string, FeedActionOutcome> {
  const byQitemId = new Map<string, FeedActionOutcome>();
  for (const row of rows) {
    if (!row.qitemId || byQitemId.has(row.qitemId)) continue;
    const outcome = actionOutcomeFromAudit(row);
    if (outcome) byQitemId.set(row.qitemId, outcome);
  }
  return byQitemId;
}

function queueTags(card: FeedCardModel, item: QueueItemDetail | undefined): string[] {
  const payload = (card.source.payload ?? {}) as Record<string, unknown>;
  return [
    ...asStringArray(payload.tags),
    ...(item?.tags ?? []),
  ];
}

function hydratedCardKind(
  card: FeedCardModel,
  item: QueueItemDetail | undefined,
  outcome: FeedActionOutcome | undefined,
): FeedCardKind {
  if (outcome && (card.kind === "action-required" || card.kind === "approval")) {
    return "approval";
  }
  if (!item) return card.kind;
  const tags = queueTags(card, item).join(" ").toLowerCase();
  const state = item.state.toLowerCase();
  const destination = item.destinationSession.toLowerCase();
  const body = item.body.toLowerCase();
  if (
    tags.includes("approval") ||
    tags.includes("ratify") ||
    state.includes("approval") ||
    body.includes("approval requested")
  ) {
    return "approval";
  }
  if (state === "done" || state === "closed" || state === "completed") return "shipped";
  if (destination === "human@host" || destination.startsWith("human-")) return "action-required";
  return card.kind;
}

function sliceForCard(
  card: FeedCardModel,
  item: QueueItemDetail | undefined,
  slices: SliceListEntry[],
): string | null {
  const tags = new Set(queueTags(card, item));
  for (const slice of slices) {
    if (tags.has(slice.name)) return slice.name;
  }
  const haystack = [
    card.title,
    card.body,
    item?.body,
    ...(item?.tags ?? []),
  ].filter((value): value is string => Boolean(value)).join("\n");
  for (const slice of slices) {
    if (haystack.includes(slice.name)) return slice.name;
  }
  return null;
}

function proofPreviewForSlice(detail: SliceDetail | undefined): FeedProofPreview | null {
  const packet = detail?.tests.proofPackets.find((candidate) => candidate.screenshots.length > 0)
    ?? detail?.tests.proofPackets[0];
  if (!detail || !packet || packet.screenshots.length === 0) return null;
  return {
    sliceName: detail.name,
    displayName: detail.displayName || detail.name,
    passFailBadge: packet.passFailBadge,
    screenshots: packet.screenshots,
  };
}

export function Feed() {
  const { events } = useActivityFeed();
  const [lens, setLens] = useState<FeedCardKind | "all">("all");
  const subs = useFeedSubscriptions();

  const rawCards = useMemo(() => classifyFeed(events).slice(0, HISTORY_LIMIT), [events]);
  const qitemIds = useMemo(
    () => rawCards.map(qitemIdForCard).filter((id): id is string => Boolean(id)),
    [rawCards],
  );
  const queueItems = useQueueItemMap(qitemIds);
  const actionAudit = useMissionControlAudit({ limit: 200 });
  const actionOutcomes = useMemo(
    () => actionOutcomeMap(actionAudit.data?.rows ?? []),
    [actionAudit.data?.rows],
  );
  const cards = useMemo(() => {
    const hydrated = rawCards.map((card) => {
      const qitemId = qitemIdForCard(card);
      const item = qitemId ? queueItems.itemsById.get(qitemId) : undefined;
      const outcome = qitemId ? actionOutcomes.get(qitemId) : undefined;
      const kind = hydratedCardKind(card, item, outcome);
      return kind === card.kind ? card : { ...card, kind };
    });
    // Filter by subscription state FIRST so the feed honors operator
    // configuration, then apply the transient lens filter on top.
    const subscribed = hydrated.filter((c) =>
      isCardKindSubscribed(c.kind, subs.state),
    );
    return lens === "all" ? subscribed : subscribed.filter((c) => c.kind === lens);
  }, [rawCards, lens, queueItems.itemsById, actionOutcomes, subs.state]);
  const slicesQuery = useSlices("all");
  const sliceRows = useMemo(() => {
    if (!slicesQuery.data || "unavailable" in slicesQuery.data) return [];
    return slicesQuery.data.slices;
  }, [slicesQuery.data]);
  const proofSliceNames = useMemo(() => {
    const names = new Set<string>();
    for (const card of cards) {
      if (card.kind !== "shipped") continue;
      const qitemId = qitemIdForCard(card);
      const item = qitemId ? queueItems.itemsById.get(qitemId) : undefined;
      const sliceName = sliceForCard(card, item, sliceRows);
      if (sliceName) names.add(sliceName);
    }
    return Array.from(names);
  }, [cards, queueItems.itemsById, sliceRows]);
  const proofSlices = useSliceDetails(proofSliceNames);

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
          label={EMPTY_COPY[lens].label}
          description={EMPTY_COPY[lens].description}
          variant="card"
          testId="for-you-empty"
        />
      ) : (
        <div data-testid="for-you-feed-cards">
          {cards.map((c) => {
            const qitemId = qitemIdForCard(c);
            const queueItem = qitemId ? queueItems.itemsById.get(qitemId) : undefined;
            const sliceName = c.kind === "shipped" ? sliceForCard(c, queueItem, sliceRows) : null;
            const proofPreview = sliceName ? proofPreviewForSlice(proofSlices.itemsByName.get(sliceName)) : null;
            const actionOutcome = qitemId ? actionOutcomes.get(qitemId) ?? null : null;
            return (
              <FeedCard
                key={c.id}
                card={c}
                queueItem={queueItem}
                proofPreview={proofPreview}
                actionOutcome={actionOutcome}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
