/**
 * Stage 1 contract 4 extract — submit → canonical QueueRepository → same qitem closed.
 * Does not claim to replace the full product queue; proves one work-item lifecycle.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import {
  CanonicalQueuePath,
  CanonicalQueuePathError,
} from "../src/domain/canonical-queue-path.js";

describe("Contract 4 — canonical queue path (one work item lifecycle)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queue: QueueRepository;
  let path: CanonicalQueuePath;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    queue = new QueueRepository(db, bus, { validateRig: () => true });
    path = new CanonicalQueuePath(queue);
  });

  afterEach(() => db.close());

  it("submit creates a canonical queue task; executor claim+complete closes THAT same item", async () => {
    const sub = await path.submit({
      summary: "one lifecycle",
      sourceSession: "submitter@dev",
      destinationSession: "executor@dev",
    });

    const pending = path.get(sub.qitemId);
    expect(pending).not.toBeNull();
    expect(pending!.state).toBe("pending");
    expect(pending!.destinationSession).toBe("executor@dev");

    const claimed = path.claimAsExecutor(sub.qitemId, "executor@dev");
    expect(claimed.state).toBe("in-progress");

    const correlationId = "result-receipt-abc";
    const done = path.complete({
      qitemId: sub.qitemId,
      actorSession: "executor@dev",
      correlationId,
    });

    expect(done.state).toBe("done");
    expect(done.closureTarget).toBe(correlationId);
    expect(done.qitemId).toBe(sub.qitemId);

    const transitions = queue.listTransitions(sub.qitemId);
    expect(
      transitions.some((t) => (t.transitionNote ?? "").includes(correlationId)),
    ).toBe(true);

    const matching = queue
      .list({ destinationSession: "executor@dev" })
      .filter((q) => q.qitemId === sub.qitemId);
    expect(matching).toHaveLength(1);
  });

  it("without QueueRepository, path refuses — EventBus alone is not the queue", async () => {
    const unwired = new CanonicalQueuePath(null);
    await expect(
      unwired.submit({
        summary: "events only",
        sourceSession: "a@dev",
        destinationSession: "b@dev",
      }),
    ).rejects.toMatchObject({ code: "queue_not_wired" });

    expect(() => unwired.get("qitem-nope")).toThrow(CanonicalQueuePathError);
    expect(() => unwired.claimAsExecutor("qitem-nope", "b@dev")).toThrow(
      /QueueRepository/,
    );

    // A live EventBus with zero QueueRepository writes still has zero queue rows.
    expect(queue.list({ destinationSession: "b@dev" })).toHaveLength(0);
  });
});
