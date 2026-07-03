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
import type { RigWithRelations, Snapshot } from "./types.js";

/** OPR.0.4.3.20 FR-6 — a present token whose last verification is older than this
 *  is surfaced as `stale` (age-based staleness — the "stale while running" signal
 *  that needs no probe). DELIVERY DEFAULT; pm confirms the exact value. */
export const RESUME_FRESHNESS_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/** OPR.0.4.3.20 FR-6 — per-seat token truth in the restore plan. */
export type ResumeTokenState = "present" | "missing" | "stale" | "unverified";

export interface RestorePlanPreviewNode {
  logicalId: string;
  /** The slice-02 vocabulary, as a forecast: what apply mode WOULD do. */
  intendedAction: "resume-original" | "fresh-primed" | "awaiting-decision";
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
  nodeId: string;
  restorePolicy: string | null;
  resumeType: string | null;
  resumeToken: string | null;
  // OPR.0.4.3.20 FR-6 — provenance + verification freshness (nullable/degrading
  // for pre-45 rows and old snapshots → rendered as unverified, never a crash).
  resumeProvenance: string | null;
  resumeLastVerified: string | null;
  resumeLastProbeStatus: string | null;
  /** ULID-ordered id so the newest session per node wins (matches the
   *  orchestrator's latest-session selection). */
  id: string;
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
    const verifiedMs = parseSqliteUtcMs(lastVerified);
    if (!Number.isNaN(verifiedMs) && nowMs - verifiedMs > RESUME_FRESHNESS_THRESHOLD_MS) {
      return { tokenState: "stale", provenance, lastVerified };
    }
  }
  return { tokenState: "present", provenance, lastVerified };
}

/** Parse a SQLite `datetime('now')` value ("YYYY-MM-DD HH:MM:SS", UTC, no zone
 *  marker) to epoch ms. Returns NaN on an unparseable value (age check is then
 *  skipped — an unparseable stamp is never treated as stale-by-age). */
function parseSqliteUtcMs(value: string): number {
  return new Date(value.replace(" ", "T") + "Z").getTime();
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

/** Forecast one seat's restore action — mirrors the orchestrator's pre-launch
 *  classification (OPR.0.3.4.2) without touching anything. A fresh-listed
 *  seat (operation B, `--fresh <seat>`) forecasts `fresh-primed` BEFORE any
 *  resume-token logic, exactly as apply mode deliberately skips the resume. */
function intendedActionFor(rows: PreviewSessionRow[], freshRequested: boolean): { intendedAction: RestorePlanPreviewNode["intendedAction"]; reason?: string } {
  if (freshRequested) {
    return {
      intendedAction: "fresh-primed",
      reason: "listed in --fresh — apply would deliberately skip the resume (operation B)",
    };
  }
  const latest = rows.length > 0 ? rows.reduce((a, b) => (b.id > a.id ? b : a)) : null;
  const policy = latest?.restorePolicy ?? "resume_if_possible";
  const sourceRecorded = !!latest?.resumeType && latest.resumeType !== "none";
  if (policy === "resume_if_possible" && sourceRecorded && latest?.resumeToken) {
    return { intendedAction: "resume-original" };
  }
  if (policy === "resume_if_possible" && sourceRecorded && !latest?.resumeToken) {
    return {
      intendedAction: "awaiting-decision",
      reason: `resume source '${latest?.resumeType}' recorded but no token available — apply would stop and ask (zero session)`,
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
): PreviewSessionRow[] {
  if (snapshot) {
    return (snapshot.data.sessions ?? []).map((s) => ({
      nodeId: s.nodeId,
      restorePolicy: s.restorePolicy ?? null,
      resumeType: s.resumeType ?? null,
      resumeToken: s.resumeToken ?? null,
      // OPR.0.4.3.20 FR-6 — degrade to null for snapshots serialized pre-45.
      resumeProvenance: s.resumeProvenance ?? null,
      resumeLastVerified: s.resumeLastVerified ?? null,
      resumeLastProbeStatus: s.resumeLastProbeStatus ?? null,
      id: s.id,
    }));
  }
  const nodeIds = rig.nodes.map((n) => n.id);
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, node_id, restore_policy, resume_type, resume_token, resume_provenance, resume_last_verified, resume_last_probe_status FROM sessions WHERE node_id IN (${placeholders})`
  ).all(...nodeIds) as Array<{ id: string; node_id: string; restore_policy: string | null; resume_type: string | null; resume_token: string | null; resume_provenance: string | null; resume_last_verified: string | null; resume_last_probe_status: string | null }>;
  return rows.map((r) => ({
    nodeId: r.node_id,
    restorePolicy: r.restore_policy,
    resumeType: r.resume_type,
    resumeToken: r.resume_token,
    resumeProvenance: r.resume_provenance,
    resumeLastVerified: r.resume_last_verified,
    resumeLastProbeStatus: r.resume_last_probe_status,
    id: r.id,
  }));
}

export function buildRestorePlanPreview(
  rig: RigWithRelations,
  snapshot: Snapshot | null,
  sessionRows: PreviewSessionRow[],
  freshLogicalIds?: string[],
  nowMs: number = Date.now(),
): RestorePlanPreview {
  const byNode = new Map<string, PreviewSessionRow[]>();
  for (const row of sessionRows) {
    (byNode.get(row.nodeId) ?? byNode.set(row.nodeId, []).get(row.nodeId)!).push(row);
  }
  const nodes: RestorePlanPreviewNode[] = rig.nodes.map((node) => {
    const rows = byNode.get(node.id) ?? [];
    const freshRequested = freshLogicalIds?.includes(node.logicalId) ?? false;
    const { intendedAction, reason } = intendedActionFor(rows, freshRequested);
    // OPR.0.4.3.20 FR-6 — per-seat token state (read-only; latest session per node).
    const latest = rows.length > 0 ? rows.reduce((a, b) => (b.id > a.id ? b : a)) : null;
    const { tokenState, provenance, lastVerified } = tokenStateFor(latest, nowMs);
    const runtimePrompt = runtimePromptFor(node.runtime, tokenState);
    return {
      logicalId: node.logicalId,
      intendedAction,
      ...(reason ? { reason } : {}),
      tokenState,
      ...(provenance ? { provenance } : {}),
      ...(lastVerified ? { lastVerified } : {}),
      // no resumable token → restore needs an explicit --fresh (never silent).
      freshRequired: tokenState === "missing",
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
