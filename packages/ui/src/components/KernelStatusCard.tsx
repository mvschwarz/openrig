// OPR.0.4.3.22 — dashboard kernel-status card.
//
// Kernel health comes from /api/kernel/status (the boot-tracker surface), NEVER
// inferred from the daemon /healthz check (guard 4). The card CONSUMES the
// kernel_state verdict in its rendered badge tone — a non-ready kernel renders
// non-green (the 19/21 lesson: render the verdict, don't default to green while
// carrying it in data).
//
// "Restore kernel" opens the same launch/recovery modal against the kernel rig.
// Double-instantiation guard: the action is disabled unless a kernel rig exists
// (found via the rig summary) AND the kernel is not already up; the restore
// itself routes through /api/rigs/:id/up, whose `rig_not_stopped` guard refuses
// to restore a running kernel (so no second kernel/advisor/operator is spawned).

import { useState } from "react";
import { RigStatusCard } from "./RigStatusCard.js";
import { LaunchRecoveryModal } from "./LaunchRecoveryModal.js";
import { useKernelStatus, isKernelUnavailable, type KernelState } from "../hooks/useKernelStatus.js";
import { useRigSummary } from "../hooks/useRigSummary.js";
import type { RigAggStatus } from "../hooks/useRigStatus.js";

function kernelToAggregate(state: KernelState | undefined): RigAggStatus {
  switch (state) {
    case "ready":
      return "up";
    case "booting":
    case "partial_ready":
    case "degraded":
      return "partial";
    case "auth_blocked":
    case "spec_missing":
    case "bootstrap_failed":
      return "blocked";
    default:
      return "unknown";
  }
}

export function KernelStatusCard() {
  const { data: kernel, isLoading } = useKernelStatus();
  const { data: rigs } = useRigSummary();
  const [modalOpen, setModalOpen] = useState(false);

  const kernelRig = rigs?.find((r) => r.name === "kernel");

  if (isLoading || !kernel) {
    return (
      <RigStatusCard
        rigId="kernel"
        rigName="kernel"
        isKernel
        status="unknown"
        seatsRunning={0}
        seatsTotal={0}
        recoverable={false}
        src={["kernel-status: loading…"]}
        primaryLabel="Restore kernel ▸"
        primaryDisabled
        testId="kernel-status-card"
      />
    );
  }

  // 503 — the boot tracker is not wired into this daemon. Consume as `unknown`
  // (never green); restore is not offered (nothing observable to restore).
  if (isKernelUnavailable(kernel)) {
    return (
      <RigStatusCard
        rigId={kernelRig?.id ?? "kernel"}
        rigName="kernel"
        isKernel
        status="unknown"
        seatsRunning={0}
        seatsTotal={0}
        recoverable={false}
        src={[`kernel-status: unavailable (${kernel.error})`]}
        primaryLabel="Restore kernel ▸"
        primaryDisabled
        testId="kernel-status-card"
      />
    );
  }

  // Defensive: a malformed envelope (missing kernel_state / agents) reads as
  // `unknown` — never a crash, never a false green.
  const status = kernelToAggregate(kernel.kernel_state);
  const agents = Array.isArray(kernel.agents) ? kernel.agents : [];
  const readyAgents = agents.filter((a) => a.startup_status === "ready").length;
  const src = [
    `kernel-status.kernel_state=${kernel.kernel_state ?? "unknown"}`,
    ...(kernel.variant ? [`variant=${kernel.variant}`] : []),
    `agents ${readyAgents}/${agents.length} ready`,
    ...(kernel.detail ? [kernel.detail] : []),
  ];

  // Double-instantiation guard: restore only when a kernel rig exists and the
  // kernel is not already up.
  const restoreDisabled = !kernelRig || status === "up";

  return (
    <>
      <RigStatusCard
        rigId={kernelRig?.id ?? "kernel"}
        rigName="kernel"
        isKernel
        status={status}
        seatsRunning={readyAgents}
        seatsTotal={agents.length}
        recoverable={status === "down" || status === "partial"}
        src={src}
        primaryLabel="Restore kernel ▸"
        primaryDisabled={restoreDisabled}
        onPrimary={() => setModalOpen(true)}
        testId="kernel-status-card"
      />
      {kernelRig ? (
        <LaunchRecoveryModal
          rigId={kernelRig.id}
          rigName="kernel"
          open={modalOpen}
          onOpenChange={setModalOpen}
        />
      ) : null}
    </>
  );
}
