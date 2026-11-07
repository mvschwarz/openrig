import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Clock, History, PackageCheck, X, CircleAlert } from "lucide-react";

import { AuthorAgentTag } from "./AuthorAgentTag.js";
import { FeedCardTerminalDrill } from "./FeedCardTerminalDrill.js";
import {
  FeedCardQuestionAsk,
  normalizeHumanAnswers,
  normalizeHumanQuestions,
} from "./FeedCardQuestionAsk.js";
import { QueueItemTrigger } from "../drawer-triggers/QueueItemTrigger.js";
import type { QueueItemViewerData } from "../drawer-viewers/QueueItemViewer.js";
import type { QueueItemDetail } from "../../hooks/useSlices.js";
import type { FeedCard as FeedCardModel, FeedCardKind } from "../../lib/feed-classifier.js";
import { isSyntheticFeedCard } from "../../lib/attention-feed.js";
import { VerbActions } from "../mission-control/components/VerbActions.js";
import { ProgressiveTerminal } from "../terminal/ProgressiveTerminal.js";
import { buildChatPreamble } from "../review/chat.js";
import { StatusDot } from "../ui/status-badge.js";
import {
  ProofPacketHeader,
  ProofThumbnailGrid,
  TagPill,
  compactSessionLabel,
  eventToken,
  formatFriendlyDate,
  queueStateToken,
  type ProjectMetaTone,
  type ProjectToken,
} from "../project/ProjectMetaPrimitives.js";
import { ProofImageViewer } from "../project/ProofImageViewer.js";
import type { MissionControlVerb } from "../mission-control/hooks/useMissionControlAction.js";
import { ACTION_VERB_META, actionVerbToken } from "../mission-control/action-verb-meta.js";
import { ActorMark } from "../graphics/RuntimeMark.js";
import { cn } from "../../lib/utils.js";

/**
 * C11 Inbox v2: kind -> StatusDot status. action-required/approval need
 * attention; shipped is done; progress is running; observation is idle.
 */
const KIND_STATUS: Record<FeedCardKind, string> = {
  "action-required": "attention_required",
  approval: "attention_required",
  shipped: "done",
  progress: "running",
  observation: "idle",
};

const TONE_DOT: Record<ProjectMetaTone, string> = {
  neutral: "bg-outline",
  info: "bg-secondary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-tertiary",
};

const KIND_TESTID: Record<FeedCardKind, string> = {
  "action-required": "feed-card-action",
  approval: "feed-card-approval",
  shipped: "feed-card-shipped",
  progress: "feed-card-progress",
  observation: "feed-card-observation",
};

const KIND_TOKEN: Record<FeedCardKind, ProjectToken> = {
  // CORRECTIVE §7.1 guard fixback (2026-07-06): the kind tag is a STATUS
  // label like its siblings, never instruction chrome — "Your turn" is gone
  // from the surface (founder N-1); the kind's canonical name matches the
  // approved frame's subscription vocabulary ("Action required · Items the
  // human must act on").
  "action-required": { label: "Action required", tone: "danger", icon: CircleAlert },
  approval: { label: "Needs approval", tone: "warning", icon: CircleAlert },
  shipped: { label: "Shipped", tone: "success", icon: PackageCheck },
  progress: { label: "Progress", tone: "info", icon: History },
  observation: { label: "Observation", tone: "neutral", icon: Clock },
};

// OPR.0.4.1.27 Unit 5 — tone → text color (for the kind glyph; mirrors TONE_DOT).
const TONE_TEXT: Record<ProjectMetaTone, string> = {
  neutral: "text-on-surface-variant",
  info: "text-secondary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-tertiary",
};

/**
 * OPR.0.4.1.27 Unit 6 — sender-or-owner terminal resolver (fidelity map).
 * Human-action cards (action-required / approval) open the SENDER
 * (sourceSession); agent-owned cards (progress / shipped / observation) open
 * the current HOLDER (destinationSession), falling back to source when no
 * destination resolves. sourceSession / destinationSession are the only
 * terminal-addressable sessions (never handed_off_from, which is qitem lineage).
 */
export function resolveCardTerminalSession(
  kind: FeedCardKind,
  source: string | undefined,
  destination: string | undefined,
): string | undefined {
  if (kind === "action-required" || kind === "approval") return source;
  return destination ?? source;
}

/**
 * C11 Inbox v2 list-row surface (no framed card, no hard shadow, no
 * registration-mark corners, no uppercase). Rows live inside one
 * `rounded-lg border divide-y` container in Feed.tsx. Kept constants
 * (unused) so the source-assertion tests that pinned the old recipe can
 * be updated in one place with the new recipe.
 */
const CARD_SURFACE_CLASS = "group px-4 py-3";
const CARD_SHADOW_STYLE: React.CSSProperties = {};

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
    source:
      asString(payload.source_session) ??
      asString(payload.sourceSession) ??
      asString(payload.fromSession),
    destination:
      asString(payload.destination) ??
      asString(payload.destination_session) ??
      asString(payload.destinationSession) ??
      asString(payload.toSession),
    state: asString(payload.state),
    tags,
    createdAt: card.createdAt,
    body: asString(payload.body) ?? card.body,
  };
}

export interface FeedProofPreview {
  sliceName: string;
  displayName: string;
  passFailBadge: string;
  screenshots: string[];
}

function qitemViewerDataFromItem(card: FeedCardModel, item: QueueItemDetail | undefined): QueueItemViewerData | null {
  const fallback = extractQitemViewerData(card);
  if (!item) return fallback;
  return {
    qitemId: item.qitemId,
    source: item.sourceSession,
    destination: item.destinationSession,
    state: item.state,
    tags: item.tags ?? undefined,
    createdAt: item.tsCreated,
    body: item.body || fallback?.body || card.body,
  };
}

function compactQueueBody(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const trimmed = body.trim();
  if (trimmed.length <= 520) return trimmed;
  return `${trimmed.slice(0, 520).trimEnd()}\n...`;
}

export interface FeedActionOutcome {
  verb: MissionControlVerb;
  actorSession: string;
  actedAt: string;
  state?: string | null;
  destinationSession?: string | null;
  reason?: string | null;
}

const TERMINAL_QUEUE_STATES = new Set([
  "done",
  "closed",
  "completed",
  "shipped",
  "canceled",
  "cancelled",
  "denied",
  "failed",
  "handed-off",
]);

function isTerminalQueueItem(item: QueueItemDetail | undefined): boolean {
  if (!item) return false;
  return TERMINAL_QUEUE_STATES.has(item.state.toLowerCase());
}

function isActionableCard(
  kind: FeedCardKind,
  item: QueueItemDetail | undefined,
  outcome: FeedActionOutcome | null,
): boolean {
  if (kind !== "action-required" && kind !== "approval") return false;
  if (outcome) return false;
  if (isTerminalQueueItem(item)) return false;
  return true;
}

function fallbackOutcomeFromQueueItem(
  kind: FeedCardKind,
  item: QueueItemDetail | undefined,
): FeedActionOutcome | null {
  if (kind !== "action-required" && kind !== "approval") return null;
  if (!item || !isTerminalQueueItem(item)) return null;
  const reason = item.closureReason ?? null;
  const destinationSession = item.handedOffTo ?? item.closureTarget ?? null;
  const verb: MissionControlVerb =
    reason === "denied" ? "deny"
      : reason === "handed_off_to" ? "route"
        : reason === "canceled" ? "drop"
          : "approve";
  return {
    verb,
    actorSession: item.destinationSession,
    actedAt: item.tsUpdated,
    state: item.state,
    destinationSession,
    reason: reason === "no-follow-on" ? null : item.closureTarget ?? reason,
  };
}

function outcomeToken(outcome: FeedActionOutcome): ProjectToken {
  return actionVerbToken(outcome.verb, "outcome");
}

/** Inline meta mark: muted sentence-case label with a leading colored dot. */
function InlineMetaMark({ token }: { token: ProjectToken }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-on-surface-variant">
      <span aria-hidden="true" className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", TONE_DOT[token.tone])} />
      {token.label}
    </span>
  );
}

function InlineDateMark({ value }: { value: string | undefined | null }) {
  return (
    <time
      dateTime={value ?? undefined}
      className="shrink-0 text-xs tabular-nums text-on-surface-variant"
    >
      {formatFriendlyDate(value)}
    </time>
  );
}

function InlineActor({ session }: { session: string | undefined | null }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-on-surface-variant">
      <ActorMark actor={session} size="xs" decorative />
      <span className="truncate">{compactSessionLabel(session)}</span>
    </span>
  );
}

function InlineFlow({ source, destination }: { source?: string | null; destination?: string | null }) {
  if (!source && !destination) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <InlineActor session={source ?? "unknown source"} />
      <ArrowRight className="h-3.5 w-3.5 text-on-surface-variant" strokeWidth={1.4} />
      <InlineActor session={destination ?? "unresolved target"} />
    </div>
  );
}

function outcomeSentence(outcome: FeedActionOutcome): string {
  switch (outcome.verb) {
    case "approve":
      return `Approved by ${outcome.actorSession}.`;
    case "deny":
      return `Denied by ${outcome.actorSession}${outcome.reason ? `: ${outcome.reason}.` : "."}`;
    case "route":
    case "handoff":
      return outcome.destinationSession
        ? `Routed by ${outcome.actorSession} to ${outcome.destinationSession}.`
        : `Routed by ${outcome.actorSession}.`;
    case "hold":
      return `Held by ${outcome.actorSession}${outcome.reason ? `: ${outcome.reason}.` : "."}`;
    case "drop":
      return `Dropped by ${outcome.actorSession}${outcome.reason ? `: ${outcome.reason}.` : "."}`;
    case "annotate":
      return `Annotated by ${outcome.actorSession}.`;
  }
}

/**
 * Action-outcome receipt strip — vellum-coherent.
 *   subtle bg-background/40 across all tones
 *   leading colored dot indicates the tone, NOT the whole strip color
 */
function ActionOutcomePanel({ outcome }: { outcome: FeedActionOutcome }) {
  const meta = ACTION_VERB_META[outcome.verb];
  const Icon = meta.icon;
  return (
    <div
      data-testid="feed-card-action-outcome"
      className="mt-3 bg-background/40 px-3 py-2"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span aria-hidden="true" className={cn("mt-2 inline-block w-1.5 h-1.5 rounded-full shrink-0", TONE_DOT[meta.tone])} />
          <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-lowest/55 text-on-surface">
            <Icon className="h-4 w-4" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="text-sm text-on-surface">
              {meta.outcomeLabel}
            </div>
            <div className="mt-0.5 text-[11px] text-on-surface-variant">
              Decision recorded
            </div>
          </div>
        </div>
        <InlineDateMark value={outcome.actedAt} />
      </div>
      <p className="mt-3 font-body text-[12px] leading-relaxed text-on-surface">
        {outcomeSentence(outcome)}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <InlineActor session={outcome.actorSession} />
        {outcome.reason ? <TagPill tag={outcome.reason} /> : null}
      </div>
      {(outcome.verb === "route" || outcome.verb === "handoff") && outcome.destinationSession ? (
        <div className="mt-2">
          <InlineFlow source={outcome.actorSession} destination={outcome.destinationSession} />
        </div>
      ) : null}
    </div>
  );
}

const SWIPE_DISMISS_THRESHOLD = 0.5; // fraction of card width

export function FeedCard({
  card,
  queueItem,
  proofPreview,
  actionOutcome,
  onDismiss,
  onOptimisticOutcome,
}: {
  card: FeedCardModel;
  queueItem?: QueueItemDetail;
  proofPreview?: FeedProofPreview | null;
  actionOutcome?: FeedActionOutcome | null;
  /**
   * OPR.0.3.2.20 — receives the FULL card on dismiss so the parent
   * can route the dismissal to the right dismissal-set (event-seq
   * for event-derived cards, string-id for queue-derived attention
   * cards). The prior `(seq: number)` signature collided across all
   * queue-derived cards (all share synthetic seq=-1) — banked guard
   * BLOCKER.
   */
  onDismiss?: (card: FeedCardModel) => void;
  /**
   * 0.3.1 demo-bug fix — fired by VerbActions on mutation success
   * so the parent (Feed.tsx) can render the ActionOutcomePanel
   * optimistically without waiting for the audit-log re-fetch.
   */
  onOptimisticOutcome?: (qitemId: string, outcome: FeedActionOutcome) => void;
}) {
  const [selectedScreenshot, setSelectedScreenshot] = useState<string | null>(null);
  // CORRECTIVE §7.1 — CHAT quick-action state (the shared terminal, per BR-12).
  const [chatOpen, setChatOpen] = useState(false);
  // F17 (#2417) — expand multiline event bodies beyond the one-line preview.
  const [bodyExpanded, setBodyExpanded] = useState(false);
  const dragStateRef = useRef<{ startX: number; pointerId: number; isTouch: boolean } | null>(null);

  const handleKeyDown: React.KeyboardEventHandler<HTMLElement> = (event) => {
    if (!onDismiss) return;
    if (event.target !== event.currentTarget) return;
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      onDismiss(card);
    }
  };

  const handleTouchStart: React.TouchEventHandler<HTMLElement> = (event) => {
    if (!onDismiss) return;
    const touch = event.touches[0];
    if (!touch) return;
    dragStateRef.current = { startX: touch.clientX, pointerId: touch.identifier, isTouch: true };
  };

  const handleTouchEnd: React.TouchEventHandler<HTMLElement> = (event) => {
    const drag = dragStateRef.current;
    dragStateRef.current = null;
    if (!onDismiss || !drag) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const deltaX = touch.clientX - drag.startX;
    if (deltaX <= 0) return;
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) return;
    if (deltaX / rect.width >= SWIPE_DISMISS_THRESHOLD) {
      onDismiss(card);
    }
  };

  const handleDismissClick: React.MouseEventHandler<HTMLButtonElement> = (event) => {
    event.stopPropagation();
    if (!onDismiss) return;
    onDismiss(card);
  };
  const qitemViewerData = qitemViewerDataFromItem(card, queueItem);
  const payload = card.source.payload ?? {};
  const isRemote = Boolean(card.hostId && card.hostId !== "local");
  // Remote cards must use their origin's payload, not a same-id local queue row.
  const localItem = !isRemote ? queueItem : undefined;
  const rawQuestions =
    Array.isArray(localItem?.humanQuestions) && localItem.humanQuestions.length > 0
      ? localItem.humanQuestions
      : payload.humanQuestions;
  const rawAnswers = localItem?.humanAnswers ?? payload.humanAnswers;
  const parsedQuestions = !isRemote ? normalizeHumanQuestions(rawQuestions) : [];
  const parsedAnswers = !isRemote ? normalizeHumanAnswers(rawAnswers) : {};
  const hasQuestions = (Array.isArray(payload.humanQuestions) && payload.humanQuestions.length > 0)
    || (Array.isArray(localItem?.humanQuestions) && localItem.humanQuestions.length > 0);
  // Event cards can arrive before the queue read. Do not offer a closing action until it resolves.
  const questionsKnown = localItem !== undefined || Object.hasOwn(payload, "humanQuestions");
  const permissionTags = localItem ? localItem.tags : payload.tags;
  const isRunnerPermission = Array.isArray(permissionTags) && permissionTags.includes("runner-permission");
  const hasQuestionControls = !isRemote && hasQuestions && parsedQuestions.length > 0 && !isRunnerPermission;
  const body = compactQueueBody(queueItem?.body || card.body);
  const tags = queueItem?.tags ?? qitemViewerData?.tags ?? [];
  const source = qitemViewerData?.source ?? card.authorSession;
  const destination = qitemViewerData?.destination;
  const actorSession = destination?.startsWith("human") ? destination : "human@host";
  const renderedOutcome = actionOutcome ?? (hasQuestionControls ? null : fallbackOutcomeFromQueueItem(card.kind, queueItem));
  const primaryToken = renderedOutcome ? outcomeToken(renderedOutcome) : KIND_TOKEN[card.kind];
  // C11 Inbox v2: the decision verbs are hidden once a decision lands
  // (outcome receipt) or the queue item is terminal. The row's footer links
  // (Show context, Live terminal, evidence, review) stay on every card:
  // actionable kinds show them always; other cards, including decided and
  // shipped ones, reveal them on hover/focus-within.
  const hideActions = renderedOutcome != null || (isTerminalQueueItem(queueItem) && !hasQuestionControls);
  // OPR.0.4.1.27 Unit 6 — sender-or-owner terminal address.
  const terminalSession = resolveCardTerminalSession(card.kind, source, destination);
  return (
    <article
      data-testid={KIND_TESTID[card.kind]}
      className="group px-4 py-3"
      {...(onDismiss
        ? {
            tabIndex: 0,
            onKeyDown: handleKeyDown,
            onTouchStart: handleTouchStart,
            onTouchEnd: handleTouchEnd,
          }
        : {})}
    >
      <div className="flex items-center gap-3">
        {/* Left status dot by kind. */}
        <StatusDot status={KIND_STATUS[card.kind]} className="shrink-0" />
        <div className="min-w-0 flex-1">
          {/* Kind label (sentence case) + event token for real event cards. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-xs text-on-surface-variant">{primaryToken.label}</span>
            {!isSyntheticFeedCard(card) ? <InlineMetaMark token={eventToken(card.source.type)} /> : null}
            {qitemViewerData?.state ? <InlineMetaMark token={queueStateToken(qitemViewerData.state)} /> : null}
          </div>
          {/* Title: text-sm font-medium. */}
          <h3 className="truncate text-sm font-medium text-on-surface">
            {card.title}
          </h3>
          {body ? (
            <>
              {/* Muted one-line body preview; expandable when multiline. */}
              <p className={`mt-0.5 text-sm text-on-surface-variant${bodyExpanded ? "" : " truncate"}`}>
                {bodyExpanded ? body : body.split("\n")[0]}
              </p>
              {body.includes("\n") && (
                <button
                  type="button"
                  data-testid={`feed-card-expand-body-${card.id}`}
                  aria-expanded={bodyExpanded}
                  onClick={() => setBodyExpanded((v) => !v)}
                  className="text-xs text-on-surface underline hover:text-on-surface-variant"
                >
                  {bodyExpanded ? "Show less" : "Show more"}
                </button>
              )}
            </>
          ) : null}
          <div className="mt-1 flex min-w-0 items-center gap-2">
            {/* Author session in mono. */}
            {card.authorSession ? (
              <AuthorAgentTag authorSession={card.authorSession} rigId={card.rigId} />
            ) : null}
            {card.hostId && card.hostId !== "local" ? (
              <span
                data-testid="feed-card-host-chip"
                className="border border-outline-variant px-1 font-mono text-[11px] text-on-surface-variant"
              >
                {card.hostId}
              </span>
            ) : null}
          </div>
        </div>
        {/* Relative time right-aligned. */}
        <InlineDateMark value={card.createdAt} />
        {onDismiss ? (
          <button
            type="button"
            data-testid="feed-card-dismiss"
            aria-label="Dismiss card"
            onClick={handleDismissClick}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center border border-outline-variant bg-surface-lowest/80 text-on-surface-variant opacity-0 transition-opacity hover:border-outline hover:text-on-surface focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-outline group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <X className="h-3 w-3" strokeWidth={1.8} />
          </button>
        ) : null}
      </div>
      {/* Row-level details + actions, below the main row. */}
      <div className="mt-2 space-y-2 pl-5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <InlineFlow source={source} destination={destination} />
        </div>
        {tags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {tags.slice(0, 6).map((tag) => <TagPill key={tag} tag={tag} />)}
          </div>
        ) : null}
        {proofPreview && proofPreview.screenshots.length > 0 ? (
          <div
            data-testid={`feed-card-proof-preview-${card.id}`}
            className="bg-background/40 p-2"
          >
            <ProofPacketHeader
              title={`Proof packet · ${proofPreview.displayName}`}
              badge={proofPreview.passFailBadge}
            />
            <div className="mt-2">
              <ProofThumbnailGrid
                sliceName={proofPreview.sliceName}
                screenshots={proofPreview.screenshots}
                onSelect={setSelectedScreenshot}
                testIdPrefix="feed-card-proof-screenshot"
              />
            </div>
          </div>
        ) : null}
        {renderedOutcome ? <ActionOutcomePanel outcome={renderedOutcome} /> : null}
        {!hideActions && qitemViewerData && (
          isActionableCard(card.kind, queueItem, renderedOutcome)
          || (hasQuestionControls && !renderedOutcome && (card.kind === "action-required" || card.kind === "approval"))
        ) ? (
          <div
            data-testid={`feed-card-actions-${card.id}`}
          >
            {/* CORRECTIVE §7.1 + founder live-review 2026-07-05: bare APPROVE
                and CHAT only. Questions require answers in the TUI: Approve would
                close the ask without returning them. Runner permission asks
                retain Approve because their runner reads that closure as allow. */}
            <div className="flex flex-wrap items-center gap-2">
              {questionsKnown && (!hasQuestions || isRunnerPermission) ? <VerbActions
                qitemId={qitemViewerData.qitemId}
                actorSession={actorSession}
                bare
                hostId={card.hostId}
                enabledVerbs={["approve"]}
                oneClickVerbs={["approve"]}
                onOptimisticOutcome={
                  onOptimisticOutcome
                    ? (outcome) => onOptimisticOutcome(qitemViewerData.qitemId, outcome)
                    : undefined
                }
              /> : hasQuestions && parsedQuestions.length > 0 ? (
                <FeedCardQuestionAsk
                  cardId={card.id}
                  qitemId={qitemViewerData.qitemId}
                  actorSession={actorSession}
                  recipientSession={destination}
                  askerSession={source}
                  questions={parsedQuestions}
                  initialAnswers={parsedAnswers}
                  queueItem={localItem}
                />
              ) : hasQuestions ? (
                <span className="font-mono text-[10px] text-on-surface-variant break-words min-w-0">
                  {card.hostId && card.hostId !== "local"
                    ? `This ask has questions. Answer in the TUI on host ${card.hostId} (rig tui).`
                    : `This ask has questions. Answer in the TUI (rig tui)${terminalSession ? `, or tell ${terminalSession} in Chat.` : "."}`}
                </span>
              ) : null}
              <button
                type="button"
                data-testid={`feed-card-chat-${card.id}`}
                disabled={!terminalSession}
                title={terminalSession ? `Chat with ${terminalSession}` : "No owning agent resolves for this card"}
                onClick={() => setChatOpen((v) => !v)}
                className="border border-outline px-3 py-1 text-[11px] hover:bg-surface-variant disabled:opacity-50"
              >
                Chat
              </button>
            </div>
            {chatOpen && terminalSession ? (
              <div className="mt-2 border border-outline-variant">
                <ProgressiveTerminal
                  sessionName={terminalSession}
                  terminalKey={`feed-chat:${card.id}`}
                  initialText={buildChatPreamble({ sessionName: terminalSession, itemRef: qitemViewerData.qitemId })}
                />
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3 text-xs text-on-surface-variant">
          <div
            data-testid={`feed-card-footer-${card.id}`}
            className={
              isActionableCard(card.kind, queueItem, renderedOutcome) && qitemViewerData
                ? "flex min-w-0 items-center gap-2"
                : "flex min-w-0 items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            }
          >
            {/* OPR.0.4.1.27 real-data fidelity — when there is no human author
                session, render nothing here. Previously this fell back to the raw
                card.source.type, which leaked the internal wrapper string
                (e.g. activity.needs_input.synthetic) user-visible. */}
            {qitemViewerData ? (
              <QueueItemTrigger
                data={qitemViewerData}
                testId={`feed-card-show-context-${card.id}`}
                className="text-xs text-on-surface underline hover:text-on-surface-variant"
              >
                Show context
              </QueueItemTrigger>
            ) : null}
            {/* OPR.0.4.1.27 Unit 6 — drill into the live terminal of the right
                seat: the SENDER for human-action cards, the current HOLDER for
                agent-owned cards (sender-or-owner resolver). Session-name keyed;
                honest disabled state when no session resolves. */}
            <FeedCardTerminalDrill cardId={card.id} sessionName={terminalSession} />
            {/* OPR.0.4.4.20 FR-9 win #2: the evidence_ref judge-this pointer is
                visible on the card itself — the human sees WHAT to judge before
                drilling anywhere. */}
            {card.evidenceRef ? (
              <span
                data-testid={`feed-card-evidence-${card.id}`}
                title={card.evidenceRef}
                className="max-w-48 truncate font-mono text-[11px] text-on-surface-variant"
              >
                evidence: {card.evidenceRef}
              </span>
            ) : null}
            {/* OPR.0.4.4.20 FR-9 win #1: living-notes cards deep-link into the
                slice Review tab anchored at this NEEDS-YOU item. Non-living-notes
                cards keep the existing drills unchanged (additive routing). */}
            {card.reviewSlice ? (
              <Link
                to="/project/slice/$sliceId"
                params={{ sliceId: card.reviewSlice }}
                hash={card.reviewAnchor ? `needs-you-${card.reviewAnchor}` : undefined}
                data-testid={`feed-card-review-link-${card.id}`}
                className="text-xs underline text-on-surface hover:text-on-surface-variant"
              >
                review →
              </Link>
            ) : null}
          </div>
        </div>
      </div>
      {proofPreview ? (
        <ProofImageViewer
          sliceName={proofPreview.sliceName}
          relPath={selectedScreenshot}
          onClose={() => setSelectedScreenshot(null)}
        />
      ) : null}
    </article>
  );
}
