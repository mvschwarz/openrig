import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler, WAKE_INTENT_PREFIX } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import type { SendOpts } from "../src/domain/session-transport.js";
import { WorkflowInstanceStore } from "../src/domain/workflow-instance-store.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { runWorkflowBootSweep } from "../src/domain/workflow-boot-sweep.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe("workflow boot recovery with durable wake intents", () => {
  it.each(["pending", "sending", "indeterminate", "delivered", "retained", "failed", "retired"] as const)(
    "does not bypass a %s wake intent before the startup drain", async (state) => {
      const db = new Database(":memory:");
      databases.push(db);
      migrate(db, ALL_MIGRATIONS);
      db.exec("INSERT INTO rigs(id, name) VALUES ('rig', 'test')");
      const bus = new EventBus(db);
      const outbox = new OutboxHandler(db);
      const repo = new QueueRepository(db, bus, { validateRig: () => true });
      repo.attachOutbox(outbox);
      const packet = await repo.create({ sourceSession: "lead@test", destinationSession: "worker@test", body: "work", nudge: false });
      const instances = new WorkflowInstanceStore(db);
      instances.create({ workflowName: "recovery", workflowVersion: "1", createdBySession: "lead@test", initialFrontier: [packet.qitemId], currentStepId: "work" });
      db.transaction(() => repo.stageWakeIntent(packet.qitemId, "lead@test", "worker@test"))();
      const id = `${WAKE_INTENT_PREFIX}${packet.qitemId}`;
      db.prepare("UPDATE outbox_entries SET delivery_state = ? WHERE outbox_id = ?").run(state, id);
      const send = vi.fn(async (_session: string, _text: string, _opts?: SendOpts) => ({ ok: true, verified: true }));
      repo.attachTransport({ send });

      // This is startup.ts's order: workflow sweep, abandoned-claim reconciliation, intent drain.
      await runWorkflowBootSweep({ instanceStore: instances, queueRepo: repo, watchdogJobsRepo: new WatchdogJobsRepository(db) });
      repo.reconcileAbandonedWakeIntents();
      await repo.drainPendingWakeIntents();

      expect(send).toHaveBeenCalledTimes(state === "pending" ? 1 : 0);
      expect(outbox.getById(id)?.deliveryState).toBe(state === "pending" ? "delivered" : state === "sending" ? "indeterminate" : state);
      if (state === "pending") expect(send.mock.calls[0]?.[2]).toMatchObject({ committedOutboxIds: [id] });
    },
  );

  it.each([false, true])("recovers legacy packets without an intent (outbox attached: %s), once even when overdue", async (attachOutbox) => {
    const db = new Database(":memory:");
    databases.push(db);
    migrate(db, ALL_MIGRATIONS);
    db.exec("INSERT INTO rigs(id, name) VALUES ('rig', 'test')");
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    if (attachOutbox) repo.attachOutbox(new OutboxHandler(db));
    const packet = await repo.create({ sourceSession: "lead@test", destinationSession: "worker@test", body: "work", nudge: false });
    db.prepare("UPDATE queue_items SET ts_created = '2000-01-01T00:00:00.000Z' WHERE qitem_id = ?").run(packet.qitemId);
    const instances = new WorkflowInstanceStore(db);
    instances.create({ workflowName: "recovery", workflowVersion: "1", createdBySession: "lead@test", initialFrontier: [packet.qitemId], currentStepId: "work" });
    const send = vi.fn(async () => ({ ok: true, verified: true }));
    repo.attachTransport({ send });
    const ensureStuckExceptionItem = vi.fn(async () => ({ outcome: "deduped" as const, qitemId: "existing-exception" }));

    const result = await runWorkflowBootSweep({ instanceStore: instances, queueRepo: repo, watchdogJobsRepo: new WatchdogJobsRepository(db), ensureStuckExceptionItem });

    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ lostNudgesReissued: 1, stuckSurfaced: 1 });
    expect(ensureStuckExceptionItem).toHaveBeenCalledOnce();
  });
});
