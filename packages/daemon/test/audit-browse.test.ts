import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlAuditBrowse } from "../src/domain/mission-control/audit-browse.js";

describe("MissionControlAuditBrowse (PL-005 Phase B; read-only)", () => {
  let db: Database.Database;
  let log: MissionControlActionLog;
  let audit: MissionControlAuditBrowse;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, queueItemsSchema, missionControlActionsSchema]);
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
       VALUES ('q-1', '2026-05-04T01:00:00Z', '2026-05-04T01:00:00Z', 'a@r', 'b@r', 'pending', 'routine', 'x')`,
    ).run();
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
       VALUES ('q-2', '2026-05-04T02:00:00Z', '2026-05-04T02:00:00Z', 'a@r', 'b@r', 'pending', 'routine', 'x')`,
    ).run();
    log = new MissionControlActionLog(db);
    audit = new MissionControlAuditBrowse(db);
    // Seed varied actions across q-1 and q-2 with different verbs + actors + times.
    log.record({ actionVerb: "approve", qitemId: "q-1", actorSession: "alice@r", actedAt: "2026-05-04T03:00:00.000Z" });
    log.record({ actionVerb: "deny", qitemId: "q-1", actorSession: "alice@r", actedAt: "2026-05-04T03:01:00.000Z" });
    log.record({ actionVerb: "approve", qitemId: "q-2", actorSession: "bob@r", actedAt: "2026-05-04T03:02:00.000Z" });
    log.record({ actionVerb: "annotate", qitemId: "q-2", actorSession: "alice@r", actedAt: "2026-05-04T03:03:00.000Z", annotation: "test" });
  });

  afterEach(() => db.close());

  it("query without filters returns all rows DESC by acted_at", () => {
    const result = audit.query({});
    expect(result.rows).toHaveLength(4);
    expect(result.rows[0]!.actedAt).toBe("2026-05-04T03:03:00.000Z");
    expect(result.rows[3]!.actedAt).toBe("2026-05-04T03:00:00.000Z");
  });

  it("filter by qitem_id (exact)", () => {
    const result = audit.query({ qitemId: "q-1" });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.qitemId === "q-1")).toBe(true);
  });

  it("filter by action_verb (exact)", () => {
    const result = audit.query({ actionVerb: "approve" });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.actionVerb === "approve")).toBe(true);
  });

  it("filter by actor_session (exact)", () => {
    const result = audit.query({ actorSession: "alice@r" });
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((r) => r.actorSession === "alice@r")).toBe(true);
  });

  it("filter by since (acted_at >= since)", () => {
    const result = audit.query({ since: "2026-05-04T03:02:00.000Z" });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.actedAt >= "2026-05-04T03:02:00.000Z")).toBe(true);
  });

  it("filter by until (acted_at <= until)", () => {
    const result = audit.query({ until: "2026-05-04T03:01:00.000Z" });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.actedAt <= "2026-05-04T03:01:00.000Z")).toBe(true);
  });

  it("filter by since AND until (range)", () => {
    const result = audit.query({
      since: "2026-05-04T03:01:00.000Z",
      until: "2026-05-04T03:02:00.000Z",
    });
    expect(result.rows).toHaveLength(2);
  });

  it("rejects unknown action_verb with structured error", () => {
    expect(() => audit.query({ actionVerb: "totally-bogus" })).toThrow(/totally-bogus/);
  });

  it("pagination: limit honored + has_more set + next_before_id provided", () => {
    const page1 = audit.query({ limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextBeforeId).not.toBeNull();
    const page2 = audit.query({ limit: 2, beforeId: page1.nextBeforeId! });
    expect(page2.rows).toHaveLength(2);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextBeforeId).toBeNull();
  });

  it("limit clamping: > 200 → 200, < 1 → 1", () => {
    const r1 = audit.query({ limit: 999 });
    expect(r1.rows.length).toBeLessThanOrEqual(200);
    const r2 = audit.query({ limit: 0 });
    expect(r2.rows.length).toBeLessThanOrEqual(1);
  });

  it("read-only: API surface lacks insert/update/delete methods", () => {
    const proto = Object.getPrototypeOf(audit) as Record<string, unknown>;
    const names = Object.getOwnPropertyNames(proto);
    expect(names).not.toContain("insert");
    expect(names).not.toContain("update");
    expect(names).not.toContain("delete");
    expect(names).not.toContain("record");
  });
});
