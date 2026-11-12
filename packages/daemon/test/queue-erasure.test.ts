import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { InboxHandler } from "../src/domain/inbox-handler.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { QueueTransitionLog } from "../src/domain/queue-transition-log.js";
import { EraseRefusal, eraseQueue } from "../src/domain/queue-erasure.js";
import { runQueueRetentionSweep } from "../src/domain/queue-retention.js";
import { queueRoutes } from "../src/routes/queue.js";
import { recordReaderAction } from "../src/domain/stream-reader-actions.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = "2026-11-09T12:00:00.000Z";
const ago = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
const A = "a-one@n-acct";
const B = "b-two@n-acct";
const OUT = "x-other@n-else";

let db: Database.Database;
let repo: QueueRepository;
let log: QueueTransitionLog;
function open(handle: Database.Database) {
  db = handle;
  repo = new QueueRepository(db, new EventBus(db));
  repo.attachOutbox(new OutboxHandler(db));
  log = new QueueTransitionLog(db);
}
beforeEach(() => {
  const handle = createDb();
  migrate(handle, ALL_MIGRATIONS);
  open(handle);
});
afterEach(() => db.close());

/** A row whose every content field and linked copy carries `secret-<id>`, with its history at chosen ages. */
async function row(id: string, source: string, destination: string, history: Array<{ state: string; daysAgo: number }> = []) {
  const secret = `secret-${id}`;
  await repo.create({ qitemId: id, sourceSession: source, destinationSession: destination, body: `${secret} body`, summary: `${secret} summary`,
    tags: [`${secret}-tag`] });
  db.prepare("UPDATE queue_transitions SET ts = ?, transition_note = ? WHERE qitem_id = ?").run(ago(400), `${secret} created`, id);
  for (const step of history) {
    const { transitionId } = log.append({ qitemId: id, state: step.state, actorSession: destination, transitionNote: `${secret} note` });
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE transition_id = ?").run(ago(step.daysAgo), transitionId);
  }
  const state = history.at(-1)?.state ?? "pending";
  db.prepare("UPDATE queue_items SET state = ?, resolution = ?, ts_updated = ? WHERE qitem_id = ?")
    .run(state, `${secret} resolution`, ago(history.at(-1)?.daysAgo ?? 400), id);
  // The create staged the row's wake intent (its body carries the summary); make sure one exists either way.
  db.prepare(`INSERT OR IGNORE INTO outbox_entries (outbox_id, sender_session, destination_session, body, ts_dispatched, audit_pointer)
    VALUES (?, ?, ?, ?, ?, ?)`).run(`wake-intent-${id}`, source, destination, `${secret} wake`, NOW, id);
  db.prepare(`INSERT INTO inbox_entries (inbox_id, destination_session, sender_session, body, ts_dropped, state, absorbed_qitem_id)
    VALUES (?, ?, ?, ?, ?, 'absorbed', ?)`).run(`inbox-${id}`, destination, source, `${secret} inbox`, NOW, id);
  db.prepare(`INSERT INTO mission_control_actions (action_id, action_verb, qitem_id, actor_session, acted_at, reason)
    VALUES (?, 'approve', ?, ?, ?, ?)`).run(`mc-${id}`, id, destination, NOW, `${secret} reason`);
}

/** Every value in every table, so a check can say no copy of a secret is left anywhere. */
function everything(): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
  return tables.map((table) => JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all())).join("\n");
}
const exists = (id: string) => db.prepare("SELECT 1 FROM queue_items WHERE qitem_id = ?").get(id) !== undefined;
/** Event payloads as stored (everything() escapes their quotes, so match payload text here). */
const payloads = () => (db.prepare("SELECT payload FROM events").all() as Array<{ payload: string }>).map((e) => e.payload).join("\n");
const marker = (id: string) => db.prepare("SELECT * FROM queue_erased_ids WHERE qitem_id = ?").get(id) as Record<string, unknown> | undefined;

describe("account deletion (members scope)", () => {
  beforeEach(async () => {
    await row("q-done", A, B, [{ state: "done", daysAgo: 2 }]);
    await row("q-open", B, A); // open work: account deletion takes it too
    await row("q-mixed", A, OUT, [{ state: "done", daysAgo: 2 }]);
    await row("q-else", OUT, OUT);
    db.prepare(`INSERT INTO outbox_entries (outbox_id, sender_session, destination_session, body, ts_dispatched)
      VALUES ('o-loose', ?, ?, 'secret-loose', ?), ('o-cross', ?, ?, 'secret-cross', ?)`).run(A, B, NOW, A, OUT, NOW);
  });

  it("a dry run reports exactly what an apply erases, and changes nothing", async () => {
    const before = everything();
    const dry = await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: false, nowIso: NOW });
    expect(everything()).toBe(before);
    expect(dry.qitems.map((q) => [q.qitemId, q.action, q.state])).toEqual([["q-done", "delete", "done"], ["q-open", "delete", "pending"]]);
    expect(dry.mixed).toEqual([{ qitemId: "q-mixed", memberEndpoint: "source" }]);
    expect(dry.linked.outbox).toBeGreaterThanOrEqual(2);
    expect(dry.linked.events).toBeGreaterThanOrEqual(2);
    expect(dry.unlinked).toMatchObject({ outbox: 1, mixedEntries: 1 });
    const applied = await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: true, nowIso: NOW });
    expect({ ...applied, applied: false }).toEqual(dry);
  });

  it("deletes both members' rows with every copy, keeps only their ids, and leaves mixed and other rows whole", async () => {
    const report = await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: true, nowIso: NOW });
    expect(report.complete).toBe(true);
    const all = everything();
    for (const id of ["q-done", "q-open"]) {
      expect(exists(id)).toBe(false);
      expect(all).not.toContain(`secret-${id}`);
      expect(marker(id)).toEqual({ qitem_id: id, erased_at: NOW, reason: "account-deletion" });
    }
    expect(all).not.toContain("secret-loose");
    // The mixed row and its copies stay, and so does the cross-account entry; nothing else was touched.
    expect(all).toContain("secret-q-mixed body");
    expect(all).toContain("secret-q-mixed summary");
    expect(all).toContain("secret-cross");
    expect(all).toContain("secret-q-else body");
    expect(marker("q-mixed")).toBeUndefined();
  });

  it("a create reusing an erased id is refused, so erased work never comes back as new work", async () => {
    await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: true, nowIso: NOW });
    await expect(repo.create({ qitemId: "q-done", sourceSession: A, destinationSession: B, body: "secret-q-done body" }))
      .rejects.toBeInstanceOf(QueueRepositoryError);
    await expect(repo.create({ qitemId: "q-done", sourceSession: A, destinationSession: B, body: "secret-q-done body" }))
      .rejects.toMatchObject({ code: "qitem_erased" });
    expect(exists("q-done")).toBe(false);
  });

  it("a run that stops partway says so, and a rerun finishes the rest", async () => {
    const first = await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: true, nowIso: NOW, batchSize: 1, maxBatches: 1 });
    expect(first.complete).toBe(false);
    expect(first.unlinked).toBeUndefined();
    expect(first.qitems.map((q) => q.qitemId)).toEqual(["q-done"]);
    expect(exists("q-open")).toBe(true);
    const rest = await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: true, nowIso: NOW, batchSize: 1 });
    expect(rest.complete).toBe(true);
    expect(rest.qitems.map((q) => q.qitemId)).toEqual(["q-open"]);
    expect(everything()).not.toContain("secret-loose");
  });

  it("a row a workflow still references is reported and left", async () => {
    db.pragma("foreign_keys = OFF");
    db.prepare(`INSERT INTO workflow_frontier_bindings (instance_id, packet_id, step_id, created_at) VALUES ('wf-1', 'q-done', 's1', ?)`).run(NOW);
    db.pragma("foreign_keys = ON");
    const report = await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: true, nowIso: NOW });
    expect(report.gaps).toEqual([{ code: "workflow-reference", qitemId: "q-done" }]);
    expect(report.qitems.map((q) => q.qitemId)).toEqual(["q-open"]);
    expect(everything()).toContain("secret-q-done body");
  });
});

describe("routine closed-work retention", () => {
  beforeEach(async () => {
    // Closed 40 days ago; a note yesterday keeps the closed state, so it doesn't restart the clock.
    await row("r-old-done", A, B, [{ state: "done", daysAgo: 40 }, { state: "done", daysAgo: 1 }]);
    await row("r-recent", A, B, [{ state: "done", daysAgo: 10 }]);
    await row("r-ancient-canceled", A, B, [{ state: "canceled", daysAgo: 100 }]);
    await row("r-failed", A, B, [{ state: "failed", daysAgo: 100 }]);
    await row("r-open", A, B, [{ state: "in-progress", daysAgo: 200 }]);
    // Closed long ago, reopened, closed again five days ago: it counts from the latest close.
    await row("r-reclosed", A, B, [{ state: "done", daysAgo: 50 }, { state: "pending", daysAgo: 20 }, { state: "denied", daysAgo: 5 }]);
  });

  it("removes content past the content window and the row past the metadata window, from when each row closed", async () => {
    const report = await eraseQueue(db, { scope: { kind: "routine", contentDays: 30, metadataDays: 90 }, apply: true, nowIso: NOW });
    expect(report.qitems.map((q) => [q.qitemId, q.action])).toEqual([["r-ancient-canceled", "delete"], ["r-old-done", "scrub"]]);
    const all = everything();
    expect(all).not.toContain("secret-r-old-done");
    expect(all).not.toContain("secret-r-ancient-canceled");
    for (const id of ["r-recent", "r-failed", "r-open", "r-reclosed"]) expect(all).toContain(`secret-${id} body`);
    expect(marker("r-ancient-canceled")).toMatchObject({ reason: "retention-metadata" });
    // The scrubbed row stays, with its identity, endpoints and state.
    const kept = db.prepare("SELECT source_session, destination_session, state, body, content_erased_at FROM queue_items WHERE qitem_id = 'r-old-done'").get();
    expect(kept).toEqual({ source_session: A, destination_session: B, state: "done", body: "", content_erased_at: NOW });
    const event = db.prepare("SELECT payload FROM events WHERE json_extract(payload, '$.qitemId') = 'r-old-done'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ type: "queue.created", qitemId: "r-old-done", contentErased: true });
    // A second sweep finds nothing more to do.
    const again = await eraseQueue(db, { scope: { kind: "routine", contentDays: 30, metadataDays: 90 }, apply: true, nowIso: NOW });
    expect(again.qitems).toEqual([]);
  });

  it("a retried create for a scrubbed row returns that row and makes no new work", async () => {
    await eraseQueue(db, { scope: { kind: "routine", contentDays: 30, metadataDays: 0 }, apply: true, nowIso: NOW });
    const transitions = () => (db.prepare("SELECT COUNT(*) AS n FROM queue_transitions WHERE qitem_id = 'r-old-done'").get() as { n: number }).n;
    const before = transitions();
    const retried = await repo.create({ qitemId: "r-old-done", sourceSession: A, destinationSession: B, body: "secret-r-old-done body" });
    expect(retried).toMatchObject({ qitemId: "r-old-done", state: "done", body: "", contentErasedAt: NOW });
    expect(transitions()).toBe(before);
    expect(everything()).not.toContain("secret-r-old-done");
  });

  it("runs from the retention sweep only when a window is set", async () => {
    const off = await runQueueRetentionSweep(db, { nowIso: NOW });
    expect([off.closedScrubbed, off.closedDeleted]).toEqual([0, 0]);
    expect(everything()).toContain("secret-r-old-done body");
    const on = await runQueueRetentionSweep(db, { nowIso: NOW, closedContentDays: 30, closedMetadataDays: 90 });
    expect([on.closedScrubbed, on.closedDeleted, on.closedKept]).toEqual([1, 1, 0]);
  });
});

describe("ids scope: reapplying a ledger after a restore", () => {
  it("deletes restored rows again and writes back every id marker, including ids already gone", async () => {
    await row("i-one", A, B, [{ state: "done", daysAgo: 3 }]);
    await eraseQueue(db, { scope: { kind: "ids", entries: [{ qitemId: "i-one", action: "delete" }] }, apply: true, nowIso: NOW });
    // A restore from a backup taken before the erase brings the row back and loses the marker.
    db.prepare("DELETE FROM queue_erased_ids").run();
    await row("i-one", A, B, [{ state: "done", daysAgo: 3 }]);
    const reapplied = await eraseQueue(db, { scope: { kind: "ids", entries: [{ qitemId: "i-one", action: "delete" }, { qitemId: "i-gone", action: "delete" }] }, apply: true, nowIso: NOW });
    expect(reapplied.qitems.map((q) => q.qitemId)).toEqual(["i-one"]);
    expect(reapplied.alreadyAbsent).toEqual(["i-gone"]);
    expect(exists("i-one")).toBe(false);
    expect(everything()).not.toContain("secret-i-one");
    expect(marker("i-one")).toMatchObject({ reason: "erase-by-id" });
    expect(marker("i-gone")).toMatchObject({ reason: "erase-by-id" });
  });

  it("a scrub of an unknown id is reported, not invented", async () => {
    const report = await eraseQueue(db, { scope: { kind: "ids", entries: [{ qitemId: "nope", action: "scrub" }] }, apply: true, nowIso: NOW });
    expect(report.gaps).toEqual([{ code: "not-found", qitemId: "nope" }]);
    expect(marker("nope")).toBeUndefined();
  });
});

describe("POST /api/queue/erase", () => {
  function app(settings: Record<string, unknown> = {}) {
    const bus = new EventBus(db);
    const hono = new Hono();
    hono.use("*", async (c, next) => {
      c.set("db" as never, db as never);
      c.set("eventBus" as never, bus as never);
      c.set("queueRepo" as never, repo as never);
      c.set("inboxHandler" as never, new InboxHandler(db, bus, repo) as never);
      c.set("outboxHandler" as never, new OutboxHandler(db) as never);
      c.set("settingsStore" as never, { resolveOne: (key: string) => ({ value: settings[key] ?? 0 }) } as never);
      await next();
    });
    hono.route("/api/queue", queueRoutes());
    return hono;
  }
  const post = (hono: Hono, body: unknown) => hono.request("/api/queue/erase", {
    method: "POST", headers: { "content-type": "application/json", "X-OpenRig-Session": "ops-admin@n-ops" }, body: JSON.stringify(body),
  });

  it("refuses a missing, doubled or malformed scope with a fixed code", async () => {
    const hono = app();
    const codes = async (body: unknown) => {
      const res = await post(hono, body);
      return [res.status, ((await res.json()) as { error: string }).error];
    };
    expect(await codes({})).toEqual([400, "erase_scope_required"]);
    expect(await codes({ members: [A], ids: ["x"] })).toEqual([400, "erase_scope_conflict"]);
    expect(await codes({ members: [] })).toEqual([400, "erase_members_invalid"]);
    expect(await codes({ members: [" a-one@n-acct"] })).toEqual([400, "erase_members_invalid"]);
    expect(await codes({ ids: ["x"], action: "shred" })).toEqual([400, "erase_action_invalid"]);
    expect(await codes({ routine: true })).toEqual([400, "erase_routine_off"]);
    expect(await codes({ ids: ["x"], rig: "rig-id" })).toEqual([400, "erase_rig_invalid"]);
    expect(await codes({ ids: [{ qitemId: "x", action: "shred" }] })).toEqual([400, "erase_action_invalid"]);
  });

  it("runs a dry run by default and erases only with apply", async () => {
    await row("p-one", A, B, [{ state: "done", daysAgo: 2 }]);
    const hono = app();
    const dry = await post(hono, { members: [A, B] });
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({ ok: true, applied: false, qitems: [{ qitemId: "p-one", action: "delete" }] });
    expect(exists("p-one")).toBe(true);
    const applied = await post(hono, { members: [A, B], apply: true });
    expect(await applied.json()).toMatchObject({ applied: true, complete: true });
    expect(exists("p-one")).toBe(false);
  });

  it("a run that stops on an error answers 500 with what it committed", async () => {
    await row("p-a", A, B, [{ state: "done", daysAgo: 2 }]);
    await row("p-b", A, B, [{ state: "done", daysAgo: 2 }]);
    db.exec("CREATE TEMP TRIGGER fail_pb BEFORE DELETE ON queue_items WHEN old.qitem_id = 'p-b' BEGIN SELECT RAISE(ABORT, 'disk full (test)'); END;");
    const res = await post(app(), { members: [A, B], apply: true });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ complete: false, error: { stage: "rows" } });
  });

  it("takes a ledger's commit and abort lines with its entries, and replays only committed batches", async () => {
    await row("p-kept", A, B, [{ state: "done", daysAgo: 2 }]);
    await row("p-gone", A, B, [{ state: "done", daysAgo: 2 }]);
    const res = await post(app(), { apply: true, ids: [
      { qitemId: "p-kept", action: "delete", batch: "b-aborted" }, { batch: "b-aborted", committed: false },
      { qitemId: "p-gone", action: "delete", batch: "b-committed" }, { batch: "b-committed", committed: true },
    ] });
    expect(await res.json()).toMatchObject({ qitems: [{ qitemId: "p-gone" }], skipped: [{ qitemId: "p-kept", batch: "b-aborted" }], gaps: [] });
    expect([exists("p-kept"), exists("p-gone")]).toEqual([true, false]);
    const bad = await post(app(), { ids: [{ qitemId: "p-kept", batch: 7 }] });
    expect([bad.status, ((await bad.json()) as { error: string }).error]).toEqual([400, "erase_ids_invalid"]);
  });

  it("routine reads this daemon's own windows", async () => {
    await row("p-old", A, B, [{ state: "done", daysAgo: 40 }]);
    const res = await post(app({ "retention.closed_content_days": 30 }), { routine: true, apply: true });
    expect(await res.json()).toMatchObject({ routine: { contentDays: 30, metadataDays: 0 }, qitems: [{ qitemId: "p-old", action: "scrub" }] });
  });
});

describe("account deletion with the account's rig", () => {
  const RIG = "rig-acct-id";
  beforeEach(async () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, 'n-acct'), ('rig-else-id', 'n-else')").run(RIG);
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('node-a', ?, 'a.one'), ('node-x', 'rig-else-id', 'x.other')").run(RIG);
    const bus = new EventBus(db);
    bus.emit({ type: "rig.imported", rigId: RIG, specName: "secret-rig-spec", specVersion: "1" } as never);
    bus.emit({ type: "node.launched", rigId: RIG, nodeId: "node-a", logicalId: "a.one", sessionName: A } as never);
    bus.emit({ type: "node.launched", rigId: "rig-else-id", nodeId: "node-x", logicalId: "x.other", sessionName: OUT } as never);
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, data) VALUES ('snap-a', ?, 'periodic', '{\"seat\":\"secret-snapshot\"}')").run(RIG);
    db.prepare("INSERT INTO seat_identity_verdicts (node_id, session_name, verdict, observed_at) VALUES ('node-a', ?, 'verified', ?)").run(A, NOW);
    db.prepare(`INSERT INTO watchdog_jobs (job_id, policy, spec_yaml, target_session, interval_seconds, registered_by_session, registered_at)
      VALUES ('wd-a', 'periodic-reminder', 'secret-watchdog', ?, 60, ?, ?), ('wd-cross', 'periodic-reminder', 'x', ?, 60, ?, ?)`)
      .run(A, B, NOW, OUT, A, NOW);
    db.prepare("INSERT INTO watchdog_history (job_id, evaluated_at, outcome) VALUES ('wd-a', ?, 'fired')").run(NOW);
    await row("g-done", A, B, [{ state: "done", daysAgo: 2 }]);
    db.prepare(`INSERT INTO inbox_entries (inbox_id, destination_session, sender_session, body, ts_dropped)
      VALUES ('i-loose', ?, ?, 'secret-loose-inbox', ?)`).run(B, A, NOW);
  });

  it("erases the rig's own records, leaves another rig's, and counts a member's job aimed outside", async () => {
    const report = await eraseQueue(db, { scope: { kind: "members", members: [A, B], rig: RIG }, apply: true, nowIso: NOW });
    expect(report.error).toBeUndefined();
    expect(report.rig).toMatchObject({ id: RIG, found: true, erased: { snapshots: 1, seat_identity_verdicts: 1, watchdog_jobs: 1, watchdog_history: 1 },
      left: { watchdog_jobs: 1 } });
    expect(report.rig!.erased.events).toBeGreaterThanOrEqual(2);
    expect(report.clean).toBe(false); // the member's job aimed outside the account is left, so not clean
    const all = everything();
    for (const secret of ["secret-rig-spec", "secret-snapshot", "secret-watchdog", "secret-loose-inbox", "secret-g-done"]) {
      expect(all).not.toContain(secret);
    }
    expect(payloads()).not.toContain(`"sessionName":"${A}"`);
    expect(payloads()).toContain(`"sessionName":"${OUT}"`);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE rig_id = ?").get(RIG)).toEqual({ n: 0 });
  });

  it("refuses a rig the members don't belong to, and erases nothing", async () => {
    const before = everything();
    await expect(eraseQueue(db, { scope: { kind: "members", members: [A, B], rig: "rig-else-id" }, apply: true, nowIso: NOW }))
      .rejects.toThrowError(EraseRefusal);
    await expect(eraseQueue(db, { scope: { kind: "members", members: [A, B], rig: "rig-else-id" }, apply: true, nowIso: NOW }))
      .rejects.toMatchObject({ code: "erase_rig_mismatch" });
    expect(everything()).toBe(before);
  });

  it("after the rig is removed, a rerun erases what its removal wrote, by the rig's id", async () => {
    await eraseQueue(db, { scope: { kind: "members", members: [A, B], rig: RIG }, apply: true, nowIso: NOW });
    db.prepare("DELETE FROM watchdog_jobs WHERE job_id = 'wd-cross'").run();
    db.prepare("DELETE FROM nodes WHERE rig_id = ?").run(RIG);
    db.prepare("DELETE FROM rigs WHERE id = ?").run(RIG);
    new EventBus(db).emit({ type: "session.detached", rigId: RIG, nodeId: "node-a", sessionName: A } as never);
    const rerun = await eraseQueue(db, { scope: { kind: "members", members: [A, B], rig: RIG }, apply: true, nowIso: NOW });
    expect(rerun.rig).toMatchObject({ found: false, erased: { events: 1 } });
    expect(rerun.clean).toBe(true);
    expect(payloads()).not.toContain(`"sessionName":"${A}"`);
    expect(payloads()).toContain(`"sessionName":"${OUT}"`);
    // The record is now a completion receipt without the rig's name, so an identical rerun (after a lost response,
    // say) still verifies and reports clean.
    expect(rerun.rig).toMatchObject({ completedAt: NOW });
    expect(db.prepare("SELECT rig_name, completed_at FROM queue_erased_rigs WHERE rig_id = ?").get(RIG)).toEqual({ rig_name: "", completed_at: NOW });
    const again = await eraseQueue(db, { scope: { kind: "members", members: [A, B], rig: RIG }, apply: true, nowIso: NOW });
    expect(again.rig).toMatchObject({ found: false, verified: true, completedAt: NOW, unknown: [] });
    expect(again.clean).toBe(true);
  });

  it("K2: a rig pass that stops partway reports the records it already erased", async () => {
    db.exec("CREATE TEMP TRIGGER fail_wd BEFORE DELETE ON watchdog_jobs BEGIN SELECT RAISE(ABORT, 'disk I/O error (test)'); END;");
    const report = await eraseQueue(db, { scope: { kind: "members", members: [A, B], rig: RIG }, apply: true, nowIso: NOW });
    expect(report).toMatchObject({ complete: false, error: { stage: "rig" }, rig: { erased: { snapshots: 1, watchdog_history: 1 } } });
    expect(report.rig!.erased.events).toBeGreaterThanOrEqual(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE rig_id = ?").get(RIG)).toEqual({ n: 0 });
  });

  it("restore control: after restoring a backup taken before the erase, the documented replay leaves no account content", async () => {
    await row("g-scrub", A, OUT, [{ state: "done", daysAgo: 40 }]); // another account's row, scrubbed by routine retention
    const backup = db.serialize();
    await eraseQueue(db, { scope: { kind: "members", members: [A, B], rig: RIG }, apply: true, nowIso: NOW });
    const routine = await eraseQueue(db, { scope: { kind: "routine", contentDays: 30, metadataDays: 0 }, apply: true, nowIso: NOW });
    const ledger = routine.qitems; // what a ledger keeps: ids with their actions
    // The restore: the database comes back as it was before both runs.
    db.close();
    open(new Database(backup));
    expect(everything()).toContain("secret-g-done body");
    // The documented replay: the retained membership and rig, then the ledger with its actions, then routine.
    const replay = await eraseQueue(db, { scope: { kind: "members", members: [A, B], rig: RIG }, apply: true, nowIso: NOW });
    await eraseQueue(db, { scope: { kind: "ids", entries: ledger }, apply: true, nowIso: NOW });
    await eraseQueue(db, { scope: { kind: "routine", contentDays: 30, metadataDays: 0 }, apply: true, nowIso: NOW });
    expect(replay.complete).toBe(true);
    const all = everything();
    for (const secret of ["secret-g-done", "secret-loose-inbox", "secret-rig-spec", "secret-snapshot", "secret-watchdog", "secret-g-scrub"]) {
      expect(all).not.toContain(secret);
    }
    expect(marker("g-done")).toMatchObject({ reason: "account-deletion" });
    // The scrubbed row was scrubbed again, not promoted to a deletion.
    expect(exists("g-scrub")).toBe(true);
    expect(marker("g-scrub")).toBeUndefined();
  });
});

describe("clean", () => {
  it("is true only when the run finished and left nothing", async () => {
    await row("c-one", A, B, [{ state: "done", daysAgo: 2 }]);
    expect((await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: false, nowIso: NOW })).clean).toBe(true);
    await row("c-mixed", A, OUT, [{ state: "done", daysAgo: 2 }]);
    expect((await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: false, nowIso: NOW })).clean).toBe(false);
    const partial = await eraseQueue(db, { scope: { kind: "ids", entries: [{ qitemId: "c-one", action: "delete" }] }, apply: false, nowIso: NOW, batchSize: 1, maxBatches: 0 });
    expect([partial.complete, partial.clean]).toEqual([false, false]);
  });
});

describe("round 1 controls", () => {
  it("J1: the events walk finds the same events whatever its window", async () => {
    await row("w-one", A, B, [{ state: "done", daysAgo: 40 }]);
    await row("w-two", A, B, [{ state: "done", daysAgo: 40 }]);
    const wide = await eraseQueue(db, { scope: { kind: "routine", contentDays: 30, metadataDays: 0 }, apply: false, nowIso: NOW });
    const narrow = await eraseQueue(db, { scope: { kind: "routine", contentDays: 30, metadataDays: 0 }, apply: true, nowIso: NOW, eventsWindow: 1 });
    expect(narrow.linked.events).toBe(wide.linked.events);
    expect(narrow.linked.events).toBeGreaterThanOrEqual(2);
    expect(payloads()).not.toContain("secret-w-");
  });

  it("J2: a linked copy held with someone outside the account is kept and reported, and the run isn't clean", async () => {
    await row("o-own", A, B, [{ state: "done", daysAgo: 2 }]);
    db.prepare(`INSERT INTO outbox_entries (outbox_id, sender_session, destination_session, body, ts_dispatched, audit_pointer)
      VALUES ('o-mixed', ?, ?, 'secret-mixed-copy', ?, 'o-own'), ('o-foreign', ?, ?, 'secret-foreign-copy', ?, 'o-own')`).run(A, OUT, NOW, OUT, OUT, NOW);
    const report = await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: true, nowIso: NOW });
    expect(report.keptCopies).toEqual(expect.arrayContaining([
      { table: "outbox_entries", id: "o-mixed", qitemId: "o-own", ownership: "mixed" },
      { table: "outbox_entries", id: "o-foreign", qitemId: "o-own", ownership: "foreign" },
    ]));
    expect(report.clean).toBe(false);
    const all = everything();
    expect(all).toContain("secret-mixed-copy");
    expect(all).toContain("secret-foreign-copy");
    expect(all).not.toContain("secret-o-own");
  });

  it("J3: a scrub clears closure notes in every copy and a duplicate reader action's reason, and keeps a successor id", async () => {
    await row("c-canceled", A, B);
    repo.update({ qitemId: "c-canceled", actorSession: B, state: "done", closureReason: "canceled", closureTarget: "secret-closure-note" });
    await row("c-handed", A, B);
    repo.update({ qitemId: "c-handed", actorSession: B, state: "done", closureReason: "handed_off_to", closureTarget: B });
    db.prepare("INSERT INTO stream_items (stream_item_id, ts_emitted, stream_sort_key, source_session, body) VALUES ('s-dup', ?, 'k', ?, 'x')").run(NOW, A);
    recordReaderAction(db, { streamItemId: "s-dup", readerSession: A, action: "duplicate", duplicateOf: "c-canceled", reason: "secret-dup-reason" }, NOW);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id IN ('c-canceled', 'c-handed')").run(ago(40));
    await eraseQueue(db, { scope: { kind: "routine", contentDays: 30, metadataDays: 0 }, apply: true, nowIso: NOW });
    const all = everything();
    expect(all).not.toContain("secret-closure-note");
    expect(all).not.toContain("secret-dup-reason");
    expect(db.prepare("SELECT closure_target AS t FROM queue_items WHERE qitem_id = 'c-handed'").get()).toEqual({ t: B });
  });

  it("J4: content written to a scrubbed row after its scrub is erased by the next run, and a reclose counts from the new close", async () => {
    await row("n-row", A, B, [{ state: "done", daysAgo: 40 }]);
    await eraseQueue(db, { scope: { kind: "routine", contentDays: 30, metadataDays: 0 }, apply: true, nowIso: NOW });
    repo.update({ qitemId: "n-row", actorSession: B, transitionNote: "secret-later-note" });
    const again = await eraseQueue(db, { scope: { kind: "routine", contentDays: 30, metadataDays: 0 }, apply: true, nowIso: NOW });
    expect(again.qitems.map((q) => q.qitemId)).toEqual(["n-row"]);
    expect(everything()).not.toContain("secret-later-note");
    repo.update({ qitemId: "n-row", actorSession: B, state: "pending", reopen: true, transitionNote: "secret-reopened" });
    repo.update({ qitemId: "n-row", actorSession: B, state: "done", closureReason: "no-follow-on" });
    const soon = await eraseQueue(db, { scope: { kind: "routine", contentDays: 30, metadataDays: 0 }, apply: true, nowIso: NOW });
    expect(soon.qitems).toEqual([]); // closed again just now: inside the window
    const later = new Date(Date.now() + 31 * 86_400_000).toISOString();
    const aged = await eraseQueue(db, { scope: { kind: "routine", contentDays: 30, metadataDays: 0 }, apply: true, nowIso: later });
    expect(aged.qitems.map((q) => q.qitemId)).toEqual(["n-row"]);
    expect(everything()).not.toContain("secret-reopened");
  });

  it("J5: a dry run and an apply agree when deleting a row frees a member's stream item", async () => {
    await row("s-row", A, B, [{ state: "done", daysAgo: 2 }]);
    db.prepare("INSERT INTO stream_items (stream_item_id, ts_emitted, stream_sort_key, source_session, body) VALUES ('s-act', ?, 'k', ?, 'secret-stream')").run(NOW, A);
    recordReaderAction(db, { streamItemId: "s-act", readerSession: B, action: "act", workQitemId: "s-row" }, NOW);
    const dry = await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: false, nowIso: NOW });
    const applied = await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: true, nowIso: NOW });
    expect({ ...applied, applied: false }).toEqual(dry);
    expect(dry.unlinked).toMatchObject({ streamItems: 1, referencedStreamItems: 0 });
    expect(everything()).not.toContain("secret-stream");
  });

  it("J8: a failure after a committed batch returns only what committed, and the sweep's other passes still run", async () => {
    await row("f-1", A, B, [{ state: "done", daysAgo: 2 }]);
    await row("f-2", A, B, [{ state: "done", daysAgo: 2 }]);
    db.exec("CREATE TEMP TRIGGER fail_f2 BEFORE DELETE ON queue_items WHEN old.qitem_id = 'f-2' BEGIN SELECT RAISE(ABORT, 'disk I/O error (test)'); END;");
    const report = await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: true, nowIso: NOW, batchSize: 1 });
    expect(report).toMatchObject({ complete: false, clean: false, error: { stage: "rows", message: "disk I/O error (test)" } });
    expect(report.qitems.map((q) => q.qitemId)).toEqual(["f-1"]);
    expect([exists("f-1"), exists("f-2")]).toEqual([false, true]);
    expect(report.linked.events).toBeGreaterThan(0);
    expect(payloads()).not.toContain('"qitemId":"f-1"');
    expect(payloads()).toContain('"qitemId":"f-2"');
    db.exec("CREATE TEMP TRIGGER fail_scrub BEFORE UPDATE OF content_erased_at ON queue_items BEGIN SELECT RAISE(ABORT, 'disk I/O error (test)'); END;");
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = 'f-2'").run(ago(40));
    const swept = await runQueueRetentionSweep(db, { nowIso: NOW, closedContentDays: 30, transitionsRetentionDays: 1 });
    expect(swept.closedError).toMatch(/disk I\/O error/);
    expect(swept.archivedQitems).toBeGreaterThan(0); // the transition archive still ran
  });
});

describe("round 1 controls: the account rig after removal, and a restore across a close", () => {
  const RIG = "rig-r1-id";
  beforeEach(() => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, 'n-acct')").run(RIG);
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('node-r1', ?, 'a.one')").run(RIG);
    new EventBus(db).emit({ type: "rig.imported", rigId: RIG, specName: "secret-r1-spec", specVersion: "1" } as never);
  });

  it("N2: refuses a rig with a session the members don't list", async () => {
    db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('sess-x', 'node-r1', ?)").run(OUT);
    await expect(eraseQueue(db, { scope: { kind: "members", members: [A, B], rig: RIG }, apply: false, nowIso: NOW }))
      .rejects.toMatchObject({ code: "erase_rig_mismatch" });
  });

  it("J6: after removal a name-bound workflow record is counted as left, and an unverified id erases nothing", async () => {
    db.pragma("foreign_keys = OFF");
    db.prepare(`INSERT INTO workflow_specs (spec_id, name, version, purpose, target_rig, roles_json, steps_json, coordination_terminal_turn_rule,
      source_path, source_hash, cached_at) VALUES ('spec-1', 's', '1', 'p', 'n-acct', '[]', '[]', 'hot_potato', '/x', 'h', ?)`).run(NOW);
    db.pragma("foreign_keys = ON");
    await eraseQueue(db, { scope: { kind: "members", members: [A, B], rig: RIG }, apply: true, nowIso: NOW });
    db.prepare("DELETE FROM nodes WHERE rig_id = ?").run(RIG);
    db.prepare("DELETE FROM rigs WHERE id = ?").run(RIG);
    new EventBus(db).emit({ type: "rig.deleted", rigId: RIG } as never);
    const rerun = await eraseQueue(db, { scope: { kind: "members", members: [A, B], rig: RIG }, apply: true, nowIso: NOW });
    expect(rerun.rig).toMatchObject({ found: false, verified: true, left: { workflow_specs: 1 }, unknown: [] });
    expect(rerun.clean).toBe(false);
    // Another removed rig's id, never verified with this membership: nothing keyed by it is erased.
    new EventBus(db).emit({ type: "rig.deleted", rigId: "rig-someone-else" } as never);
    const unverified = await eraseQueue(db, { scope: { kind: "members", members: [A, B], rig: "rig-someone-else" }, apply: true, nowIso: NOW });
    expect(unverified.rig).toMatchObject({ found: false, verified: false, left: { events: 1 }, unknown: ["workflow_instances", "workflow_specs"] });
    expect(unverified.clean).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE rig_id = 'rig-someone-else'").get()).toEqual({ n: 1 });
  });

  it("J7: a backup taken before a row closed is replayed from the ledger, and restored open work stays", async () => {
    const ledgerPath = join(mkdtempSync(join(tmpdir(), "erase-ledger-")), "ledger.jsonl");
    await row("l-row", A, B); // open when the backup is taken
    await row("l-open", A, B); // still open later
    const backup = db.serialize();
    repo.update({ qitemId: "l-row", actorSession: B, state: "done", closureReason: "no-follow-on" });
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = 'l-row'").run(ago(40));
    await eraseQueue(db, { scope: { kind: "routine", contentDays: 30, metadataDays: 0 }, apply: true, nowIso: NOW, ledgerPath });
    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { qitemId: string; action: "scrub"; batch: string });
    expect(lines).toEqual([{ qitemId: "l-row", action: "scrub", reason: "retention-content", erasedAt: NOW, batch: expect.any(String) },
      { batch: lines[0].batch, committed: true, at: NOW }]);
    db.close();
    open(new Database(backup));
    expect(everything()).toContain("secret-l-row body");
    await eraseQueue(db, { scope: { kind: "ids", entries: [lines[0]], commits: [{ batch: lines[0].batch, committed: true }] }, apply: true, nowIso: NOW });
    await eraseQueue(db, { scope: { kind: "routine", contentDays: 30, metadataDays: 0 }, apply: true, nowIso: NOW });
    const all = everything();
    expect(all).not.toContain("secret-l-row");
    expect(all).toContain("secret-l-open body");
  });
});

describe("round 2 controls", () => {
  const routine = { kind: "routine", contentDays: 30, metadataDays: 0 } as const;

  it("K1: a row reopened or taken up by a workflow after selection is kept and reported, with its events", async () => {
    await row("k-reopen", A, B, [{ state: "done", daysAgo: 100 }]);
    await row("k-workflow", A, B, [{ state: "done", daysAgo: 100 }]);
    await row("k-stays", A, B, [{ state: "done", daysAgo: 100 }]);
    // The run yields after each events window. With a window of 1, these writes land during the walk, after selection.
    const run = eraseQueue(db, { scope: { kind: "routine", contentDays: 30, metadataDays: 90 }, apply: true, nowIso: NOW, eventsWindow: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    repo.update({ qitemId: "k-reopen", actorSession: B, state: "pending", reopen: true, transitionNote: "back to work" });
    db.pragma("foreign_keys = OFF");
    db.prepare(`INSERT INTO workflow_frontier_bindings (instance_id, packet_id, step_id, created_at) VALUES ('wf-k', 'k-workflow', 's1', ?)`).run(NOW);
    db.pragma("foreign_keys = ON");
    const report = await run;
    expect(report.qitems.map((q) => q.qitemId)).toEqual(["k-stays"]);
    expect(report.gaps).toEqual(expect.arrayContaining([{ code: "changed-during-run", qitemId: "k-reopen" },
      { code: "workflow-reference", qitemId: "k-workflow" }]));
    expect(report.clean).toBe(false);
    expect(db.prepare("SELECT state, body FROM queue_items WHERE qitem_id = 'k-reopen'").get()).toEqual({ state: "pending", body: "secret-k-reopen body" });
    expect(marker("k-reopen")).toBeUndefined();
    expect(payloads()).toContain("secret-k-reopen");
    expect(payloads()).toContain("secret-k-workflow");
    expect([exists("k-workflow"), exists("k-stays")]).toEqual([true, false]);
  });

  it("K2: a ledger that can't be written stops the run before anything changes", async () => {
    await row("l-one", A, B, [{ state: "done", daysAgo: 2 }]);
    const before = everything();
    const ledgerPath = join(mkdtempSync(join(tmpdir(), "erase-ledger-")), "missing", "ledger.jsonl");
    const report = await eraseQueue(db, { scope: { kind: "ids", entries: [{ qitemId: "l-one", action: "delete" }, { qitemId: "l-gone", action: "delete" }] },
      apply: true, nowIso: NOW, ledgerPath });
    expect(report).toMatchObject({ complete: false, clean: false, error: { stage: "ledger" }, qitems: [], alreadyAbsent: [] });
    expect(everything()).toBe(before);
    expect(payloads()).toContain("secret-l-one");
  });

  it("K3, L3: an event that names a row but can't be read is reported with its row kept, on every rerun until it's resolved", async () => {
    await row("u-row", A, B, [{ state: "done", daysAgo: 2 }]);
    await row("u-other", A, B, [{ state: "done", daysAgo: 2 }]);
    const bad = db.prepare("INSERT INTO events (type, payload) VALUES ('queue.updated', ?)").run('{"qitemId":"u-row","summary":"secret-truncated');
    const dry = await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: false, nowIso: NOW });
    const report = await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: true, nowIso: NOW });
    expect({ ...report, applied: false }).toEqual(dry);
    expect(report.unreadableEvents).toEqual([{ seq: Number(bad.lastInsertRowid), qitemIds: ["u-row"] }]);
    expect(report.gaps).toEqual([{ code: "unreadable-event", qitemId: "u-row" }]);
    expect([report.complete, report.clean]).toEqual([true, false]);
    expect([exists("u-row"), exists("u-other")]).toEqual([true, false]);
    // An identical rerun (after a lost response, say) finds it again.
    const again = await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: true, nowIso: NOW });
    expect(again.unreadableEvents).toEqual(report.unreadableEvents);
    expect(again.clean).toBe(false);
    expect(payloads()).toContain("secret-truncated");
    // Once the event is resolved, the next run erases the row and is clean.
    db.prepare("DELETE FROM events WHERE seq = ?").run(bad.lastInsertRowid);
    const resolved = await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: true, nowIso: NOW });
    expect([resolved.clean, exists("u-row")]).toEqual([true, false]);
  });

  it("K4: a successor reason keeps its target only when it names a session or a queue row", async () => {
    await row("t-prose", A, B);
    repo.update({ qitemId: "t-prose", actorSession: B, state: "done", closureReason: "handed_off_to", closureTarget: "secret-prose-target, see the thread" });
    await row("t-super", A, B);
    repo.update({ qitemId: "t-super", actorSession: B, state: "canceled", closureReason: "superseded", closureTarget: "qitem-successor-row" });
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id IN ('t-prose', 't-super')").run(ago(40));
    const report = await eraseQueue(db, { scope: routine, apply: true, nowIso: NOW });
    expect(report.qitems.map((q) => q.qitemId)).toEqual(["t-prose", "t-super"]);
    expect(everything()).not.toContain("secret-prose-target");
    expect(payloads()).not.toContain("secret-prose-target");
    expect(db.prepare("SELECT closure_target AS t FROM queue_items WHERE qitem_id = 't-super'").get()).toEqual({ t: "qitem-successor-row" });
  });

  it("N1: a note archived while erasure was off still makes a scrubbed row eligible again", async () => {
    await row("v-row", A, B, [{ state: "done", daysAgo: 40 }]);
    await eraseQueue(db, { scope: routine, apply: true, nowIso: NOW });
    repo.update({ qitemId: "v-row", actorSession: B, transitionNote: "secret-archived-note" });
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await runQueueRetentionSweep(db, { nowIso: later, transitionsRetentionDays: 1 });
    const note = "SELECT COUNT(*) AS n FROM %s WHERE transition_note = 'secret-archived-note'";
    expect([db.prepare(note.replace("%s", "queue_transitions")).get(), db.prepare(note.replace("%s", "queue_transitions_archive")).get()])
      .toEqual([{ n: 0 }, { n: 1 }]);
    const again = await eraseQueue(db, { scope: routine, apply: true, nowIso: later });
    expect(again.qitems.map((q) => q.qitemId)).toEqual(["v-row"]);
    expect(everything()).not.toContain("secret-archived-note");
  });

  it("N2: a dry run and an apply count the same mixed entries when a kept copy points at an erased row", async () => {
    await row("m-row", A, B, [{ state: "done", daysAgo: 2 }]);
    db.prepare(`INSERT INTO outbox_entries (outbox_id, sender_session, destination_session, body, ts_dispatched, audit_pointer)
      VALUES ('o-m', ?, ?, 'secret-m-copy', ?, 'm-row')`).run(A, OUT, NOW);
    const dry = await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: false, nowIso: NOW });
    const applied = await eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: true, nowIso: NOW });
    expect({ ...applied, applied: false }).toEqual(dry);
    expect(dry.keptCopies).toEqual([{ table: "outbox_entries", id: "o-m", qitemId: "m-row", ownership: "mixed" }]);
    expect(dry.unlinked).toMatchObject({ mixedEntries: 0 });
  });
});

describe("round 3 controls", () => {
  // The run yields after each events window. With a window of 1, a write queued now lands during the walk, after
  // selection and before the batches.
  const duringWalk = () => new Promise((resolve) => setImmediate(resolve));

  it("L1: a row rerouted out of the account after selection is kept with its events and reported", async () => {
    await row("l1-moved", A, B, [{ state: "done", daysAgo: 2 }]);
    await row("l1-stays", A, B, [{ state: "done", daysAgo: 2 }]);
    const run = eraseQueue(db, { scope: { kind: "members", members: [A, B] }, apply: true, nowIso: NOW, eventsWindow: 1 });
    await duringWalk();
    repo.routeToFallback("l1-moved", OUT, "owner unavailable");
    const report = await run;
    expect(report.qitems.map((q) => q.qitemId)).toEqual(["l1-stays"]);
    expect(report.gaps).toEqual([{ code: "changed-during-run", qitemId: "l1-moved" }]);
    expect(report.clean).toBe(false);
    expect(db.prepare("SELECT destination_session AS d, body FROM queue_items WHERE qitem_id = 'l1-moved'").get())
      .toEqual({ d: OUT, body: "secret-l1-moved body" });
    expect(marker("l1-moved")).toBeUndefined();
    expect(payloads()).toContain("secret-l1-moved");
  });

  it("L2: an id absent at selection but created during the run is reported, never certified absent", async () => {
    await row("l2-old", A, B, [{ state: "done", daysAgo: 2 }]);
    const run = eraseQueue(db, { scope: { kind: "ids", entries: [{ qitemId: "l2-new", action: "delete" }, { qitemId: "l2-old", action: "delete" }] },
      apply: true, nowIso: NOW, eventsWindow: 1 });
    await duringWalk();
    await repo.create({ qitemId: "l2-new", sourceSession: A, destinationSession: B, body: "secret-l2-new body" });
    const report = await run;
    expect(report.qitems.map((q) => q.qitemId)).toEqual(["l2-old"]);
    expect(report.alreadyAbsent).toEqual([]);
    expect(report.gaps).toEqual([{ code: "changed-during-run", qitemId: "l2-new" }]);
    expect(report.clean).toBe(false);
    expect(marker("l2-new")).toBeUndefined();
    expect(everything()).toContain("secret-l2-new body");
  });
});
