import path from "node:path";
import type Database from "better-sqlite3";

/** A staged Pi occupant must not change the current occupant's credentials or sidecar. */
export function piAccountSwitchStateRoot(root: string, generation: string): string {
  return path.join(root, "account-switches", generation);
}

/** The committed switch ledger keeps the chosen state directory stable across daemon restarts. */
export function piAccountStateRoot(db: Database.Database, root: string, session: string): string {
  const row = db.prepare(`SELECT s.successor_generation FROM seat_runtime_switches s
    JOIN bindings b ON b.node_id = s.node_id JOIN nodes n ON n.id = s.node_id
    WHERE b.tmux_session = ? AND n.runtime = 'pi' AND s.to_runtime = 'pi' AND s.committed_at IS NOT NULL
    ORDER BY s.rowid DESC LIMIT 1`).get(session) as { successor_generation: string } | undefined;
  return row ? piAccountSwitchStateRoot(root, row.successor_generation) : root;
}
