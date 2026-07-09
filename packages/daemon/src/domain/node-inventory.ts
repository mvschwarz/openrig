import type Database from "better-sqlite3";
import type { NodeInventoryEntry, NodeDetailEntry, NodeDetailPeer, NodeDetailEdge, NodeDetailCompactSpec, NodeRestoreOutcome, NodeOriented, NodeLifecycleState, Binding, RestoreResult, NodeRecoveryGuidance, Snapshot, WorkspaceSpec, SeatIdentityVerdict, SeatIdentityVerdictKind } from "./types.js";
import { identityVerdictDownranksRunning } from "./types.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import { buildOrientedMap } from "./startup-proof.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import type { ContextUsageStore } from "./context-usage-store.js";
import type { AgentActivityStore } from "./agent-activity-store.js";
import type { SeatActivityService } from "./seat-activity-service.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { probeSessionActivity } from "./session-transport.js";
import { findLatestUsableSnapshot, findLatestUsableSnapshotsForAllRigs } from "./rig-repository.js";
import { resolveNodeWorkspace } from "./workspace/workspace-resolver.js";
import { deriveCanonicalSessionName } from "./session-name.js";
import { buildNativeResumeCommand, buildCodexResumeCore } from "./native-resume-probe.js";

// -- Row types for SQL results --

interface InventoryRow {
  node_id: string;
  rig_id: string;
  rig_name: string;
  logical_id: string;
  pod_id: string | null;
  pod_namespace: string | null;
  role: string | null;
  runtime: string | null;
  model: string | null;
  codex_config_profile: string | null;
  agent_ref: string | null;
  profile: string | null;
  cwd: string | null;
  restore_policy: string | null;
  resolved_spec_name: string | null;
  resolved_spec_version: string | null;
  resolved_spec_hash: string | null;
  occupant_lifecycle: string | null;
  continuity_outcome: string | null;
  handover_result: string | null;
  previous_occupant: string | null;
  handover_at: string | null;
  // Newest session fields (may be null if no session)
  session_name: string | null;
  session_status: string | null;
  startup_status: string | null;
  resume_type: string | null;
  resume_token: string | null;
  startup_completed_at: string | null;
  binding_attachment_type: string | null;
  binding_tmux_pane: string | null;
}

interface EventRow {
  seq: number;
  rig_id: string;
  node_id: string;
  type: string;
  payload: string;
  created_at: string;
}

interface StartupContextRow {
  node_id: string;
  projection_entries_json: string;
  resolved_files_json: string;
  startup_actions_json: string;
  runtime: string;
}

interface BindingRow {
  id: string;
  node_id: string;
  attachment_type: string | null;
  tmux_session: string | null;
  tmux_window: string | null;
  tmux_pane: string | null;
  external_session_name: string | null;
  cmux_workspace: string | null;
  cmux_surface: string | null;
  updated_at: string;
}

// -- Helpers --

function computeResumeCommand(runtime: string | null, resumeToken: string | null, codexConfigProfile?: string | null): string | null {
  return buildNativeResumeCommand(runtime, resumeToken, null, codexConfigProfile);
}

function computeRecoveryGuidance(input: {
  runtime: string | null;
  resumeToken: string | null;
  cwd: string | null;
  sessionName: string | null;
  codexConfigProfile?: string | null;
}): NodeRecoveryGuidance | null {
  const { runtime, resumeToken, cwd, sessionName, codexConfigProfile } = input;

  if (runtime === "claude-code") {
    const commands: string[] = [];
    const notes: string[] = [];

    if (resumeToken) {
      const cmd = buildNativeResumeCommand(runtime, resumeToken, sessionName);
      if (cmd) commands.push(cmd);
    }
    if (cwd) {
      commands.push(`cd ${cwd}`);
    }
    commands.push("claude --resume");

    if (sessionName) {
      notes.push(`Look for session name: ${sessionName}`);
    }
    notes.push("Choose the full conversation option, not summary.");

    return {
      summary: resumeToken
        ? "Try native Claude resume first, then fall back to the workspace-local picker if needed."
        : "No stored Claude resume token. Use the workspace-local Claude picker fallback.",
      commands,
      notes,
    };
  }

  if (runtime === "codex") {
    const commands: string[] = [];
    const notes: string[] = [];

    if (resumeToken) {
      commands.push(buildCodexResumeCore(resumeToken, codexConfigProfile));
    }
    if (cwd) {
      commands.push(`cd ${cwd}`);
    }
    if (!resumeToken) {
      commands.push(buildCodexResumeCore("", codexConfigProfile, true));
    }

    notes.push("Use workspace and recent prompt text to identify the right conversation.");
    if (codexConfigProfile) {
      notes.push(`Preserve Codex config profile: ${codexConfigProfile}`);
    }
    if (sessionName) {
      notes.push(`If the identity anchor was captured, the picker may include: ${sessionName}`);
    }

    return {
      summary: resumeToken
        ? "Try native Codex resume first; posture flags preserve the approval/sandbox configuration."
        : "No stored Codex resume token. Try codex resume --last with posture flags.",
      commands,
      notes,
    };
  }

  return null;
}

function deriveNodeKind(runtime: string | null): "agent" | "infrastructure" {
  return runtime === "terminal" ? "infrastructure" : "agent";
}

/**
 * Derives per-node lifecycle state from session/restore truth plus the rig's latest
 * usable snapshot.
 *
 * Priorities (post-L2):
 *   attention_required  — restoreOutcome=failed AND tmux session is alive
 *                         (v0 proxy for the Claude resume-prompt case; revisited in L3).
 *   running             — sessionStatus=running.
 *   recoverable         — non-running session AND the latest usable snapshot has a
 *                         non-null resume token for THIS node.
 *   detached            — anything else (no session, exited, detached without resume token).
 *
 * Permission/IO failures upstream (L1 fail-closed) leave sessionStatus unchanged, so
 * the projection stays honest without misclassifying ambiguous probe failures.
 */
export function deriveNodeLifecycleState(input: {
  sessionStatus: string | null;
  restoreOutcome: NodeRestoreOutcome;
  nodeId: string;
  usableSnapshot: Snapshot | null;
  /** OPR.0.4.3.19 — the persisted liveness identity verdict for this node.
   *  A `mismatch`/`pane_missing` verdict down-ranks a `running` session to
   *  `attention_required` (no false-green). `verified`, `tmux_unavailable`,
   *  and an absent verdict leave the projection unchanged. */
  identityVerdict?: SeatIdentityVerdictKind | null;
}): NodeLifecycleState {
  // L3: the explicit `attention_required` outcome (Claude resume-selection
  // prompt) and the L2 proxy (failed + alive tmux session) both surface as
  // lifecycleState=attention_required.
  if (
    input.restoreOutcome === "attention_required"
    || (input.restoreOutcome === "failed" && input.sessionStatus === "running")
  ) {
    return "attention_required";
  }
  if (input.sessionStatus === "running") {
    // OPR.0.4.3.19 — a `running` session projects `running` ONLY when its
    // pane process identity is verified (or not-yet-observed). An explicit
    // mismatch/pane-missing verdict down-ranks to attention_required so a
    // dead/orphaned/squatted pane never surfaces as healthy green.
    if (identityVerdictDownranksRunning(input.identityVerdict)) return "attention_required";
    return "running";
  }
  if (input.usableSnapshot) {
    const nodeSession = (input.usableSnapshot.data.sessions ?? []).find(
      (s) => s.nodeId === input.nodeId,
    );
    if (typeof nodeSession?.resumeToken === "string" && nodeSession.resumeToken.length > 0) {
      return "recoverable";
    }
  }
  return "detached";
}

function deriveOccupantLifecycle(
  row: InventoryRow,
  identityVerdict?: SeatIdentityVerdictKind | null,
): NodeInventoryEntry["occupantLifecycle"] {
  if (row.occupant_lifecycle) {
    return row.occupant_lifecycle as NodeInventoryEntry["occupantLifecycle"];
  }
  // OPR.0.4.3.19 — the derived `active` occupant requires a verified (or
  // not-yet-observed) pane identity, mirroring the lifecycleState gate.
  if (row.session_status === "running" && !identityVerdictDownranksRunning(identityVerdict)) {
    return "active";
  }
  return "unknown";
}

function deriveContinuityOutcome(
  row: InventoryRow,
  restoreOutcome: NodeRestoreOutcome,
): NodeInventoryEntry["continuityOutcome"] {
  if (row.continuity_outcome) {
    return row.continuity_outcome as NodeInventoryEntry["continuityOutcome"];
  }
  if (restoreOutcome === "n-a") return null;
  // L3: `attention_required` and `operator_recovered` are restore-attempt
  // outcomes that don't map onto the ContinuityOutcome vocabulary
  // ("resumed"|"rebuilt"|"forked"|"fresh"|"failed"). Surface as null here;
  // the lifecycleState projection picks them up via restoreOutcome directly.
  if (restoreOutcome === "attention_required") return null;
  if (restoreOutcome === "operator_recovered") return "resumed";
  // OPR.0.3.4.2: a deliberate fresh-prime IS fresh continuity; awaiting-decision
  // means zero session, so no continuity outcome exists — null (the
  // restoreOutcome field carries the distinct term).
  if (restoreOutcome === "fresh-primed") return "fresh";
  if (restoreOutcome === "awaiting-decision") return null;
  return restoreOutcome;
}

// FS-1 W1.3 S1 — hoist restore-outcome derivation to ONCE-PER-RIG.
// Prior shape: deriveRestoreOutcome(db, rigId, nodeId) fetched + JSON-parsed the
// rig's ENTIRE restore-event set once PER NODE inside buildInventoryEntry (K
// nodes x E events per rig per poll = the dominant W3 residual). This builds a
// nodeId->outcome map in ONE seq-DESC pass and buildInventoryEntry does an O(1)
// lookup.
//   OPR.0.3.4.11 + 0.4.0.16: per-node-latest across restore.completed,
//   restore.subset_completed, AND restore.outcome_reconciled. reconciled has a
//   different shape (top-level nodeId/to, not result.nodes[]).
// BYTE-IDENTICAL BY CONSTRUCTION: the prior per-node reader returned the FIRST
// event in seq-DESC order that referenced the node. This single seq-DESC pass
// sets a node's outcome ONLY IF ABSENT — so the first (highest-seq) event
// referencing a node wins, reproducing exactly that (incl.
// newer-reconcile-overrides-older-failure). rigId given -> WHERE rig_id=? (the
// prior single-rig filter); rigId omitted -> all rigs in one pass (a nodeId is
// referenced only by its own rig's events, so the per-node value is identical).
// [GUARD AT CODE REVIEW: the only-if-absent set is the one load-bearing
//  semantics cell — it is what preserves first/newest-wins.]
function buildRestoreOutcomeMap(db: Database.Database, rigId?: string): Map<string, NodeRestoreOutcome> {
  const stmt = db.prepare(
    `SELECT type, payload, seq FROM events WHERE type IN ('restore.completed', 'restore.subset_completed', 'restore.outcome_reconciled')${rigId ? " AND rig_id = ?" : ""} ORDER BY seq DESC`
  );
  const rows = (rigId ? stmt.all(rigId) : stmt.all()) as { type: string; payload: string; seq: number }[];
  const map = new Map<string, NodeRestoreOutcome>();
  for (const row of rows) {
    try {
      if (row.type === "restore.outcome_reconciled") {
        const event = JSON.parse(row.payload) as { nodeId: string; to: string };
        if (!map.has(event.nodeId)) map.set(event.nodeId, mapStatus(event.to));
        continue;
      }
      const event = JSON.parse(row.payload) as { result: RestoreResult };
      for (const nodeResult of event.result.nodes) {
        if (!map.has(nodeResult.nodeId)) map.set(nodeResult.nodeId, mapStatus(nodeResult.status));
      }
    } catch {
      continue;
    }
  }
  return map;
}

function mapStatus(status: string): NodeRestoreOutcome {
  if (status === "resumed") return "resumed";
  if (status === "failed") return "failed";
  if (status === "rebuilt") return "rebuilt";
  if (status === "fresh") return "fresh";
  if (status === "fresh-primed") return "fresh-primed";
  if (status === "awaiting-decision") return "awaiting-decision";
  if (status === "attention_required") return "attention_required";
  if (status === "operator_recovered") return "operator_recovered";
  if (status === "checkpoint_written") return "rebuilt";
  if (status === "fresh_no_checkpoint") return "fresh";
  return "n-a";
}

function deriveHeldReason(db: Database.Database, rigId: string, nodeId: string, sessionStatus: string | null): string | null {
  if (sessionStatus === "running") return null;

  const heldRow = db.prepare(
    "SELECT seq, payload FROM events WHERE node_id = ? AND type = 'node.held' ORDER BY seq DESC LIMIT 1"
  ).get(nodeId) as { seq: number; payload: string } | undefined;
  if (!heldRow) return null;

  // Superseded by a later rig-scoped restore event containing this node.
  // restore.completed/restore.subset_completed are rig-scoped (no top-level nodeId),
  // so query by rig_id and parse payloads for node containment.
  const laterRestoreRows = db.prepare(
    "SELECT payload FROM events WHERE rig_id = ? AND type IN ('restore.completed', 'restore.subset_completed') AND seq > ? ORDER BY seq DESC"
  ).all(rigId, heldRow.seq) as { payload: string }[];
  for (const row of laterRestoreRows) {
    try {
      const event = JSON.parse(row.payload) as { result: { nodes: Array<{ nodeId: string }> } };
      if (event.result?.nodes?.some((n) => n.nodeId === nodeId)) return null;
    } catch { continue; }
  }

  try {
    const parsed = JSON.parse(heldRow.payload) as { reason?: string };
    return parsed.reason ?? null;
  } catch {
    return null;
  }
}

function getLatestError(db: Database.Database, rigId: string, nodeId: string): string | null {
  const row = db.prepare(
    "SELECT payload FROM events WHERE rig_id = ? AND node_id = ? AND type = 'node.startup_failed' ORDER BY seq DESC LIMIT 1"
  ).get(rigId, nodeId) as { payload: string } | undefined;

  if (!row) return null;

  try {
    const event = JSON.parse(row.payload) as { error?: string };
    return event.error ?? null;
  } catch {
    return null;
  }
}

/**
 * Map persisted projection entries to the installedResources shape.
 * The startup-orchestrator persists: { category, effectiveId, sourceSpec, sourcePath, resourcePath, absolutePath, mergeStrategy, target }
 * We normalize to: { id, category, targetPath }
 */
function mapProjectionEntries(entries: unknown[]): Array<{ id: string; category: string; targetPath: string }> {
  return entries.map((e: unknown) => {
    const entry = e as Record<string, string>;
    return {
      id: entry.effectiveId ?? entry.id ?? "",
      category: entry.category ?? "",
      targetPath: entry.target ?? entry.targetPath ?? "",
    };
  });
}

/**
 * OPR.0.4.3.19 rev1-r2 B1 — gate a durable identity verdict to the CURRENT
 * binding. The verdict table is keyed only by node_id, so on rebind/relaunch
 * (same node_id, new session + new pane) the stored verdict describes a pane
 * that is no longer bound. Serving it for the new pane opens a false-green
 * window (a stale `verified` suppresses the down-rank a fresh squat/orphan
 * should trigger; a stale `mismatch` would down-rank a healthy new pane).
 *
 * A verdict applies ONLY when it was computed against the current binding:
 *   verdict.sessionName === row.session_name  AND
 *   verdict.evidence.registeredPane === row.tmux_pane
 * Otherwise return null — the projection treats it as ABSENT (fail-open: a
 * running seat is left unchanged, never down-ranked). This keeps the rev1-r1
 * fail-open discipline: turning a stale verdict into ABSENT never down-ranks;
 * only a matching mismatch/pane_missing does.
 */
function applicableVerdict(
  verdict: SeatIdentityVerdict | null,
  row: Pick<InventoryRow, "session_name" | "binding_tmux_pane">,
): SeatIdentityVerdict | null {
  if (!verdict) return null;
  if (verdict.sessionName !== row.session_name) return null;
  if (verdict.evidence.registeredPane !== row.binding_tmux_pane) return null;
  return verdict;
}

// -- Public API --

/**
 * Get the canonical node inventory for a rig.
 * Single source of truth consumed by CLI, UI, and MCP.
 */
export function getNodeInventory(db: Database.Database, rigId: string): NodeInventoryEntry[] {
  // Resolve the rig's latest usable snapshot once for the whole projection so per-node
  // recoverability checks share the same source of truth without N extra queries.
  const usableSnapshot = findLatestUsableSnapshot(db, rigId);
  // PL-007: rig's typed workspace block (if declared) loaded once per
  // projection so per-node kind resolution shares one parse.
  const workspaceSpec = readRigWorkspaceJson(db, rigId);
  // OPR.0.4.3.19: the persisted per-node liveness identity verdicts, read once
  // per projection (cheap indexed read, defensive to a missing table). Gates
  // the running/active green derivations below.
  const identityVerdicts = new SeatIdentityStore(db).getForRig(rigId);
  // FS-1 W1.3 S1/S2 — the per-node restore-outcome + oriented reads built ONCE
  // for the rig (was a query per node inside the rows.map). rig-scoped restore
  // map = the prior WHERE rig_id=? filter; oriented map is node-scoped/global.
  const restoreOutcomes = buildRestoreOutcomeMap(db, rigId);
  const orienteds = buildOrientedMap(db);

  const rows = queryInventoryRows(db, rigId);

  return rows.map((row) =>
    buildInventoryEntry(db, row, { usableSnapshot, workspaceSpec, identityVerdicts, restoreOutcomes, orienteds }),
  );
}

/**
 * FS-1 W1.2 — the shared inventory-row query. Extracted verbatim from the prior
 * inline `getNodeInventory` SELECT so the single-rig and all-rigs paths run the
 * IDENTICAL query.
 *   - `rigId` given → one rig (`WHERE n.rig_id = ?`, `ORDER BY n.created_at`) —
 *     byte-identical to the prior per-rig read.
 *   - `rigId` omitted → ALL rigs in one pass (no WHERE; `ORDER BY n.rig_id,
 *     n.created_at` so JS grouping preserves each rig's `created_at` order,
 *     matching the per-rig ordering exactly).
 * The latest-session subquery (`s2.node_id = n.id ORDER BY id DESC LIMIT 1`)
 * rides the W1.1 index (051, idx_sessions_node_created_id).
 */
function queryInventoryRows(db: Database.Database, rigId?: string): InventoryRow[] {
  // Join nodes with newest session (max ULID = max session.id string comparison)
  // and the rig name
  const hasCodexConfigProfile = db.prepare("PRAGMA table_info(nodes)").all()
    .some((row) => (row as { name?: string }).name === "codex_config_profile");
  const codexConfigProfileSelect = hasCodexConfigProfile
    ? "n.codex_config_profile"
    : "NULL";
  const stmt = db.prepare(`
    SELECT
      n.id as node_id,
      n.rig_id,
      r.name as rig_name,
      n.logical_id,
      n.pod_id,
      p.namespace as pod_namespace,
      n.role,
      n.runtime,
      n.model,
      ${codexConfigProfileSelect} as codex_config_profile,
      n.agent_ref,
      n.profile,
      n.cwd,
      n.restore_policy,
      n.resolved_spec_name,
      n.resolved_spec_version,
      n.resolved_spec_hash,
      n.occupant_lifecycle,
      n.continuity_outcome,
      n.handover_result,
      n.previous_occupant,
      n.handover_at,
      s.session_name,
      s.status as session_status,
      s.startup_status,
      s.resume_type,
      s.resume_token,
      s.startup_completed_at,
      b.attachment_type as binding_attachment_type,
      b.tmux_pane as binding_tmux_pane
    FROM nodes n
    JOIN rigs r ON r.id = n.rig_id
    LEFT JOIN pods p ON p.id = n.pod_id
    LEFT JOIN sessions s ON s.node_id = n.id
      AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
    LEFT JOIN bindings b ON b.node_id = n.id
    ${rigId ? "WHERE n.rig_id = ?" : ""}
    ORDER BY ${rigId ? "n.created_at" : "n.rig_id, n.created_at"}
  `);
  return (rigId ? stmt.all(rigId) : stmt.all()) as InventoryRow[];
}

/** Per-rig setup context an inventory row is built against. FS-1 W1.2: the
 *  single-rig (`getNodeInventory`) and all-rigs (`getNodeInventoryForAllRigs`)
 *  paths both build entries through THIS one function, so their output is
 *  byte-identical by construction — the collapse changes only HOW the context +
 *  rows are fetched (per-rig vs batched), never how an entry is derived. */
interface InventoryBuildContext {
  usableSnapshot: Snapshot | null;
  workspaceSpec: WorkspaceSpec | null;
  identityVerdicts: Map<string, SeatIdentityVerdict>;
  // FS-1 W1.3 S1/S2 — the once-per-rig-batched per-node reads, keyed by node_id.
  // Built ONCE per projection (rig-scoped for single-rig, all-rigs for the
  // batched path) and looked up O(1) here instead of a query per node.
  restoreOutcomes: Map<string, NodeRestoreOutcome>;
  orienteds: Map<string, NodeOriented>;
}

function buildInventoryEntry(
  db: Database.Database,
  row: InventoryRow,
  ctx: InventoryBuildContext,
): NodeInventoryEntry {
  const { usableSnapshot, workspaceSpec, identityVerdicts, restoreOutcomes, orienteds } = ctx;
  // FS-1 W1.3 S1 — O(1) lookup into the once-per-rig restore-outcome map
  // (byte-identical to the prior per-node deriveRestoreOutcome; "n-a" when a node
  // is referenced by no restore event, matching the prior fall-through).
  const restoreOutcome = restoreOutcomes.get(row.node_id) ?? "n-a";
  // OPR.0.4.3.19 rev1-r2 B1 — a durable verdict is keyed only by node_id, so
  // after a rebind/relaunch (same node, NEW session + NEW pane) a stale
  // `verified` verdict for the OLD pane would otherwise be served for the new
  // pane until the next 5s reconcile tick, suppressing down-rank and rendering
  // a fresh squat/orphan false-green. Make applicability LOAD-BEARING at read
  // time: a stored verdict applies ONLY when it was computed against the
  // current binding (its sessionName === the latest session AND its
  // registeredPane === the current binding pane). Otherwise treat it as ABSENT
  // (null) — a STALE verdict becomes fail-open (never down-ranks a running
  // seat), it does NOT itself down-rank. Only a MATCHING mismatch/pane_missing
  // verdict down-ranks.
  const identityVerdict = applicableVerdict(identityVerdicts.get(row.node_id) ?? null, row);
  const lifecycleState = deriveNodeLifecycleState({
    sessionStatus: row.session_status,
    restoreOutcome,
    nodeId: row.node_id,
    usableSnapshot,
    identityVerdict: identityVerdict?.verdict ?? null,
  });
  return {
    rigId: row.rig_id,
    rigName: row.rig_name,
    logicalId: row.logical_id,
    podId: row.pod_id,
    podNamespace: row.pod_namespace,
    // OPR.0.4.6.FAC1: the seat-side role dimension (nodes.role,
    // declared in the pod-member spec) — the workflow binding layer's
    // candidate filter. null = role-less (never role-resolved).
    role: row.role,
    canonicalSessionName: row.session_name,
    attachmentType: (row.binding_attachment_type as NodeInventoryEntry["attachmentType"]) ?? null,
    nodeKind: deriveNodeKind(row.runtime),
    runtime: row.runtime,
    sessionStatus: row.session_status,
    startupStatus: row.startup_status as NodeInventoryEntry["startupStatus"],
    restoreOutcome,
    // FS-1 W1.3 S2 — O(1) lookup into the fleet-batched oriented map
    // (byte-identical to the prior per-node deriveOriented; "n-a" when a node has
    // no proof events, matching deriveOriented's no-challenge branch).
    oriented: orienteds.get(row.node_id) ?? "n-a",
    lifecycleState,
    occupantLifecycle: deriveOccupantLifecycle(row, identityVerdict?.verdict ?? null),
    continuityOutcome: deriveContinuityOutcome(row, restoreOutcome),
    handoverResult: row.handover_result as NodeInventoryEntry["handoverResult"] ?? null,
    previousOccupant: row.previous_occupant,
    handoverAt: row.handover_at,
    tmuxAttachCommand: row.binding_attachment_type === "tmux" && row.session_name ? `tmux attach -t ${row.session_name}` : null,
    resumeCommand: computeResumeCommand(row.runtime, row.resume_token, row.codex_config_profile),
    // OPR.0.4.0.26: recoveryGuidance is NOT inlined per node in the LIST
    // payload. It duplicated ~47KB of templated prose across all nodes and
    // no node-list consumer reads it. The full guidance is recomputed on
    // the single-node detail path (getNodeDetail / GET
    // /api/rigs/:rigId/nodes/:logicalId) — relocation, not loss.
    recoveryGuidance: null,
    latestError: row.startup_status === "ready" ? null : getLatestError(db, row.rig_id, row.node_id),
    // Extended fields
    model: row.model,
    agentRef: row.agent_ref,
    profile: row.profile,
    codexConfigProfile: row.codex_config_profile,
    resolvedSpecName: row.resolved_spec_name,
    resolvedSpecVersion: row.resolved_spec_version,
    resolvedSpecHash: row.resolved_spec_hash,
    cwd: row.cwd,
    restorePolicy: row.restore_policy,
    resumeType: row.resume_type,
    resumeToken: row.resume_token,
    startupCompletedAt: row.startup_completed_at,
    // PL-007 Workspace Primitive — per-node workspace summary derived
    // from cwd against the rig's typed workspace block. null when the
    // rig has no workspace declaration.
    workspace: resolveNodeWorkspace({ spec: workspaceSpec, cwd: row.cwd }),
    // OPR.0.4.3.19 — the liveness identity verdict (third axis). null when
    // never observed; carries evidence on mismatch/missing.
    identityVerdict,
    heldReason: deriveHeldReason(db, row.rig_id, row.node_id, row.session_status),
  };
}

/** FS-1 W1.2 — all-rigs batched form of `readRigWorkspaceJson`: one query,
 *  `rigId → WorkspaceSpec`. Rigs with no/malformed workspace are absent (callers
 *  default to null — byte-identical to `readRigWorkspaceJson`'s null return). */
function readAllRigWorkspaceJson(db: Database.Database): Map<string, WorkspaceSpec> {
  const out = new Map<string, WorkspaceSpec>();
  try {
    const rows = db.prepare("SELECT id, workspace_json FROM rigs").all() as Array<{ id: string; workspace_json: string | null }>;
    for (const row of rows) {
      if (!row.workspace_json) continue;
      try { out.set(row.id, JSON.parse(row.workspace_json) as WorkspaceSpec); } catch { /* malformed → absent → caller null (matches per-rig) */ }
    }
  } catch { /* column/table absent → empty → caller null (matches per-rig defensive path) */ }
  return out;
}

/**
 * FS-1 W1.2 — the rig-level N+1 collapse. Builds inventory for ALL rigs in a
 * bounded, rig-count-INDEPENDENT set of queries: 3 batched setup reads
 * (snapshots / workspaces / identity verdicts) + 1 all-rigs node SELECT, grouped
 * by rig_id. Every entry is built through the SAME `buildInventoryEntry` that the
 * per-rig `getNodeInventory` uses, so `getNodeInventoryForAllRigs(db).get(rigId)`
 * is byte-identical to `getNodeInventory(db, rigId)` — the collapse changes only
 * HOW the context + rows are fetched (batched vs per-rig), never how an entry is
 * derived. Per-node reads inside `buildInventoryEntry` (`deriveRestoreOutcome`
 * etc.) remain per-node and ride the 047 index — NOT the rig-level N+1 removed here.
 */
export function getNodeInventoryForAllRigs(db: Database.Database): Map<string, NodeInventoryEntry[]> {
  const snapshotByRig = findLatestUsableSnapshotsForAllRigs(db);
  const workspaceByRig = readAllRigWorkspaceJson(db);
  const verdictsByRig = new SeatIdentityStore(db).getForAllRigs();
  // FS-1 W1.3 S1/S2 — the per-node reads built ONCE for ALL rigs (O(1) queries,
  // not O(nodes)). Restore map unscoped: a nodeId is referenced only by its own
  // rig's restore events, so each node's value equals the single-rig path.
  const restoreOutcomes = buildRestoreOutcomeMap(db);
  const orienteds = buildOrientedMap(db);
  const rows = queryInventoryRows(db);
  const out = new Map<string, NodeInventoryEntry[]>();
  for (const row of rows) {
    const entry = buildInventoryEntry(db, row, {
      usableSnapshot: snapshotByRig.get(row.rig_id) ?? null,
      workspaceSpec: workspaceByRig.get(row.rig_id) ?? null,
      identityVerdicts: verdictsByRig.get(row.rig_id) ?? new Map(),
      restoreOutcomes,
      orienteds,
    });
    let list = out.get(row.rig_id);
    if (!list) { list = []; out.set(row.rig_id, list); }
    list.push(entry);
  }
  return out;
}

/** PL-007 — read the rig's typed workspace block from `rigs.workspace_json`
 *  defensively. Migration 038 may not yet be applied in older test fixtures
 *  that bypass the canonical migration list, so a missing column returns
 *  null cleanly. */
function readRigWorkspaceJson(db: Database.Database, rigId: string): WorkspaceSpec | null {
  try {
    const row = db.prepare("SELECT workspace_json FROM rigs WHERE id = ?")
      .get(rigId) as { workspace_json: string | null } | undefined;
    if (!row || !row.workspace_json) return null;
    return JSON.parse(row.workspace_json) as WorkspaceSpec;
  } catch {
    return null;
  }
}

/**
 * Get detailed node information including startup files, resources, and events.
 * The adapter dependency is optional — when provided, uses live listInstalled;
 * otherwise falls back to projection entries from startup context.
 */
export function getNodeDetail(
  db: Database.Database,
  rigId: string,
  logicalId: string,
  opts?: {
    adapters?: Record<string, RuntimeAdapter>;
    /** Pre-resolved installed resources from adapter.listInstalled() — route layer provides this. */
    installedResourcesOverride?: Array<{ id: string; category: string; targetPath: string }>;
  },
): NodeDetailEntry | null {
  // Get the inventory entry first
  const allEntries = getNodeInventory(db, rigId);
  const entry = allEntries.find((e) => e.logicalId === logicalId);
  if (!entry) return null;

  // Find the node ID
  const nodeRow = db.prepare(
    "SELECT id FROM nodes WHERE rig_id = ? AND logical_id = ?"
  ).get(rigId, logicalId) as { id: string } | undefined;
  if (!nodeRow) return null;
  const nodeId = nodeRow.id;

  // Binding
  const bindingRow = db.prepare("SELECT * FROM bindings WHERE node_id = ?").get(nodeId) as BindingRow | undefined;
  const binding: Binding | null = bindingRow ? {
    id: bindingRow.id,
    nodeId,
    attachmentType: (bindingRow.attachment_type as Binding["attachmentType"]) ?? "tmux",
    tmuxSession: bindingRow.tmux_session,
    tmuxWindow: bindingRow.tmux_window,
    tmuxPane: bindingRow.tmux_pane,
    externalSessionName: bindingRow.external_session_name ?? null,
    cmuxWorkspace: bindingRow.cmux_workspace,
    cmuxSurface: bindingRow.cmux_surface,
    updatedAt: bindingRow.updated_at,
  } : null;

  // Startup context
  const ctxRow = db.prepare(
    "SELECT * FROM node_startup_context WHERE node_id = ?"
  ).get(nodeId) as StartupContextRow | undefined;

  const startupFiles = ctxRow ? JSON.parse(ctxRow.resolved_files_json) : [];
  const startupActions = ctxRow ? JSON.parse(ctxRow.startup_actions_json) : [];
  const projectionEntries = ctxRow ? JSON.parse(ctxRow.projection_entries_json) : [];

  // Installed resources: override (from async adapter call) > projection fallback
  let installedResources: NodeDetailEntry["installedResources"];
  if (opts?.installedResourcesOverride) {
    installedResources = opts.installedResourcesOverride;
  } else if (opts?.adapters?.[entry.runtime ?? ""] && binding) {
    // Adapter is available — caller should have pre-resolved via listInstalled (async).
    // If caller passed adapters but not override, try sync call for test compatibility.
    try {
      const adapter = opts.adapters[entry.runtime ?? ""]!;
      const nodeBinding = { ...binding, cwd: entry.cwd ?? "." };
      const resources = adapter.listInstalled(nodeBinding) as unknown;
      // Handle both sync (test mocks) and Promise (real adapters)
      if (Array.isArray(resources)) {
        installedResources = (resources as Array<{ effectiveId: string; category: string; installedPath: string }>).map((r) => ({
          id: r.effectiveId,
          category: r.category,
          targetPath: r.installedPath,
        }));
      } else {
        // Async — fall through to projection
        installedResources = mapProjectionEntries(projectionEntries);
      }
    } catch {
      installedResources = mapProjectionEntries(projectionEntries);
    }
  } else {
    // Projection fallback
    installedResources = mapProjectionEntries(projectionEntries);
  }

  // Recent events (last 20 for this node)
  const eventRows = db.prepare(
    "SELECT * FROM events WHERE node_id = ? ORDER BY seq DESC LIMIT 20"
  ).all(nodeId) as EventRow[];

  const recentEvents = eventRows.map((r) => {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(r.payload); } catch { /* empty */ }
    return {
      type: r.type,
      createdAt: r.created_at,
      payload,
    };
  });

  // Infrastructure startup command
  let infrastructureStartupCommand: string | null = null;
  if (entry.nodeKind === "infrastructure" && startupActions.length > 0) {
    const sendTextAction = startupActions.find((a: { type: string }) => a.type === "send_text");
    if (sendTextAction) {
      infrastructureStartupCommand = sendTextAction.value;
    }
  }

  // Peers: other nodes in the same rig
  const peers: NodeDetailPeer[] = allEntries
    .filter((e) => e.logicalId !== logicalId)
    .map((e) => ({
      logicalId: e.logicalId,
      canonicalSessionName: e.canonicalSessionName,
      attachmentType: e.attachmentType,
      runtime: e.runtime,
    }));

  // Edges: outgoing and incoming for this node
  const edgeRows = db.prepare(
    "SELECT e.kind, e.source_id, e.target_id, src.logical_id as src_logical, tgt.logical_id as tgt_logical " +
    "FROM edges e " +
    "JOIN nodes src ON src.id = e.source_id " +
    "JOIN nodes tgt ON tgt.id = e.target_id " +
    "WHERE e.rig_id = ? AND (e.source_id = ? OR e.target_id = ?)"
  ).all(rigId, nodeId, nodeId) as Array<{ kind: string; source_id: string; target_id: string; src_logical: string; tgt_logical: string }>;

  const nodeSessionMap = new Map(allEntries.map((e) => [e.logicalId, e.canonicalSessionName]));
  const outgoing: NodeDetailEdge[] = [];
  const incoming: NodeDetailEdge[] = [];
  for (const row of edgeRows) {
    if (row.source_id === nodeId) {
      outgoing.push({ kind: row.kind, to: { logicalId: row.tgt_logical, sessionName: nodeSessionMap.get(row.tgt_logical) ?? null } });
    }
    if (row.target_id === nodeId) {
      incoming.push({ kind: row.kind, from: { logicalId: row.src_logical, sessionName: nodeSessionMap.get(row.src_logical) ?? null } });
    }
  }

  // Compact spec summary
  const compactSpec: NodeDetailCompactSpec = {
    name: entry.resolvedSpecName,
    version: entry.resolvedSpecVersion,
    profile: entry.profile,
    skillCount: installedResources.filter((r) => r.category === "skill" || r.category === "skills").length,
    guidanceCount: installedResources.filter((r) => r.category === "guidance" || r.category === "guidance_merge").length,
  };

  return {
    ...entry,
    // OPR.0.4.0.26: the LIST omits recoveryGuidance to stay slim; the
    // single-node detail recomputes the full guidance from the entry's
    // resume fields (relocation of the per-node prose, not loss).
    recoveryGuidance: computeRecoveryGuidance({
      runtime: entry.runtime,
      resumeToken: entry.resumeToken,
      cwd: entry.cwd,
      sessionName: entry.canonicalSessionName,
      codexConfigProfile: entry.codexConfigProfile,
    }),
    binding,
    startupFiles,
    startupActions,
    installedResources,
    recentEvents,
    infrastructureStartupCommand,
    peers,
    edges: { outgoing, incoming },
    transcript: { enabled: false, path: null, tailCommand: null }, // populated by route handler
    compactSpec,
  };
}

/**
 * Context-aware wrapper: returns inventory with context usage attached.
 * Uses one daemon-owned ContextUsageStore for all reads.
 */
export function getNodeInventoryWithContext(
  db: Database.Database,
  rigId: string,
  contextUsageStore: ContextUsageStore,
): NodeInventoryEntry[] {
  const entries = getNodeInventory(db, rigId);

  // Find node IDs for batch read
  const nodeRows = db.prepare(
    "SELECT id, logical_id FROM nodes WHERE rig_id = ?"
  ).all(rigId) as Array<{ id: string; logical_id: string }>;
  const nodeIdByLogicalId = new Map(nodeRows.map((r) => [r.logical_id, r.id]));

  const contextEntries = entries.map((e) => ({
    nodeId: nodeIdByLogicalId.get(e.logicalId) ?? "",
    currentSessionName: e.canonicalSessionName,
  }));

  const contextMap = contextUsageStore.getForNodes(contextEntries);

  return entries.map((e) => {
    const nodeId = nodeIdByLogicalId.get(e.logicalId) ?? "";
    const usage = contextMap.get(nodeId) ?? contextUsageStore.unknownUsage("no_data");
    // OPR.0.4.0.26: drop the heavy `currentUsage` blob from the LIST
    // contextUsage (a serialized per-node usage payload, ~79KB across a
    // large fleet; no node-list consumer reads it). All scalars are kept so
    // the ring/table/filter consumers are unaffected. The full currentUsage
    // remains on the detail/whoami path (getNodeDetailWithContext, whoami).
    return { ...e, contextUsage: { ...usage, currentUsage: null } };
  });
}

/**
 * Context-aware wrapper: returns node detail with context usage attached.
 */
export function getNodeDetailWithContext(
  db: Database.Database,
  rigId: string,
  logicalId: string,
  contextUsageStore: ContextUsageStore,
  opts?: Parameters<typeof getNodeDetail>[3],
): NodeDetailEntry | null {
  const detail = getNodeDetail(db, rigId, logicalId, opts);
  if (!detail) return null;

  const nodeRow = db.prepare(
    "SELECT id FROM nodes WHERE rig_id = ? AND logical_id = ?"
  ).get(rigId, logicalId) as { id: string } | undefined;

  if (nodeRow) {
    detail.contextUsage = contextUsageStore.getForNode(nodeRow.id, detail.canonicalSessionName);
  } else {
    detail.contextUsage = contextUsageStore.unknownUsage("no_data");
  }

  return detail;
}

/**
 * Slice 15 — populate `terminalActive` + `hasAssignedWork` per node.
 *
 * Two orthogonal enrichments computed independently (non-inference
 * contract per IMPL-PRD §2.3):
 *   - `terminalActive`: read from SeatActivityService (tmux signal)
 *   - `hasAssignedWork` + `pendingWorkCount`: derived from queue_items
 *     where destination_session matches the seat's canonical session name
 *
 * Pure / synchronous — keeps the projection cheap for both `rig ps` and
 * the UI which both fetch this per-request. The two enrichments do not
 * read each other's source.
 */
export function attachTerminalActivityAndWork(
  entries: NodeInventoryEntry[],
  deps: { db: Database.Database; seatActivity?: SeatActivityService },
): NodeInventoryEntry[] {
  const seatActivity = deps.seatActivity ?? null;
  const pendingByDest = readPendingWorkBySession(deps.db);
  return entries.map((entry) => {
    let terminalActive: boolean | null | undefined = undefined;
    if (seatActivity && entry.canonicalSessionName) {
      const obs = seatActivity.getSeatActivity(entry.canonicalSessionName);
      terminalActive = obs ? obs.isActiveWithinWindow : null;
    }
    const pendingCount = countPendingForEntry(entry, pendingByDest);
    return {
      ...entry,
      terminalActive,
      hasAssignedWork: pendingCount > 0,
      pendingWorkCount: pendingCount,
    };
  });
}

/**
 * QA baseline-deep-dogfood BLOCKING-A2 (qitem-20260518063900-85745917):
 * adopted/live-session rigs do NOT surface assigned queue work because
 * the prior lookup matched destination_session ONLY against
 * canonicalSessionName.
 *
 * For MANAGED seats, canonicalSessionName equals the canonical form
 * `{pod}-{member}@{rig}` (set by deriveCanonicalSessionName at
 * materialize time) and queue operators address them by that form, so
 * the single-key lookup works.
 *
 * For ADOPTED seats, canonicalSessionName is the RAW tmux session
 * name (whatever the adopter chose, e.g., `my-existing-claude`).
 * Operators address adopted seats by the canonical form (logical
 * `{pod}-{member}@{rig}`) through `rig queue create --destination`,
 * so the single-key lookup misses.
 *
 * Resolve via BOTH forms:
 *   1. entry.canonicalSessionName (covers managed + adopted-by-raw)
 *   2. derived `{pod}-{member}@{rig}` from logicalId + rigName
 *      (covers adopted-by-canonical)
 *
 * The logicalId is the pod-aware `pod.member` form (dot-separated).
 * The canonical session form replaces the dot with a dash to match the
 * convention from deriveCanonicalSessionName (so `redo.driver-2` in
 * rig `openrig-velocity` becomes `redo-driver-2@openrig-velocity`).
 *
 * Sums distinct destination_session keys to avoid double-counting
 * when both forms are identical (managed seats whose
 * canonicalSessionName already equals the derived canonical form).
 */
function countPendingForEntry(
  entry: NodeInventoryEntry,
  pendingByDest: Map<string, number>,
): number {
  const keys = new Set<string>();
  if (entry.canonicalSessionName) keys.add(entry.canonicalSessionName);
  const derived = deriveCanonicalFromEntry(entry);
  if (derived) keys.add(derived);
  let count = 0;
  for (const key of keys) {
    count += pendingByDest.get(key) ?? 0;
  }
  return count;
}

/** EXPORTED (OPR.0.4.6.FAC1): the derived canonical coordinate
 *  `{pod}-{member}@{rig}` for an inventory entry — the binding layer's
 *  ONE string rule (tiebreak key AND recorded destination) reuses
 *  exactly this dual-key derivation, never a parallel one. */
export function deriveCanonicalFromEntry(entry: NodeInventoryEntry): string | null {
  if (!entry.rigName || !entry.logicalId) return null;
  const dotIdx = entry.logicalId.indexOf(".");
  if (dotIdx <= 0 || dotIdx === entry.logicalId.length - 1) return null;
  const pod = entry.logicalId.slice(0, dotIdx);
  const member = entry.logicalId.slice(dotIdx + 1);
  return deriveCanonicalSessionName(pod, member, entry.rigName);
}

export function readPendingWorkBySession(db: Database.Database): Map<string, number> {
  const rows = db.prepare(`
    SELECT destination_session, COUNT(*) as c
    FROM queue_items
    WHERE state = 'pending'
    GROUP BY destination_session
  `).all() as Array<{ destination_session: string; c: number }>;
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.destination_session, r.c);
  return out;
}

export async function attachAgentActivity(
  entries: NodeInventoryEntry[],
  deps: {
    tmuxAdapter: TmuxAdapter;
    activityStore?: AgentActivityStore;
    now?: Date;
    // OPR.0.4.3 healthz-wedge amplification fix: cheap by default. The per-node
    // tmux `capturePaneContent` fallback (probeSessionActivity) is the storm that
    // amplifies fleet-scale under the CLI `rig ps --nodes` fan-out + the graph/nodes
    // polls. It is ONLY reached for hook-less seats (getLatestForNode returns null),
    // and it uniquely adds ONLY pane-heuristic `needs_input` for those seats — the
    // SeatActivityService snapshot (terminalActive) already serves running/idle at a
    // higher UI precedence, and getLatestForNode serves hook activity (incl.
    // hook-needs_input). So cheap-default skips the capture and emits an HONEST
    // `unknown/no_runtime_hook` placeholder (running/idle then come from the snapshot
    // at render time). Set `captureFallback: true` (via ?full=/?refresh=) to opt into
    // the per-node tmux capture — needs-input surfaces (useNeedsInputSeats, node
    // detail) request it explicitly.
    captureFallback?: boolean;
  },
): Promise<NodeInventoryEntry[]> {
  const sampledAt = deps.now ?? new Date();
  const captureFallback = deps.captureFallback ?? false;
  return Promise.all(entries.map(async (entry) => {
    const hookActivity = deps.activityStore?.getLatestForNode({
      sessionName: entry.canonicalSessionName,
      now: sampledAt,
    });
    if (hookActivity) {
      return {
        ...entry,
        agentActivity: hookActivity,
      };
    }

    if (!captureFallback) {
      // CHEAP DEFAULT — no per-node tmux capture. running/idle is supplied by the
      // SeatActivityService snapshot (terminalActive) at higher precedence; a
      // hook-less seat's pane-heuristic needs_input requires ?full/?refresh.
      return {
        ...entry,
        agentActivity: {
          state: "unknown",
          reason: "no_runtime_hook",
          evidenceSource: "session_registry",
          sampledAt: sampledAt.toISOString(),
          evidence: null,
          fallback: true,
        },
      };
    }

    return {
      ...entry,
      agentActivity: await probeSessionActivity({
      sessionName: entry.canonicalSessionName,
      runtime: entry.runtime,
      attachmentType: entry.attachmentType,
      tmuxAdapter: deps.tmuxAdapter,
      now: sampledAt,
    }),
    };
  }));
}
