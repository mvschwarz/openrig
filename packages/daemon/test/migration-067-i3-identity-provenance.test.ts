import { describe, it, expect } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

// P21 I3 — migration 067 extends the era-stamp audit boundary (mig-065 pattern) to the QUEUE-SPINE
// identity-carrying stores. Same contract as 065's mission_control_actions column: a NULLABLE
// identity_provenance the I3 chokepoint writes `transport:v1` into; absence = claimed-era (no backfill).
describe("migration 067 — I3 era-stamp: identity_provenance on the queue-spine stores", () => {
  it("adds a NULLABLE identity_provenance column to queue_transitions, inbox_entries, outbox_entries, stream_items", () => {
    // Seed with the SHIPPED migration set (not the curated createFullTestDb subset, which omits the
    // inbox/outbox base tables) — migration-fixture parity: prove the real ALL_MIGRATIONS path.
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    for (const table of ["queue_transitions", "inbox_entries", "outbox_entries", "stream_items"]) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
      const col = cols.find((c) => c.name === "identity_provenance");
      expect(col, `${table} must carry the identity_provenance era-stamp`).toBeTruthy();
      // NULLABLE is load-bearing: absence IS the claimed-era marker (never backfilled/re-labeled).
      expect(col!.notnull, `${table}.identity_provenance must be NULLABLE`).toBe(0);
    }
  });
});
