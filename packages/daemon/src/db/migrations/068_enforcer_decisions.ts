import type { Migration } from "../migrate.js";

/** W4 — durable, attributable human hold/authorize decisions for enforcers. */
export const enforcerDecisionsSchema: Migration = {
  name: "068_enforcer_decisions.sql",
  sql: `
    CREATE TABLE enforcer_decisions (
      decision_id TEXT PRIMARY KEY,
      enforcer_kind TEXT NOT NULL,
      session_name TEXT NOT NULL,
      generation_uuid TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('hold', 'authorize')),
      automatic_reason TEXT,
      reason TEXT NOT NULL,
      actor_session TEXT NOT NULL,
      identity_provenance TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      release_kind TEXT,
      released_at TEXT,
      released_by_session TEXT,
      release_identity_provenance TEXT,
      release_reason TEXT,
      consumed_at TEXT,
      consumed_by_enforcer_kind TEXT,
      lifted_reason TEXT,
      attempt_outcome TEXT,
      attempt_failure_reason TEXT,
      last_observed_at TEXT,
      last_observed_outcome TEXT
    );

    CREATE UNIQUE INDEX idx_enforcer_decisions_one_active
      ON enforcer_decisions(enforcer_kind, session_name, generation_uuid)
      WHERE active = 1;

    CREATE INDEX idx_enforcer_decisions_lookup
      ON enforcer_decisions(enforcer_kind, session_name, direction, active, generation_uuid);
  `,
};
