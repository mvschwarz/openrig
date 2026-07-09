import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.6.WF1 FR-5 — workflow_instances.version column.
 *
 * The optimistic-concurrency guard for instance advancement: every
 * project() carries the version it read into the transaction, and
 * updateFrontier's UPDATE is qualified `WHERE version = ?` with a
 * `version = version + 1` bump. Zero rows changed = a concurrent
 * writer advanced the instance first → structured
 * `instance_version_conflict` (the whole scribe transaction rolls
 * back). SQLite's single-writer serialization orders the writes;
 * the version guard is what stops the SECOND writer from operating on
 * the stale instance state it read before the first committed.
 *
 * Additive, NOT NULL with DEFAULT 0 so existing in-flight instances
 * adopt version 0 and their next projection bumps normally — no
 * backfill required.
 */
export const workflowInstanceVersionSchema: Migration = {
  name: "049_workflow_instance_version.sql",
  sql: `
    ALTER TABLE workflow_instances ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
  `,
};
