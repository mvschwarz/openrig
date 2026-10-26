import { resolveActiveSnapshotSession } from "./active-occupant.js";
import { currentRestoreSnapshot } from "./current-restore-snapshot.js";
import { capturedPreviewSessionRows, classifyCapturedHistory, type ResumeTokenState } from "./restore-plan-preview.js";
import type { PreviewSessionRow } from "./restore-plan-preview.js";
import { restoreRuntimeCompatibilityError } from "./restore-runtime-compatibility.js";
import type { RestoreSeatFacts } from "./restore-policy.js";
import type { RigRepository } from "./rig-repository.js";
import type { SnapshotRepository } from "./snapshot-repository.js";
import type { RestoreOrchestrator } from "./restore-orchestrator.js";

export const HISTORY_REF_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface SelectableHistory {
  snapshotId: string;
  historySessionId: string;
  resumeType: "codex_id" | "claude_id" | "claude_name";
  tokenState: ResumeTokenState;
}

export type SharedHistoryResult =
  | { ok: true; rigId: string; nodeId: string; logicalId: string; snapshotId: string; histories: SelectableHistory[] }
  | { ok: false; code: "seat_unavailable" | "source_unavailable" | "history_unavailable"; message: string };

const seatUnavailable = (): SharedHistoryResult => ({ ok: false, code: "seat_unavailable", message: "The selected seat is unavailable." });
const sourceUnavailable = (): SharedHistoryResult => ({ ok: false, code: "source_unavailable", message: "There is no compatible current history source for this seat." });
const historyUnavailable = (): SharedHistoryResult => ({ ok: false, code: "history_unavailable", message: "This history is no longer available for a resume attempt. Refresh the list." });

/** Stored snapshot JSON can be structurally restore-usable while an older
 * session's optional metadata has the wrong JSON type. Such a row is not a
 * selectable native resume identity; keep sibling choices available. */
function candidateMetadataWellFormed(row: PreviewSessionRow): boolean {
  return [row.status, row.restorePolicy, row.resumeType, row.resumeToken, row.communityHarness,
    row.resumeProvenance, row.resumeLastVerified, row.resumeLastProbeStatus]
    .every((value) => value === null || typeof value === "string");
}

/** A read-only projection of selectable captured histories. References are
 * locators, not capabilities or proof that the native conversation exists. */
export function listSharedHistories(
  deps: { rigRepo: RigRepository; snapshotRepo: SnapshotRepository; restoreOrchestrator: RestoreOrchestrator },
  rigId: string,
  nodeId: string,
  selection?: { snapshotId: string; historySessionId: string },
): SharedHistoryResult {
  const rig = deps.rigRepo.getRig(rigId);
  const node = rig?.nodes.find((entry) => entry.id === nodeId);
  if (!rig || !node) return seatUnavailable();
  const archived = deps.rigRepo.db.prepare("SELECT archived_at FROM rigs WHERE id=?").get(rigId) as { archived_at: string | null } | undefined;
  if (archived?.archived_at) return seatUnavailable();
  const snapshot = currentRestoreSnapshot(deps.rigRepo.db, deps.snapshotRepo, rig, node.id);
  if (!snapshot || !HISTORY_REF_RE.test(snapshot.id) || snapshot.data.rig.id !== rigId) return sourceUnavailable();
  // A same-name replacement, omitted roster member, or runtime switch is not
  // the same saved seat. Never borrow a captured row from another node.
  const savedNode = snapshot.data.nodes.find((entry) => entry.id === node.id && entry.logicalId === node.logicalId);
  if (!savedNode || (snapshot.data.topologyRoster && !snapshot.data.topologyRoster.intendedNodeIds.includes(node.id))
    || savedNode.runtime !== node.runtime
    || restoreRuntimeCompatibilityError(node.runtime, snapshot.data.nodeStartupContext?.[node.id]?.runtime)) return sourceUnavailable();
  const active = resolveActiveSnapshotSession(snapshot.data, node.id);
  if (active.kind === "ambiguous") return sourceUnavailable();
  if (selection && selection.snapshotId !== snapshot.id) return historyUnavailable();

  const allRows = capturedPreviewSessionRows(snapshot);
  const ids = new Set<string>();
  for (const row of allRows) {
    if (typeof row.id !== "string" || !HISTORY_REF_RE.test(row.id) || ids.has(row.id)) return sourceUnavailable();
    ids.add(row.id);
  }
  const rows = allRows.filter((row) => row.nodeId === node.id);
  const seat: RestoreSeatFacts = { savedRuntime: savedNode.runtime, currentRuntime: node.runtime, recordedSessions: rows };
  const histories: SelectableHistory[] = [];
  for (const row of rows) {
    if (selection && row.id !== selection.historySessionId) continue;
    if (!candidateMetadataWellFormed(row)) continue;
    // Codex's implicit last-session mode is never a named history choice.
    if (row.resumeType !== "codex_id" && row.resumeType !== "claude_id" && row.resumeType !== "claude_name") continue;
    const adapterCanResume = deps.restoreOrchestrator.canAttemptRecordedResume(node.runtime, row.resumeType, row.resumeToken);
    const verdict = classifyCapturedHistory(row, seat, {
      attached: node.binding?.attachmentType === "external_cli",
      adapterCanResume,
    });
    if (!verdict.eligible) continue;
    histories.push({ snapshotId: snapshot.id, historySessionId: row.id,
      resumeType: row.resumeType, tokenState: verdict.tokenState });
  }
  if (selection && histories.length !== 1) return historyUnavailable();
  return { ok: true, rigId, nodeId: node.id, logicalId: node.logicalId, snapshotId: snapshot.id, histories };
}
