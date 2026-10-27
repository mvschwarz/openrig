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
import { useAttentionItems } from "../../hooks/useAttentionItems.js";
import {
  classifyFeed,
  isHumanSeat,
  sortFeedByDecisionBand,
  type FeedCard as FeedCardModel,
  type FeedCardKind,
} from "../../lib/feed-classifier.js";
import {
  attentionItemToFeedCard,
  needsInputSeatToFeedCard,
  eventDerivedSeqsForPrune,
  isQueueDerivedFeedCard,
  isSyntheticFeedCard,
  mergeAttentionIntoFeed,
} from "../../lib/attention-feed.js";
import { useNeedsInputSeats } from "../../hooks/useNeedsInputSeats.js";
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
import { LevelControl } from "./LevelControl.js";
import { useDismissedSeqs } from "../../hooks/useDismissedSeqs.js";
import { useDismissedCardIds } from "../../hooks/useDismissedCardIds.js";
import { FeedCard } from "./FeedCard.js";
import { UndoToast } from "./UndoToast.js";
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
    // CORRECTIVE §7.1 rev1-r2 fixback (B1, 2026-07-06): the empty-state copy
    // must not leak the retired deny/route schema — the surface is one-tap
    // APPROVE + CHAT only (founder N-1).
    description: "When a queue item needs your response, it will appear here with one-tap approve and chat with the owning agent.",
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

// Exported for tests (OPR.0.4.4.19 FR-3 — the structured-signal contract is
// pinned by unit tests; the component render path is unchanged).
export function hydratedCardKind(
  card: FeedCardModel,
  item: QueueItemDetail | undefined,
  outcome: FeedActionOutcome | undefined,
): FeedCardKind {
  if (outcome && (card.kind === "action-required" || card.kind === "approval")) {
    return "approval";
  }
  if (!item) return card.kind;
  // OPR.0.4.4.19 FR-3: card-kind promotion reads STRUCTURED signals only —
  // the human-gate tier (C6) and the strict human-seat destination predicate.
  // The prior body-text ("approval requested") / tag-guess ("approval",
  // "ratify") / state-substring sniffing is retired, a deletion: once the
  // signals are enforced at the write path, guessing is worse than reading.
  if (item.tier === "human-gate") return "approval";
  const state = item.state.toLowerCase();
  if (state === "done" || state === "closed" || state === "completed") return "shipped";
  if (isHumanSeat(item.destinationSession)) return "action-required";
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

  // OPR.0.3.2.20 — For You priority windowing.
  // Action-required + Approval lenses source from the daemon's
  // durable open-attention query (window-independent), then merge
  // with event-derived cards. Queue-derived attention cards
  // SUPERSEDE event-derived cards with the same qitemId. Other
  // kinds (shipped/progress/observation) stay event-derived
  // (HG-6 no regression).
  // OPR.0.4.4.15 — consolidated multi-host feed: with ≥1 enabled remote
  // host subscription the attention poll switches to the aggregated
  // endpoint (daemon-side fan-out; the browser still only talks to the
  // local daemon). Zero-config keeps today's endpoint + rendering exactly.
  const remoteFeedActive = subs.anyRemoteEnabled;
  const [hostFilter, setHostFilter] = useState<string | null>(null);
  const attentionQuery = useAttentionItems(50, remoteFeedActive);
  const hostStatuses = useMemo(() => attentionQuery.data?.hosts ?? [], [attentionQuery.data]);
  const queueDerivedAttention = useMemo<FeedCardModel[]>(
    () => (attentionQuery.data?.items ?? []).map(attentionItemToFeedCard),
    [attentionQuery.data],
  );
  const needsInputQuery = useNeedsInputSeats();
  const needsInputCards = useMemo<FeedCardModel[]>(
    () => (needsInputQuery.data ?? []).map(needsInputSeatToFeedCard),
    [needsInputQuery.data],
  );
  const eventDerivedCards = useMemo(() => classifyFeed(events).slice(0, HISTORY_LIMIT), [events]);
  const allAttention = useMemo(
    () => [...queueDerivedAttention, ...needsInputCards],
    [queueDerivedAttention, needsInputCards],
  );
  const rawCards = useMemo(
    () => sortFeedByDecisionBand(mergeAttentionIntoFeed(eventDerivedCards, allAttention)),
    [eventDerivedCards, allAttention],
  );
  // OPR.0.3.2.20 — useDismissedSeqs auto-prunes by min-seq across
  // currentSeqs. Queue-derived synthetic cards carry seq=-1, which
  // would pin min-seq at -1 and prevent the auto-prune for
  // event-derived dismissals (guard re-verify-2
  // CLEANUP-1). eventDerivedSeqsForPrune
  // filters them OUT — their dismissal lives in useDismissedCardIds.
  const rawCardSeqs = useMemo(() => eventDerivedSeqsForPrune(rawCards), [rawCards]);
  const rawCardIds = useMemo(() => rawCards.map((c) => c.id), [rawCards]);
  const { dismissedSeqs, dismiss: dismissSeq, undismiss: undismissSeq } = useDismissedSeqs(rawCardSeqs);
  // OPR.0.3.2.20 — string-keyed dismissal parallel to event-seq
  // dismissal. Queue-derived attention cards share synthetic
  // ActivityEvent.seq = -1 (no real event), so seq-keyed dismissal
  // collides across them; routing those dismissals to a string-id
  // set (FeedCard.id is stable + unique) keeps each queue-derived
  // card's dismissal independent. Auto-prune is membership-based:
  // when the qitem closes the card disappears from rawCardIds and
  // the dismissal is dropped.
  const { dismissedIds, dismiss: dismissId, undismiss: undismissId } = useDismissedCardIds(rawCardIds);
  const [pendingUndo, setPendingUndo] = useState<{ kind: "seq"; seq: number } | { kind: "id"; id: string } | null>(null);

  // Routes a dismiss call: synthetic cards (queue-attention-* and
  // activity-needs-input-*) use the string-keyed dismissedIds set;
  // event-derived cards continue using the seq-keyed dismissedSeqs
  // set. Avoids collision on the synthetic seq=-1.
  const handleDismiss = useCallback(
    (card: FeedCardModel) => {
      if (isSyntheticFeedCard(card)) {
        dismissId(card.id);
        setPendingUndo({ kind: "id", id: card.id });
      } else {
        dismissSeq(card.source.seq);
        setPendingUndo({ kind: "seq", seq: card.source.seq });
      }
    },
    [dismissSeq, dismissId],
  );

  const handleUndo = useCallback(() => {
    if (pendingUndo === null) return;
    if (pendingUndo.kind === "seq") undismissSeq(pendingUndo.seq);
    else undismissId(pendingUndo.id);
    setPendingUndo(null);
  }, [pendingUndo, undismissSeq, undismissId]);

  const handleUndoExpire = useCallback(() => {
    setPendingUndo(null);
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
    // OPR.0.4.4.15 — per-host filter (cards without a hostId are local by
    // definition: event-derived + needs-input cards never leave this host).
    const hostFiltered = hostFilter === null ? lensFiltered : lensFiltered.filter((c) => (c.hostId ?? "local") === hostFilter);
    return hostFiltered.filter((c) => {
      if (isSyntheticFeedCard(c)) return !dismissedIds.has(c.id);
      return !dismissedSeqs.has(c.source.seq);
    });
  }, [rawCards, lens, hostFilter, queueItems.itemsById, actionOutcomes, subs.state, dismissedSeqs, dismissedIds]);
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

  // OPR.0.4.1.27-foryou (founder-picked option a) — the vestigial 0.3.1
  // storytelling-preview band was removed. For You is now the slice-27
  // restyled, subscription/lens-filtering FeedCard list below; the mission/
  // slice rollups it duplicated stay on Dashboard/Project. The shared
  // storytelling-cards.tsx primitives remain (the /lab/card-previews gallery
  // still imports them) — only this band's wiring was dropped.

  return (
    <div data-testid="for-you-feed" className="mx-auto w-full max-w-[720px] px-6 py-8">
      <header className="border-b border-outline-variant pb-4 mb-4">
        <SectionHeader tone="muted">Attention</SectionHeader>
        <h1 className="font-headline text-headline-md font-bold tracking-tight uppercase text-on-surface mt-1">
          For You
        </h1>
      </header>

      {/* OPR.0.4.1.27 — the PRIMARY subscription control at the top of the
          (phone) feed: a plain-language level (All activity / Highlights /
          Needs you) over the same toggle model; action items always on. The 5
          individual toggles remain the advanced view in the Explorer sidebar. */}
      <div data-testid="feed-level-control" className="mb-4">
        <LevelControl />
      </div>

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
                ? "border-on-surface bg-inverse-surface text-background"
                : "border-outline-variant text-on-surface-variant hover:bg-surface-low",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* OPR.0.4.4.15 — host chips + per-host status rows, rendered ONLY
          when aggregation is active (hostStatuses is empty on the legacy
          path — zero-config DOM is byte-identical to today). Same
          lens-chip visual pattern; failed hosts render muted + a status
          row (never a silently thinner feed). */}
      {hostStatuses.length > 0 && (
        <div
          data-testid="feed-host-chips"
          role="toolbar"
          aria-label="Host filter"
          className="flex flex-wrap gap-1 mb-2"
        >
          <button
            type="button"
            data-testid="feed-host-all"
            data-active={hostFilter === null}
            onClick={() => setHostFilter(null)}
            className={cn(
              "px-2 py-1 border font-mono text-[9px] uppercase tracking-wide",
              hostFilter === null
                ? "border-on-surface bg-inverse-surface text-background"
                : "border-outline-variant text-on-surface-variant hover:bg-surface-low",
            )}
          >
            ALL HOSTS
          </button>
          {hostStatuses.map((h) => (
            <button
              key={h.hostId}
              type="button"
              data-testid={`feed-host-${h.hostId}`}
              data-active={hostFilter === h.hostId}
              data-host-status={h.status}
              onClick={() => setHostFilter(hostFilter === h.hostId ? null : h.hostId)}
              className={cn(
                "px-2 py-1 border font-mono text-[9px] uppercase tracking-wide",
                hostFilter === h.hostId
                  ? "border-on-surface bg-inverse-surface text-background"
                  : "border-outline-variant text-on-surface-variant hover:bg-surface-low",
                h.status !== "ok" && "opacity-60",
              )}
            >
              {h.hostId}
              {h.status !== "ok" ? ` · ${h.status}` : ""}
            </button>
          ))}
        </div>
      )}
      {hostStatuses
        .filter((h) => h.status !== "ok")
        .map((h) => (
          <div
            key={`status-${h.hostId}`}
            data-testid={`feed-host-status-${h.hostId}`}
            className="mb-2 border border-outline-variant px-2 py-1 font-mono text-[9px] text-on-surface-variant"
          >
            {h.hostId}: {h.status}
            {h.error ? ` — ${h.error}` : ""} (other hosts&apos; items unaffected)
          </div>
        ))}

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
      {pendingUndo !== null ? (
        <UndoToast
          key={pendingUndo.kind === "seq" ? `seq-${pendingUndo.seq}` : `id-${pendingUndo.id}`}
          label="Card dismissed"
          onUndo={handleUndo}
          onExpire={handleUndoExpire}
          durationMs={5000}
        />
      ) : null}
    </div>
  );
}
