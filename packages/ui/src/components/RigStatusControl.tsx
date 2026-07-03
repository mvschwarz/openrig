// OPR.0.4.3.22 — the rig-status + launch/recovery control (topology rig page).
//
// Wires the composed rig-status object (useRigStatus) to the RigStatusCard +
// LaunchRecoveryModal. This is the rig launch/restore control; terminal-surface
// actions (Open topology / Launch in CMUX) live in a SEPARATE block (the tab-bar
// LaunchCmuxButton) and never restore or fresh-prime (guard 5).

import { useState } from "react";
import { RigStatusCard } from "./RigStatusCard.js";
import { LaunchRecoveryModal } from "./LaunchRecoveryModal.js";
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
        className="border border-stone-300 bg-white/60 px-4 py-3 font-mono text-[10px] text-secondary"
      >
        Loading rig status…
      </div>
    );
  }

  const primaryLabel = status.status === "blocked" ? "Resolve & restore ▸" : "Restore / launch ▸";

  return (
    <div data-testid={`rig-status-control-${rigId}`}>
      <RigStatusCard
        rigId={status.rigId}
        rigName={status.rigName}
        isKernel={status.isKernel}
        status={status.status}
        seatsRunning={status.seatsRunning}
        seatsTotal={status.seatsTotal}
        recoverable={status.recoverable}
        src={status.src}
        primaryLabel={primaryLabel}
        onPrimary={() => setModalOpen(true)}
      />
      <LaunchRecoveryModal rigId={rigId} rigName={rigName} open={modalOpen} onOpenChange={setModalOpen} />
    </div>
  );
}
