// #2794: `rig queue show` finds a handed-off row's successor by its handed_off_from. Migration 159 indexes that column
// (partially: only successor rows carry it), so the lookup is a seek, not a scan of the whole queue.
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

describe("queue_items.handed_off_from index (migration 159)", () => {
  it("a successor lookup by handed_off_from uses the index", () => {
    const db = new Database(":memory:");
    try {
      migrate(db, ALL_MIGRATIONS);
      const plan = db.prepare("EXPLAIN QUERY PLAN SELECT qitem_id FROM queue_items WHERE handed_off_from = ?").all("qitem-x") as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join(" ")).toContain("idx_queue_items_handed_off_from");
    } finally { db.close(); }
  });
});
