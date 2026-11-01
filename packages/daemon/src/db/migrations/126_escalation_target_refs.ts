import type { Migration } from "../migrate.js";

/** #605: a remote-rig escalation keeps its declared address even while that rig is absent. */
export const escalationTargetRefsSchema: Migration = {
  name: "126_escalation_target_refs.sql",
  sql: `
    CREATE TABLE edges_with_refs (
      id TEXT PRIMARY KEY,
      rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
      target_ref TEXT,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK ((target_id IS NOT NULL AND target_ref IS NULL) OR
             (target_id IS NULL AND target_ref IS NOT NULL AND kind = 'escalates_to'))
    );
    INSERT INTO edges_with_refs (id, rig_id, source_id, target_id, kind, created_at)
      SELECT id, rig_id, source_id, target_id, kind, created_at FROM edges;
    DROP TABLE edges;
    ALTER TABLE edges_with_refs RENAME TO edges;
    CREATE TRIGGER edge_same_rig_insert BEFORE INSERT ON edges BEGIN
      SELECT RAISE(ABORT, 'edge source and target must belong to the same rig')
        WHERE NEW.target_id IS NOT NULL AND
          (SELECT rig_id FROM nodes WHERE id = NEW.source_id) !=
          (SELECT rig_id FROM nodes WHERE id = NEW.target_id);
      SELECT RAISE(ABORT, 'edge rig_id must match source node rig_id')
        WHERE NEW.rig_id != (SELECT rig_id FROM nodes WHERE id = NEW.source_id);
    END;
  `,
};
