import { useState } from "react";
import { CheckCircle2, CircleAlert, Clock, FilePenLine, History, PackageCheck, Route, Trash2, X } from "lucide-react";

import { VellumCard } from "../ui/vellum-card.js";
import { AuthorAgentTag } from "./AuthorAgentTag.js";
import { QueueItemTrigger } from "../drawer-triggers/QueueItemTrigger.js";
import type { QueueItemViewerData } from "../drawer-viewers/QueueItemViewer.js";
import type { QueueItemDetail } from "../../hooks/useSlices.js";
import type { FeedCard as FeedCardModel, FeedCardKind } from "../../lib/feed-classifier.js";
import { VerbActions } from "../mission-control/components/VerbActions.js";
import {
  DateChip,
  FlowChips,
  ProjectPill,
  ProofPacketHeader,
  ProofThumbnailGrid,
  TagPill,
  type ProjectToken,
} from "../project/ProjectMetaPrimitives.js";
import { ProofImageViewer } from "../project/ProofImageViewer.js";
import type { MissionControlVerb } from "../mission-control/hooks/useMissionControlAction.js";

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

const KIND_TOKEN: Record<FeedCardKind, ProjectToken> = {
  "action-required": { label: "Action required", tone: "danger", icon: CircleAlert },
  approval: { label: "Approval", tone: "warning", icon: CircleAlert },
  shipped: { label: "Shipped", tone: "success", icon: PackageCheck },
  progress: { label: "Progress", tone: "info", icon: History },
  observation: { label: "Observation", tone: "neutral", icon: Clock },
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
  switch (outcome.verb) {
    case "approve":
      return { label: "Approved", tone: "success", icon: CheckCircle2 };
    case "deny":
      return { label: "Denied", tone: "danger", icon: X };
    case "route":
    case "handoff":
      return { label: "Routed", tone: "info", icon: Route };
    case "hold":
      return { label: "Held", tone: "warning", icon: Clock };
    case "drop":
      return { label: "Dropped", tone: "neutral", icon: Trash2 };
    case "annotate":
      return { label: "Annotated", tone: "neutral", icon: FilePenLine };
  }
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

function ActionOutcomePanel({ outcome }: { outcome: FeedActionOutcome }) {
  return (
    <div
      data-testid="feed-card-action-outcome"
      className="mt-3 border border-outline-variant bg-white/35 p-2 backdrop-blur-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ProjectPill token={outcomeToken(outcome)} />
        <DateChip value={outcome.actedAt} />
      </div>
      <p className="mt-2 font-mono text-[11px] leading-relaxed text-stone-700">
        {outcomeSentence(outcome)}
      </p>
      {(outcome.verb === "route" || outcome.verb === "handoff") && outcome.destinationSession ? (
        <div className="mt-2">
          <FlowChips source={outcome.actorSession} destination={outcome.destinationSession} muted />
        </div>
      ) : null}
    </div>
  );
}

export function FeedCard({
  card,
  queueItem,
  proofPreview,
  actionOutcome,
}: {
  card: FeedCardModel;
  queueItem?: QueueItemDetail;
  proofPreview?: FeedProofPreview | null;
  actionOutcome?: FeedActionOutcome | null;
}) {
  const [selectedScreenshot, setSelectedScreenshot] = useState<string | null>(null);
  const qitemViewerData = qitemViewerDataFromItem(card, queueItem);
  const body = compactQueueBody(queueItem?.body || card.body);
  const tags = queueItem?.tags ?? qitemViewerData?.tags ?? [];
  const source = qitemViewerData?.source ?? card.authorSession;
  const destination = qitemViewerData?.destination;
  const actorSession = destination?.startsWith("human") ? destination : "human@host";
  const renderedOutcome = actionOutcome ?? fallbackOutcomeFromQueueItem(card.kind, queueItem);
  return (
    <VellumCard
      as="article"
      testId={KIND_TESTID[card.kind]}
      accentClass={KIND_ACCENT[card.kind]}
      className="mb-3 bg-white/50 backdrop-blur-sm"
    >
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <ProjectPill token={KIND_TOKEN[card.kind]} />
            <h3 className="font-mono text-sm text-stone-900 truncate">
              {card.title}
            </h3>
          </div>
          <DateChip value={card.createdAt} />
        </div>
        {body ? (
          <p className="mt-3 font-mono text-xs leading-relaxed text-on-surface-variant whitespace-pre-line">
            {body}
          </p>
        ) : null}
        <div className="mt-3">
          <FlowChips source={source} destination={destination} muted />
        </div>
        {tags.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tags.slice(0, 6).map((tag) => <TagPill key={tag} tag={tag} />)}
          </div>
        ) : null}
        {proofPreview && proofPreview.screenshots.length > 0 ? (
          <div
            data-testid={`feed-card-proof-preview-${card.id}`}
            className="mt-3 border border-outline-variant bg-white/35 p-2 backdrop-blur-sm"
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
            className="mt-3 border border-outline-variant bg-white/35 p-2 backdrop-blur-sm"
          >
            <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.12em] text-stone-600">
              Actions
            </div>
            <VerbActions
              qitemId={qitemViewerData.qitemId}
              actorSession={actorSession}
              enabledVerbs={["approve", "deny", "route"]}
            />
          </div>
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
        </div>
      </div>
      {proofPreview ? (
        <ProofImageViewer
          sliceName={proofPreview.sliceName}
          relPath={selectedScreenshot}
          onClose={() => setSelectedScreenshot(null)}
        />
      ) : null}
    </VellumCard>
  );
}
