import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { InboxHandler } from "../src/domain/inbox-handler.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { QueueTransitionLog } from "../src/domain/queue-transition-log.js";
import { eraseQueue } from "../src/domain/queue-erasure.js";
import { runQueueRetentionSweep } from "../src/domain/queue-retention.js";
import { queueRoutes } from "../src/routes/queue.js";

const NOW = "2026-11-09T12:00:00.000Z";
const ago = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
const A = "a-one@n-acct";
const B = "b-two@n-acct";
const OUT = "x-other@n-else";

let db: Database.Database;
let repo: QueueRepository;
let log: QueueTransitionLog;
beforeEach(() => {
  db = createDb();
  migrate(db, ALL_MIGRATIONS);
  repo = new QueueRepository(db, new EventBus(db));
  repo.attachOutbox(new OutboxHandler(db));
  log = new QueueTransitionLog(db);
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
    await eraseQueue(db, { scope: { kind: "ids", ids: ["i-one"], action: "delete" }, apply: true, nowIso: NOW });
    // A restore from a backup taken before the erase brings the row back and loses the marker.
    db.prepare("DELETE FROM queue_erased_ids").run();
    await row("i-one", A, B, [{ state: "done", daysAgo: 3 }]);
    const reapplied = await eraseQueue(db, { scope: { kind: "ids", ids: ["i-one", "i-gone"], action: "delete" }, apply: true, nowIso: NOW });
    expect(reapplied.qitems.map((q) => q.qitemId)).toEqual(["i-one"]);
    expect(reapplied.alreadyAbsent).toEqual(["i-gone"]);
    expect(exists("i-one")).toBe(false);
    expect(everything()).not.toContain("secret-i-one");
    expect(marker("i-one")).toMatchObject({ reason: "erase-by-id" });
    expect(marker("i-gone")).toMatchObject({ reason: "erase-by-id" });
  });

  it("a scrub of an unknown id is reported, not invented", async () => {
    const report = await eraseQueue(db, { scope: { kind: "ids", ids: ["nope"], action: "scrub" }, apply: true, nowIso: NOW });
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

  it("routine reads this daemon's own windows", async () => {
    await row("p-old", A, B, [{ state: "done", daysAgo: 40 }]);
    const res = await post(app({ "retention.closed_content_days": 30 }), { routine: true, apply: true });
    expect(await res.json()).toMatchObject({ routine: { contentDays: 30, metadataDays: 0 }, qitems: [{ qitemId: "p-old", action: "scrub" }] });
  });
});
