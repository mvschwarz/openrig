import type { Migration } from "../migrate.js";

/**
 * The origin a remote caller reported about itself, beside the transport identity and any loopback-established principal
 * that the same row already records. A request whose X-OpenRig-Session arrives in the session-with-origin form
 * (`seat@rig@originHost`) from a non-loopback peer is the one case where a writer has anything to say: the third segment
 * is CLAIMED — it is not verified, not used to derive the actor, and never changes a permission decision. Additive and
 * nullable: absent on every earlier row (no backfill) and wherever no valid claim arrived (missing, malformed, or a
 * direct local request), so absence reads as unknown. Same five identity-carrying stores as migrations 067/140; the
 * transitions archive gets it too, so retention keeps a row's claim with the row.
 */
export const claimedOriginSchema: Migration = {
  name: "162_claimed_origin.sql",
  sql: `
    ALTER TABLE queue_transitions ADD COLUMN claimed_origin TEXT;
    ALTER TABLE queue_transitions_archive ADD COLUMN claimed_origin TEXT;
    ALTER TABLE inbox_entries ADD COLUMN claimed_origin TEXT;
    ALTER TABLE outbox_entries ADD COLUMN claimed_origin TEXT;
    ALTER TABLE stream_items ADD COLUMN claimed_origin TEXT;
  `,
};
