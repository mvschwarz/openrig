import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import {
  MissionControlActionLog,
  MissionControlActionLogError,
  MISSION_CONTROL_VERBS,
} from "../src/domain/mission-control/mission-control-action-log.js";

describe("MissionControlActionLog (PL-005 Phase A; append-only)", () => {
  let db: Database.Database;
  let log: MissionControlActionLog;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, queueItemsSchema, missionControlActionsSchema]);
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
       VALUES ('q-1', '2026-05-04T01:00:00Z', '2026-05-04T01:00:00Z', 'a@r', 'b@r', 'pending', 'routine', 'x')`,
    ).run();
    log = new MissionControlActionLog(db);
  });

  afterEach(() => db.close());

  it("record persists all 7 verbs", () => {
    for (const verb of MISSION_CONTROL_VERBS) {
      const e = log.record({
        actionVerb: verb,
        qitemId: "q-1",
        actorSession: "human-wrandom@kernel",
        actedAt: "2026-05-04T01:00:00.000Z",
        annotation: verb === "annotate" ? "test annotation" : undefined,
        reason: verb === "hold" || verb === "drop" ? "test reason" : undefined,
      });
      expect(e.actionVerb).toBe(verb);
      expect(e.actionId).toMatch(/^[0-9A-Z]{26}$/);
    }
    expect(log.countAll()).toBe(7);
  });

  it("record(annotate) requires annotation", () => {
    try {
      log.record({
        actionVerb: "annotate",
        qitemId: "q-1",
        actorSession: "x@r",
        actedAt: "2026-05-04T01:00:00.000Z",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissionControlActionLogError);
      expect((err as MissionControlActionLogError).code).toBe("annotation_required");
    }
  });

  it("record(hold/drop) requires reason", () => {
    for (const verb of ["hold", "drop"] as const) {
      try {
        log.record({
          actionVerb: verb,
          qitemId: "q-1",
          actorSession: "x@r",
          actedAt: "2026-05-04T01:00:00.000Z",
        });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MissionControlActionLogError);
        expect((err as MissionControlActionLogError).code).toBe("reason_required");
      }
    }
  });

  it("record rejects unknown verb", () => {
    try {
      log.record({
        actionVerb: "totally-bogus" as never,
        qitemId: "q-1",
        actorSession: "x@r",
        actedAt: "2026-05-04T01:00:00.000Z",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissionControlActionLogError);
      expect((err as MissionControlActionLogError).code).toBe("verb_unknown");
    }
  });

  it("record JSON-encodes before/after state and audit notes", () => {
    log.record({
      actionVerb: "approve",
      qitemId: "q-1",
      actorSession: "human@r",
      actedAt: "2026-05-04T01:00:00.000Z",
      beforeState: { state: "pending" },
      afterState: { state: "done" },
      auditNotes: { evidence: "/path/x" },
    });
    const list = log.listRecent();
    expect(list[0]?.beforeState).toEqual({ state: "pending" });
    expect(list[0]?.afterState).toEqual({ state: "done" });
    expect(list[0]?.auditNotes).toEqual({ evidence: "/path/x" });
  });

  it("listRecent returns DESC by acted_at", () => {
    log.record({ actionVerb: "approve", qitemId: "q-1", actorSession: "x@r", actedAt: "2026-05-04T01:00:00.000Z" });
    log.record({ actionVerb: "approve", qitemId: "q-1", actorSession: "x@r", actedAt: "2026-05-04T01:01:00.000Z" });
    const list = log.listRecent();
    expect(list[0]?.actedAt).toBe("2026-05-04T01:01:00.000Z");
    expect(list[1]?.actedAt).toBe("2026-05-04T01:00:00.000Z");
  });

  it("listForQitem + listForActor filter correctly", () => {
    log.record({ actionVerb: "approve", qitemId: "q-1", actorSession: "alice@r", actedAt: "2026-05-04T01:00:00.000Z" });
    log.record({ actionVerb: "deny", qitemId: "q-1", actorSession: "bob@r", actedAt: "2026-05-04T01:01:00.000Z" });
    expect(log.listForQitem("q-1")).toHaveLength(2);
    expect(log.listForActor("alice@r")).toHaveLength(1);
    expect(log.listForActor("bob@r")).toHaveLength(1);
  });

  it("API surface lacks update/delete (append-only contract)", () => {
    const proto = Object.getPrototypeOf(log) as Record<string, unknown>;
    const names = Object.getOwnPropertyNames(proto);
    expect(names).not.toContain("update");
    expect(names).not.toContain("delete");
    expect(names).not.toContain("remove");
  });
});
