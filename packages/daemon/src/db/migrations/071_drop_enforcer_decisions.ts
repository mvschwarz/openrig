import type { Migration } from "../migrate.js";

// Unbuild of the W4 compaction-enforcement suite (founder-ruled, over-engineering audit).
//
// FORWARD-ONLY BY RULING: 068_enforcer_decisions is APPLIED on live DBs and 069/070 sit above it,
// so its migration file stays as history and is NOT deleted — removing it would leave an applied
// ledger row with no migration and two migrations above the gap. This drops the table instead, so
// schema_migrations keeps an honest record of both the create and the drop.
//
// IF EXISTS is load-bearing, not defensive noise: 068 is excluded from the shared full-test DB
// fixture (test-app.ts migrationsForFullTestDbExclusions), so on that fixture this migration runs
// against a database where enforcer_decisions was never created. The indexes are dropped with the
// table by SQLite.
export const dropEnforcerDecisionsSchema: Migration = {
  name: "071_drop_enforcer_decisions.sql",
  sql: `
    DROP TABLE IF EXISTS enforcer_decisions;
  `,
};
