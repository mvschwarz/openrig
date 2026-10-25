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
      lastDelivery: { stage: "turn_boundary", at: "2026-01-01T00:00:00Z", ok: false, reason: "target_activity_unknown", failures: 2 } };
    await reportRestoreDeliveryFailure(db, queue, failure);
    await Promise.all([reportRestoreDeliveryFailure(db, queue, failure), reportRestoreDeliveryFailure(db, queue, failure)]);
    const id = "qitem-compaction-restore-attempt-one";
    expect(queue.getById(id)?.destinationSession).toBe("owner@restore-notice");
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
