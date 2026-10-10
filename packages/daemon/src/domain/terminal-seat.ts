import type Database from "better-sqlite3";

/** A `runtime: terminal` node, by its newest session row or else its composed canonical name
 *  (`<logical id with dashes>@<rig>`). A database that can't answer reads as not terminal. */
export function isTerminalSeat(db: Database.Database, sessionName: string): boolean {
  try {
    const exact = db.prepare(
      `SELECT n.runtime AS runtime FROM sessions s JOIN nodes n ON n.id = s.node_id
        WHERE s.session_name = ? ORDER BY s.id DESC LIMIT 1`,
    ).get(sessionName) as { runtime: string | null } | undefined;
    if (exact) return exact.runtime === "terminal";
    const at = sessionName.lastIndexOf("@");
    if (at <= 0) return false;
    const composed = db.prepare(
      `SELECT n.runtime AS runtime FROM nodes n JOIN rigs r ON r.id = n.rig_id
        WHERE r.name = ? AND REPLACE(n.logical_id, '.', '-') = ? LIMIT 1`,
    ).get(sessionName.slice(at + 1), sessionName.slice(0, at)) as { runtime: string | null } | undefined;
    return composed?.runtime === "terminal";
  } catch {
    return false;
  }
}
