// Restoring an existing rig from its latest restore-usable snapshot: what `rig up <rig> --existing`
// does (routes/up.ts), and what daemon start does for a kernel that a reboot left down (kernel-boot.ts).
// One copy, so the two cannot choose snapshots differently.

import { summarizeSnapshot, type SnapshotRepository } from "./snapshot-repository.js";
import type { SnapshotCapture } from "./snapshot-capture.js";
import type { RestoreOrchestrator } from "./restore-orchestrator.js";
import type { RigRepository } from "./rig-repository.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import type Database from "better-sqlite3";
import type { RestoreSnapshotSelection, Snapshot } from "./types.js";
import { assessCurrentStateRehydrateEligibility, snapshotMatchesCurrentOccupants } from "./rehydrate-eligibility.js";
import { resolveActiveSnapshotSession } from "./active-occupant.js";

export interface ExistingRigRestoreDeps {
  rigRepo: RigRepository;
  snapshotRepo: SnapshotRepository;
  snapshotCapture: SnapshotCapture;
  restoreOrchestrator?: RestoreOrchestrator;
  runtimeAdapters?: Record<string, RuntimeAdapter>;
}

type Rig = NonNullable<ReturnType<RigRepository["getRig"]>>;

export type RestoreSnapshotChoice =
  | { ok: true; rig: Rig; snapshot: Snapshot | null; snapshotSelection: RestoreSnapshotSelection | undefined; staleSnapshot: boolean }
  | { ok: false; status: 404; body: { error: string; code: "rig_not_found" | "no_snapshot"; blockers?: unknown } };

/** L3b: prefers `auto-pre-down` when present but falls back to the latest manual snapshot whose
 *  structural metadata satisfies `RestoreOrchestrator.restore`'s pre-validation. A snapshot naming an
 *  older occupant is not used. `snapshot: null` means current DB state is eligible for rehydrate. */
export function chooseRestoreSnapshot(deps: ExistingRigRestoreDeps, rigId: string): RestoreSnapshotChoice {
  const rig = deps.rigRepo.getRig(rigId);
  if (!rig) {
    return { ok: false, status: 404, body: { error: `Rig ${rigId} not found`, code: "rig_not_found" } };
  }
  const automaticSelection = deps.snapshotRepo.selectRestoreUsable(rigId);
  let snapshot = automaticSelection.ok ? automaticSelection.snapshot : null;
  let snapshotSelection = automaticSelection.ok ? automaticSelection.selection : undefined;
  let staleSnapshot = false;
  if (snapshot && !snapshotMatchesCurrentOccupants(deps.snapshotRepo.db, rig, snapshot)) {
    snapshot = null;
    snapshotSelection = undefined;
    staleSnapshot = true;
  }
  if (!snapshot) {
    const eligibility = assessCurrentStateRehydrateEligibility(deps.snapshotRepo.db, rig);
    if (!eligibility.ok) {
      return {
        ok: false,
        status: 404,
        body: {
          error: `Rig exists but ${staleSnapshot ? "its restore snapshots name an older occupant" : "has no restore-usable snapshot"} and current DB state is insufficient for rehydrate. Start fresh with: rig up <spec-path>`,
          code: "no_snapshot",
          blockers: eligibility.blockers,
        },
      };
    }
  }
  return { ok: true, rig, snapshot, snapshotSelection, staleSnapshot };
}

/** Run the restore for a choice: capture current state as `auto-rehydrate` when no snapshot was usable,
 *  then restore from it. */
export async function runExistingRigRestore(
  deps: ExistingRigRestoreDeps,
  choice: Extract<RestoreSnapshotChoice, { ok: true }>,
  opts: {
    freshLogicalIds?: string[]; nonInterruptive?: boolean; exists: (path: string) => boolean;
    onSnapshot?: (snapshotId: string) => void; onSessionLaunched?: (nodeId: string, sessionId: string) => void;
  },
) {
  let { snapshot, snapshotSelection } = choice;
  let capturedCurrentState = false;
  if (!snapshot) {
    snapshot = deps.snapshotCapture.captureSnapshot(choice.rig.rig.id, "auto-rehydrate");
    snapshotSelection = {
      ...summarizeSnapshot(snapshot),
      mode: "automatic",
      rationale: "automatic rehydrate captured current eligible state because no current-occupant snapshot was usable",
      newerUsableAlternative: null,
    };
    capturedCurrentState = true;
  }
  opts.onSnapshot?.(snapshot.id);
  if (!deps.restoreOrchestrator) {
    return { snapshot, capturedCurrentState, result: { ok: false as const, code: "restore_unavailable" as const, message: "Restore orchestrator not available" } };
  }
  const result = await deps.restoreOrchestrator.restore(snapshot.id, {
    adapters: deps.runtimeAdapters ?? {},
    fsOps: { exists: opts.exists },
    // OPR.0.3.4.2 — operation B opt-in seats from `rig up --existing --fresh`.
    freshLogicalIds: opts.freshLogicalIds,
    nonInterruptive: opts.nonInterruptive,
    snapshotSelection,
    onSessionLaunched: opts.onSessionLaunched,
  });
  return { snapshot, capturedCurrentState, result };
}

/** Said in a response that reports daemon start's restore instead of running one of its own. */
export const JOINED_AUTOMATIC_RESTORE_WARNING =
  "Daemon start was already restoring this rig; this is that restore's outcome, and no second restore was started.";

export type ExistingRigRestoreOutcome =
  | { ok: false; choice: Extract<RestoreSnapshotChoice, { ok: false }> }
  | ({ ok: true; staleSnapshot: boolean } & Awaited<ReturnType<typeof runExistingRigRestore>>);

// Daemon start's unattended restore of each rig, per database: the latest attempt, kept after it
// returns. Requests that meet it coordinate with it (`joinAutomaticRestore`, `settleAutomaticRestore`)
// instead of colliding with its seat leases.
// `snapshotId` is the snapshot that restore runs from, known as soon as it has chosen or captured it.
// `launched` holds the session each seat's launch registered, recorded as its row is committed.
type AutomaticRestore = {
  outcome: Promise<ExistingRigRestoreOutcome>;
  settled: ExistingRigRestoreOutcome | null;
  snapshotId: string | null;
  launched: Map<string, string>;
  hasSession?: (sessionName: string) => Promise<boolean>;
};
const automaticRestores = new WeakMap<object, Map<string, AutomaticRestore>>();

function automaticRestore(db: Database.Database, rigId: string): AutomaticRestore | null {
  return automaticRestores.get(db)?.get(rigId) ?? null;
}

/** Wait for daemon start's restore of this rig, if one is running, to return. A stop then runs on
 *  what that restore left, under fresh leases, instead of failing on the seats it rebound. */
export async function settleAutomaticRestore(db: Database.Database, rigId: string): Promise<void> {
  const attempt = automaticRestore(db, rigId);
  if (attempt && !attempt.settled) await attempt.outcome.catch(() => undefined);
}

type SeatRow = { id: string; resumeType: string | null; resumeToken: string | null; provenance: string | null };

/** Whether every seat still holds what the attempt left or is about to restore:
 *  - a seat the attempt has launched holds exactly that session, with no token yet, the snapshot's,
 *    or one its own launch reported (a resume that continued under a new id). An operator's
 *    correction to another token, or any other session, even one naming the same conversation, is
 *    not the attempt's;
 *  - a seat it has not launched still holds the session it is restoring, naming the snapshot's
 *    resume target, or, while the attempt runs, none: it stands the old session down before
 *    registering its own. */
function seatsHeldByAttempt(db: Database.Database, rig: Rig, snapshot: Snapshot, attempt: AutomaticRestore, running: boolean): boolean {
  const newest = db.prepare(
    `SELECT id, resume_type AS resumeType, resume_token AS resumeToken, resume_provenance AS provenance FROM sessions
      WHERE node_id = ? AND status NOT IN ('superseded', 'exited')
      ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  return rig.nodes.every((node) => {
    const row = newest.get(node.id) as SeatRow | undefined;
    const target = resolveActiveSnapshotSession(snapshot.data, node.id);
    const sameTarget = target.kind === "resolved" && !!row?.resumeToken
      && row.resumeType === (target.session.resumeType ?? null) && row.resumeToken === (target.session.resumeToken ?? null);
    const launched = attempt.launched.get(node.id);
    if (launched) return row?.id === launched && (!row.resumeToken || sameTarget || row.provenance !== "operator");
    if (!row) return running;
    if (target.kind === "none") return !row.resumeToken;
    return sameTarget;
  });
}

/** Whether every seat's terminal session the attempt launched still exists. */
async function attemptTerminalsPresent(db: Database.Database, rig: Rig, attempt: AutomaticRestore): Promise<boolean> {
  if (!attempt.hasSession) return true;
  for (const node of rig.nodes) {
    const sessionId = attempt.launched.get(node.id);
    const row = sessionId
      ? db.prepare("SELECT session_name AS sessionName FROM sessions WHERE id = ?").get(sessionId) as { sessionName: string } | undefined
      : undefined;
    if (!row || !(await attempt.hasSession(row.sessionName))) return false;
  }
  return true;
}

/** Whether the finished attempt restored every seat and each still runs, and is bound to, the
 *  session it launched. Synchronous, so a caller can check it after its last await. */
function attemptStillRunning(db: Database.Database, rig: Rig, attempt: AutomaticRestore): boolean {
  const done = attempt.settled;
  if (!done?.ok || !done.result.ok || done.result.result.rigResult !== "fully_restored") return false;
  return rig.nodes.every((node) => {
    const sessionId = attempt.launched.get(node.id);
    const row = sessionId ? db.prepare(
      `SELECT s.status, s.session_name AS sessionName, b.tmux_session AS bound FROM sessions s
        LEFT JOIN bindings b ON b.node_id = s.node_id WHERE s.id = ?`,
    ).get(sessionId) as { status: string; sessionName: string; bound: string | null } | undefined : undefined;
    return !!row && row.status === "running" && row.bound === row.sessionName;
  });
}

/** The outcome of daemon start's restore of this rig, for a request that asks for the same restore
 *  (no --fresh seats, no non-interruptive choice, not a plan), or null when the request must take
 *  the ordinary path:
 *  - while that restore runs, the request waits for it, then gets its outcome if every seat still
 *    holds what it left (`seatsHeldByAttempt`);
 *  - once it has returned, the request gets its outcome only if it restored every seat and each
 *    still runs the session it launched, checked against the terminal.
 *  Either way no second launch and no snapshot of its own. */
export async function joinAutomaticRestore(
  deps: Pick<ExistingRigRestoreDeps, "rigRepo" | "snapshotRepo">,
  rigId: string,
): Promise<ExistingRigRestoreOutcome | null> {
  const db = deps.snapshotRepo.db;
  const attempt = automaticRestore(db, rigId);
  const snapshot = attempt?.snapshotId ? deps.snapshotRepo.getSnapshot(attempt.snapshotId) : null;
  if (!attempt || !snapshot) return null;
  const rig = () => deps.rigRepo.getRig(rigId);
  const held = (running: boolean) => {
    const current = rig();
    return !!current && seatsHeldByAttempt(db, current, snapshot, attempt, running);
  };
  if (!attempt.settled) {
    if (!held(true)) return null;
    const outcome = await attempt.outcome;
    return held(false) ? outcome : null;
  }
  const current = rig();
  if (!current || !held(false) || !attemptStillRunning(db, current, attempt)) return null;
  if (!(await attemptTerminalsPresent(db, current, attempt))) return null;
  // The terminal check awaited: a stop or another occupant may have come meanwhile.
  const after = rig();
  return after && held(false) && attemptStillRunning(db, after, attempt) ? attempt.settled : null;
}

/** Restore an existing rig with no operator present (daemon start bringing back a lost kernel) and
 *  reduce the outcome to the errors that kept it from restoring. A partial restore is not a
 *  failure: the seats' own status then decides ready or partial_ready. */
export function restoreExistingRigUnattended(
  deps: ExistingRigRestoreDeps & { tmuxAdapter?: { hasSession(name: string): Promise<boolean> } },
  rigId: string,
  exists: (path: string) => boolean,
): Promise<{ errors: string[] }> {
  const tmux = deps.tmuxAdapter;
  const entry: AutomaticRestore = {
    outcome: Promise.resolve(null as never), settled: null, snapshotId: null, launched: new Map(),
    ...(tmux ? { hasSession: (name: string) => tmux.hasSession(name) } : {}),
  };
  const outcome = (async (): Promise<ExistingRigRestoreOutcome> => {
    const choice = chooseRestoreSnapshot(deps, rigId);
    if (!choice.ok) return { ok: false, choice };
    const run = runExistingRigRestore(deps, choice, {
      exists,
      onSnapshot: (id) => { entry.snapshotId = id; },
      onSessionLaunched: (nodeId, sessionId) => { entry.launched.set(nodeId, sessionId); },
    });
    return { ok: true, staleSnapshot: choice.staleSnapshot, ...await run };
  })();
  entry.outcome = outcome;
  const db = deps.snapshotRepo.db;
  const attempts = automaticRestores.get(db) ?? new Map<string, AutomaticRestore>();
  automaticRestores.set(db, attempts);
  attempts.set(rigId, entry);
  outcome.then((done) => { entry.settled = done; }, () => { attempts.delete(rigId); });
  return outcome.then((done) => {
    if (!done.ok) return { errors: [done.choice.body.error] };
    const { result } = done;
    if (!result.ok) return { errors: [result.message] };
    const { rigResult, nodes } = result.result;
    if (rigResult !== "failed" && rigResult !== "not_attempted") return { errors: [] };
    const nodeErrors = nodes.filter((node) => node.error).map((node) => `${node.logicalId}: ${node.error}`);
    return { errors: nodeErrors.length > 0 ? nodeErrors : [`restore ${rigResult}`] };
  });
}
