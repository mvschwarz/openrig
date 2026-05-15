import { useRef, useState } from "react";
import { ArrowRight, CalendarDays, CircleAlert, Clock, History, PackageCheck, X } from "lucide-react";

import { CornerBracket } from "../dashboard/vellum/index.js";
import { AuthorAgentTag } from "./AuthorAgentTag.js";
import { QueueItemTrigger } from "../drawer-triggers/QueueItemTrigger.js";
import type { QueueItemViewerData } from "../drawer-viewers/QueueItemViewer.js";
import type { QueueItemDetail } from "../../hooks/useSlices.js";
import type { FeedCard as FeedCardModel, FeedCardKind } from "../../lib/feed-classifier.js";
import { VerbActions } from "../mission-control/components/VerbActions.js";
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
 * Vellum-coherent kind indicator. Mono uppercase tag + leading colored
 * dot, mapped to the design tokens (success / warning / tertiary /
 * secondary / stone-500). Replaces the old colored-pill chrome.
 */
const KIND_DOT: Record<FeedCardKind, string> = {
  "action-required": "bg-tertiary",
  approval: "bg-warning",
  shipped: "bg-success",
  progress: "bg-secondary",
  observation: "bg-stone-500",
};

const TONE_DOT: Record<ProjectMetaTone, string> = {
  neutral: "bg-stone-500",
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
  "action-required": { label: "Your turn", tone: "danger", icon: CircleAlert },
  approval: { label: "Needs approval", tone: "warning", icon: CircleAlert },
  shipped: { label: "Shipped", tone: "success", icon: PackageCheck },
  progress: { label: "Progress", tone: "info", icon: History },
  observation: { label: "Observation", tone: "neutral", icon: Clock },
};

/**
 * Card surface — vellum-coherent. Matches CardShell in
 * storytelling-cards.tsx so /for-you reads as one surface.
 *   bg-stone-100/45 + backdrop-blur-[10px]
 *   ambient 3-stop box-shadow defines the card edges through the vellum
 *   no left-stripe, no outline border
 */
const CARD_SURFACE_CLASS =
  "relative bg-stone-100/45 backdrop-blur-[10px] overflow-hidden group";
const CARD_SHADOW_STYLE: React.CSSProperties = {
  boxShadow: [
    "0 2px 4px rgba(0, 0, 0, 0.14)",
    "0 8px 20px rgba(0, 0, 0, 0.16)",
    "0 0 40px rgba(0, 0, 0, 0.12)",
  ].join(", "),
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

/** Inline meta mark: mono uppercase pill replacement — colored dot + label. */
function InlineMetaMark({ token }: { token: ProjectToken }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-stone-700">
      <span aria-hidden="true" className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", TONE_DOT[token.tone])} />
      {token.label}
    </span>
  );
}

function InlineDateMark({ value }: { value: string | undefined | null }) {
  return (
    <time
      dateTime={value ?? undefined}
      className="inline-flex items-center gap-1 font-mono text-[10px] text-stone-500"
    >
      <CalendarDays className="h-3 w-3" strokeWidth={1.5} />
      {formatFriendlyDate(value)}
    </time>
  );
}

function InlineActor({ session }: { session: string | undefined | null }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[10px] text-stone-600">
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
      <ArrowRight className="h-3.5 w-3.5 text-stone-400" strokeWidth={1.4} />
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
 *   subtle bg-stone-50/40 across all tones
 *   leading colored dot indicates the tone, NOT the whole strip color
 */
function ActionOutcomePanel({ outcome }: { outcome: FeedActionOutcome }) {
  const meta = ACTION_VERB_META[outcome.verb];
  const Icon = meta.icon;
  return (
    <div
      data-testid="feed-card-action-outcome"
      className="mt-3 bg-stone-50/40 px-3 py-2"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span aria-hidden="true" className={cn("mt-2 inline-block w-1.5 h-1.5 rounded-full shrink-0", TONE_DOT[meta.tone])} />
          <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/55 text-stone-800">
            <Icon className="h-4 w-4" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-stone-700">
              {meta.outcomeLabel}
            </div>
            <div className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-stone-500">
              Decision recorded
            </div>
          </div>
        </div>
        <InlineDateMark value={outcome.actedAt} />
      </div>
      <p className="mt-3 font-body text-[12px] leading-relaxed text-stone-800">
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
}: {
  card: FeedCardModel;
  queueItem?: QueueItemDetail;
  proofPreview?: FeedProofPreview | null;
  actionOutcome?: FeedActionOutcome | null;
  onDismiss?: (seq: number) => void;
}) {
  const [selectedScreenshot, setSelectedScreenshot] = useState<string | null>(null);
  const dragStateRef = useRef<{ startX: number; pointerId: number; isTouch: boolean } | null>(null);

  const handleKeyDown: React.KeyboardEventHandler<HTMLElement> = (event) => {
    if (!onDismiss) return;
    if (event.target !== event.currentTarget) return;
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      onDismiss(card.source.seq);
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
      onDismiss(card.source.seq);
    }
  };

  const handleDismissClick: React.MouseEventHandler<HTMLButtonElement> = (event) => {
    event.stopPropagation();
    if (!onDismiss) return;
    onDismiss(card.source.seq);
  };
  const qitemViewerData = qitemViewerDataFromItem(card, queueItem);
  const body = compactQueueBody(queueItem?.body || card.body);
  const tags = queueItem?.tags ?? qitemViewerData?.tags ?? [];
  const source = qitemViewerData?.source ?? card.authorSession;
  const destination = qitemViewerData?.destination;
  const actorSession = destination?.startsWith("human") ? destination : "human@host";
  const renderedOutcome = actionOutcome ?? fallbackOutcomeFromQueueItem(card.kind, queueItem);
  const primaryToken = renderedOutcome ? outcomeToken(renderedOutcome) : KIND_TOKEN[card.kind];
  const primaryDotClass = renderedOutcome
    ? TONE_DOT[primaryToken.tone]
    : KIND_DOT[card.kind];
  return (
    <article
      data-testid={KIND_TESTID[card.kind]}
      style={CARD_SHADOW_STYLE}
      className={cn(CARD_SURFACE_CLASS, "mb-3")}
      {...(onDismiss
        ? {
            tabIndex: 0,
            onKeyDown: handleKeyDown,
            onTouchStart: handleTouchStart,
            onTouchEnd: handleTouchEnd,
          }
        : {})}
    >
      {/* 4 corner brackets — register the card bounds through the vellum
          without a hard border. */}
      <CornerBracket position="tl" />
      <CornerBracket position="tr" />
      <CornerBracket position="bl" />
      <CornerBracket position="br" />

      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {/* Kind tag — mono uppercase + leading colored dot. Replaces
                  the old colored-pill chrome. */}
              <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-stone-700">
                <span aria-hidden="true" className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", primaryDotClass)} />
                {primaryToken.label}
              </span>
              <InlineMetaMark token={eventToken(card.source.type)} />
              {qitemViewerData?.state ? <InlineMetaMark token={queueStateToken(qitemViewerData.state)} /> : null}
            </div>
            {/* Title — legibility north star: 16px headline bold. */}
            <h3 className="font-headline text-[16px] font-bold leading-tight text-stone-900 truncate">
              {card.title}
            </h3>
          </div>
          <div className="flex items-start gap-2">
            <InlineDateMark value={card.createdAt} />
            {onDismiss ? (
              <button
                type="button"
                data-testid="feed-card-dismiss"
                aria-label="Dismiss card"
                onClick={handleDismissClick}
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-stone-400 transition-opacity inline-flex h-5 w-5 items-center justify-center border border-stone-300 bg-white/80 text-stone-600 hover:text-stone-900 hover:border-stone-500"
              >
                <X className="h-3 w-3" strokeWidth={1.8} />
              </button>
            ) : null}
          </div>
        </div>
        {body ? (
          // Qitem / event body is prose. 12px body for legibility.
          <p className="mt-3 font-body text-[12px] leading-relaxed text-stone-700 whitespace-pre-line">
            {body}
          </p>
        ) : null}
        <div className="mt-3">
          <InlineFlow source={source} destination={destination} />
        </div>
        {tags.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tags.slice(0, 6).map((tag) => <TagPill key={tag} tag={tag} />)}
          </div>
        ) : null}
        {proofPreview && proofPreview.screenshots.length > 0 ? (
          <div
            data-testid={`feed-card-proof-preview-${card.id}`}
            className="mt-3 bg-stone-50/40 p-2"
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
        {qitemViewerData && isActionableCard(card.kind, queueItem, renderedOutcome) ? (
          <div
            data-testid={`feed-card-actions-${card.id}`}
            className="mt-3 bg-stone-50/40 p-3"
          >
            <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-stone-700">
                  <span aria-hidden="true" className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", TONE_DOT.danger)} />
                  Your turn
                </div>
                <p className="mt-1 max-w-xl font-body text-[12px] leading-relaxed text-stone-700">
                  Review the context, then approve, deny, or route this queue item.
                </p>
              </div>
            </div>
            <VerbActions
              qitemId={qitemViewerData.qitemId}
              actorSession={actorSession}
              enabledVerbs={["approve", "deny", "route"]}
            />
          </div>
        ) : null}
        <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[10px] text-stone-500">
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
