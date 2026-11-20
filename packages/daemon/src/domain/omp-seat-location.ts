import type Database from "better-sqlite3";

export interface OmpSeatLocation {
  storageSession: string;
  canonicalSession: string;
  /** This storage belongs to a previous generation until the original writer is verified in its pane. */
  pendingAdoption?: {
    storageSession: string;
    nodeId: string;
    writerGeneration: string;
    pane: string;
    committedAt: string;
    confirm: () => boolean;
  };
}

interface CommittedOmpSwitch {
  id: string;
  node_id: string;
  staging_session: string;
  successor_generation: string;
  successor_pane: string | null;
  tmux_pane: string | null;
  current_generation: string;
  verified_adoption_generation: string | null;
  committed_at: string;
}

/** Keep a switched occupant's state in its original directory after its pane moves.
 * The durable switch journal, not a process-local alias, resolves it after daemon restart. */
export function ompSeatLocation(db: Database.Database, session: string): OmpSeatLocation {
  const staged = db.prepare(`SELECT canonical_session FROM seat_runtime_switches
    WHERE staging_session = ? AND to_runtime = 'omp-tui'`).get(session) as { canonical_session: string } | undefined;
  if (staged) return { storageSession: session, canonicalSession: staged.canonical_session };
  const query = db.prepare(`SELECT s.id, s.node_id, s.staging_session, s.successor_generation, s.successor_pane,
      b.tmux_pane, current.generation_uuid AS current_generation, s.verified_adoption_generation, s.committed_at
    FROM seat_runtime_switches s
    JOIN bindings b ON b.node_id = s.node_id JOIN nodes n ON n.id = s.node_id
    JOIN occupant_tenures current ON current.node_id = n.id AND current.generation_ordinal =
      (SELECT MAX(generation_ordinal) FROM occupant_tenures WHERE node_id = n.id)
    WHERE b.tmux_session = ? AND b.attachment_type = 'tmux' AND n.runtime = 'omp-tui' AND s.to_runtime = 'omp-tui' AND s.committed_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM occupant_tenures t WHERE t.node_id = n.id AND t.generation_uuid = s.successor_generation
        AND NOT EXISTS (SELECT 1 FROM occupant_tenures later WHERE later.node_id = t.node_id
          AND later.generation_ordinal > t.generation_ordinal AND later.kind <> 'adopt'))
    ORDER BY s.rowid DESC LIMIT 1`);
  const committed = query.get(session) as CommittedOmpSwitch | undefined;
  const location: OmpSeatLocation = { storageSession: session, canonicalSession: session };
  if (!committed) return location;
  if (committed.current_generation === committed.successor_generation) {
    return { ...location, storageSession: committed.staging_session };
  }
  if (!committed.tmux_pane || committed.tmux_pane !== committed.successor_pane) return location;
  if (committed.verified_adoption_generation === committed.current_generation) {
    return { ...location, storageSession: committed.staging_session };
  }
  location.pendingAdoption = {
    storageSession: committed.staging_session, nodeId: committed.node_id, writerGeneration: committed.successor_generation,
    pane: committed.tmux_pane, committedAt: committed.committed_at,
    confirm: db.transaction(() => {
      // The process check awaited tmux. Persist its result only for the same switch, binding and adopted occupant.
      const latest = query.get(session) as CommittedOmpSwitch | undefined;
      if (latest?.id !== committed.id || latest.current_generation !== committed.current_generation || latest.tmux_pane !== committed.tmux_pane) return false;
      db.prepare("UPDATE seat_runtime_switches SET verified_adoption_generation = ? WHERE id = ?").run(latest.current_generation, latest.id);
      return true;
    }).immediate,
  };
  return location;
}
