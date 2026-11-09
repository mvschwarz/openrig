import * as humanSelection from "../src/domain/workflow-human-destination.js";
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";
import { it, expect, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { reportPreparationFailure, reportRestoreDeliveryFailure } from "../src/domain/compaction-restore-notice.js";
import type { PreparationFailure, RestoreDeliveryFailure } from "../src/domain/claude-compaction-enforcer.js";

it.each(["target_activity_unknown", "input_box_not_empty"])("notifies the seat's owner once for %s, updates a changed refusal without another wake, and honors the owner's closure", async (reason) => {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  try {
    const rigs = new RigRepository(db), sessions = new SessionRegistry(db);
    const rig = rigs.createRig("restore-notice");
    const owner = rigs.addNode(rig.id, "owner", { runtime: "claude-code" });
    const seat = rigs.addNode(rig.id, "writer", { runtime: "claude-code" });
    sessions.registerSession(owner.id, "owner@restore-notice");
    sessions.updateBinding(owner.id, { tmuxSession: "owner@restore-notice" });
    sessions.registerSession(seat.id, "writer@restore-notice");
    rigs.addEdge(rig.id, owner.id, seat.id, "delegates_to");
    const send = vi.fn(async () => ({ ok: true, verified: true }));
    const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, transport: { send } });
    const failure: RestoreDeliveryFailure = { sessionName: "writer@restore-notice", attemptId: "attempt-one", mapPath: "/maps/attempt-one/RESTORE-MAP.md",
      markerPath: "/openrig/compaction/restore-pending/writer.json",
      lastDelivery: { stage: "turn_boundary", at: "2026-01-01T00:00:00Z", ok: false, reason, failures: 2 } };
    await reportRestoreDeliveryFailure(db, queue, failure);
    await Promise.all([reportRestoreDeliveryFailure(db, queue, failure), reportRestoreDeliveryFailure(db, queue, failure)]);
    const id = "qitem-compaction-restore-attempt-one";
    expect(queue.getById(id)?.destinationSession).toBe("owner@restore-notice");
    // #2575: the owner is told how to take the restore over with existing verbs, and that it isn't race-free.
    const body = queue.getById(id)?.body ?? "";
    expect(body).toContain("Restore input follows ordinary delivery defaults");
    expect(body).toContain("transport.draft_delivery=refuse");
    const possibleWriteHold = "This step waits because this attempt's /compact may be waiting unsubmitted in the input box, where Enter could submit it; inspect the pane and clear or submit that text so the next poll can retry this restore step.";
    if (reason === "input_box_not_empty") {
      expect(body).toContain(possibleWriteHold);
      expect(body).toContain("If the box can't be read, cancel and restore by hand using the route below.");
    }
    else expect(body).not.toContain(possibleWriteHold);
    expect(body).toContain("first run rig compact 'writer@restore-notice' --cancel, so OpenRig stops owing the remaining steps (a step it is already pasting at that moment can still land)");
    expect(body).toContain("naming the restore map, its restore-pending marker /openrig/compaction/restore-pending/writer.json and the packet the marker names.");
    expect(send).toHaveBeenCalledTimes(1);
    // A restarted reporter uses the same persisted item, not an in-memory dedup list.
    const restarted = new QueueRepository(db, new EventBus(db), { validateRig: () => true, transport: { send } });
    failure.lastDelivery = { ...failure.lastDelivery, reason: "typing_guard_enabled", failures: 4 };
    await reportRestoreDeliveryFailure(db, restarted, failure);
    await reportRestoreDeliveryFailure(db, restarted, failure);
    expect(restarted.getById(id)?.summary).toContain("typing_guard_enabled");
    expect(restarted.listTransitions(id).filter(t => t.transitionNote?.includes("summary updated"))).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    failure.lastDelivery.reason = "input_box_not_empty";
    await reportRestoreDeliveryFailure(db, restarted, failure);
    expect(restarted.listTransitions(id).at(-1)?.transitionNote).toContain(possibleWriteHold);
    expect(restarted.listTransitions(id).at(-1)?.transitionNote).toContain("If the box can't be read, cancel and restore by hand using the route below.");
    failure.lastDelivery = { ...failure.lastDelivery, ok: true, reason: "delivered_over_unreadable_pane", failures: 0 };
    await reportRestoreDeliveryFailure(db, restarted, failure);
    expect(restarted.getById(id)?.summary).toContain("delivered over an unreadable pane");
    expect(send).toHaveBeenCalledTimes(1);
    restarted.update({ qitemId: id, actorSession: "owner@restore-notice", state: "done", closureReason: "no-follow-on" });
    failure.lastDelivery.reason = "target_needs_input";
    await reportRestoreDeliveryFailure(db, restarted, failure);
    expect(restarted.getById(id)?.state).toBe("done");
    expect(send).toHaveBeenCalledTimes(1);
  } finally { db.close(); }
});

it("a human fallback is a plain ask: urgent-only stays on Steering while every-ask subscribers see it", async () => {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const human = { entityId: "human-owner", class: "human", displayName: "Owner", address: "human-owner@external", connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary", handle: "U0" }], prefs: {},
    subscriptions: [{ destination: { connector: "slack" }, filter: { preset: "urgent-only" } }] } as HumanFragment;
  const selected = vi.spyOn(humanSelection, "workflowHumanDestination").mockReturnValue(human.address);
  try {
    const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [human] }) });
    const failure: RestoreDeliveryFailure = { sessionName: "writer@demo", attemptId: "human-plain", mapPath: "/maps/restore.md", lastDelivery: { stage: "restore_prompt", at: "2026-01-01T00:00:00Z", ok: false, reason: "typing_guard_enabled", failures: 2 } };
    await reportRestoreDeliveryFailure(db, queue, failure);
    expect(queue.listTransitions("qitem-compaction-restore-human-plain")[0]).toMatchObject({ ownerNotificationKind: "human-required", ownerNotificationLevel: "RECORD" });
    human.subscriptions = [];
    await reportRestoreDeliveryFailure(db, queue, { ...failure, attemptId: "human-every-ask" });
    expect(queue.listTransitions("qitem-compaction-restore-human-every-ask")[0]).toMatchObject({ ownerNotificationKind: "human-required", ownerNotificationLevel: "ALERT" });
  } finally { selected.mockRestore(); db.close(); }
});

it("preparation loop finds its owner once across attempts and honors the owner's disposition", async () => {
  const db = createDb(); migrate(db, ALL_MIGRATIONS);
  try {
    const rigs = new RigRepository(db), sessions = new SessionRegistry(db), rig = rigs.createRig("prep-notice");
    const owner = rigs.addNode(rig.id, "owner", { runtime: "claude-code" });
    const seat = rigs.addNode(rig.id, "writer", { runtime: "claude-code" });
    sessions.registerSession(owner.id, "owner@prep-notice"); sessions.updateBinding(owner.id, { tmuxSession: "owner@prep-notice" });
    sessions.registerSession(seat.id, "writer@prep-notice"); rigs.addEdge(rig.id, owner.id, seat.id, "delegates_to");
    const send = vi.fn(async () => ({ ok: true, verified: true }));
    const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, transport: { send } });
    const f: PreparationFailure = { sessionName: "writer@prep-notice", occupantGeneration: "g1", attemptId: "three", endedAttempts: 3,
      mapPath: "/maps/three/RESTORE-MAP.md", statePath: "/maps/three/COMPACTION-STATE.json", reason: "typing_guard_enabled" };
    await reportPreparationFailure(db, queue, f);
    const rows = db.prepare("SELECT qitem_id AS id FROM queue_items WHERE tags LIKE '%preparation-delivery%'").all() as { id: string }[];
    expect(rows).toHaveLength(1); const id = rows[0]!.id;
    expect(queue.getById(id)).toMatchObject({ destinationSession: "owner@prep-notice", evidenceRef: "/maps/three/COMPACTION-STATE.json", summary: expect.stringContaining("3 ended unsent attempts"), body: expect.stringContaining("reading unavailable") });
    await reportPreparationFailure(db, queue, { ...f, attemptId: "four", endedAttempts: 4, inputBox: { status: "typed", confidence: "high", cursor: null, evidence: ["cursor unavailable"] } });
    expect(queue.listTransitions(id).at(-1)?.transitionNote).toContain('"status":"typed"');
    expect(send).toHaveBeenCalledTimes(1);
    await queue.update({ qitemId: id, actorSession: "owner@prep-notice", state: "done", closureReason: "no-follow-on" });
    await reportPreparationFailure(db, new QueueRepository(db, new EventBus(db), { validateRig: () => true, transport: { send } }), { ...f, attemptId: "five", endedAttempts: 5 });
    expect(queue.getById(id)?.state).toBe("done"); expect(send).toHaveBeenCalledTimes(1);
  } finally { db.close(); }
});
