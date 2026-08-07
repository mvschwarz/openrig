import type { Migration } from "../migrate.js";

/**
 * P21 — the CLAIMED-era vs DERIVED-era audit boundary (plan §4). Adds a NULLABLE `identity_provenance`
 * column to the identity-carrying audit stores so a consumer can tell an actor that was verified by the
 * transport chokepoint from a pre-P21 claimed-era row. The chokepoint writes `transport:v1`; **absence
 * IS the claimed-era marker** — no backfill, no re-labeling (the house absent-never-fabricated doctrine).
 * The boundary is per-ROW truth, not a timestamp: surfaces flip at different folds and each row stays
 * individually honest. Consumers render a NULL row as "recorded (pre-verification era)", never "verified".
 *
 * This migration lands the column on `mission_control_actions` (I1 scope-approve + I2 mission-control
 * both write it). Later increments extend the same era-stamp to their stores (queue_transitions,
 * inbox/outbox, stream_items, chat_messages) — nullable + additive, same contract.
 */
export const identityProvenanceSchema: Migration = {
  name: "065_identity_provenance.sql",
  sql: `
    ALTER TABLE mission_control_actions ADD COLUMN identity_provenance TEXT;
  `,
};
