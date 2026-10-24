import type Database from "better-sqlite3";
import { resolveGuardTarget } from "./seat-delivery-guard.js";

/** Exact-text selection needs the same unique current target as input delivery,
 * plus a binding to the actual tmux address. Historical rows and unbound
 * canonical names alone do not establish what is receiving this input. */
export function isBoundTerminalSeat(db: Database.Database, sessionName: string): boolean {
  try {
    const target = resolveGuardTarget(db, sessionName);
    if (!target) return false;
    const current = db.prepare(
      `SELECT n.runtime AS runtime FROM nodes n JOIN bindings b ON b.node_id = n.id
        WHERE n.id = ? AND (b.tmux_session = ? OR b.tmux_pane = ?)`,
    ).get(target.nodeId, sessionName, sessionName) as { runtime: string | null } | undefined;
    return current?.runtime === "terminal";
  } catch {
    return false;
  }
}

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
