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
import {
  MissionControlWriteContract,
  MissionControlWriteContractError,
} from "../src/domain/mission-control/mission-control-write-contract.js";

describe("MissionControlWriteContract (PL-005 Phase A; atomic 7-verb)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let actionLog: MissionControlActionLog;
  let writeContract: MissionControlWriteContract;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, missionControlActionsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    actionLog = new MissionControlActionLog(db);
    writeContract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo, actionLog });
  });

  afterEach(() => db.close());

  async function seedQitem(): Promise<string> {
    const created = await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "dst@rig",
      body: "test work",
      tier: "human-gate",
    });
    return created.qitemId;
  }

  it("approve closes qitem with closure_reason=no-follow-on + records audit + emits event", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const qitemId = await seedQitem();
    const result = await writeContract.act({
      verb: "approve",
      qitemId,
      actorSession: "human-wrandom@kernel",
    });
    expect(result.actionId).toMatch(/^[0-9A-Z]{26}$/);
    expect(queueRepo.getById(qitemId)?.state).toBe("done");
    expect(queueRepo.getById(qitemId)?.closureReason).toBe("no-follow-on");
    expect(actionLog.listForQitem(qitemId)).toHaveLength(1);
    expect(actionLog.listForQitem(qitemId)[0]?.actionVerb).toBe("approve");
    expect(events.some((e) => e.type === "mission_control.action_executed")).toBe(true);
    expect(events.some((e) => e.type === "queue.updated")).toBe(true);
  });

  it("deny closes qitem with closure_reason=denied", async () => {
    const qitemId = await seedQitem();
    await writeContract.act({
      verb: "deny",
      qitemId,
      actorSession: "human@r",
      reason: "wrong scope",
    });
    expect(queueRepo.getById(qitemId)?.closureReason).toBe("denied");
  });

  it("hold transitions qitem to blocked + sets closure_reason=blocked_on + blocked_on column", async () => {
    const qitemId = await seedQitem();
    await writeContract.act({
      verb: "hold",
      qitemId,
      actorSession: "human@r",
      reason: "external-gate-x",
    });
    const closed = queueRepo.getById(qitemId);
    expect(closed?.state).toBe("blocked");
    expect(closed?.closureReason).toBe("blocked_on");
    expect(closed?.blockedOn).toBe("external-gate-x");
  });

  it("drop closes qitem with closure_reason=canceled", async () => {
    const qitemId = await seedQitem();
    await writeContract.act({
      verb: "drop",
      qitemId,
      actorSession: "human@r",
      reason: "stale work",
    });
    expect(queueRepo.getById(qitemId)?.closureReason).toBe("canceled");
  });

  it("handoff is atomic 4-step: source closes + destination created + audit + event in same transaction", async () => {
    const qitemId = await seedQitem();
    const result = await writeContract.act({
      verb: "handoff",
      qitemId,
      actorSession: "human@r",
      destinationSession: "next@r",
      notify: false,
    });
    expect(result.createdQitemId).not.toBeNull();
    const closed = queueRepo.getById(qitemId);
    expect(closed?.state).toBe("handed-off");
    expect(closed?.closureReason).toBe("handed_off_to");
    expect(closed?.handedOffTo).toBe("next@r");
    const created = queueRepo.getById(result.createdQitemId!);
    expect(created?.destinationSession).toBe("next@r");
    expect(created?.state).toBe("pending");
  });

  it("route mirrors handoff but tags the new packet with mission-control:route", async () => {
    const qitemId = await seedQitem();
    const result = await writeContract.act({
      verb: "route",
      qitemId,
      actorSession: "human@r",
      destinationSession: "other@r",
      notify: false,
    });
    expect(result.createdQitemId).not.toBeNull();
    const created = queueRepo.getById(result.createdQitemId!);
    expect(created?.tags).toContain("mission-control:route");
  });

  it("annotate has no queue mutation but writes audit + event", async () => {
    const qitemId = await seedQitem();
    const beforeState = queueRepo.getById(qitemId)?.state;
    await writeContract.act({
      verb: "annotate",
      qitemId,
      actorSession: "human@r",
      annotation: "operator note",
    });
    expect(queueRepo.getById(qitemId)?.state).toBe(beforeState); // unchanged
    const list = actionLog.listForQitem(qitemId);
    expect(list[0]?.actionVerb).toBe("annotate");
    expect(list[0]?.annotation).toBe("operator note");
  });

  it("annotate rejects unknown qitem instead of creating a ghost audit row", async () => {
    const auditCountBefore = actionLog.countAll();
    try {
      await writeContract.act({
        verb: "annotate",
        qitemId: "qitem-missing",
        actorSession: "human@r",
        annotation: "operator note",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissionControlWriteContractError);
      expect((err as MissionControlWriteContractError).code).toBe("qitem_not_found");
    }
    expect(actionLog.countAll()).toBe(auditCountBefore);
  });

  it("annotate rejects terminal qitems like other Mission Control actions", async () => {
    const qitemId = await seedQitem();
    await writeContract.act({ verb: "approve", qitemId, actorSession: "human@r" });
    const auditCountBefore = actionLog.countAll();
    try {
      await writeContract.act({
        verb: "annotate",
        qitemId,
        actorSession: "human@r",
        annotation: "late note",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissionControlWriteContractError);
      expect((err as MissionControlWriteContractError).code).toBe("qitem_already_terminal");
    }
    expect(actionLog.countAll()).toBe(auditCountBefore);
  });

  it("rejects mutations on terminal items with qitem_already_terminal", async () => {
    const qitemId = await seedQitem();
    await writeContract.act({ verb: "approve", qitemId, actorSession: "human@r" });
    try {
      await writeContract.act({ verb: "approve", qitemId, actorSession: "human@r" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissionControlWriteContractError);
      expect((err as MissionControlWriteContractError).code).toBe("qitem_already_terminal");
    }
  });

  it("rejects route/handoff without destinationSession", async () => {
    const qitemId = await seedQitem();
    try {
      await writeContract.act({ verb: "handoff", qitemId, actorSession: "human@r" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissionControlWriteContractError);
      expect((err as MissionControlWriteContractError).code).toBe("destination_required");
    }
  });

  it("ATOMIC ROLLBACK: handoff with invalid destination rolls back source close + audit + new qitem", async () => {
    const failingRepo = new QueueRepository(db, bus, { validateRig: () => false });
    const failingContract = new MissionControlWriteContract({
      db,
      eventBus: bus,
      queueRepo: failingRepo,
      actionLog,
    });
    const qitemId = await seedQitem();
    const beforeState = queueRepo.getById(qitemId)?.state;
    const auditCountBefore = actionLog.countAll();
    const queueCountBefore = db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number };

    let threw = false;
    try {
      await failingContract.act({
        verb: "handoff",
        qitemId,
        actorSession: "human@r",
        destinationSession: "rejected@r",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Rollback: source unchanged, no audit row, no orphan qitem.
    expect(queueRepo.getById(qitemId)?.state).toBe(beforeState);
    expect(actionLog.countAll()).toBe(auditCountBefore);
    const queueCountAfter = db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number };
    expect(queueCountAfter.n).toBe(queueCountBefore.n);
  });
});
