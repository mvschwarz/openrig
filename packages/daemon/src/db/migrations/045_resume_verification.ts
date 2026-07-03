import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.3.20 FR-6 — resume-token verification freshness columns.
 *
 * Adds two additive, NULLABLE columns to `sessions` so the restore plan can
 * surface per-seat token FRESHNESS (present / missing / stale / unverified):
 *
 * - `resume_last_verified` (TEXT, nullable) — the last time the token was
 *   confirmed current (stamped whenever it is written/re-derived from live
 *   state, or a live resume probe returns `resumable`). NULL = never verified.
 * - `resume_last_probe_status` (TEXT, nullable) — the last resume-probe outcome:
 *   `resumable | not_resumable | inconclusive`. NULL = never probed.
 *
 * Together these make a PRESENT-but-stale token representable (a present token
 * whose probe returned `not_resumable`, or whose last-verified age is past the
 * freshness threshold) — the survival-critical case FR-6 surfaces as
 * `stale/unverified — re-verify` instead of a silent restore failure. A lone
 * last-verified column could not distinguish "never probed" from "probe failed".
 *
 * NULLABLE + degrading by contract: all pre-45 rows (and every old snapshot's
 * serialized sessions) read NULL and render as `unverified` — never a crash,
 * never a false `present`. Do NOT make these NOT NULL or backfill a default.
 *
 * Base table: 002_bindings_sessions.ts (sessions); resume columns from
 * 006_resume_metadata.ts + 043_resume_provenance.ts. Next free number after
 * 044_queue_item_summary.ts.
 */
export const resumeVerificationSchema: Migration = {
  name: "045_resume_verification.sql",
  sql: `
    ALTER TABLE sessions ADD COLUMN resume_last_verified TEXT;
    ALTER TABLE sessions ADD COLUMN resume_last_probe_status TEXT;
  `,
};
