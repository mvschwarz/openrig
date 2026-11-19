import type { Migration } from "../migrate.js";

/**
 * #3395 (Piece 1): the seat pool's one migration. `nodes.pool` holds a model member's `pool:` block as JSON (NULL = no
 * pool). `seat_pool_slots` holds the pool's agents, keyed by the model node rather than by the job, so a replaced job
 * finds the same agents. A slot is never removed by the pool: its four phases are adding, live, draining and drained.
 * Deleting the agent's node, or the model's node, by hand takes the slot row with it. A slot number is a positive
 * safe integer, and an agent's node is never its model's node.
 */
export const seatPoolSchema: Migration = {
  name: "178_seat_pool.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN pool TEXT;

    CREATE TABLE seat_pool_slots (
      slot_id TEXT PRIMARY KEY,
      model_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      slot_number INTEGER NOT NULL CHECK (typeof(slot_number) = 'integer' AND slot_number BETWEEN 1 AND 9007199254740991),
      node_id TEXT UNIQUE REFERENCES nodes(id) ON DELETE CASCADE,
      phase TEXT NOT NULL CHECK (phase IN ('adding', 'live', 'draining', 'drained')),
      phase_changed_at TEXT NOT NULL,
      attempt_id TEXT,
      attempt_kind TEXT CHECK (attempt_kind IN ('add', 'comeback')),
      attempt_state TEXT CHECK (attempt_state IN ('reserved', 'issued', 'settled')),
      attempt_basis TEXT,
      attempt_outcome TEXT,
      attempt_result TEXT,
      reuse_hold TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (model_node_id, slot_number),
      CHECK (node_id IS NULL OR node_id <> model_node_id)
    );
  `,
};
