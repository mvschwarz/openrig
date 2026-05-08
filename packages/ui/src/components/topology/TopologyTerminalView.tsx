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

function SeatTerminalCard({ seat }: { seat: NodeInventoryEntry }) {
  const sessionName = seat.canonicalSessionName ?? seat.logicalId;
  const active = isActiveRunning(seat);
  const memberName = displayAgentName(seat.logicalId);
  return (
    <div
      data-testid={`terminal-card-${seat.rigId}-${seat.logicalId}`}
      data-active={active ? "true" : "false"}
      className={cn(
        "border bg-white/40 p-2 flex flex-col gap-2",
        active
          ? "border-secondary terminal-card-active"
          : "border-outline-variant",
      )}
    >
      <header className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.10em] text-stone-900 truncate">
          {memberName}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1">
          <RuntimeBadge runtime={seat.runtime} size="xs" compact variant="inline" />
          {typeof seat.contextUsage?.usedPercentage === "number" ? (
            <span className="font-mono text-[8px] uppercase tracking-wide text-on-surface-variant">
              {seat.contextUsage.usedPercentage}%
            </span>
          ) : null}
        </span>
      </header>
      <SessionPreviewPane
        sessionName={sessionName}
        lines={20}
        testIdPrefix={`terminal-preview-${seat.rigId}-${seat.logicalId}`}
      />
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
