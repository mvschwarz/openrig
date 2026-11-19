import type Database from "better-sqlite3";

/** Keep a switched occupant's state in its original directory after its pane moves.
 * The durable switch journal, not a process-local alias, resolves it after daemon restart. */
export function ompSeatLocation(db: Database.Database, session: string): { storageSession: string; canonicalSession: string } {
  const staged = db.prepare(`SELECT canonical_session FROM seat_runtime_switches
    WHERE staging_session = ? AND to_runtime = 'omp-tui'`).get(session) as { canonical_session: string } | undefined;
  if (staged) return { storageSession: session, canonicalSession: staged.canonical_session };
  const committed = db.prepare(`SELECT s.staging_session FROM seat_runtime_switches s
    JOIN bindings b ON b.node_id = s.node_id JOIN nodes n ON n.id = s.node_id
    WHERE b.tmux_session = ? AND n.runtime = 'omp-tui' AND s.to_runtime = 'omp-tui' AND s.committed_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM occupant_tenures t WHERE t.node_id = n.id AND t.generation_uuid = s.successor_generation
        AND NOT EXISTS (SELECT 1 FROM occupant_tenures later WHERE later.node_id = t.node_id
          AND later.generation_ordinal > t.generation_ordinal AND later.kind <> 'adopt'))
    ORDER BY s.rowid DESC LIMIT 1`).get(session) as { staging_session: string } | undefined;
  return { storageSession: committed?.staging_session ?? session, canonicalSession: session };
}
