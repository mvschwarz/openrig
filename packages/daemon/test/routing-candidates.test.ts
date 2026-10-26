import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { routingCandidates } from "../src/domain/classification-sources.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

describe("routing candidates (slice 22): durable seats and their open work", () => {
  let db: Database.Database;
  const seat = (rig: string, id: string, session: string, role: string | null) => {
    db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, role) VALUES (?, ?, ?, ?)`).run(`node-${id}`, rig, id, role);
    db.prepare(`INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)`).run(`b-${id}`, `node-${id}`, session);
  };
  const row = (id: string, destination: string, state: string, updated: string, summary: string | null = null) =>
    db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body, summary)
      VALUES (?, ?, ?, 'poster@rig', ?, ?, ?, ?)`).run(id, updated, updated, destination, state, `body of ${id}`, summary);

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('rig-a', 'a'), ('rig-b', 'b')`).run();
    // No session rows at all: none of these seats is running.
    seat("rig-a", "dev.lead", "dev-lead@a", "Owns the build pod's work");
    seat("rig-a", "qa.one", "qa-one@a", null);
    seat("rig-b", "other.seat", "other-seat@b", "another rig");
  });
  afterEach(() => db.close());

  it("lists the rig's seats whether or not they're running, and only the open work they hold, newest first", () => {
    row("q-old", "dev-lead@a", "pending", "2026-10-23T10:00:00Z", "Older work");
    row("q-new", "qa-one@a", "in-progress", "2026-10-23T11:00:00Z");
    row("q-done", "dev-lead@a", "done", "2026-10-23T12:00:00Z", "Finished");
    row("q-elsewhere", "other-seat@b", "pending", "2026-10-23T12:00:00Z", "Another rig's work");
    const r = routingCandidates(db, "rig-a");
    expect(r.owners).toEqual([
      { session: "dev-lead@a", logicalId: "dev.lead", role: "Owns the build pod's work" },
      { session: "qa-one@a", logicalId: "qa.one", role: null },
    ]);
    expect(r.work).toEqual([
      { qitemId: "q-new", destination: "qa-one@a", state: "in-progress", summary: "body of q-new" },
      { qitemId: "q-old", destination: "dev-lead@a", state: "pending", summary: "Older work" },
    ]);
    expect([r.ownersTruncated, r.workTruncated]).toEqual([false, false]);
  });

  it("says when open work was cut at 30", () => {
    for (let i = 0; i < 31; i++) row(`q-${String(i).padStart(2, "0")}`, "dev-lead@a", "blocked", `2026-10-23T10:${String(i).padStart(2, "0")}:00Z`);
    const r = routingCandidates(db, "rig-a");
    expect(r.work).toHaveLength(30);
    expect(r.work[0]!.qitemId).toBe("q-30");
    expect(r.workTruncated).toBe(true);
  });
});
