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

import { useCallback, useMemo, useState } from "react";
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
import { useDismissedSeqs } from "../../hooks/useDismissedSeqs.js";
import { useCompletedMissions } from "../../hooks/useCompletedMissions.js";
import { useMissionStatuses } from "../../hooks/useMissionStatuses.js";
import { FeedCard } from "./FeedCard.js";
import { UndoToast } from "./UndoToast.js";
import type { FeedActionOutcome, FeedProofPreview } from "./FeedCard.js";
import {
  StorytellingFeed,
  buildStorytellingFeedItems,
  type FeedCardItem as StorytellingFeedItem,
} from "../feed/cards/storytelling-cards.js";
import { useMissionDiscovery } from "../../hooks/useMissionDiscovery.js";
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
  // Demo-bug fix #1 — optimistic action outcomes keyed by qitemId.
  // VerbActions fires onOptimisticOutcome on mutation success; the
  // ActionOutcomePanel reads from here first, falling back to the
  // audit-derived map below. Audit re-fetch eventually surfaces the
  // same shape, but the user-visible state is instant.
  const [optimisticOutcomes, setOptimisticOutcomes] = useState<Map<string, FeedActionOutcome>>(
    () => new Map(),
  );
  const setOptimisticOutcome = useCallback(
    (qitemId: string, outcome: FeedActionOutcome) => {
      setOptimisticOutcomes((prev) => {
        const next = new Map(prev);
        next.set(qitemId, outcome);
        return next;
      });
    },
    [],
  );

  const rawCards = useMemo(() => classifyFeed(events).slice(0, HISTORY_LIMIT), [events]);
  const rawCardSeqs = useMemo(() => rawCards.map((c) => c.source.seq), [rawCards]);
  const { dismissedSeqs, dismiss, undismiss } = useDismissedSeqs(rawCardSeqs);
  const [pendingUndoSeq, setPendingUndoSeq] = useState<number | null>(null);

  const handleDismiss = useCallback(
    (seq: number) => {
      dismiss(seq);
      setPendingUndoSeq(seq);
    },
    [dismiss],
  );

  const handleUndo = useCallback(() => {
    if (pendingUndoSeq !== null) undismiss(pendingUndoSeq);
    setPendingUndoSeq(null);
  }, [pendingUndoSeq, undismiss]);

  const handleUndoExpire = useCallback(() => {
    setPendingUndoSeq(null);
  }, []);
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
    // configuration, then apply the transient lens filter, then drop
    // anything the operator has soft-dismissed via per-event-seq.
    const subscribed = hydrated.filter((c) =>
      isCardKindSubscribed(c.kind, subs.state),
    );
    const lensFiltered = lens === "all" ? subscribed : subscribed.filter((c) => c.kind === lens);
    return lensFiltered.filter((c) => !dismissedSeqs.has(c.source.seq));
  }, [rawCards, lens, queueItems.itemsById, actionOutcomes, subs.state, dismissedSeqs]);
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

  // 0.3.1 slice 06 — adapt the daemon-driven sliceRows + missions
  // into the new storytelling card primitives so they render in the
  // live For You surface. Each of the 5 card types is mounted by a
  // distinct data adapter so the production wire is the real one,
  // not a stub. The legacy FeedCard list below remains the primary
  // surface; this section is the storytelling-primitives preview
  // band at the top of the feed.
  //
  // Adapters:
  //   - Missions (useMissionDiscovery) → ProgressCard for the first 2
  //     missions; drill-in routes to /project/mission/<id>. Percent
  //     defaults to 0 at v0 (mission-level percent computation moves
  //     in a follow-up slice via PROGRESS.md checkbox count).
  //   - Slices (useSlices) → ShippedCard for status=shipped/done,
  //     IncidentCard for everything else, capped at 3.
  const missionsResult = useMissionDiscovery();
  const { completedMissionIds, markCompleted } = useCompletedMissions();
  const discoveredMissionIds = useMemo(
    () => (Array.isArray(missionsResult.missions) ? missionsResult.missions.map((m) => m.name) : []),
    [missionsResult.missions],
  );
  const { statuses: missionStatuses } = useMissionStatuses(discoveredMissionIds);
  // Slice 18 §3.5 — thread the daemon-derived status onto each mission
  // row so buildStorytellingFeedItems filters durably on `status ===
  // "complete"` (survives browser/localStorage reset).
  const missionsWithStatus = useMemo(
    () => (Array.isArray(missionsResult.missions) ? missionsResult.missions : []).map((m) => ({
      ...m,
      status: missionStatuses.get(m.name) ?? null,
    })),
    [missionsResult.missions, missionStatuses],
  );
  const storytellingItems = useMemo<StorytellingFeedItem[]>(
    () => buildStorytellingFeedItems(
      missionsWithStatus,
      Array.isArray(sliceRows) ? sliceRows : [],
      completedMissionIds,
      rawCards,
    ),
    [missionsWithStatus, sliceRows, completedMissionIds, rawCards],
  );

  // Slice 18 §3.5 — Getting Started complete-and-hide. Optimistic local
  // hide via useCompletedMissions; best-effort daemon write to
  // POST /api/missions/:missionId/complete for the audit trail. Network
  // errors are swallowed silently (audit is best-effort, UI stays
  // responsive) so a partial-air-gapped daemon doesn't block the hide.
  const handleMarkMissionComplete = useCallback(
    (missionId: string) => {
      markCompleted(missionId);
      void fetch(`/api/missions/${encodeURIComponent(missionId)}/complete`, {
        method: "POST",
      }).catch(() => {
        // Swallow — local optimistic state is the user-visible truth.
      });
    },
    [markCompleted],
  );

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

      {storytellingItems.length > 0 && (
        <section
          data-testid="for-you-storytelling-preview"
          aria-label="Storytelling preview"
          className="mb-4"
        >
          <SectionHeader tone="muted">Storytelling preview</SectionHeader>
          <div className="mt-2">
            <StorytellingFeed items={storytellingItems} onMarkMissionComplete={handleMarkMissionComplete} />
          </div>
        </section>
      )}

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
            const actionOutcome = qitemId
              ? optimisticOutcomes.get(qitemId) ?? actionOutcomes.get(qitemId) ?? null
              : null;
            return (
              <FeedCard
                key={c.id}
                card={c}
                queueItem={queueItem}
                proofPreview={proofPreview}
                actionOutcome={actionOutcome}
                onDismiss={handleDismiss}
                onOptimisticOutcome={setOptimisticOutcome}
              />
            );
          })}
        </div>
      )}
      {pendingUndoSeq !== null ? (
        <UndoToast
          key={pendingUndoSeq}
          label="Card dismissed"
          onUndo={handleUndo}
          onExpire={handleUndoExpire}
          durationMs={5000}
        />
      ) : null}
    </div>
  );
}
