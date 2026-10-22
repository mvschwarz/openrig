// SWEEP-a (shape f2576102) — closure/blocked-field coherence: an accept-path either
// takes effect or fails LOUD; incoherent fields NEVER silently persist.
// Admits-map (CORRECTED from live schema use — the workflow park writers pass
// state:"blocked"+closureReason:"blocked_on" at workflow-runtime.ts:587/1013):
// closure_reason/target admit on done with a terminal reason, OR on blocked when
// closureReason==="blocked_on" (the park-record form); blocked_on admits only on blocked.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { OutboxHandler } from "../src/domain/outbox-handler.js";

describe("SWEEP-a — closure/blocked coherence guard", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let id: string;

  beforeEach(async () => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, inboxEntriesSchema, outboxEntriesSchema, queueTargetRepoSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
    id = (await repo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "x" } as never)).qitemId;
  });
  afterEach(() => db.close());

  it("closure_reason on state=in-progress REJECTS loud, nothing persisted", async () => {
    let err: unknown;
    try { await repo.update({ qitemId: id, actorSession: "a@rig", state: "in-progress", closureReason: "denied" } as never); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(QueueRepositoryError);
    expect((err as QueueRepositoryError).code).toBe("closure_fields_not_admitted");
    expect(repo.getById(id)!.closureReason).toBeNull(); // NO write
    expect(repo.getById(id)!.state).toBe("pending");
  });

  it("blocked_on on state=done REJECTS loud", async () => {
    let err: unknown;
    try { await repo.update({ qitemId: id, actorSession: "a@rig", state: "done", closureReason: "canceled", blockedOn: "x@rig" } as never); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(QueueRepositoryError);
    expect((err as QueueRepositoryError).code).toBe("blocked_on_not_admitted");
    expect(repo.getById(id)!.state).toBe("pending"); // the whole update rejected
  });

  it("rejects done + blocked_on without changing work, transitions, events or wakes", async () => {
    const child = (await repo.create({ sourceSession: "b@rig", destinationSession: "c@rig", body: "child" })).qitemId;
    const dependent = (await repo.create({ sourceSession: "d@rig", destinationSession: "e@rig", body: "waiting on the parent" })).qitemId;
    repo.update({ qitemId: dependent, actorSession: "e@rig", state: "blocked", blockedOn: id });
    repo.claim({ qitemId: id, destinationSession: "b@rig" });
    const notified = vi.fn();
    bus.subscribe(notified);
    const send = vi.fn().mockResolvedValue({ ok: true, verified: true });
    repo.attachTransport({ send });
    repo.attachOutbox(new OutboxHandler(db));
    const snapshot = () => ({
      items: db.prepare("SELECT * FROM queue_items ORDER BY qitem_id").all(),
      transitions: db.prepare("SELECT * FROM queue_transitions ORDER BY transition_id").all(),
      events: db.prepare("SELECT * FROM events ORDER BY seq").all(),
      outbox: db.prepare("SELECT * FROM outbox_entries ORDER BY outbox_id").all(),
    });
    const before = snapshot();

    let err: unknown;
    try {
      repo.update({ qitemId: id, actorSession: "b@rig", state: "done", closureReason: "blocked_on", closureTarget: child,
        transitionNote: "wait for child", resolution: "unfinished work" });
    } catch (e) { err = e; }
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(err).toBeInstanceOf(QueueRepositoryError);
    expect((err as QueueRepositoryError).code).toBe("invalid_closure_reason");
    expect((err as Error).message).toMatch(/state=done.*terminal/);
    expect((err as Error).message).toContain("rig queue block <id> --on <child>");
    expect(snapshot()).toEqual(before);
    expect(repo.listOpenObligations("b@rig", 10).some((row) => row.qitemId === id)).toBe(true);
    expect(repo.getById(dependent)).toMatchObject({ state: "blocked", blockedOn: id });
    expect(notified).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects done + blocked_on on an already-done row with the same correction", () => {
    repo.update({ qitemId: id, actorSession: "b@rig", state: "done", closureReason: "no-follow-on" });
    const before = repo.getById(id);
    const transitions = db.prepare("SELECT * FROM queue_transitions WHERE qitem_id = ?").all(id);
    const events = db.prepare("SELECT * FROM events ORDER BY seq").all();

    let err: unknown;
    try {
      repo.update({ qitemId: id, actorSession: "b@rig", state: "done", closureReason: "blocked_on", closureTarget: "qitem-child" });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(QueueRepositoryError);
    expect((err as QueueRepositoryError).code).toBe("invalid_closure_reason");
    expect((err as Error).message).toContain("state=done is terminal");
    expect((err as Error).message).toContain("rig queue block <id> --on <child>");
    expect(repo.getById(id)).toEqual(before);
    expect(db.prepare("SELECT * FROM queue_transitions WHERE qitem_id = ?").all(id)).toEqual(transitions);
    expect(db.prepare("SELECT * FROM events ORDER BY seq").all()).toEqual(events);
  });

  it("a blocked_on park record stays open and returns to pending when its blocker completes", async () => {
    const child = (await repo.create({ sourceSession: "b@rig", destinationSession: "c@rig", body: "child" })).qitemId;
    repo.claim({ qitemId: id, destinationSession: "b@rig" });

    repo.update({ qitemId: id, actorSession: "b@rig", state: "blocked", closureReason: "blocked_on", closureTarget: child, blockedOn: child });
    expect(repo.getById(id)).toMatchObject({ state: "blocked", closureReason: "blocked_on", closureTarget: child, blockedOn: child });
    expect(repo.listOpenObligations("b@rig", 10).some((row) => row.qitemId === id)).toBe(true);

    repo.update({ qitemId: child, actorSession: "c@rig", state: "done", closureReason: "no-follow-on" });
    expect(repo.getById(id)).toMatchObject({ state: "pending", blockedOn: null });
    expect(repo.listOpenObligations("b@rig", 10).some((row) => row.qitemId === id)).toBe(true);
  });

  it("CONTROL: done+closure stays green; the blocked park-record form stays green (workflow writers)", async () => {
    await repo.update({ qitemId: id, actorSession: "a@rig", state: "blocked", closureReason: "blocked_on", closureTarget: "gate@rig", blockedOn: "gate@rig" } as never);
    expect(repo.getById(id)!.state).toBe("blocked");
    expect(repo.getById(id)!.blockedOn).toBe("gate@rig");
    await repo.update({ qitemId: id, actorSession: "a@rig", state: "done", closureReason: "no-follow-on" } as never);
    expect(repo.getById(id)!.state).toBe("done");
  });
});
