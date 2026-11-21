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
