// OPR.0.4.7.1 — the topology rig-status control: a COMPACT status badge +
// launch button that opens the existing LaunchRecoveryModal.
//
// Replaces the inline RigStatusCard mount, which rendered as a large
// left-anchored card underneath the topology explorer overlay (reproduced:
// the card started at x335 with its left half, text, and action obscured).
// RigStatusCard itself is untouched — the dashboard kernel card still uses
// it (OPR.0.4.3.22). Terminal-surface actions (Open in terminal) still live
// SEPARATELY in the tab bar and never restore or fresh-prime (guard 5).
//
// The control stays a BUTTON in every state — status=up opens the modal too:
// the modal is plan-before-mutation (a read-only forecast on open), so
// opening it while up is safe, and a control that sometimes isn't clickable
// reads as broken. The one-line status meaning rides the badge tooltip.

import { useState } from "react";
import { LaunchRecoveryModal } from "./LaunchRecoveryModal.js";
import { statusBadgeTone, statusHelp, statusToPip } from "./RigStatusCard.js";
import { StatusPip } from "./ui/status-pip.js";
import { Button } from "./ui/button.js";
import { cn } from "../lib/utils.js";
import { useRigStatus } from "../hooks/useRigStatus.js";

export function RigStatusControl({ rigId, rigName }: { rigId: string; rigName: string }) {
  const { data: status, isLoading } = useRigStatus(rigId);
  const [modalOpen, setModalOpen] = useState(false);

  // Defensive: render the placeholder until a well-formed status object arrives
  // (a malformed/empty response must never crash the topology page).
  if (isLoading || !status || typeof status.rigName !== "string" || !Array.isArray(status.src)) {
    return (
      <div
        data-testid={`rig-status-control-${rigId}`}
        className="inline-flex items-center border border-stone-300 bg-white/60 px-3 py-1.5 font-mono text-[9px] text-secondary"
      >
        Loading rig status…
      </div>
    );
  }

  const primaryLabel =
    status.status === "blocked"
      ? "Resolve & restore ▸"
      : status.status === "up"
        ? "Running ▸"
        : "Restore / launch ▸";

  return (
    <div
      data-testid={`rig-status-control-${rigId}`}
      data-status={status.status}
      className="inline-flex items-center gap-2 border border-stone-900 bg-white hard-shadow px-2 py-1.5"
    >
      <span
        data-testid={`rig-status-badge-${rigId}`}
        title={statusHelp[status.status]}
        className={cn(
          "px-2 py-0.5 border font-mono text-[9px] uppercase tracking-wide inline-flex items-center gap-1.5",
          statusBadgeTone[status.status],
        )}
      >
        <StatusPip status={statusToPip[status.status]} />
        {status.status}
      </span>
      <span data-testid={`seats-${rigId}`} className="font-mono text-[9px] text-secondary">
        {status.seatsRunning}/{status.seatsTotal}
      </span>
      <Button
        variant={status.status === "blocked" ? "destructive" : "default"}
        size="sm"
        onClick={() => setModalOpen(true)}
        data-testid={`rig-primary-action-${rigId}`}
        className="font-mono text-[10px] tracking-widest"
      >
        {primaryLabel}
      </Button>
      <LaunchRecoveryModal rigId={rigId} rigName={rigName} open={modalOpen} onOpenChange={setModalOpen} />
    </div>
  );
}
