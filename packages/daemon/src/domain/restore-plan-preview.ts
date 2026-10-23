import { restoreRuntimeCompatibilityError } from "./restore-runtime-compatibility.js";
// OPR.0.3.4.4 — read-only restore plan preview.
//
// `rig up --existing <rig> --plan` advertised "preview without executing" but
// the rig_name path bypassed the plan gate and MUTATED (recreated sessions,
// flipped detached->running, replaced manually-resumed panes). This module is
// the shared read-only preview both restore routes (`/api/up` rig_name and the
// Explorer `/api/rigs/:id/up`) return when plan=true: it computes the INTENDED
// per-seat restore action from snapshot/session data and touches NOTHING — no
// restoreOrchestrator.restore(), no session create/kill/replace/resume, no
// snapshot capture (the auto-rehydrate capture is itself a mutation and is
// only reported as would-happen), no projection writes.

import type Database from "better-sqlite3";
import { resolveActiveSnapshotSession, deriveRehydrateOccupantsByNode, deriveRehydrateSessionIdByNode, activeOccupantAmbiguityError, absentSeatResumeHistory, absentSeatResumeHistoryError, type ActiveOccupantResolution } from "./active-occupant.js";
import type { RigWithRelations, Snapshot } from "./types.js";
import { readFreshOccupantRelations } from "./fresh-occupant-relation.js";
import { parseSqliteUtcMs } from "./sqlite-time.js";
import { effectiveRestorePolicy, isOrdinaryTerminalSeat, type RestoreSeatFacts } from "./restore-policy.js";
import { assessSnapshotCurrentOccupants, stoppedSnapshotReason } from "./rehydrate-eligibility.js";

/** OPR.0.4.3.20 FR-6 — a present token whose last verification is older than this
 *  is surfaced as `stale` (age-based staleness — the "stale while running" signal
 *  that needs no probe). DELIVERY DEFAULT; pm confirms the exact value. */
export const RESUME_FRESHNESS_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/** OPR.0.4.3.20 FR-6 — per-seat token truth in the restore plan. */
export type ResumeTokenState = "present" | "missing" | "stale" | "unverified";

export interface RestorePlanPreviewNode {
  logicalId: string;
  /** Consent version, not a guessed native conversation id. */
  occupantSessionId?: string | null;
  hasHistory?: boolean;
  /** The slice-02 vocabulary, as a forecast: what apply mode WOULD do. `leave-attached`: a seat joined with `rig attach` as
   *  an external CLI, which restore leaves as it is (its result is `left_attached`). */
  intendedAction: "resume-original" | "fresh-primed" | "awaiting-decision" | "leave-attached";
  reason?: string;
  // OPR.0.4.3.20 FR-6 — per-seat token state + freshness (read-only forecast).
  /** present = verified + fresh; missing = no token; stale = probe failed OR
   *  last-verified past the freshness threshold; unverified = present but never
   *  verified. A stale/unverified token is NEVER a silent restore failure —
   *  the operator sees it here and can re-verify before restore. */
  tokenState: ResumeTokenState;
  /** The token's source: adoption / hook / operator / scrape (null when none). */
  provenance?: string | null;
  /** When the token was last confirmed current (SQLite UTC ts; null = never). */
  lastVerified?: string | null;
  /** True when the seat has no resumable token → restore would require an
   *  explicit `--fresh` (surfaced here; never presented as a silent fresh-prime). */
  freshRequired: boolean;
  /** A runtime prompt the operator should expect at restore (Claude session
   *  picker, Codex auth/update) — a forecast, not an incidental surprise. */
  runtimePrompt?: string;
}

export interface RestorePlanPreview {
  status: "plan";
  mode: "restore";
  rigId: string;
  rigName: string;
  /** The snapshot apply mode would restore from (null when it would capture
   *  a current-state auto-rehydrate snapshot instead). */
  snapshot: { id: string; kind: string; createdAt: string } | null;
  /** True when apply mode would first CAPTURE an auto-rehydrate snapshot —
   *  reported, not performed (plan mode performs zero writes). */
  wouldCaptureCurrentState: boolean;
  nodes: RestorePlanPreviewNode[];
  /** Always false — the contract this preview exists to keep. */
  mutated: false;
}

export interface PreviewSessionRow {
  /** Current stop proved against this snapshot; never persisted as new history. */
  stoppedCurrent?: boolean;
  nodeId: string;
  restorePolicy: string | null;
  resumeType: string | null;
  resumeToken: string | null;
  // OPR.0.4.3.20 FR-6 — provenance + verification freshness (nullable/degrading
  // for pre-45 rows and old snapshots → rendered as unverified, never a crash).
  resumeProvenance?: string | null;
  resumeLastVerified?: string | null;
  resumeLastProbeStatus?: string | null;
  /** Row id (ULID). Selection is by the shared ACTIVE-OCCUPANT resolution
   *  (active-occupant.ts) — the same truth the restore execution consumes —
   *  never by newest-id inference. */
  id: string;
  /** Session status — the occupant ladder's legacy/uniquely-running input and
   *  the live would-capture derivation's input. */
  status: string | null;
}

/** OPR.0.4.3.20 FR-6 — compute a seat's token state (read-only). A present token
 *  whose probe failed (`not_resumable`/`inconclusive`) OR whose last-verified age
 *  is past the freshness threshold is `stale` — surfaced, never silently nulled. */
function tokenStateFor(
  latest: PreviewSessionRow | null,
  nowMs: number,
): { tokenState: ResumeTokenState; provenance: string | null; lastVerified: string | null } {
  if (!latest || !latest.resumeToken) {
    return { tokenState: "missing", provenance: null, lastVerified: null };
  }
  const provenance = latest.resumeProvenance ?? null;
  const lastVerified = latest.resumeLastVerified ?? null;
  const probe = latest.resumeLastProbeStatus ?? null;
  if (probe === "not_resumable" || probe === "inconclusive") {
    return { tokenState: "stale", provenance, lastVerified };
  }
  if (!probe && !lastVerified) {
    return { tokenState: "unverified", provenance, lastVerified };
  }
  if (lastVerified) {
    // NaN (unparseable) skips the age check: an unreadable stamp is never stale-by-age.
    const verifiedMs = parseSqliteUtcMs(lastVerified);
    if (!Number.isNaN(verifiedMs) && nowMs - verifiedMs > RESUME_FRESHNESS_THRESHOLD_MS) {
      return { tokenState: "stale", provenance, lastVerified };
    }
  }
  return { tokenState: "present", provenance, lastVerified };
}

/** OPR.0.4.3.20 FR-6 — forecast the runtime prompt a resume WOULD hit, so it is
 *  an expected operator step, not a terminal surprise. Only meaningful when the
 *  seat would attempt a resume (has a token). */
function runtimePromptFor(runtime: string | null, tokenState: ResumeTokenState): string | undefined {
  if (tokenState === "missing") return undefined;
  if (runtime === "claude-code") return "expect the Claude session picker (full-session resume)";
  if (runtime === "codex") return "expect a Codex auth/update check before resume";
  return undefined;
}

/** Why restore leaves a seat joined with `rig attach` as an external CLI as it is: said by its result and by this forecast. */
export function leftAttachedReason(name: string): string {
  return `${name} is joined with rig attach as an external CLI, so restore leaves it attached: nothing is launched in its place, and OpenRig `
    + `can't see whether that app is still running. To run this seat under OpenRig instead, release it with: rig unclaim ${name}, then launch it.`;
}

/** Forecast one seat's restore action — mirrors the orchestrator's pre-launch
 *  classification (OPR.0.3.4.2) without touching anything. A fresh-listed
 *  seat (operation B, `--fresh <seat>`) forecasts `fresh-primed` BEFORE any
 *  resume-token logic, exactly as apply mode deliberately skips the resume. */
function intendedActionFor(
  resolution: ActiveOccupantResolution<PreviewSessionRow>,
  freshRequested: boolean,
  seat: RestoreSeatFacts,
  absentHistory: { logicalId: string; rigName: string; row: PreviewSessionRow | null; stoppedCurrent: boolean },
): { intendedAction: RestorePlanPreviewNode["intendedAction"]; reason?: string } {
  // OPR.0.5.7.1 — a broken authoritative relation beats --fresh, exactly as
  // execution fails loudly before its fresh check: --fresh cannot override
  // A1 ambiguity.
  if (resolution.kind === "ambiguous") {
    return {
      intendedAction: "awaiting-decision",
      reason: activeOccupantAmbiguityError(resolution.candidateIds, resolution.detail),
    };
  }
  if (freshRequested) {
    return {
      intendedAction: "fresh-primed",
      reason: "listed in --fresh — apply would deliberately skip the resume (operation B)",
    };
  }
  if (resolution.kind === "none" && absentHistory.stoppedCurrent) {
    return { intendedAction: "awaiting-decision", reason: stoppedSnapshotReason(absentHistory.logicalId, absentHistory.rigName) };
  }
  // No occupant, but an earlier one left a resume token: apply stops for the same decision.
  if (resolution.kind === "none" && absentHistory.row) {
    return {
      intendedAction: "awaiting-decision",
      reason: absentSeatResumeHistoryError(absentHistory.logicalId, absentHistory.row.resumeType, absentHistory.rigName),
    };
  }
  const occupant = resolution.kind === "resolved" ? resolution.session : null;
  const policy = effectiveRestorePolicy(seat, occupant?.restorePolicy);
  const sourceRecorded = !!occupant?.resumeType && occupant.resumeType !== "none";
  if (policy === "resume_if_possible" && sourceRecorded && occupant?.resumeToken) {
    return { intendedAction: "resume-original" };
  }
  if (policy === "resume_if_possible" && occupant && (!sourceRecorded || !occupant.resumeToken)) {
    return {
      intendedAction: "awaiting-decision",
      reason: "Prior occupant has no usable native resume identity. No session will be started without a fresh-start decision.",
    };
  }
  return { intendedAction: "fresh-primed" };
}

/** Gather the session rows the preview forecasts from — the snapshot's
 *  captured sessions when one exists, otherwise the live rows an
 *  auto-rehydrate capture WOULD snapshot (read-only SELECT; the capture
 *  itself is a mutation and is never performed here). */
export function collectPreviewSessionRows(
  db: Database.Database,
  rig: RigWithRelations,
  snapshot: Snapshot | null,
  preserveStoppedInitial = false,
): PreviewSessionRow[] {
  if (snapshot) {
    const { stoppedNodeIds } = assessSnapshotCurrentOccupants(db, rig, snapshot, preserveStoppedInitial);
    return (snapshot.data.sessions ?? []).map((s) => ({
      stoppedCurrent: stoppedNodeIds.has(s.nodeId),
      nodeId: s.nodeId,
      restorePolicy: s.restorePolicy ?? null,
      resumeType: s.resumeType ?? null,
      resumeToken: s.resumeToken ?? null,
      // OPR.0.4.3.20 FR-6 — degrade to null for snapshots serialized pre-45.
      resumeProvenance: s.resumeProvenance ?? null,
      resumeLastVerified: s.resumeLastVerified ?? null,
      resumeLastProbeStatus: s.resumeLastProbeStatus ?? null,
      id: s.id,
      status: s.status ?? null,
    }));
  }
  const nodeIds = rig.nodes.map((n) => n.id);
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, node_id, restore_policy, resume_type, resume_token, resume_provenance, resume_last_verified, resume_last_probe_status, status FROM sessions WHERE node_id IN (${placeholders})`
  ).all(...nodeIds) as Array<{ id: string; node_id: string; restore_policy: string | null; resume_type: string | null; resume_token: string | null; resume_provenance: string | null; resume_last_verified: string | null; resume_last_probe_status: string | null; status: string | null }>;
  const sessions = rows.map((r) => ({
    nodeId: r.node_id,
    restorePolicy: r.restore_policy,
    resumeType: r.resume_type,
    resumeToken: r.resume_token,
    resumeProvenance: r.resume_provenance,
    resumeLastVerified: r.resume_last_verified,
    resumeLastProbeStatus: r.resume_last_probe_status,
    id: r.id,
    status: r.status,
  }));
  // Forecast the exact occupancy auto-rehydrate capture would write, without
  // persisting a snapshot or changing any session/tenure state.
  const recorded = readFreshOccupantRelations(db, rig.rig.id);
  const data = {
    sessions,
    activeSessionIdByNode: deriveRehydrateSessionIdByNode(sessions, nodeIds, recorded),
    activeOccupantsByNode: deriveRehydrateOccupantsByNode(sessions, nodeIds, recorded),
  };
  const { stoppedNodeIds } = assessSnapshotCurrentOccupants(db, rig, { data }, preserveStoppedInitial);
  return sessions.map(session => ({ ...session, stoppedCurrent: stoppedNodeIds.has(session.nodeId) }));
}

/**
 * Forecast per-seat restore actions from current inventory and saved occupancy.
 * Report token state and guidance without launching or changing any sessions.
 */
export function buildRestorePlanPreview(
  rig: RigWithRelations,
  snapshot: Snapshot | null,
  sessionRows: PreviewSessionRow[],
  freshLogicalIds?: string[],
  nowMs: number = Date.now(),
  recorded: Record<string, string | null> = {},
): RestorePlanPreview {
  // OPR.0.5.7.1 — the relation the resolution consumes: the snapshot's own
  // when previewing a snapshot; for the live no-snapshot case, the SAME
  // would-capture derivation SnapshotCapture uses (shared helper — the
  // sibling paths cannot drift).
  const nodeIds = rig.nodes.map(node => node.id);
  const occupancy = snapshot?.data ?? {
    sessions: sessionRows,
    activeSessionIdByNode: deriveRehydrateSessionIdByNode(sessionRows, nodeIds, recorded),
    activeOccupantsByNode: deriveRehydrateOccupantsByNode(sessionRows, nodeIds, recorded),
  };
  const nodes: RestorePlanPreviewNode[] = rig.nodes.map((node) => {
    const freshRequested = freshLogicalIds?.includes(node.logicalId) ?? false;
    const savedNodeId = snapshot?.data.nodes?.find(saved => saved.logicalId === node.logicalId)?.id ?? node.id;
    const resolution = resolveActiveSnapshotSession<PreviewSessionRow>(occupancy, savedNodeId);
    const runtimeError = resolution.kind !== "ambiguous"
      ? restoreRuntimeCompatibilityError(node.runtime, snapshot?.data.nodeStartupContext?.[savedNodeId]?.runtime)
      : null;
    // The runtimes and recorded sessions restore reads the seat's policy through: the snapshot's own node, else the live one.
    const seat: RestoreSeatFacts = {
      savedRuntime: snapshot?.data.nodes?.find(saved => saved.logicalId === node.logicalId)?.runtime ?? node.runtime,
      currentRuntime: node.runtime,
      recordedSessions: sessionRows.filter((row) => row.nodeId === savedNodeId),
    };
    const stoppedCurrent = sessionRows.some(row => row.nodeId === savedNodeId && row.stoppedCurrent);
    // Restore checks the live binding before anything else (restoreNodeWithCompensation), and so does its forecast.
    const attached = node.binding?.attachmentType === "external_cli";
    const { intendedAction, reason } = attached
      ? { intendedAction: "leave-attached" as const, reason: leftAttachedReason(node.binding?.externalSessionName ?? node.logicalId) }
      : runtimeError
      ? { intendedAction: "awaiting-decision" as const, reason: runtimeError }
      : intendedActionFor(resolution, freshRequested, seat,
        { logicalId: node.logicalId, rigName: rig.rig.name, row: absentSeatResumeHistory(sessionRows, savedNodeId), stoppedCurrent });
    // OPR.0.4.3.20 FR-6 — per-seat token state (read-only), derived from the
    // RESOLVED occupant only — never from a historical row.
    const occupant = resolution.kind === "resolved" ? resolution.session : null;
    const { tokenState, provenance, lastVerified } = tokenStateFor(occupant, nowMs);
    const runtimePrompt = attached ? undefined : runtimePromptFor(node.runtime, tokenState);
    return {
      logicalId: node.logicalId,
      occupantSessionId: occupant?.id ?? null,
      hasHistory: sessionRows.some((row) => row.nodeId === savedNodeId),
      intendedAction,
      ...(reason ? { reason } : {}),
      tokenState,
      ...(provenance ? { provenance } : {}),
      ...(lastVerified ? { lastVerified } : {}),
      // no resumable token → restore needs an explicit --fresh (never
      // silent); runtime mismatches and broken relations cannot be resolved
      // by a fresh request, so --fresh must not be suggested as their remedy.
      // A terminal has no token to find and relaunches fresh on its own.
      freshRequired: attached || stoppedCurrent || runtimeError || resolution.kind === "ambiguous" ? false : tokenState === "missing" && !isOrdinaryTerminalSeat(seat),
      ...(runtimePrompt ? { runtimePrompt } : {}),
    };
  });
  return {
    status: "plan",
    mode: "restore",
    rigId: rig.rig.id,
    rigName: rig.rig.name,
    snapshot: snapshot ? { id: snapshot.id, kind: snapshot.kind, createdAt: snapshot.createdAt } : null,
    wouldCaptureCurrentState: snapshot === null,
    nodes,
    mutated: false,
  };
}
