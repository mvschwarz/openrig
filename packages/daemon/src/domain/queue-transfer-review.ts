import type Database from "better-sqlite3";
import { parseSessionName, isHumanSeatSessionRef } from "./session-name.js";
import type { ParsedQueueTransfer } from "./queue-transfer-parse.js";

type Finding<Code extends string> = { readonly code: Code; readonly qitemId?: string; readonly reference?: string; readonly message?: string };
export type TransferRefusal = Finding<"format_unsupported" | "digest_mismatch" | "origin_identity_missing" | "selection_not_shown" |
  "archive_invalid" | "archive_too_large" | "already_activated" | "qitem_id_collision" | "qitem_erased_at_destination" | "workspace_has_unrelated_conflict">;
export type TransferWarning = Finding<"destination_unbound" | "unresolved_rig" | "unresolved_seat" | "missing_evidence" | "dangling_reference">;

export function reviewQueueTransfer(db: Database.Database, archive: ParsedQueueTransfer, missing: ReadonlySet<string>) {
  const host = db.prepare<[], { hostId: string }>("SELECT host_id AS hostId FROM self_host_identity WHERE singleton = 1").get()?.hostId;
  const erased = db.prepare<[string]>("SELECT 1 FROM queue_erased_ids WHERE qitem_id = ?");
  const exists = db.prepare<[string]>("SELECT 1 FROM queue_items WHERE qitem_id = ?");
  const action = db.prepare<[string]>("SELECT 1 FROM mission_control_actions WHERE action_id = ?");
  const rig = db.prepare<[string]>("SELECT 1 FROM rigs WHERE name = ? AND archived_at IS NULL LIMIT 1");
  const seat = db.prepare<[string, string]>(`SELECT 1 FROM sessions s JOIN nodes n ON s.node_id = n.id
    JOIN rigs r ON n.rig_id = r.id WHERE r.archived_at IS NULL AND r.name = ? AND s.session_name = ? LIMIT 1`);
  const refusals: TransferRefusal[] = [];
  const warnings: TransferWarning[] = [{ code: "destination_unbound" }];
  const projectedRunnable: string[] = [];
  const seenActions = new Set<string>();
  const selected = new Set(archive.rows.map(row => row.qitemId));
  const counts = { open: 0, terminal: 0, erased: archive.erasedIds.length };
  const checkSeat = (address: string): TransferWarning["code"] | null => {
    if (address === "daemon@kernel" || address.startsWith("system:")) return null;
    const parts = address.split("@");
    const localAddress = parts.length === 3 && parts[2] === host ? parts.slice(0, 2).join("@") : address;
    const parsed = parseSessionName(localAddress);
    if (parsed.kind !== "canonical" || isHumanSeatSessionRef(localAddress) ||
        (parts.length > 2 && localAddress === address)) return "unresolved_seat";
    if (!rig.get(parsed.rig)) return "unresolved_rig";
    return seat.get(parsed.rig, localAddress) ? null : "unresolved_seat";
  };
  for (const reference of archive.selection.rigs) {
    if (!rig.get(reference)) warnings.push({ code: "unresolved_rig", reference });
  }
  for (const qitemId of archive.selection.qitemIds) {
    if (erased.get(qitemId)) refusals.push({ code: "qitem_erased_at_destination", qitemId });
    else if (exists.get(qitemId)) refusals.push({ code: "qitem_id_collision", qitemId }, { code: "workspace_has_unrelated_conflict", qitemId });
  }
  for (const row of archive.rows) {
    const { qitemId } = row;
    const initiallyRunnable = row.state === "pending" || row.state === "in-progress";
    if (row.erased) counts.erased++;
    else if (initiallyRunnable || row.state === "blocked") counts.open++;
    else counts.terminal++;
    if (!row.erased && initiallyRunnable && !checkSeat(row.destinationSession)) projectedRunnable.push(qitemId);
    if (missing.has(qitemId) && row.evidenceRef) warnings.push({ code: "missing_evidence", qitemId, reference: row.evidenceRef });
    const references = new Set([...row.references, row.blockedOn, row.closureTarget]);
    for (const reference of references) {
      if (!reference?.startsWith("qitem-")) continue;
      const [id, remote] = reference.split("@");
      if (!id || (remote && remote !== host) || (!selected.has(id) && !exists.get(id))) {
        warnings.push({ code: "dangling_reference", qitemId, reference });
      }
    }
    for (const id of row.missingTransitions) warnings.push({ code: "dangling_reference", qitemId, reference: `transition:${id}` });
    const routes = new Set([row.sourceSession, row.destinationSession, row.returnRoute,
      row.blockedOn?.includes("@") && !row.blockedOn.startsWith("qitem-") ? row.blockedOn : null]);
    for (const reference of routes) {
      if (!reference) continue;
      const code = checkSeat(reference);
      if (code) warnings.push({ code, qitemId, reference });
    }
    for (const id of row.actionIds) {
      if (seenActions.has(id) || action.get(id)) refusals.push({ code: "workspace_has_unrelated_conflict", qitemId, reference: id });
      seenActions.add(id);
    }
  }
  return { counts, warnings, refusals, projectedRunnable };
}
