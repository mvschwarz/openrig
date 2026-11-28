import type Database from "better-sqlite3";
import { QUEUE_TRANSFER_COLUMNS as columns } from "./queue-transfer-export.js";
import type { QueueTransferObject } from "./queue-transfer-format.js";
import type { ParsedQueueTransfer } from "./queue-transfer-parse.js";

export const transferWireKey = (column: string) => column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

export function transferInsert(db: Database.Database, table: string, fields: readonly string[]) {
  const statement = db.prepare(`INSERT INTO ${table} (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`);
  return (row: QueueTransferObject) => statement.run(...fields.map(column => row[transferWireKey(column)] ?? null));
}

export function historyWriter(db: Database.Database, recordId: string, origin: ParsedQueueTransfer["origin"]) {
  const live = transferInsert(db, "queue_transitions", columns.queue_transitions.slice(1));
  const archived = transferInsert(db, "queue_transitions_archive", [...columns.queue_transitions, "archived_at"]);
  const wake = transferInsert(db, "queue_transition_wakes", columns.queue_transition_wakes);
  const action = transferInsert(db, "mission_control_actions", [...columns.mission_control_actions, "imported_from"]);
  const deleteLive = db.prepare("DELETE FROM queue_transitions WHERE transition_id = ?");
  const mark = db.prepare("INSERT INTO queue_transfer_transition_origins VALUES (?, ?, ?, ?, ?)");
  const stats = { transitionsImported: 0, wakeEvidenceImportedNotScheduled: 0, missionControlActionsImported: 0 };
  return { stats, write(row: ParsedQueueTransfer["rows"][number]) {
    const ids = new Map<number, number>();
    for (const transition of row.transitions) {
      if (typeof transition.transitionId !== "number") continue;
      const local = Number(live(transition).lastInsertRowid);
      if (transition.archivedAt != null) {
        archived({ ...transition, transitionId: local });
        deleteLive.run(local);
      }
      mark.run(local, recordId, transition.transitionId, origin.hostId, origin.mintedAt);
      ids.set(transition.transitionId, local);
      stats.transitionsImported++;
    }
    for (const evidence of row.wakes) {
      const local = typeof evidence.transitionId === "number" ? ids.get(evidence.transitionId) : undefined;
      if (local === undefined) continue;
      wake({ ...evidence, transitionId: local });
      stats.wakeEvidenceImportedNotScheduled++;
    }
    for (const entry of row.actions) {
      action({ ...entry, importedFrom: `${origin.hostId}/${origin.mintedAt}` });
      stats.missionControlActionsImported++;
    }
  } };
}
