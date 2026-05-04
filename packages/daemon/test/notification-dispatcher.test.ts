import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlNotificationDispatcher } from "../src/domain/mission-control/notification-dispatcher.js";
import type {
  NotificationAdapter,
  NotificationDeliveryResult,
  NotificationPayload,
} from "../src/domain/mission-control/notification-adapter-types.js";

class FakeAdapter implements NotificationAdapter {
  readonly mechanism = "fake";
  readonly target = "fake://test";
  calls: NotificationPayload[] = [];
  nextResult: NotificationDeliveryResult = { ok: true, ack: "fake-ok" };
  async send(payload: NotificationPayload): Promise<NotificationDeliveryResult> {
    this.calls.push(payload);
    return this.nextResult;
  }
}

describe("MissionControlNotificationDispatcher (PL-005 Phase B)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let adapter: FakeAdapter;
  let dispatcher: MissionControlNotificationDispatcher;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, missionControlActionsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    adapter = new FakeAdapter();
    dispatcher = new MissionControlNotificationDispatcher({ db, eventBus: bus, adapter });
    dispatcher.start();
  });

  afterEach(() => {
    dispatcher.stop();
    db.close();
  });

  it("dispatches on human-gate qitem arrival (mandatory trigger)", async () => {
    await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human-wrandom@kernel",
      body: "needs human approval",
      tier: "human-gate",
    });
    // Yield event loop so dispatcher's async handler completes.
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.title).toContain("human-gate");
    expect(adapter.calls[0]!.tags).toContain("human-gate");
  });

  it("does NOT dispatch on non-human-gate qitem arrival", async () => {
    await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "agent@rig",
      body: "agent task",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.calls).toHaveLength(0);
  });

  it("does NOT dispatch on action_executed by default (verb-completion opt-in)", async () => {
    const created = await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human@rig",
      body: "x",
      tier: "human-gate",
    });
    await new Promise((r) => setTimeout(r, 10));
    adapter.calls.length = 0;
    const actionLog = new MissionControlActionLog(db);
    const writeContract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo, actionLog });
    await writeContract.act({ verb: "approve", qitemId: created.qitemId, actorSession: "human@rig" });
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.calls).toHaveLength(0);
  });

  it("DOES dispatch on action_executed when includeVerbCompletion=true", async () => {
    dispatcher.stop();
    const dispatcher2 = new MissionControlNotificationDispatcher({
      db,
      eventBus: bus,
      adapter,
      includeVerbCompletion: true,
    });
    dispatcher2.start();
    const created = await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human@rig",
      body: "x",
      tier: "human-gate",
    });
    await new Promise((r) => setTimeout(r, 10));
    adapter.calls.length = 0;
    const actionLog = new MissionControlActionLog(db);
    const writeContract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo, actionLog });
    await writeContract.act({ verb: "approve", qitemId: created.qitemId, actorSession: "human@rig" });
    await new Promise((r) => setTimeout(r, 10));
    const verbCalls = adapter.calls.filter((c) => c.title.includes("verb completed"));
    expect(verbCalls).toHaveLength(1);
    dispatcher2.stop();
  });

  it("emits mission_control.notification_sent on success", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human@rig",
      body: "x",
      tier: "human-gate",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(events.find((e) => e.type === "mission_control.notification_sent")).toBeDefined();
  });

  it("emits mission_control.notification_failed when adapter returns ok=false (best-effort; underlying action proceeds)", async () => {
    adapter.nextResult = { ok: false, error: "ntfy POST 503" };
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const created = await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human@rig",
      body: "x",
      tier: "human-gate",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(events.find((e) => e.type === "mission_control.notification_failed")).toBeDefined();
    // Underlying queue item is still present (notification failure doesn't undo durable mutations).
    expect(queueRepo.getById(created.qitemId)).not.toBeNull();
  });

  it("dedups same qitem (no duplicate notification on re-emit)", async () => {
    const created = await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human@rig",
      body: "x",
      tier: "human-gate",
    });
    await new Promise((r) => setTimeout(r, 10));
    // Re-emit a synthetic queue.created event for same qitem (defensive dedup).
    bus.emit({
      type: "queue.created",
      qitemId: created.qitemId,
      sourceSession: "src@rig",
      destinationSession: "human@rig",
      priority: "routine",
      tier: "human-gate",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.calls).toHaveLength(1);
  });

  it("sendTest dispatches synthetic notification through adapter", async () => {
    const result = await dispatcher.sendTest();
    expect(result.ok).toBe(true);
    expect(result.mechanism).toBe("fake");
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.title).toContain("test");
  });
});
