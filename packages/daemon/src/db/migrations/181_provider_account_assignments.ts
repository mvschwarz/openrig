import type { Migration } from "../migrate.js";

/**
 * #3625 (slice 3): a rig's account assignment, per provider, stored on the daemon that runs the rig when an apply starts
 * (the label, its reference in words, who asked and when), and each seat's latest applied result: one of the six kinds,
 * with its detail, any recovery command, the seat's activity when it was switched, and the reference it was given. A
 * reference only, never credential bytes. Both go with their rig, and a result with its seat.
 *
 * With the applied reference, a result keeps the label it came from and that account's reference as the apply used it
 * (applied_label, applied_account). A later result that moved nothing (unchanged, refused, failed) replaces the seat's
 * latest label and kind, but not these, so a seat that still follows an earlier apply is known to be on that apply's
 * account, and a label later pointed at another reference isn't mistaken for it.
 */
export const providerAccountAssignmentsSchema: Migration = {
  name: "181_provider_account_assignments.sql",
  sql: `
    CREATE TABLE provider_account_assignments (
      rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
      label TEXT NOT NULL,
      reference TEXT NOT NULL,
      requested_by TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (rig_id, provider)
    );
    CREATE TABLE provider_assignment_results (
      rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      seat TEXT NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('unchanged', 'switched', 'pending_successor', 'unsupported', 'failed_before_effect', 'unknown')),
      detail TEXT NOT NULL,
      recovery TEXT,
      activity TEXT NOT NULL,
      ref_file TEXT,
      ref_kind TEXT,
      codex_home TEXT,
      codex_login TEXT,
      applied_label TEXT,
      applied_account TEXT,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (rig_id, provider, node_id)
    );
  `,
};
