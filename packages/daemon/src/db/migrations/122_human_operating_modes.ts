import type { Migration } from "../migrate.js";

// Operating modes for a person: modes named after their working life (asleep, away from desk, ...), each a bundle of
// three settings, and the record of applying one.
// - human_saved_modes: one row per person and mode name, as the person agreed it. Availability is the value the human
//   registry's `availability` would be set to (NULL leaves it alone) plus an expected-back time in the person's words.
//   Decision room is the person's own words plus the exclusions read back; NULL words mean no decision room, and none is
//   ever inferred from the name. Delivery refers to a quiet rule in the quiet-hours store's own shape (NULL: no quiet),
//   plus where the "back" account goes. "At desk" is no application at all, so it needs no row.
// - human_mode_applications: one per application; at most one active (ended_at NULL) per person. `settings` is the
//   mode as it was applied, so later edits to the saved mode don't rewrite history.
// - human_mode_effects: what an application changed, per consumer: the prior value, the identity of the change it
//   wrote (what ending checks is still its own), and the effect's real state. `handed-off`: a later mode took over
//   restoring this one's prior value (its own restore was still owed when that mode was applied).
// The legacy operator-context mode bindings (operator_context_mode_bindings) are separate and untouched.
export const humanOperatingModesSchema: Migration = {
  name: "122_human_operating_modes.sql",
  sql: `
    CREATE TABLE human_saved_modes (
      entity_id            TEXT NOT NULL,
      name                 TEXT NOT NULL,
      availability         TEXT CHECK (availability IS NULL OR availability IN ('available', 'focus', 'away', 'off')),
      expected_back        TEXT,
      decision_room_words  TEXT,
      decision_room_exclusions TEXT NOT NULL DEFAULT '[]',
      quiet_rule           TEXT,
      account_destination  TEXT,
      set_by               TEXT NOT NULL,
      set_at               TEXT NOT NULL,
      PRIMARY KEY (entity_id, name)
    );
    CREATE TABLE human_mode_applications (
      application_id TEXT PRIMARY KEY,
      entity_id      TEXT NOT NULL,
      mode_name      TEXT NOT NULL,
      settings       TEXT NOT NULL,
      started_by     TEXT NOT NULL,
      started_at     TEXT NOT NULL,
      scheduled_end  TEXT,
      ended_at       TEXT,
      ended_by       TEXT,
      end_reason     TEXT CHECK (end_reason IS NULL OR end_reason IN ('back', 'scheduled', 'switched'))
    );
    CREATE UNIQUE INDEX human_mode_applications_one_active ON human_mode_applications (entity_id) WHERE ended_at IS NULL;
    CREATE TABLE human_mode_effects (
      application_id  TEXT NOT NULL REFERENCES human_mode_applications (application_id),
      consumer        TEXT NOT NULL CHECK (consumer IN ('availability', 'quiet', 'decision-room')),
      prior           TEXT,
      change_identity TEXT,
      state           TEXT NOT NULL CHECK (state IN ('active', 'pending', 'failed', 'ended', 'kept', 'handed-off')),
      detail          TEXT,
      updated_at      TEXT NOT NULL,
      PRIMARY KEY (application_id, consumer)
    );
  `,
};
