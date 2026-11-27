import type { Migration } from "../migrate.js";

/** A seat's own newest queue action, read from the archive too. A seat attached from an outside program (`rig attach`) shows
 *  the newest queue transition it wrote itself as the only sign it's working (node-inventory's `lastOwnQueueAction`).
 *  Retention moves finished work's transitions to the archive, so that read looks there when the live table has none newer;
 *  the live table already has `idx_queue_transitions_actor`. Index-only: no table, trigger or backfill. */
export const queueTransitionsArchiveActorIndexSchema: Migration = {
  name: "201_queue_transitions_archive_actor_index.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_queue_transitions_archive_actor
      ON queue_transitions_archive(actor_session, transition_id DESC);
  `,
};
