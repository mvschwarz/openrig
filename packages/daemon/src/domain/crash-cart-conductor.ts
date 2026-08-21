// B1 — Crash-cart RESTORE CONDUCTOR (daemon-side batch verb). Plan-locked
// (workspace/missions/release-0.5.2/B1-CRASH-CART-CONDUCTOR-PLAN-2026-08-21, content-hash 84401cd4).
//
// Atom B — the conductor CORE. It restores the fleet's rigs in the founder's
// order (kernel rig first, then the rest, sequential v1), COMPOSING the shipped
// per-rig restore (findLatestRestoreUsable + RestoreOrchestrator.restore) via an
// injectable `restoreRig` dep — it does NOT re-author restore logic. Best-effort:
// one rig's failure never halts the fleet. Cancel is STOP-BEFORE-NEXT-RIG: the
// in-flight rig runs to its own outcome; rigs not yet started become
// `not_attempted` (Atom A/C wire discovery + the fleet rollup; Atom D the TUI ⏎).

/** The shipped closed per-rig union (never widened at the fleet layer). `not_attempted`
 *  is first-class — a rig the conductor did not reach (no usable snapshot, or cancelled). */
export type PerRigOutcome = "fully_restored" | "partially_restored" | "failed" | "not_attempted";

/** One rig's conductor result. `receiptRef` references the durable restore event/attempt
 *  seq (the ledger lineage) — the conductor RENDERS receipts, it never re-authors them. */
export interface ConductorRigResult {
  rigId: string;
  outcome: PerRigOutcome;
  receiptRef?: string | number;
}

export interface RestoreConductorDeps {
  /** Rigs in restore order — KERNEL FIRST (the supervisor), then the rest. */
  listRigsInOrder: () => Array<{ rigId: string; isKernel: boolean }>;
  /** Restore ONE rig. Default (wired at the route) = findLatestRestoreUsable(rigId) →
   *  RestoreOrchestrator.restore(snapshotId) → rollupRestoreRigResult; a rig with no
   *  usable snapshot returns `not_attempted` (never a silent older/partial substitute). */
  restoreRig: (rigId: string) => Promise<{ outcome: PerRigOutcome; receiptRef?: string | number }>;
  /** Cancel signal, polled at each rig BOUNDARY (stop-before-next-rig). Optional. */
  isCancelled?: () => boolean;
}

export class RestoreConductor {
  constructor(private readonly deps: RestoreConductorDeps) {}

  /** Restore the fleet, kernel-first, best-effort, honoring stop-before-next-rig cancel.
   *  Returns the ordered per-rig sequence (Atom C aggregates it into the FleetRollup). */
  async restoreFleet(): Promise<ConductorRigResult[]> {
    const rigs = this.deps.listRigsInOrder(); // kernel first, then the rest
    const results: ConductorRigResult[] = [];
    for (const rig of rigs) {
      // Stop-before-next-rig: poll cancel at the rig BOUNDARY, before this rig
      // starts. A rig already in flight is never interrupted; rigs not yet
      // reached become `not_attempted` (honest, never silently dropped).
      if (this.deps.isCancelled?.()) {
        results.push({ rigId: rig.rigId, outcome: "not_attempted" });
        continue;
      }
      try {
        const r = await this.deps.restoreRig(rig.rigId);
        results.push({ rigId: rig.rigId, outcome: r.outcome, receiptRef: r.receiptRef });
      } catch {
        // Best-effort continue: one rig's failure never halts the fleet.
        results.push({ rigId: rig.rigId, outcome: "failed" });
      }
    }
    return results;
  }
}
