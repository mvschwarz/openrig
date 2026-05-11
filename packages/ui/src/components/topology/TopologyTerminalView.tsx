// V1 attempt-3 Phase 5 P5-7 — Topology terminal grid view.
//
// Per topology-terminal-view.md L13-L80: pinned-card grid where each card
// is a transcript-tail preview of an agent's terminal output. V1 reuses
// the existing SessionPreviewPane primitive (preserved per code-map AFTER
// tree). V2 ships interactive xterm.js + tmux-attach (out of scope here).
//
// Key behaviors (canon-load-bearing):
//   - Pulsing-ring on cards whose agent is "running" (active recently)
//     per topology-terminal-view.md L47 — at-a-glance scan signal
//     ("humans must be able to spot which agents to attend to without
//     reading every card"). CSS keyframe is pseudo-element-paint
//     (jsdom-incompatible) so a CSS-source-assertion test guards it.
//   - safe-N pagination at host scope (L70-L80): default 12 cards;
//     "show all N" toggle for operators who need the full grid.
//   - Polling cadence: SessionPreviewPane uses useSessionPreview which
//     respects the configured ui.preview.refresh_interval_seconds
//     (default 3s). Per L60-L65, larger scopes = lower frequency; the
//     existing config covers it.

import { useMemo, useState } from "react";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { useNodeInventory, type NodeInventoryEntry } from "../../hooks/useNodeInventory.js";
import { displayAgentName } from "../../lib/display-name.js";
import { SessionPreviewPane } from "../preview/SessionPreviewPane.js";
import { EmptyState } from "../ui/empty-state.js";
import { SectionHeader } from "../ui/section-header.js";
import { cn } from "../../lib/utils.js";
import { RuntimeBadge } from "../graphics/RuntimeMark.js";
import { formatCompactTokenCount, formatTokenTotalTitle, sumTokenCounts } from "../../lib/token-format.js";
import { contextUsageTextClass } from "../ContextUsageRing.js";
import { TerminalPreviewPopover } from "./TerminalPreviewPopover.js";

const SAFE_N = 12;

interface TopologyTerminalViewProps {
  scope: "host" | "rig" | "pod";
  /** Required for rig + pod scopes. */
  rigId?: string;
  /** Required for pod scope. */
  podName?: string;
}

function isActiveRunning(seat: NodeInventoryEntry): boolean {
  // Per topology-terminal-view.md L47: pulsing-ring on cards for "active"
  // agents (output emitted within polling window). The PL-019 agentActivity
  // summary's "running" state is the closest available proxy.
  return seat.agentActivity?.state === "running";
}

function ContextMetric({ seat }: { seat: NodeInventoryEntry }) {
  const usage = seat.contextUsage;
  const known = usage?.availability === "known" && typeof usage.usedPercentage === "number";
  return (
    <span
      data-testid={`terminal-card-context-${seat.rigId}-${seat.logicalId}`}
      className={`font-mono text-[8px] font-bold uppercase tracking-wide ${contextUsageTextClass(usage?.usedPercentage, usage?.fresh, usage?.availability)}`}
      title={
        known
          ? usage?.fresh === false
            ? "Context usage (stale sample)"
            : "Context usage (fresh)"
          : "Context sample unavailable"
      }
    >
      {known ? `${usage.usedPercentage}%` : "--"}
    </span>
  );
}

function TokenMetric({ seat }: { seat: NodeInventoryEntry }) {
  const usage = seat.contextUsage;
  const total = sumTokenCounts(usage?.totalInputTokens, usage?.totalOutputTokens);
  const label = formatCompactTokenCount(total);
  const title = formatTokenTotalTitle(usage?.totalInputTokens, usage?.totalOutputTokens);
  return (
    <span
      data-testid={`terminal-card-tokens-${seat.rigId}-${seat.logicalId}`}
      className={`font-mono text-[8px] font-bold uppercase tracking-wide ${label ? "text-stone-500" : "text-stone-300"}`}
      title={title ?? "Token sample unavailable"}
    >
      {label ?? "--"}
    </span>
  );
}

// V0.3.1 slice 14 walk-item 17 — TerminalView card.
// Click-through opens TerminalPreviewPopover (same black-glass shell
// used by the graph view), and the card font shrinks via the existing
// type scale: header text-[10px] → text-[8px] (~20% reduction). The
// preview pane font hint scales with parent.
const TERMINAL_PREVIEW_EVENT = "openrig:topology-terminal-preview";

function SeatTerminalCard({ seat }: { seat: NodeInventoryEntry }) {
  const sessionName = seat.canonicalSessionName ?? seat.logicalId;
  const active = isActiveRunning(seat);
  const memberName = displayAgentName(seat.logicalId);
  const previewKey = `${seat.rigId ?? "unknown"}:${seat.logicalId}`;
  const handleCardClick = () => {
    window.dispatchEvent(
      new CustomEvent(TERMINAL_PREVIEW_EVENT, { detail: { key: previewKey } }),
    );
  };
  return (
    <div
      data-testid={`terminal-card-${seat.rigId}-${seat.logicalId}`}
      data-active={active ? "true" : "false"}
      className={cn(
        "relative border bg-white/40 p-2 flex flex-col gap-2",
        active
          ? "border-secondary terminal-card-active"
          : "border-outline-variant",
      )}
    >
      <button
        type="button"
        onClick={handleCardClick}
        aria-label={`Open ${memberName} terminal preview`}
        className="absolute inset-0 z-10 cursor-pointer bg-transparent focus:outline-none focus:ring-2 focus:ring-stone-900/20"
        data-testid={`terminal-card-trigger-${seat.rigId}-${seat.logicalId}`}
      />
      {/*
        TerminalPreviewPopover renders its own sr-only button + popover
        portal. The card-level button above dispatches the open event;
        this component listens for the matching key + renders the
        positioned popover anchored to the wrapper div (top-right of
        the card via wrapperClassName).
      */}
      {seat.rigId ? (
        <TerminalPreviewPopover
          rigId={seat.rigId}
          logicalId={seat.logicalId}
          sessionName={sessionName}
          reducedMotion={false}
          testIdPrefix={`terminal-grid-${seat.rigId}-${seat.logicalId}`}
          wrapperClassName="absolute right-1 top-1 z-20"
          buttonClassName="sr-only"
        />
      ) : null}
      <header className="relative z-0 flex items-center justify-between gap-2 pointer-events-none">
        <span className="font-mono text-[8px] font-semibold uppercase tracking-[0.10em] text-stone-900 truncate">
          {memberName}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1">
          <RuntimeBadge runtime={seat.runtime} size="xs" compact variant="inline" />
          <ContextMetric seat={seat} />
          <TokenMetric seat={seat} />
        </span>
      </header>
      <div className="relative z-0 pointer-events-none">
        <SessionPreviewPane
          sessionName={sessionName}
          lines={20}
          testIdPrefix={`terminal-preview-${seat.rigId}-${seat.logicalId}`}
        />
      </div>
    </div>
  );
}

function TerminalGrid({
  seats,
  emptyLabel,
  emptyDescription,
}: {
  seats: NodeInventoryEntry[];
  emptyLabel: string;
  emptyDescription: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? seats : seats.slice(0, SAFE_N);
  const hasMore = seats.length > SAFE_N;

  if (seats.length === 0) {
    return (
      <EmptyState
        label={emptyLabel}
        description={emptyDescription}
        variant="card"
        testId="topology-terminal-empty"
      />
    );
  }

  return (
    <div data-testid="topology-terminal-grid" className="space-y-3">
      <div className="font-mono text-[9px] text-on-surface-variant flex items-center justify-between">
        <span data-testid="topology-terminal-count">
          showing {visible.length} of {seats.length} terminal{seats.length === 1 ? "" : "s"}
        </span>
        {hasMore ? (
          <button
            type="button"
            data-testid="topology-terminal-show-toggle"
            onClick={() => setShowAll((s) => !s)}
            className="px-2 py-0.5 border border-outline-variant font-mono text-[9px] uppercase tracking-wide text-stone-700 hover:bg-stone-100/60"
          >
            {showAll ? `show first ${SAFE_N}` : `show all ${seats.length}`}
          </button>
        ) : null}
      </div>
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {visible.map((seat) => (
          <SeatTerminalCard
            key={`${seat.rigId}-${seat.logicalId}`}
            seat={seat}
          />
        ))}
      </div>
    </div>
  );
}

function RigTerminalSection({ rigId, rigName }: { rigId: string; rigName: string }) {
  const { data: nodes } = useNodeInventory(rigId);
  const seats = useMemo(
    () => (nodes ?? []).filter((n) => n.nodeKind !== "infrastructure"),
    [nodes],
  );
  if (seats.length === 0) return null;
  return (
    <section
      data-testid={`topology-terminal-rig-${rigId}`}
      className="border-t border-outline-variant pt-4 first:border-t-0 first:pt-0"
    >
      <SectionHeader tone="muted">{rigName}</SectionHeader>
      <div className="mt-2">
        <TerminalGrid
          seats={seats}
          emptyLabel="NO SEATS"
          emptyDescription={`No agent seats in ${rigName}.`}
        />
      </div>
    </section>
  );
}

export function TopologyTerminalView({ scope, rigId, podName }: TopologyTerminalViewProps) {
  const { data: rigs } = useRigSummary();
  const { data: rigNodes } = useNodeInventory(scope !== "host" ? (rigId ?? null) : null);

  if (scope === "host") {
    if (!rigs || rigs.length === 0) {
      return (
        <div className="p-6">
          <EmptyState
            label="NO RIGS"
            description="No rigs registered. Register a rig to see terminals at host scope."
            variant="card"
            testId="topology-terminal-empty"
          />
        </div>
      );
    }
    return (
      <div data-testid="topology-terminal-host" className="p-6 space-y-6">
        {rigs.map((r) => (
          <RigTerminalSection key={r.id} rigId={r.id} rigName={r.name} />
        ))}
      </div>
    );
  }

  // Rig + Pod scopes share the same single-rig data source; pod filters by
  // podName.
  const seatsAll = (rigNodes ?? []).filter((n) => n.nodeKind !== "infrastructure");
  const seats =
    scope === "pod" && podName
      ? seatsAll.filter((s) => (s.podNamespace ?? s.podId) === podName)
      : seatsAll;

  return (
    <div data-testid={`topology-terminal-${scope}`} className="p-6">
      <TerminalGrid
        seats={seats}
        emptyLabel="NO SEATS"
        emptyDescription={
          scope === "pod"
            ? `No agent seats in pod ${podName}.`
            : "No agent seats in this rig."
        }
      />
    </div>
  );
}
