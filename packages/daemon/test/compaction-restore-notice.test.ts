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
import { reportRestoreDeliveryFailure } from "../src/domain/compaction-restore-notice.js";
import type { RestoreDeliveryFailure } from "../src/domain/claude-compaction-enforcer.js";

it("notifies the seat's owner once, updates a changed refusal without another wake, and honors the owner's closure", async () => {
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
      lastDelivery: { stage: "turn_boundary", at: "2026-01-01T00:00:00Z", ok: false, reason: "target_activity_unknown", failures: 2 } };
    await reportRestoreDeliveryFailure(db, queue, failure);
    await Promise.all([reportRestoreDeliveryFailure(db, queue, failure), reportRestoreDeliveryFailure(db, queue, failure)]);
    const id = "qitem-compaction-restore-attempt-one";
    expect(queue.getById(id)?.destinationSession).toBe("owner@restore-notice");
    // #2575: the owner is told how to take the restore over with existing verbs, and that it isn't race-free.
    const body = queue.getById(id)?.body ?? "";
    expect(body).toContain("OpenRig sends the step itself after 2 idle polls, recorded as over an unreadable box. That doesn't apply after a /compact whose result was lost, where each step waits for an empty box, or on a seat whose draft-aware delivery or typing guard holds OpenRig's input: those keep holding, draft-aware delivery until the seat's mode is set to off and a typing guard until its level admits OpenRig's input.");
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
