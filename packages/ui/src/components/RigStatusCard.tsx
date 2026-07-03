// OPR.0.4.3.22 — the reusable rig-status card. Renders the COMPOSED backend
// aggregate (up / partial / down / blocked / unknown), NOT inferred from pane
// text. Used in two places: the dashboard kernel-status card and the topology
// rig control. The card exposes ONE primary recovery/launch action (opens the
// launch/recovery modal); terminal-surface actions (Open topology / CMUX) live
// SEPARATELY, never on this card (guard 5).
//
// The status badge CONSUMES the backend verdict in its rendered tone — a
// non-`up` status renders non-green (the 19/21 lesson: render the verdict, don't
// default to green while carrying it in data).

import { Hexagon, Server } from "lucide-react";
import { StatusPip, type StatusPipStatus } from "./ui/status-pip.js";
import { Button } from "./ui/button.js";
import { cn } from "../lib/utils.js";
import type { RigAggStatus } from "../hooks/useRigStatus.js";

const statusToPip: Record<RigAggStatus, StatusPipStatus> = {
  up: "running",
  partial: "warning",
  down: "stopped",
  blocked: "error",
  unknown: "info",
};

const statusBadgeTone: Record<RigAggStatus, string> = {
  up: "border-success text-success",
  partial: "border-warning text-warning",
  down: "border-stone-400 text-stone-500",
  blocked: "border-tertiary text-tertiary",
  unknown: "border-stone-300 text-stone-400",
};

const statusHelp: Record<RigAggStatus, string> = {
  up: "All managed seats are running.",
  partial: "Some seats running, some stopped / detached / attention-required.",
  down: "No seats running — recoverable from snapshot.",
  blocked: "Restore cannot proceed without operator action (missing token / auth / spec).",
  unknown: "Daemon/API cannot confidently compute the state.",
};

export interface RigStatusCardProps {
  rigId: string;
  rigName: string;
  isKernel?: boolean;
  status: RigAggStatus;
  seatsRunning: number;
  seatsTotal: number;
  recoverable: boolean;
  /** The composed provenance line(s) — visible so the state is legible, not just a color. */
  src: string[];
  primaryLabel: string;
  onPrimary?: () => void;
  /** Override the enablement (e.g. the kernel card disables restore when no
   *  kernel rig exists — the double-instantiation guard). Defaults to disabled
   *  only when the rig is already `up`. */
  primaryDisabled?: boolean;
  testId?: string;
}

export function RigStatusCard({
  rigId,
  rigName,
  isKernel = false,
  status,
  seatsRunning,
  seatsTotal,
  recoverable,
  src,
  primaryLabel,
  onPrimary,
  primaryDisabled,
  testId,
}: RigStatusCardProps) {
  const pip = statusToPip[status];
  const disabled = primaryDisabled ?? status === "up";

  return (
    <div
      data-testid={testId ?? `rig-status-card-${rigId}`}
      data-status={status}
      className="bg-white border border-stone-900 hard-shadow relative"
    >
      {/* Dark header stripe — vellum grammar (matches RigCard). */}
      <div className="bg-stone-900 text-white px-4 py-1.5 font-mono text-[10px] flex justify-between items-center">
        <span>{isKernel ? "KERNEL RIG" : `RIG: ${rigName.toUpperCase()}`}</span>
        {isKernel ? <Hexagon className="h-3 w-3" /> : <Server className="h-3 w-3" />}
      </div>

      <div className="p-4 space-y-3">
        {/* Name + aggregate status badge (the badge tone CONSUMES the verdict). */}
        <div className="flex justify-between items-end border-b border-stone-100 pb-2">
          <span className="font-headline font-bold text-lg tracking-tight uppercase">{rigName}</span>
          <span
            data-testid={`rig-status-badge-${rigId}`}
            className={cn(
              "px-2 py-0.5 border font-mono text-[9px] uppercase tracking-wide inline-flex items-center gap-1.5",
              statusBadgeTone[status],
            )}
          >
            <StatusPip status={pip} />
            {status}
          </span>
        </div>

        {/* One-line meaning of the status. */}
        <p className="font-mono text-[9px] leading-relaxed text-secondary">{statusHelp[status]}</p>

        {/* Telemetry grid. */}
        <div className="space-y-1">
          <div className="flex justify-between font-mono text-[9px] text-secondary">
            <span>SEATS RUNNING</span>
            <span data-testid={`seats-${rigId}`}>
              {seatsRunning}/{seatsTotal}
            </span>
          </div>
          <div className="flex justify-between font-mono text-[9px] text-secondary">
            <span>RECOVERABLE</span>
            <span>{recoverable ? "yes" : "no — needs operator"}</span>
          </div>
        </div>

        {/* Primary recovery/launch action — the ONE thing this card does. */}
        <div className="pt-1">
          <Button
            variant={status === "blocked" ? "destructive" : "default"}
            size="sm"
            disabled={disabled}
            onClick={onPrimary}
            data-testid={`rig-primary-action-${rigId}`}
            className="w-full font-mono text-[10px] tracking-widest"
          >
            {status === "up" ? "RUNNING" : primaryLabel}
          </Button>
        </div>

        {/* Provenance — the composed source signals (composed, not inferred). */}
        <p
          data-testid={`rig-status-src-${rigId}`}
          className="font-mono text-[8px] leading-snug text-stone-400 border-t border-stone-100 pt-2"
        >
          src: {src.join(" · ")}
        </p>
      </div>
    </div>
  );
}
