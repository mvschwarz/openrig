// 51-06 atom D2 — non-persistable queue update metadata (summary/evidence_ref) must HARD-REJECT
// BEFORE any mutation, per the Guard-bound design (no post-commit marker; reject-before-write).
// Migration-faithful: the canonical queue set PLUS 044 (summary) + 048 (evidence_ref) so a drop is
// provably the non-park rule, NOT a missing column (the test-suite parity gap this atom flags).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { inboxEntriesSchema } from "../src/db/migrations/026_inbox_entries.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { queueRoutes } from "../src/routes/queue.js";

const REJECT_CODE = "summary_evidence_not_persistable";

function buildApp(bus: EventBus, queueRepo: QueueRepository): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("eventBus" as never, bus); c.set("queueRepo" as never, queueRepo); await next(); });
  app.route("/api/queue", queueRoutes());
  return app;
}

describe("51-06 D2 — non-park queue update metadata reject", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, inboxEntriesSchema, outboxEntriesSchema, queueTargetRepoSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
    app = buildApp(bus, repo);
  });
  afterEach(() => db.close());

  const mkItem = async () => (await repo.create({ sourceSession: "orch@rig", destinationSession: "dev-x@rig", body: "d2 item" })).qitemId;
  const txnCount = (id: string) => (db.prepare("SELECT count(*) c FROM queue_transitions WHERE qitem_id = ?").get(id) as { c: number }).c;
  const eventCount = () => (db.prepare("SELECT count(*) c FROM events").get() as { c: number }).c;

  async function expectRejectZeroMutation(input: Record<string, unknown>, invalidFields: string[]) {
    const id = await mkItem();
    const beforeState = repo.getByIdOrThrow(id).state;
    const beforeTxns = txnCount(id);
    const beforeEvents = eventCount();
    let err: unknown;
    try { repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "in-progress", ...input }); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(QueueRepositoryError);
    expect((err as QueueRepositoryError).code).toBe(REJECT_CODE);
    expect((err as QueueRepositoryError).meta?.invalidFields).toEqual(invalidFields);
    // zero mutation: no UPDATE (state), no log (transition), no event
    expect(repo.getByIdOrThrow(id).state).toBe(beforeState);
    expect(txnCount(id)).toBe(beforeTxns);
    expect(eventCount()).toBe(beforeEvents);
  }

  it("rejects --summary on a non-park transition, before any mutation", async () => {
    await expectRejectZeroMutation({ summary: "DROPME" }, ["summary"]);
  });
  it("rejects --evidence-ref on a non-park transition, before any mutation", async () => {
    await expectRejectZeroMutation({ evidenceRef: "/proof/x.md" }, ["evidenceRef"]);
  });
  it("rejects BOTH, naming both invalidFields, before any mutation", async () => {
    await expectRejectZeroMutation({ summary: "S", evidenceRef: "/e" }, ["summary", "evidenceRef"]);
  });
  it("treats empty-string as PRESENT (null=absent, ''=present) -> rejects", async () => {
    await expectRejectZeroMutation({ summary: "" }, ["summary"]);
  });

  it("also rejects on a terminal non-park transition (in-progress -> done + closure)", async () => {
    const id = await mkItem();
    repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "in-progress" }); // claim (metadata-free, ok)
    let err: unknown;
    try { repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "done", closureReason: "no-follow-on", summary: "S" }); }
    catch (e) { err = e; }
    expect((err as QueueRepositoryError).code).toBe(REJECT_CODE);
    expect(repo.getByIdOrThrow(id).state).toBe("in-progress"); // unchanged by the rejected close
  });

  it("metadata-free non-park update is UNCHANGED (null=absent, no reject)", async () => {
    const id = await mkItem();
    const res = repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "in-progress", summary: null, evidenceRef: null });
    expect(res.state).toBe("in-progress");
  });

  it("CONTROL: human-seat park still PERSISTS summary + evidence byte-for-byte", async () => {
    const id = await mkItem();
    const res = repo.update({ qitemId: id, actorSession: "orch@rig", state: "blocked", blockedOn: "human@kernel", summary: "PARK-KEEP", evidenceRef: "/proof/park.md" });
    expect(res.summary).toBe("PARK-KEEP");
    expect(res.evidenceRef).toBe("/proof/park.md");
  });

  it("ROUTE: POST /:id/update non-park + summary -> HTTP 400 naming invalidFields", async () => {
    // P21 I3: create/update derive the sender from the transport header; header==body claim ⇒ tolerated.
    const created = await app.request("/api/queue/create", { method: "POST", headers: { "content-type": "application/json", "X-OpenRig-Session": "orch@rig" }, body: JSON.stringify({ sourceSession: "orch@rig", destinationSession: "dev-x@rig", body: "r" }) });
    const id = ((await created.json()) as { qitemId: string }).qitemId;
    const res = await app.request(`/api/queue/${id}/update`, { method: "POST", headers: { "content-type": "application/json", "X-OpenRig-Session": "dev-x@rig" }, body: JSON.stringify({ actorSession: "dev-x@rig", state: "in-progress", summary: "DROPME" }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; invalidFields?: string[] };
    expect(body.error).toBe(REJECT_CODE);
    expect(body.invalidFields).toEqual(["summary"]);
  });
});
