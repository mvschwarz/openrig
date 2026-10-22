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
    "leaves a %s wake intent to the one startup drain", async (state) => {
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
      db.prepare("UPDATE queue_items SET ts_created = '2000-01-01T00:00:00.000Z' WHERE qitem_id = ?").run(packet.qitemId);
      const log: string[] = [];
      const ensureStuckExceptionItem = vi.fn(async () => ({ outcome: "created" as const, qitemId: "exception" }));

      // Startup reconciles prior-process claims before current producers, then drains after the sweep.
      repo.reconcileAbandonedWakeIntents();
      const result = await runWorkflowBootSweep({ instanceStore: instances, queueRepo: repo,
        watchdogJobsRepo: new WatchdogJobsRepository(db), log: line => log.push(line), ensureStuckExceptionItem });
      await repo.drainPendingWakeIntents();

      const retryable = ["pending", "sending", "indeterminate", "failed"].includes(state);
      expect(send).toHaveBeenCalledTimes(retryable ? 1 : 0);
      expect(result).toMatchObject({ lostNudgeRecoveryAttempts: 1, stuckSurfaced: 1, exceptionItemsCreated: 1 });
      expect(log.at(-1)).toContain("1 lost-nudge recovery attempt(s)");
      expect(log.at(-1)).not.toContain("reissued");
      expect(ensureStuckExceptionItem).toHaveBeenCalledOnce();
      expect(outbox.getById(id)?.deliveryState).toBe(retryable ? "delivered" : state);
      if (retryable) expect(send.mock.calls[0]?.[2]).toMatchObject({ committedOutboxIds: [id] });
    },
  );

  it.each(["failed", "indeterminate"].flatMap(state => ["pending", "in-progress"].map(packetState => ({ state, packetState }))))("overdue recovery keeps a prior $state attempt with the durable intent owner (packet: $packetState)", async ({ state, packetState }) => {
    const db = new Database(":memory:"); databases.push(db); migrate(db, ALL_MIGRATIONS);
    db.exec("INSERT INTO rigs(id,name) VALUES ('rig','test')");
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    const outbox = new OutboxHandler(db); repo.attachOutbox(outbox);
    const packet = await repo.create({ sourceSession: "lead@test", destinationSession: "worker@test", body: "work", nudge: false });
    repo.stageWakeIntent(packet.qitemId, "lead@test", "worker@test");
    const id = WAKE_INTENT_PREFIX + packet.qitemId, frozen = outbox.getById(id)!.body;
    const send = vi.fn(async (_session: string, _text: string, _opts?: SendOpts) => state === "failed" ? { ok: false, sent: false, error: "unavailable" } : { ok: true, verified: false });
    repo.attachTransport({ send });
    await repo.deliverWakeForSuccessor(packet.qitemId, "worker@test", "lead@test");
    expect(repo.getById(packet.qitemId)!.lastNudgeAttempt).not.toBeNull();
    expect(outbox.getById(id)!.deliveryState).toBe(state);
    send.mockReset(); send.mockResolvedValue({ ok: true, verified: true });
    if (packetState === "in-progress") {
      repo.claim({ qitemId: packet.qitemId, destinationSession: "worker@test" });
      db.prepare("UPDATE queue_items SET claimed_at='2000-01-01T00:00:00Z',closure_required_at=NULL WHERE qitem_id=?").run(packet.qitemId);
    }
    const instances = new WorkflowInstanceStore(db);
    instances.create({ workflowName: "recovery", workflowVersion: "1", createdBySession: "lead@test", initialFrontier: [packet.qitemId], currentStepId: "work" });
    db.prepare("UPDATE queue_items SET ts_created='2000-01-01T00:00:00Z',last_nudge_attempt='2000-01-01T00:00:00Z' WHERE qitem_id=?").run(packet.qitemId);
    await runWorkflowBootSweep({ instanceStore: instances, queueRepo: repo, watchdogJobsRepo: new WatchdogJobsRepository(db) });
    await repo.drainPendingWakeIntents();
    expect(send).toHaveBeenCalledTimes(1);
    if (packetState === "pending") expect(send.mock.calls[0]?.[1]).toContain(frozen);
    expect(outbox.getById(id)!.deliveryState).toBe(packetState === "pending" ? "delivered" : state);
  });

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
    expect(result).toMatchObject({ lostNudgeRecoveryAttempts: 1, stuckSurfaced: 1 });
    expect(ensureStuckExceptionItem).toHaveBeenCalledOnce();
  });
});
