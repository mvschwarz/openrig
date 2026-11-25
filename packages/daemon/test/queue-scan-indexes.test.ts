// The delegated-decision account read every queue row to find the few with a delegated decision. Migration 183's
// partial index lists only those rows, so the read covers them alone. These cells pin the plan and the answers. The
// health ceremony's lineage read, the other index in 183, is pinned in health-passive-ceremony.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { deriveCanonicalSessionName } from "../src/domain/session-name.js";

const planner = deriveCanonicalSessionName("dev", "planner", "rig");
const worker = deriveCanonicalSessionName("dev", "worker", "rig");

describe("the delegated-decision account reads only rows with a delegated decision", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db));
  });
  afterEach(() => db.close());

  /** The statement delegatedDecisionsFor prepares, as it runs. */
  function preparedSql(): string {
    const sql: string[] = [];
    const original = db.prepare;
    (db as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => { sql.push(s); return original.call(db, s); };
    try { repo.delegatedDecisionsFor("application-a"); } finally { (db as unknown as { prepare: typeof original }).prepare = original; }
    const statement = sql.find((s) => s.includes("delegated_decision IS NOT NULL"));
    expect(statement).toBeDefined();
    return statement!;
  }

  it("plans through the partial index, with no scan of every queue row", () => {
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${preparedSql()}`).all("application-a") as Array<{ detail: string }>).map((row) => row.detail);
    expect(plan.join(" | ")).toContain("idx_queue_items_delegated_decision");
    expect(plan).not.toContain("SCAN queue_items");
  });

  it("returns the application's decisions in decision order, as before", async () => {
    const decide = async (applicationId: string, decidedAt: string) => {
      const row = await repo.create({ sourceSession: planner, destinationSession: worker, body: "ask", nudge: false });
      db.prepare("UPDATE queue_items SET delegated_decision = ? WHERE qitem_id = ?").run(JSON.stringify({ applicationId, decidedAt }), row.qitemId);
      return row.qitemId;
    };
    const later = await decide("application-a", "2026-11-22T02:00:00.000Z");
    await decide("application-b", "2026-11-22T01:00:00.000Z");
    const earlier = await decide("application-a", "2026-11-22T01:30:00.000Z");
    await repo.create({ sourceSession: planner, destinationSession: worker, body: "no decision", nudge: false });
    expect(repo.delegatedDecisionsFor("application-a").map((item) => item.qitemId)).toEqual([earlier, later]);
    expect(repo.delegatedDecisionsFor("application-c")).toEqual([]);
  });
});
