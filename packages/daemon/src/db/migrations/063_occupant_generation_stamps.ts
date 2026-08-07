import type { Migration } from "../migrate.js";

/**
 * GHOST-STAGE (e/Class-B) — occupant-generation stamps on the durable seat-ROLE stores.
 *
 * Class-B stores (queue_items, watchdog_jobs) are keyed by seat NAME (member@rig), which continues
 * across a handover — so a name-scoped drop would neutralize the SUCCESSOR's own legitimate role
 * entries. Only an entry bound to the RETIRING generation's specific in-flight work is a ghost. These
 * columns carry the occupant-generation (atom-B `generation_uuid`) of the CONTEXT-BINDING act, so the
 * invalidator can discriminate the retiree's entries from the successor's by generation, not name.
 *
 * Stamp the binding act, not merely INSERT (orch ruling): an item MINTED by seat-A gen-X but CLAIMED
 * by seat-B gen-Y needs the CLAIMANT's generation for the ghost test — minting-gen alone re-creates
 * the false-positive.
 *   - queue_items.minting_generation_uuid    — set at INSERT (the creating occupant's gen).
 *   - queue_items.claimed_by_generation_uuid — set at CLAIM, cleared at release (the CLAIMANT's gen;
 *                                              THIS is the queue-item ghost discriminator).
 *   - watchdog_jobs.registered_by_generation_uuid — set at arm (the registering occupant's gen).
 *
 * All NULLABLE + no default: pre-063 rows and un-stamped writers stay NULL, and a NULL generation is
 * UNKNOWN → the invalidator's gen predicate never matches it (never dropped/released on unknown —
 * note-2). Additive ALTERs; defensive column-detect reads keep pre-063 fixtures degrading cleanly.
 */
export const occupantGenerationStampsSchema: Migration = {
  name: "063_occupant_generation_stamps.sql",
  sql: `
    ALTER TABLE queue_items ADD COLUMN minting_generation_uuid TEXT;
    ALTER TABLE queue_items ADD COLUMN claimed_by_generation_uuid TEXT;
    ALTER TABLE watchdog_jobs ADD COLUMN registered_by_generation_uuid TEXT;
  `,
};
