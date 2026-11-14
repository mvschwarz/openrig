import * as humanSelection from "../src/domain/workflow-human-destination.js";
import * as queueOwner from "../src/domain/queue-owner.js";
import { KERNEL_OPERATOR_SESSION } from "../src/domain/default-receiver.js";
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { reportPreparationFailure, reportRestoreDeliveryFailure } from "../src/domain/compaction-restore-notice.js";
import type { PreparationFailure, RestoreDeliveryFailure } from "../src/domain/claude-compaction-enforcer.js";

// Keep the host's receiving-agent setting out of these isolated queue fixtures.
beforeEach(() => { vi.spyOn(queueOwner, "readReceivingAgentSetting").mockReturnValue({ session: null }); });
afterEach(() => { vi.restoreAllMocks(); });

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
    const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }), transport: { send } });
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
    // #2845: an agent owner keeps the paths it works from.
    expect(body).toContain("Restore map: /maps/attempt-one/RESTORE-MAP.md.");
    expect(queue.getById(id)?.evidenceRef).toBe("/maps/attempt-one/RESTORE-MAP.md");
    expect(send).toHaveBeenCalledTimes(1);
    // A restarted reporter uses the same persisted item, not an in-memory dedup list.
    const restarted = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }), transport: { send } });
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

// #2845: a notice to a person may be relayed to chat, so it names the seat, the stage and the local command, and leaves
// the restore map, the marker and any session id on the host.
it.each(["target_activity_unknown", "input_box_not_empty"])("a person's notice names the seat, stage and command, with no local path or session id (%s)", async (reason) => {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const human = { entityId: "human-owner", class: "human", displayName: "Owner", address: "human-owner@external", connectorBindings: [], prefs: {}, subscriptions: [] } as unknown as HumanFragment;
  const selected = vi.spyOn(humanSelection, "workflowHumanDestination").mockReturnValue(human.address);
  try {
    const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [human] }) });
    const sessionId = "0f9c3b1e-5a7d-4c2e-9b8a-1d2e3f4a5b6c";
    const failure: RestoreDeliveryFailure = { sessionName: "writer@demo", attemptId: "person", mapPath: `/tmp/claude-compaction-restore/${sessionId}-20261110/RESTORE-MAP.md`,
      markerPath: "/openrig/compaction/restore-pending/writer.json",
      lastDelivery: { stage: "restore_prompt", at: "2026-01-01T00:00:00Z", ok: false, reason, failures: 2 } };
    await reportRestoreDeliveryFailure(db, queue, failure);
    const row = queue.getById("qitem-compaction-restore-person")!;
    expect(row.destinationSession).toBe("human-owner@external");
    expect(row.evidenceRef).toBeNull();
    for (const text of [row.body, row.summary, row.evidenceRef ?? ""]) {
      expect(text).not.toContain(sessionId);
      expect(text).not.toContain("/tmp/claude-compaction-restore");
      expect(text).not.toContain("/openrig/compaction");
    }
    expect(row.body).toContain("Managed restore for writer@demo: restore_prompt undeliverable");
    expect(row.body).toContain("rig compact 'writer@demo' --state shows the stage, why it waits and, when this compaction has one, its restore map.");
    expect(row.body).toContain("run rig compact 'writer@demo' --cancel");
    // A --skip-map compaction has no map to name (owedRestore.mapPath is absent), so the route without one is in words.
    expect(row.body).toContain("If it showed none, because this compaction skipped its map, ask the seat to restore from its restore-pending marker, or from its own transcript if the marker is missing.");
    expect(row.body.includes("inspect the pane and clear or submit that text")).toBe(reason === "input_box_not_empty");
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
    const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }), transport: { send } });
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
    await reportPreparationFailure(db, new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }), transport: { send } }), { ...f, attemptId: "five", endedAttempts: 5 });
    expect(queue.getById(id)?.state).toBe("done"); expect(send).toHaveBeenCalledTimes(1);
  } finally { db.close(); }
});

interface RouteCase {
  name: string;
  chosen?: string;
  receiverStatus?: string;
  kernelStatus?: string;
  parent?: boolean;
  parentStatus?: string;
  selfParent?: boolean;
  unreadable?: boolean;
  expected: string;
  detail?: string;
}
const humanAddress = "human-owner@external";
const routes: RouteCase[] = [
  { name: "actual delegation parent precedes the configured agent", parent: true, chosen: "receiver@notice", receiverStatus: "running", expected: "owner@notice" },
  { name: "stopped parent stays ahead of the configured agent", parent: true, parentStatus: "exited", chosen: "receiver@notice", receiverStatus: "running", expected: "owner@notice", detail: "recorded state stopped (exited)" },
  { name: "self parent falls through to the configured agent", selfParent: true, chosen: "receiver@notice", receiverStatus: "running", expected: "receiver@notice" },
  { name: "configured running agent", chosen: "receiver@notice", receiverStatus: "running", expected: "receiver@notice", detail: "recorded as running" },
  { name: "configured idle agent", chosen: "receiver@notice", receiverStatus: "idle", expected: "receiver@notice", detail: "recorded as idle" },
  { name: "configured stopped agent remains owner", chosen: "receiver@notice", receiverStatus: "exited", kernelStatus: "running", expected: "receiver@notice", detail: "answers wait for it" },
  { name: "configured missing agent remains owner", chosen: "receiver@notice", kernelStatus: "running", expected: "receiver@notice", detail: "no seat by that name" },
  { name: "configured unknown agent remains owner", chosen: "receiver@notice", receiverStatus: "unknown", expected: "receiver@notice", detail: "recorded as unknown" },
  { name: "unreadable telemetry does not abandon the configured agent", chosen: "receiver@notice", unreadable: true, expected: "receiver@notice", detail: "seat couldn't be read" },
  { name: "kernel default", kernelStatus: "running", expected: KERNEL_OPERATOR_SESSION, detail: "the kernel operator" },
  { name: "stopped kernel stays owner", kernelStatus: "exited", expected: KERNEL_OPERATOR_SESSION, detail: "answers wait for it" },
  { name: "self receiving agent uses independent kernel", chosen: "writer@notice", kernelStatus: "running", expected: KERNEL_OPERATOR_SESSION },
  { name: "self receiving agent with no kernel reaches the person", chosen: "writer@notice", expected: humanAddress },
  { name: "no independent agent reaches the person, never an unrelated running seat", expected: humanAddress },
];

describe.each(["restore", "preparation"] as const)("%s recovery routing", (kind) => {
  it.each(routes)("$name", async (route) => {
    const db = createDb(); migrate(db, ALL_MIGRATIONS);
    const human = { entityId: "human-owner", class: "human", displayName: "Owner", address: humanAddress,
      connectorBindings: [], prefs: {}, subscriptions: [] } as unknown as HumanFragment;
    vi.spyOn(humanSelection, "workflowHumanDestination").mockReturnValue(humanAddress);
    vi.mocked(queueOwner.readReceivingAgentSetting).mockReturnValue({ session: route.chosen ?? null });
    try {
      const rigs = new RigRepository(db), sessions = new SessionRegistry(db), rig = rigs.createRig("notice");
      const seat = (name: string, status: string) => {
        const node = rigs.addNode(rig.id, name, { runtime: "claude-code" });
        const session = `${name}@notice`;
        const row = sessions.registerSession(node.id, session);
        sessions.updateBinding(node.id, { tmuxSession: session });
        sessions.updateStatus(row.id, status);
        return node;
      };
      const writer = seat("writer", "running"); seat("unrelated", "running");
      if (route.receiverStatus) seat("receiver", route.receiverStatus);
      if (route.parent) { const owner = seat("owner", route.parentStatus ?? "running"); rigs.addEdge(rig.id, owner.id, writer.id, "delegates_to"); }
      if (route.selfParent) vi.spyOn(queueOwner, "defaultResolveOrchestrator").mockReturnValue("writer@notice");
      if (route.kernelStatus) {
        const row = sessions.registerSession(rigs.addNode(rig.id, "kernel", { runtime: "claude-code" }).id, KERNEL_OPERATOR_SESSION);
        sessions.updateBinding(row.nodeId, { tmuxSession: KERNEL_OPERATOR_SESSION });
        sessions.updateStatus(row.id, route.kernelStatus);
      }
      if (route.unreadable) {
        const prepare = db.prepare.bind(db);
        vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
          if (sql.startsWith("SELECT status FROM sessions WHERE session_name")) throw new Error("fixture unreadable seat telemetry");
          return prepare(sql);
        }) as typeof db.prepare);
      }
      const send = vi.fn(async (_session: string, _text: string) => ({ ok: true, verified: true }));
      const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true,
        loadHumanRegistry: () => ({ ok: true, entities: [human] }), transport: { send } });
      const restore: RestoreDeliveryFailure = { sessionName: "writer@notice", attemptId: "routing-attempt",
        mapPath: "/private/maps/RESTORE-MAP.md", markerPath: "/private/markers/restore.json",
        lastDelivery: { stage: "restore_prompt", at: "2026-01-01T00:00:00Z", ok: false, reason: "target_activity_unknown", failures: 2 } };
      const prep: PreparationFailure = { sessionName: "writer@notice", occupantGeneration: "generation-one", attemptId: "routing-attempt",
        endedAttempts: 3, reason: "typing_guard_enabled", mapPath: restore.mapPath, statePath: "/private/maps/COMPACTION-STATE.json",
        inputBox: { status: "unknown", confidence: "low", cursor: null, evidence: ["/private/pane-evidence"] } };
      const report = (repository: QueueRepository, changed = false) => kind === "restore"
        ? reportRestoreDeliveryFailure(db, repository, changed ? { ...restore, lastDelivery: { ...restore.lastDelivery, reason: "typing_guard_enabled" } } : restore)
        : reportPreparationFailure(db, repository, changed ? { ...prep, attemptId: "next-attempt", endedAttempts: 4 } : prep);
      await report(queue);
      const rows = queue.list({ limit: 20 }); expect(rows).toHaveLength(1);
      const id = rows[0]!.qitemId, row = queue.getById(id)!;
      expect(row.destinationSession).toBe(route.expected);
      expect(row.state).toBe("pending"); expect(row.claimedAt).toBeNull();
      if (route.expected === humanAddress) {
        expect(send).not.toHaveBeenCalled();
        expect(row.evidenceRef).toBeNull();
        expect(row.body).toContain("No independent recovery agent could be resolved");
        expect(row.body).not.toContain("/private/");
      } else {
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0]![0]).toBe(route.expected);
        expect(row.evidenceRef).toBe(kind === "restore" ? restore.mapPath : prep.statePath);
        if (route.detail) expect(row.body).toContain(route.detail);
      }
      // A new repository/changed configuration does not reroute or wake an existing notice.
      vi.mocked(queueOwner.readReceivingAgentSetting).mockReturnValue({ session: "unrelated@notice" });
      const restarted = new QueueRepository(db, new EventBus(db), { validateRig: () => true,
        loadHumanRegistry: () => ({ ok: true, entities: [human] }), transport: { send } });
      await report(restarted, true); await report(restarted, true);
      expect(restarted.getById(id)?.destinationSession).toBe(route.expected);
      expect(restarted.list({ limit: 20 })).toHaveLength(1);
      if (route.expected === humanAddress) expect(JSON.stringify(restarted.listTransitions(id))).not.toContain("/private/");
      else expect(send).toHaveBeenCalledTimes(1);
      await restarted.update({ qitemId: id, actorSession: route.expected, state: "done", closureReason: "no-follow-on" });
      await report(restarted, true);
      expect(restarted.getById(id)?.state).toBe("done");
      expect(send).toHaveBeenCalledTimes(route.expected === humanAddress ? 0 : 1);
    } finally { db.close(); }
  });

  it("the kernel cannot receive its own recovery", async () => {
    const db = createDb(); migrate(db, ALL_MIGRATIONS);
    vi.spyOn(humanSelection, "workflowHumanDestination").mockReturnValue(humanAddress);
    vi.mocked(queueOwner.readReceivingAgentSetting).mockReturnValue({ session: KERNEL_OPERATOR_SESSION });
    const create = vi.fn(async () => ({}));
    const queue = { getById: () => null, create } as unknown as QueueRepository;
    try {
      if (kind === "restore") await reportRestoreDeliveryFailure(db, queue, { sessionName: KERNEL_OPERATOR_SESSION, attemptId: "kernel-self", mapPath: "/private/map",
        lastDelivery: { stage: "restore_prompt", at: "2026-01-01T00:00:00Z", ok: false, reason: "target_activity_unknown", failures: 2 } });
      else await reportPreparationFailure(db, queue, { sessionName: KERNEL_OPERATOR_SESSION, occupantGeneration: "g", attemptId: "kernel-self",
        endedAttempts: 3, reason: "typing_guard_enabled", mapPath: "/private/map", statePath: "/private/state" });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ destinationSession: humanAddress, evidenceRef: null }));
    } finally { db.close(); }
  });
});
