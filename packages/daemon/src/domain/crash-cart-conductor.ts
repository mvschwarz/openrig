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
  /** Per-rig triage rows (seats needing operator action) — the fleet
   *  attention_required is the UNION of these across the sequence. */
  attention?: AttentionRow[];
  /** R3 — for a `not_attempted` rig, WHY it was skipped (no honest gap left blank). */
  reason?: string;
  /** R3 — the operator action that would let this rig be restored next time. */
  remediation?: string;
}

export interface RestoreConductorDeps {
  /** Rigs in restore order — KERNEL FIRST (the supervisor), then the rest. */
  listRigsInOrder: () => Array<{ rigId: string; isKernel: boolean }>;
  /** Restore ONE rig. Default (wired at the route) = findLatestRestoreUsable(rigId) →
   *  RestoreOrchestrator.restore(snapshotId) → rollupRestoreRigResult; a rig with no
   *  usable snapshot returns `not_attempted` (never a silent older/partial substitute). */
  restoreRig: (
    rigId: string,
  ) => Promise<{ outcome: PerRigOutcome; receiptRef?: string | number; attention?: AttentionRow[]; reason?: string; remediation?: string }>;
  /** Cancel signal, polled at each rig BOUNDARY (stop-before-next-rig). Optional. */
  isCancelled?: () => boolean;
}

export class RestoreConductor {
  constructor(private readonly deps: RestoreConductorDeps) {}

  /** Restore the fleet, kernel-first, best-effort, honoring stop-before-next-rig cancel.
   *  Returns the ordered per-rig sequence (Atom C aggregates it into the FleetRollup). */
  async restoreFleet(opts?: { onRigDone?: (result: ConductorRigResult) => void }): Promise<ConductorRigResult[]> {
    const rigs = this.deps.listRigsInOrder(); // kernel first, then the rest
    const results: ConductorRigResult[] = [];
    // Progress "stream": each rig's result is emitted as it completes so the
    // route can update a pollable rollup while the fleet restore continues
    // (the locked async shape — the route answers on-commit, never blocks to
    // completion). onRigDone stubbed until wired below (RED-first).
    const record = (result: ConductorRigResult) => {
      results.push(result);
      opts?.onRigDone?.(result); // emit progress as each rig completes
    };
    for (const rig of rigs) {
      // Stop-before-next-rig: poll cancel at the rig BOUNDARY, before this rig
      // starts. A rig already in flight is never interrupted; rigs not yet
      // reached become `not_attempted` (honest, never silently dropped).
      if (this.deps.isCancelled?.()) {
        record({
          rigId: rig.rigId,
          outcome: "not_attempted",
          reason: "cancelled before this rig started (stop-before-next-rig)",
          remediation: "re-run the fleet restore to attempt this rig",
        });
        continue;
      }
      try {
        const r = await this.deps.restoreRig(rig.rigId);
        record({
          rigId: rig.rigId,
          outcome: r.outcome,
          receiptRef: r.receiptRef,
          attention: r.attention,
          reason: r.reason,
          remediation: r.remediation,
        });
      } catch {
        // Best-effort continue: one rig's failure never halts the fleet.
        record({ rigId: rig.rigId, outcome: "failed" });
      }
    }
    return results;
  }
}

/** Deps for the DEFAULT per-rig restore — structurally typed so the conductor stays
 *  decoupled from the full orchestrator (the real wiring passes
 *  `snapshotRepo.findLatestRestoreUsable` and `RestoreOrchestrator.restore`, whose
 *  RestoreOutcome satisfies this shape). */
export interface RestoreRigDeps {
  /** Newest restore-usable snapshot for the rig, or null (→ `not_attempted`; never a silent substitute). */
  findLatestRestoreUsable: (rigId: string) => { id: string } | null;
  /** The shipped per-rig restore. `onAttemptStarted` yields the restore-started event seq = the receipt ref. */
  restore: (
    snapshotId: string,
    opts?: { onAttemptStarted?: (attemptId: number) => void },
  ) => Promise<{ ok: boolean; result?: { rigResult: PerRigOutcome; nodes?: RestoreNodeLite[] } }>;
}

/** Build the default `restoreRig` dep: COMPOSE findLatestRestoreUsable → restore →
 *  rigResult. A rig with no usable snapshot is `not_attempted` (restore never runs);
 *  a restore that fails outright is `failed`. Never re-authors restore logic. */
export function createDefaultRestoreRig(
  _deps: RestoreRigDeps,
): (rigId: string) => Promise<{ outcome: PerRigOutcome; receiptRef?: number; reason?: string; remediation?: string }> {
  return async (rigId) => {
    const snapshot = _deps.findLatestRestoreUsable(rigId);
    if (!snapshot)
      // no usable snapshot — never a silent substitute; R3: carry WHY + the fix.
      return {
        outcome: "not_attempted",
        reason: "no restore-usable snapshot for this rig",
        remediation: "take a snapshot (rig snapshot create) or mark an existing one restore-usable",
      };
    let receiptRef: number | undefined;
    const outcome = await _deps.restore(snapshot.id, {
      onAttemptStarted: (attemptId) => {
        receiptRef = attemptId;
      },
    });
    // ok:true → result.rigResult; ok:false WITH a result (e.g. pre-restore validation
    // fail → `not_attempted`) → its rigResult; ok:false with no result (a hard failure:
    // snapshot/rig not found, rig not stopped, restore in progress) → `failed`.
    const outcomeResult: PerRigOutcome = outcome.result?.rigResult ?? "failed";
    // Triage rows for this rig's seats that need operator action (from the restore
    // result's nodes) — the shipped per-rig attention, unioned at the fleet layer.
    const attention = outcome.result?.nodes ? attentionRowsFromNodes(rigId, outcome.result.nodes) : [];
    return { outcome: outcomeResult, receiptRef, attention };
  };
}

export interface RigOrderDeps {
  /** All (non-archived) rigs on this host — the conductor's fleet scope, v1. */
  listRigs: () => Array<{ id: string; name: string }>;
}

/** R2 — the founder's order: the KERNEL rig (the supervisor, name "kernel") restores
 *  FIRST, then the remaining rigs in listRigs order. No kernel rig → all rigs, none
 *  flagged kernel (honest, never fabricated). This is the `listRigsInOrder` source the
 *  conductor consumes. */
export function listRigsInKernelFirstOrder(
  deps: RigOrderDeps,
): Array<{ rigId: string; isKernel: boolean }> {
  const all = deps.listRigs();
  const kernel = all.filter((r) => r.name === "kernel");
  const rest = all.filter((r) => r.name !== "kernel");
  return [...kernel, ...rest].map((r) => ({ rigId: r.id, isKernel: r.name === "kernel" }));
}

// ── Atom C — fleet rollup (PURE AGGREGATION, ARCH-RULING Q2) ──────────────────

/** A triage row: a seat + exactly what it needs (picker/auth/remediation), sourced
 *  from the shipped per-rig restore-check attention projection. The fleet
 *  `attention_required` is the UNION of these across rigs — a VIEW, not a parallel record. */
export interface AttentionRow {
  rigId: string;
  seat: string;
  need: string;
}

/** Fleet rollup — PURE AGGREGATION over the conductor's per-rig sequence. The per-rig
 *  outcome stays the shipped CLOSED union (never widened). NO fleet verdict is stored
 *  here — a stored verdict could drift from the per-rig truth; derive it on demand via
 *  {@link deriveFleetVerdict}. `not_attempted` is first-class (never folded into failed). */
export interface FleetRollup {
  counts: Record<PerRigOutcome, number>;
  sequence: ConductorRigResult[];
  attention_required: AttentionRow[];
}

/** The fleet verdict is a DERIVED function of the counts — never a stored field. */
export type FleetVerdict = "all_fully_restored" | "all_failed" | "none_attempted" | "mixed";

/** A restore node (structural subset of the shipped RestoreNodeResult) — enough to
 *  build a triage row from the seats that need operator action. */
export interface RestoreNodeLite {
  logicalId: string;
  status: string;
  error?: string;
  attentionEvidence?: string | null;
}

/** R5 — map a rig's restore nodes → triage rows: the seats needing operator action
 *  (a LIVE runtime prompt, an unresumable session, or a hard failure), each with its
 *  EXACT need. Running/resumed nodes are excluded. Never fabricates a need. */
export function attentionRowsFromNodes(rigId: string, nodes: RestoreNodeLite[]): AttentionRow[] {
  const rows: AttentionRow[] = [];
  for (const n of nodes) {
    if (n.status === "attention_required") {
      rows.push({
        rigId,
        seat: n.logicalId,
        need: n.attentionEvidence
          ? `live runtime prompt — ${n.attentionEvidence}`
          : "live runtime prompt (resume selection / auth) — needs operator",
      });
    } else if (n.status === "awaiting-decision") {
      // BLOCKER 3 — preserve the shipped orchestrator's EXACT error/remediation (it carries the concrete
      // `--fresh <logicalId>` command and reason); only fall back to the generic sentence when the node
      // carried none. The exact need reaching the operator IS the door's "seat + exact need" acceptance.
      rows.push({
        rigId,
        seat: n.logicalId,
        need: n.error ? n.error : "original session not resumable and no --fresh — choose fresh-prime or skip",
      });
    } else if (n.status === "failed") {
      rows.push({ rigId, seat: n.logicalId, need: n.error ? `restore failed: ${n.error}` : "restore failed" });
    }
  }
  return rows;
}

export function aggregateFleetRollup(sequence: ConductorRigResult[]): FleetRollup {
  // All four closed-union keys initialized — `not_attempted` is first-class, never
  // absent and never folded into `failed`.
  const counts: Record<PerRigOutcome, number> = {
    fully_restored: 0,
    partially_restored: 0,
    failed: 0,
    not_attempted: 0,
  };
  for (const r of sequence) counts[r.outcome] += 1;
  // attention_required = the UNION of per-rig triage rows carried in the sequence (a view).
  const attention_required = sequence.flatMap((r) => r.attention ?? []);
  return { counts, sequence, attention_required };
}

/** DERIVED f(counts) — computed, never stored (a stored verdict could drift). */
export function deriveFleetVerdict(counts: Record<PerRigOutcome, number>): FleetVerdict {
  const total = counts.fully_restored + counts.partially_restored + counts.failed + counts.not_attempted;
  if (total === 0 || counts.not_attempted === total) return "none_attempted";
  if (counts.fully_restored === total) return "all_fully_restored";
  if (counts.failed === total) return "all_failed";
  return "mixed";
}
