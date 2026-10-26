import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueTransitionLog } from "../src/domain/queue-transition-log.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { queueRoutes } from "../src/routes/queue.js";
import { archiveAgedTerminalTransitions } from "../src/domain/queue-retention.js";

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = "2026-09-11T00:00:00.000Z";
const databases: ReturnType<typeof createDb>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function database(previous = false) {
  const db = createDb();
  databases.push(db);
  migrate(db, previous ? ALL_MIGRATIONS.filter((m) => m.name < "082") : ALL_MIGRATIONS);
  return db;
}
function seed(db: ReturnType<typeof createDb>, id: string, state = "done", parent: string | null = null) {
  db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session,
    destination_session, state, priority, body, handed_off_from)
    VALUES (?, ?, ?, 'sender@rig-a', 'owner@rig-a', ?, 'routine', 'archive test', ?)`).run(id, OLD, OLD, state, parent);
  const log = new QueueTransitionLog(db);
  for (const identityProvenance of ["transport:v1", "claimed:v1", null]) {
    log.append({ qitemId: id, state, actorSession: "owner@rig-a", identityProvenance,
      transitionNote: "slack-owner-notification-posted notification_key=fixture:key",
      closureReason: state === "done" ? "no-follow-on" : undefined,
      ownerNotificationKind: "human-decision-resolved", ownerNotificationLevel: "NOTICE" });
  }
  db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(OLD, id);
  return log;
}

describe("archived audit identity — real migration, writer and history readers", () => {
  it("upgrades the previous schema additively without relabeling old archive rows", () => {
    const db = database(true);
    db.prepare(`INSERT INTO queue_transitions_archive (transition_id, qitem_id, ts, state,
      actor_session, archived_at) VALUES (1, 'legacy', ?, 'done', 'owner@rig-a', ?)`).run(OLD, OLD);
    const before = db.prepare("SELECT * FROM queue_transitions_archive").get() as object;
    migrate(db, ALL_MIGRATIONS);
    const column = (db.prepare("PRAGMA table_info(queue_transitions_archive)").all() as Array<{name: string; notnull: number}>)
      .find((c) => c.name === "identity_provenance");
    expect(column).toMatchObject({ notnull: 0 });
    // 140 adds the principal column too; an old row gets neither value.
    expect(db.prepare("SELECT * FROM queue_transitions_archive").get()).toEqual({ ...before, identity_provenance: null, identity_principal: null });
    migrate(db, ALL_MIGRATIONS);
    expect(new QueueTransitionLog(db).listForQitem("legacy")[0]?.identityProvenance).toBeNull();
  });

  it("retains complete transition values through archival, public history and bounded readers", async () => {
    const db = database();
    const log = seed(db, "archived");
    seed(db, "child", "handed-off", "archived");
    const repo = new QueueRepository(db, new EventBus(db));
    const before = repo.listTransitions("archived");
    const actorBefore = log.listForActor("owner@rig-a");
    const recentBefore = log.listRecent({ kind: "rig", rig: "rig-a" });
    const familyBefore = log.listForHandoffWindow("archived", OLD, NOW, 100);
    expect(before.map((t) => t.identityProvenance)).toEqual(["transport:v1", "claimed:v1", null]);
    expect(archiveAgedTerminalTransitions(db, { nowIso: NOW })).toEqual({ archivedQitems: 2, archivedRows: 6 });
    expect(repo.listTransitions("archived")).toEqual(before);
    expect(log.listForActor("owner@rig-a")).toEqual(actorBefore);
    expect(log.listRecent({ kind: "rig", rig: "rig-a" })).toEqual(recentBefore);
    expect(log.listForQitemWindow("archived", OLD, NOW, 2)).toEqual(before.slice(0, 2));
    expect(log.listForHandoffWindow("archived", OLD, NOW, 100)).toEqual(familyBefore);
    expect(log.latestOwnerNotificationForQitem("archived")).toEqual(before.at(-1));
    expect(log.hasOwnerNotificationReceipt("archived", "fixture:key")).toBe(true);
    expect(log.hasOwnerNotificationReceipt("archived", "different:key")).toBe(false);
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("queueRepo" as never, repo); await next(); });
    app.route("/api/queue", queueRoutes());
    const response = await app.request("/api/queue/archived/transitions");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(before);
    // A newer live row and an archived row must share one ordering/limit.
    const newer = log.append({ qitemId: "archived", state: "done", actorSession: "owner@rig-a", identityProvenance: "transport:v1" });
    expect(log.listForQitem("archived")).toEqual([...before, newer]);
    expect(log.listForActor("owner@rig-a", 1)).toEqual([newer]);
    expect(archiveAgedTerminalTransitions(db, { nowIso: NOW }).archivedRows).toBe(0);
  });

  it("keeps nonterminal, recent and live-frontier history; normal retention resumes after frontier closure", () => {
    const db = database();
    seed(db, "active", "in-progress");
    seed(db, "recent");
    seed(db, "frontier");
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = 'recent'").run(NOW);
    db.prepare(`INSERT INTO workflow_instances (instance_id, workflow_name, status, current_frontier_json, workflow_version, created_by_session, created_at)
      VALUES ('wi', 'fixture', 'waiting', '["frontier"]', '1', 'owner@rig-a', ?)`).run(OLD);
    expect(archiveAgedTerminalTransitions(db, { nowIso: NOW }).archivedRows).toBe(0);
    db.prepare("UPDATE workflow_instances SET status='completed', current_frontier_json='[]'").run();
    expect(archiveAgedTerminalTransitions(db, { nowIso: NOW })).toEqual({ archivedQitems: 1, archivedRows: 3 });
    expect(new QueueTransitionLog(db).listForQitem("frontier").map((t) => t.identityProvenance))
      .toEqual(["transport:v1", "claimed:v1", null]);
    expect((db.prepare("SELECT COUNT(*) n FROM queue_transitions").get() as { n: number }).n).toBe(6);
  });

  it("rolls back the archive insert when deletion fails inside the same transaction", () => {
    const db = database();
    seed(db, "rollback");
    const before = db.prepare("SELECT * FROM queue_transitions").all();
    db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON queue_transitions BEGIN SELECT RAISE(ABORT, 'fixture delete failure'); END");
    expect(() => archiveAgedTerminalTransitions(db, { nowIso: NOW })).toThrow("fixture delete failure");
    expect(db.prepare("SELECT * FROM queue_transitions").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM queue_transitions_archive").all()).toEqual([]);
  });

  it("refuses a pre-upgrade archive that cannot carry live provenance", () => {
    const db = database(true);
    seed(db, "old-schema");
    const before = db.prepare("SELECT * FROM queue_transitions").all();
    expect(() => archiveAgedTerminalTransitions(db, { nowIso: NOW })).toThrow(/identity_provenance/);
    expect(db.prepare("SELECT * FROM queue_transitions").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM queue_transitions_archive").all()).toEqual([]);
  });
});
