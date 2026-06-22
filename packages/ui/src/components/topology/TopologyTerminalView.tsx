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
import { TerminalPreviewPopover } from "./TerminalPreviewPopover.js";
import { StaticTerminalPlate } from "../terminal/StaticTerminalPlate.js";
import { EmptyState } from "../ui/empty-state.js";
import { SectionHeader } from "../ui/section-header.js";
import { cn } from "../../lib/utils.js";
import { RuntimeBadge } from "../graphics/RuntimeMark.js";
import { formatCompactTokenCount, formatTokenTotalTitle, sumTokenCounts } from "../../lib/token-format.js";
import { contextUsageTextClass } from "../ContextUsageRing.js";

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
// OPR.0.4.0.1 (FR-5 founder amendment — RECONCILES the merged live-in-place model):
// a TUI-optimal-width live terminal does NOT fit a 1/3-width grid cell, so the card
// keeps a SMALL static thumbnail (the 3-col overview stays an at-a-glance scan) and
// reaches the wide LIVE terminal by EXPANDING OUT via the SAME graph/table primitive
// (TerminalPreviewPopover): the trigger opens the wide popover (static), then the
// universal click-inside goes live. This REPLACES the prior live-in-place model so
// every surface (graph/table/grid) opens live the same way. The global cap=2 binds
// on the inside go-live (2 wide live plates max; a 3rd evicts the oldest); static
// thumbnails + open popovers are uncapped. The pulsing-ring active treatment is
// preserved.

function SeatTerminalCard({ seat }: { seat: NodeInventoryEntry }) {
  const sessionName = seat.canonicalSessionName ?? seat.logicalId;
  const active = isActiveRunning(seat);
  const memberName = displayAgentName(seat.logicalId);
  return (
    <div
      data-testid={`terminal-card-${seat.rigId}-${seat.logicalId}`}
      data-active={active ? "true" : "false"}
      className={cn(
        // OPR.0.4.0.39 FR-4: tighter card padding + gaps so the grid does not
        // waste edge space (was p-2/gap-2).
        "relative border bg-white/40 p-1.5 flex flex-col gap-1.5",
        active
          ? "border-secondary terminal-card-active"
          : "border-outline-variant",
      )}
    >
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
      <div className="relative z-0 min-h-0 flex items-start gap-1.5">
        {/* OPR.0.4.0.39 FR-1: a SMALL static thumbnail keeps the grid an
            at-a-glance overview -- NOT widened to TUI width. It uses the SHARED
            StaticTerminalPlate (smoked-glass plate + OPAQUE #0c0a09 compact
            content, mirroring the live look) so every static terminal is
            consistent. Click-to-live here is the separate TerminalPreviewPopover
            trigger (expand-out), so the plate itself is non-interactive.
            FR-3: origin-top-left + a per-breakpoint CSS scale-down renders the
            fixed-shape terminal (whitespace-pre, never reflowed) smaller so more
            of it fits the densest 3-col cells, mirroring the live fixed-geometry
            scale (FocusedTerminal pins 120x40, no fit/reflow). The scale VALUE is
            legibility-floored and QA-screenshot-measured at each breakpoint; the
            xl:scale-90 here is the starting value (forward-fix per QA). */}
        <StaticTerminalPlate
          sessionName={sessionName}
          lines={6}
          plateTestId={`terminal-grid-${seat.rigId}-${seat.logicalId}-thumb-plate`}
          previewTestIdPrefix={`terminal-grid-${seat.rigId}-${seat.logicalId}-thumb`}
          className="min-w-0 flex-1 overflow-hidden origin-top-left scale-100 xl:scale-90"
        />
        {/* OPR.0.4.0.1 (FR-5 PINNED expand-OUT): the wide LIVE plate is reached via
            the SAME graph/table primitive -- the TerminalPreviewPopover trigger
            opens the wide popover (static), then the universal click-inside goes
            live. cap=2 binds on that inside go-live (2 wide live plates max; a 3rd
            evicts the oldest). This REPLACES the prior live-in-place model so all
            surfaces (graph/table/grid) open live the same way; no new primitive. */}
        <TerminalPreviewPopover
          rigId={seat.rigId}
          logicalId={seat.logicalId}
          sessionName={sessionName}
          testIdPrefix={`terminal-grid-${seat.rigId}-${seat.logicalId}`}
          progressive
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
      {/* OPR.0.4.0.39 FR-2: responsive 1/2/3-col by browser width; 3-col moves to
          the wider `xl` breakpoint (was `lg`) so a scaled real-terminal static
          fits 3-across cleanly without cramping. FR-4: tighter inter-card gap. */}
      <div className="grid gap-2 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
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
