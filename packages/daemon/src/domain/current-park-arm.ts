/** Missing new history evidence keeps the prior wake selection. If that
 * selection also fails, its original failure still reaches the caller. */
export function readWithCurrentParkBoundary<T>(read: (boundary: string) => T): T {
  try {
    return read(`AND NOT EXISTS (
      SELECT 1 FROM queue_transitions t
       WHERE t.qitem_id = w.qitem_id AND t.transition_id > w.transition_id AND t.state <> 'blocked'
    )`);
  } catch {
    return read("");
  }
}
import type Database from "better-sqlite3";

export function localQueueWakeSource(db: Database.Database): string {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'queue_transfer_transition_origins'").get()
    ? "(SELECT * FROM queue_transition_wakes WHERE transition_id NOT IN (SELECT transition_id FROM queue_transfer_transition_origins))"
    : "queue_transition_wakes";
}
