// SWEEP-a (shape f2576102) — closure/blocked-field coherence: an accept-path either
// takes effect or fails LOUD; incoherent fields NEVER silently persist.
// Admits-map (CORRECTED from live schema use — the workflow park writers pass
// state:"blocked"+closureReason:"blocked_on" at workflow-runtime.ts:587/1013):
// closure_reason/target admit on done, OR on blocked when closureReason==="blocked_on"
// (the park-record form); blocked_on admits only on state blocked. Surfaced to PM.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

describe("SWEEP-a — closure/blocked coherence guard", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let id: string;

  beforeEach(async () => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, inboxEntriesSchema, outboxEntriesSchema, queueTargetRepoSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
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

  it("CONTROL: done+closure stays green; the blocked park-record form stays green (workflow writers)", async () => {
    await repo.update({ qitemId: id, actorSession: "a@rig", state: "blocked", closureReason: "blocked_on", closureTarget: "gate@rig", blockedOn: "gate@rig" } as never);
    expect(repo.getById(id)!.state).toBe("blocked");
    expect(repo.getById(id)!.blockedOn).toBe("gate@rig");
    await repo.update({ qitemId: id, actorSession: "a@rig", state: "done", closureReason: "no-follow-on" } as never);
    expect(repo.getById(id)!.state).toBe("done");
  });
});
