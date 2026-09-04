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
  /** Optional richer selector. Production supplies it so the restore attempt
   * records why crash-cart chose this source; legacy test/integration callers
   * may keep the historical finder-only shape. */
  selectRestoreUsable?: (rigId: string) =>
    | { ok: true; snapshot: { id: string }; selection: import("./types.js").RestoreSnapshotSelection }
    | { ok: false };
  /** The shipped per-rig restore. `onAttemptStarted` yields the restore-started event seq = the receipt ref. */
  restore: (
    snapshotId: string,
    opts?: {
      onAttemptStarted?: (attemptId: number) => void;
      snapshotSelection?: import("./types.js").RestoreSnapshotSelection;
    },
  ) => Promise<{ ok: boolean; result?: { rigResult: PerRigOutcome; nodes?: RestoreNodeLite[] } }>;
}

// ── AMENDMENT 2 (stamped, body hash 72757e81) — the surviving-panes ADOPT branch ──
// The contradiction it resolves: for a daemon-only crash (panes SURVIVE), restore()
// fail-closes 409 `rig_not_stopped` BY DESIGN, yet the locked acceptance requires
// resumable seats to RETURN in their panes — achievable only by ADOPTION. Per rig:
// LIVE panes compose the SHIPPED reconcile/adopt + per-seat resume verification;
// DEAD panes take the restore composition below byte-unchanged. R9 boundary: adoption
// touches SESSION state only (bindings/sessions/events) — never queue state.

/** One seat of the subset-launch result, structurally the shipped RestoreNodeResult
 *  subset the triage mapper reads. */
export interface AdoptSubsetSeat extends RestoreNodeLite {
  logicalId: string;
}

/** Structural slice of RestoreOrchestrator.launchNodeSubset's result — the shipped
 *  per-seat resume-verification machinery (FR-7: an unverifiable resume fail-closes
 *  to awaiting-decision carrying the exact `--fresh <logicalId>` remediation). */
export interface AdoptSubsetResult {
  ok: boolean;
  code?: string;
  message?: string;
  launched?: AdoptSubsetSeat[];
  held?: Array<{ logicalId: string; reason: string }>;
  alreadyRunning?: Array<{ logicalId: string }>;
  failedTargets?: Array<{ logicalId: string; reason: string }>;
}

export interface AdoptRigDeps {
  /** The rig's DB-running sessions whose tmux panes are ALIVE — the same
   *  classification restore's 409 guard runs (sessionRegistry rows ×
   *  tmuxAdapter.hasSession); the conductor never invents a probe. */
  probeLiveSessions: (rigId: string) => Promise<Array<{ sessionName: string; logicalId: string }>>;
  /** The shipped no-launch adopt (ClaimService.reconcileSession — the
   *  `rig reconcile-session` precedent): session state only, never input. */
  reconcileSession: (sessionName: string) => Promise<{ ok: boolean; code?: string; message?: string }>;
  /** The rig's full seat roster (logical ids) — adoption's complement is what
   *  per-seat resume verification must cover. */
  listRigSeats: (rigId: string) => string[];
  /** The shipped subset launcher over the NOT-adopted seats. */
  launchNodeSubset: (rigId: string, logicalIds: string[]) => Promise<AdoptSubsetResult>;
}

/** LIVE-panes branch: adopt every surviving session, then per-seat resume
 *  verification for the rest, folding into the UNCHANGED closed union. A seat is
 *  OK iff it yields no triage row (attentionRowsFromNodes is the single non-OK
 *  authority, so the fold cannot invent a fifth outcome or a second mapping). */
async function adoptLivePanesRig(
  rigId: string,
  live: Array<{ sessionName: string; logicalId: string }>,
  deps: AdoptRigDeps,
): Promise<{ outcome: PerRigOutcome; attention?: AttentionRow[]; reason?: string; remediation?: string }> {
  const nodes: RestoreNodeLite[] = [];
  const adoptedIds = new Set<string>();
  for (const seat of live) {
    const adopted = await deps.reconcileSession(seat.sessionName);
    if (adopted.ok) {
      adoptedIds.add(seat.logicalId);
      nodes.push({ logicalId: seat.logicalId, status: "resumed" });
    } else {
      nodes.push({
        logicalId: seat.logicalId,
        status: "failed",
        error: `adopt failed for surviving session "${seat.sessionName}": ${adopted.message ?? adopted.code ?? "unknown"}`,
      });
    }
  }
  if (adoptedIds.size === 0) {
    // The stamped mis-probe analysis: probe-says-LIVE on a dead rig → adopt fails
    // EMPTY (honest). Never proceed to launches on a rig the adoption itself just
    // proved has no surviving session — re-running takes the restore path.
    return {
      outcome: "not_attempted",
      reason: "probe saw live panes but no surviving session could be adopted (panes likely died between probe and adopt)",
      remediation: "re-run the fleet restore — a genuinely stopped rig takes the snapshot-restore path",
      attention: attentionRowsFromNodes(rigId, nodes),
    };
  }
  const remaining = deps.listRigSeats(rigId).filter((id) => !adoptedIds.has(id));
  if (remaining.length > 0) {
    const subset = await deps.launchNodeSubset(rigId, remaining);
    if (subset.ok) {
      for (const n of subset.launched ?? []) nodes.push(n);
      for (const a of subset.alreadyRunning ?? []) {
        // r1 LOW: a seat whose ADOPT failed can still be proven LIVE by the launcher
        // (it classifies targets against tmux itself). The seat is RUNNING — drop the
        // stale adopt-failure node, or triage would name a running seat as its "need".
        const staleFailed = nodes.findIndex((n) => n.logicalId === a.logicalId && n.status === "failed");
        if (staleFailed >= 0) nodes.splice(staleFailed, 1);
        nodes.push({ logicalId: a.logicalId, status: "resumed" });
      }
      for (const f of subset.failedTargets ?? [])
        nodes.push({ logicalId: f.logicalId, status: "failed", error: `resume verification could not run: ${f.reason}` });
      for (const h of subset.held ?? [])
        nodes.push({ logicalId: h.logicalId, status: "attention_required", attentionEvidence: `held from launch — ${h.reason}` });
    } else {
      // A whole-subset refusal (e.g. no usable snapshot) leaves every remaining seat
      // unverified — each gets a NAMED row; silence here would be the round-10 gap again.
      for (const id of remaining)
        nodes.push({ logicalId: id, status: "failed", error: `per-seat resume verification unavailable: ${subset.message ?? subset.code ?? "launch subset failed"}` });
    }
  }
  const attention = attentionRowsFromNodes(rigId, nodes);
  // R6 closed union, per the amendment: all seats re-attached+verified →
  // fully_restored; some non-resumable → partially_restored (their exact needs ride
  // the triage rows). adoptedIds.size > 0 guarantees at least one OK seat here.
  return attention.length === 0
    ? { outcome: "fully_restored", attention }
    : { outcome: "partially_restored", attention };
}

/** Build the default `restoreRig` dep: COMPOSE findLatestRestoreUsable → restore →
 *  rigResult. A rig with no usable snapshot is `not_attempted` (restore never runs);
 *  a restore that fails outright is `failed`. Never re-authors restore logic.
 *  With `adoptDeps` wired (Amendment 2), a rig whose panes survived takes the ADOPT
 *  branch above; DEAD panes (and callers without adoptDeps) run unchanged. */
export function createDefaultRestoreRig(
  _deps: RestoreRigDeps,
  adoptDeps?: AdoptRigDeps,
): (rigId: string) => Promise<{ outcome: PerRigOutcome; receiptRef?: number; attention?: AttentionRow[]; reason?: string; remediation?: string }> {
  return async (rigId) => {
    if (adoptDeps) {
      const live = await adoptDeps.probeLiveSessions(rigId);
      // Adopt has NO restore-attempt receipt: its ledger lineage is the
      // node.reconciled events the shipped adopt emits per seat.
      if (live.length > 0) return adoptLivePanesRig(rigId, live, adoptDeps);
    }
    const selected = _deps.selectRestoreUsable?.(rigId);
    const snapshot = selected?.ok ? selected.snapshot : _deps.findLatestRestoreUsable(rigId);
    if (!snapshot)
      // no usable snapshot — never a silent substitute; R3: carry WHY + the fix.
      return {
        outcome: "not_attempted",
        reason: "no restore-usable snapshot for this rig",
        remediation: "take a snapshot (rig snapshot create) or mark an existing one restore-usable",
      };
    let receiptRef: number | undefined;
    const outcome = await _deps.restore(snapshot.id, {
      ...(selected?.ok ? { snapshotSelection: selected.selection } : {}),
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
