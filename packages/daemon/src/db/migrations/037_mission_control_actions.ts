import type { Migration } from "../migrate.js";

/**
 * Mission Control actions (PL-005 Phase A; daemon-backed action audit).
 *
 * Per PRD § Q5 + slice IMPL § Write Set: SQLite-canonical append-only
 * audit log of every operator action through Mission Control. Records
 * every invocation of the 7 Phase A verbs with before/after snapshots
 * for forensic reconstruction.
 *
 * Append-only contract: writers only INSERT. UPDATE/DELETE are not
 * exposed by MissionControlActionLog API; direct SQL UPDATE/DELETE
 * would succeed at the DB level (SQLite has no view/role layer) but
 * is a contract violation enforced at the domain-layer API boundary.
 *
 * Action verb enum (Phase A v1; 7 values):
 *   - approve     — operator approved a human-gated item
 *   - deny        — operator denied a human-gated item
 *   - route       — operator routed an item to a different destination
 *   - annotate    — operator added an annotation (annotation field required)
 *   - hold        — operator held an item with a reason (reason required)
 *   - drop        — operator dropped an item with a reason (reason required)
 *   - handoff     — atomic 4-step (source-update + destination-create
 *                   + opt-in best-effort notify + audit append)
 *
 * Columns:
 *   - action_id (ULID PK)
 *   - action_verb (TEXT, app-layer enum enforcement)
 *   - qitem_id (TEXT, FK to queue_items when applicable; nullable for
 *     observations / non-queue actions in future scope)
 *   - actor_session (TEXT NOT NULL) — operator session that fired the verb
 *   - acted_at (TEXT NOT NULL) — ISO timestamp
 *   - before_state_json (TEXT) — snapshot of qitem state pre-action
 *   - after_state_json (TEXT) — snapshot of qitem state post-action
 *   - reason (TEXT) — required for hold + drop
 *   - annotation (TEXT) — required for annotate
 *   - notify_attempted (INTEGER 0|1) — for handoff
 *   - notify_result (TEXT) — verified | sent-unverified | failed:<reason>
 *   - audit_notes_json (TEXT) — operator-supplied evidence map
 *
 * Indexes:
 *   - (acted_at DESC, action_verb) — recent-actions and per-verb scans
 *   - (qitem_id, acted_at DESC) — per-qitem audit trail
 *   - (actor_session, acted_at DESC) — per-operator audit
 *
 * Archive policy hooks: not implemented as automatic v1; the table is
 * append-only and grows unbounded. Future archive can move rows older
 * than N days into a sibling archive table OR export to filesystem.
 * JSONL mirror is deferred unless a concrete durability need surfaces.
 */
export const missionControlActionsSchema: Migration = {
  name: "037_mission_control_actions.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS mission_control_actions (
      action_id TEXT PRIMARY KEY,
      action_verb TEXT NOT NULL,
      qitem_id TEXT REFERENCES queue_items(qitem_id),
      actor_session TEXT NOT NULL,
      acted_at TEXT NOT NULL,
      before_state_json TEXT,
      after_state_json TEXT,
      reason TEXT,
      annotation TEXT,
      notify_attempted INTEGER NOT NULL DEFAULT 0,
      notify_result TEXT,
      audit_notes_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mc_actions_recent
      ON mission_control_actions(acted_at DESC, action_verb);
    CREATE INDEX IF NOT EXISTS idx_mc_actions_qitem
      ON mission_control_actions(qitem_id, acted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mc_actions_actor
      ON mission_control_actions(actor_session, acted_at DESC);
  `,
};
