import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
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
    migrate(db, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      missionControlActionsSchema,
      queueItemSummarySchema,
      queueItemEvidenceRefSchema,
    ]);
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
      summary: "test summary (FR-4 human-routed fixture)",
      evidenceRef: "proof/test-evidence.md",
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
      actorSession: "human-operator@kernel",
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

// OPR.0.4.4.19 FR-7 — resolve + unpark (the packet's one genuine design cell).
describe("resolve verb (OPR.0.4.4.19 FR-7)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let actionLog: MissionControlActionLog;
  let writeContract: MissionControlWriteContract;
  let sentNudges: Array<{ session: string; text: string }>;
  let failTransport: boolean;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, missionControlActionsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    bus = new EventBus(db);
    sentNudges = [];
    failTransport = false;
    queueRepo = new QueueRepository(db, bus, {
      validateRig: () => true,
      transport: {
        send: async (session: string, text: string) => {
          if (failTransport) throw new Error("transport down");
          sentNudges.push({ session, text });
          return { ok: true, verified: true };
        },
      },
    });
    actionLog = new MissionControlActionLog(db);
    writeContract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo, actionLog });
  });

  afterEach(() => db.close());

  async function parkedQitem(): Promise<string> {
    const created = await queueRepo.create({
      sourceSession: "orch@rig",
      destinationSession: "driver@rig",
      body: "build the thing",
      nudge: false,
    });
    queueRepo.claim({ qitemId: created.qitemId, destinationSession: "driver@rig" });
    queueRepo.update({
      qitemId: created.qitemId,
      actorSession: "driver@rig",
      state: "blocked",
      blockedOn: "human-review@kernel",
      summary: "Which timing rule ships?",
      evidenceRef: "missions/x/OPTIONS.md",
    });
    return created.qitemId;
  }

  it("happy path: one transaction — blocked->in-progress, decision in transition_note + actor, audit row, events, owner nudge with decision text; NON-CLOSURE", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const qitemId = await parkedQitem();
    const decision = "Ship it with the 2-regime rule; timing per option B";

    const result = await writeContract.act({
      verb: "resolve",
      qitemId,
      actorSession: "human-review@kernel",
      decision,
    });

    const item = queueRepo.getById(qitemId)!;
    // Rail 4: back to the parked owner; no ownership change, no closure.
    expect(item.state).toBe("in-progress");
    expect(item.destinationSession).toBe("driver@rig");
    expect(item.closureReason).toBeNull();
    // Rail 2: decision text queryable forever in the transition log.
    const transitions = queueRepo.transitionLog.listForQitem(qitemId);
    const resolveTransition = transitions.find((t) => t.transitionNote === decision);
    expect(resolveTransition).toBeDefined();
    expect(resolveTransition!.actorSession).toBe("human-review@kernel");
    // Audit row (append-only) records the resolve.
    const audits = actionLog.listForQitem(qitemId);
    expect(audits.some((a) => a.actionVerb === "resolve" && a.reason === decision)).toBe(true);
    // F-pre/P2 refresh contract: queue.updated emitted for the unpark.
    expect(events.some((e) => e.type === "queue.updated")).toBe(true);
    expect(events.some((e) => e.type === "mission_control.action_executed")).toBe(true);
    // Owner nudge carries the decision text.
    expect(sentNudges).toHaveLength(1);
    expect(sentNudges[0]!.session).toBe("driver@rig");
    expect(sentNudges[0]!.text).toContain(decision);
    expect(result.createdQitemId).toBeNull(); // never a new potato
  });

  it.each(["external:qa-pass", "fold:review-complete", "auth:access-granted"])("resolves typed wait %s with evidence, audit and an owner nudge, not a human decision", async (blockedOn) => {
    const created = await queueRepo.create({ sourceSession: "orch@rig", destinationSession: "driver@rig", body: "work", nudge: false });
    queueRepo.update({ qitemId: created.qitemId, actorSession: "driver@rig", state: "blocked", blockedOn });
    const decision = "Verified the recorded condition against the result";
    const result = await writeContract.act({ verb: "resolve", qitemId: created.qitemId, actorSession: "orch@rig", decision });
    expect(queueRepo.getById(created.qitemId)).toMatchObject({ state: "in-progress", destinationSession: "driver@rig", closureReason: null });
    const transition = queueRepo.transitionLog.listForQitem(created.qitemId).find((t) => t.transitionNote?.includes(decision));
    expect(transition).toMatchObject({ actorSession: "orch@rig", transitionNote: `Blocker ${blockedOn} resolved: ${decision}` });
    expect(transition!.ownerNotificationKind).not.toBe("human-decision-resolved");
    expect(actionLog.listForQitem(created.qitemId).some((a) => a.actionVerb === "resolve" && a.reason === decision)).toBe(true);
    expect(sentNudges).toHaveLength(1);
    expect(sentNudges[0]).toMatchObject({ session: "driver@rig" });
    expect(sentNudges[0]!.text).toContain(`Blocker resolved on ${created.qitemId}`);
    expect(result.createdQitemId).toBeNull();
  });

  it.each(["external:", "fold:   ", "auth:", "unknown:gate"])("refuses malformed or unknown persisted blocker %s without effects", async (blockedOn) => {
    const qitemId = await parkedQitem();
    db.prepare("UPDATE queue_items SET blocked_on = ? WHERE qitem_id = ?").run(blockedOn, qitemId);
    const before = queueRepo.getById(qitemId);
    const transitions = queueRepo.transitionLog.listForQitem(qitemId);
    const audits = actionLog.listForQitem(qitemId);
    await expect(writeContract.act({ verb: "resolve", qitemId, actorSession: "orch@rig", decision: "evidence" }))
      .rejects.toMatchObject({ code: "qitem_not_leg1_parked" });
    expect(queueRepo.getById(qitemId)).toEqual(before);
    expect(queueRepo.transitionLog.listForQitem(qitemId)).toEqual(transitions);
    expect(actionLog.listForQitem(qitemId)).toEqual(audits);
    expect(sentNudges).toHaveLength(0);
  });

  it("empty/whitespace decision text is rejected (enforcement symmetry)", async () => {
    const qitemId = await parkedQitem();
    await expect(
      writeContract.act({ verb: "resolve", qitemId, actorSession: "human@kernel", decision: "   " })
    ).rejects.toMatchObject({ code: "decision_required" });
    await expect(
      writeContract.act({ verb: "resolve", qitemId, actorSession: "human@kernel" })
    ).rejects.toMatchObject({ code: "decision_required" });
  });

  it("resolve against a non-parked qitem is rejected naming the expected park shape", async () => {
    const created = await queueRepo.create({
      sourceSession: "a@rig", destinationSession: "b@rig", body: "x", nudge: false,
    });
    await expect(
      writeContract.act({ verb: "resolve", qitemId: created.qitemId, actorSession: "human@kernel", decision: "d" })
    ).rejects.toMatchObject({ code: "qitem_not_leg1_parked" });
  });

  it("resolve against a qitem blocked on ANOTHER QITEM is rejected (leg-1 shape only)", async () => {
    const blocker = await queueRepo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "blocker", nudge: false });
    const item = await queueRepo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "x", nudge: false });
    queueRepo.update({ qitemId: item.qitemId, actorSession: "b@rig", state: "blocked", blockedOn: blocker.qitemId });
    await expect(
      writeContract.act({ verb: "resolve", qitemId: item.qitemId, actorSession: "human@kernel", decision: "d" })
    ).rejects.toMatchObject({ code: "qitem_not_leg1_parked" });
  });

  it("idempotence: re-resolving an already-resolved item is a no-op error, not a double transition", async () => {
    const qitemId = await parkedQitem();
    await writeContract.act({ verb: "resolve", qitemId, actorSession: "human@kernel", decision: "first" });
    const transitionsAfterFirst = queueRepo.transitionLog.listForQitem(qitemId).length;
    await expect(
      writeContract.act({ verb: "resolve", qitemId, actorSession: "human@kernel", decision: "second" })
    ).rejects.toMatchObject({ code: "qitem_not_leg1_parked" });
    expect(queueRepo.transitionLog.listForQitem(qitemId)).toHaveLength(transitionsAfterFirst);
  });

  it("BR-8: the resolve commits even when the owner nudge transport fails", async () => {
    const qitemId = await parkedQitem();
    failTransport = true;
    const result = await writeContract.act({
      verb: "resolve", qitemId, actorSession: "human@kernel", decision: "commit anyway",
    });
    expect(queueRepo.getById(qitemId)!.state).toBe("in-progress");
    // Nudge outcome recorded via the existing last_nudge_* mechanics.
    expect(queueRepo.getById(qitemId)!.lastNudgeResult).toMatch(/^failed:/);
    expect(result.notifyAttempted).toBe(true);
  });

  it("the write contract has NO closure mapping for resolve: closure_reason stays null after resolve", async () => {
    const qitemId = await parkedQitem();
    await writeContract.act({ verb: "resolve", qitemId, actorSession: "human@kernel", decision: "d" });
    const item = queueRepo.getById(qitemId)!;
    expect(item.state).toBe("in-progress");
    expect(item.closureReason).toBeNull();
    expect(item.closureTarget).toBeNull();
  });
});
