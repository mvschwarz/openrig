import { createHash } from "node:crypto";
import * as humanSelection from "../src/domain/workflow-human-destination.js";
import * as queueOwner from "../src/domain/queue-owner.js";
import { makeTopologyDestinationCheck } from "../src/domain/queue-destination-check.js";
import { KERNEL_OPERATOR_SESSION } from "../src/domain/default-receiver.js";
import type { HumanFragment, LoadResult } from "../src/domain/gateway/human-registry.js";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { reportPreparationFailure, reportRestoreDeliveryFailure, reportRestoreUptakeUnknown } from "../src/domain/compaction-restore-notice.js";
import { deriveCanonicalSessionName } from "../src/domain/session-name.js";
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
    // An uptake notice to a person keeps the map on the host too.
    await reportRestoreUptakeUnknown(db, queue, { sessionName: failure.sessionName, attemptId: "person-uptake", mapPath: failure.mapPath,
      doneAt: "2026-01-01T00:10:00.000Z", waitedMinutes: 30 });
    const uptake = queue.getById("qitem-compaction-uptake-person-uptake")!;
    expect(uptake.destinationSession).toBe(human.address);
    expect(uptake.evidenceRef).toBeNull();
    for (const text of [uptake.body, uptake.summary]) {
      expect(text).not.toContain(sessionId);
      expect(text).not.toContain("/tmp/claude-compaction-restore");
    }
    expect(uptake.body).toContain("ask it to restore from its newest restore map.");
  } finally { selected.mockRestore(); db.close(); }
});

it("a restore whose uptake is unknown tells the seat's owner once, with its map, and never calls it failed", async () => {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  try {
    const rigs = new RigRepository(db), sessions = new SessionRegistry(db);
    const rig = rigs.createRig("uptake-notice");
    const ownerName = deriveCanonicalSessionName("dev", "owner", "uptake-notice");
    const seatName = deriveCanonicalSessionName("dev", "writer", "uptake-notice");
    const owner = rigs.addNode(rig.id, "owner", { runtime: "claude-code" });
    const seat = rigs.addNode(rig.id, "writer", { runtime: "claude-code" });
    sessions.registerSession(owner.id, ownerName);
    sessions.updateBinding(owner.id, { tmuxSession: ownerName });
    sessions.registerSession(seat.id, seatName);
    rigs.addEdge(rig.id, owner.id, seat.id, "delegates_to");
    const send = vi.fn(async () => ({ ok: true, verified: true }));
    const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }), transport: { send } });
    const unknown = { sessionName: seatName, attemptId: "attempt-up", mapPath: "/maps/attempt-up/RESTORE-MAP.md", doneAt: "2026-11-21T03:00:00.000Z", waitedMinutes: 30 };
    await reportRestoreUptakeUnknown(db, queue, unknown);
    await reportRestoreUptakeUnknown(db, queue, unknown);
    const row = queue.getById("qitem-compaction-uptake-attempt-up")!;
    expect(row.destinationSession).toBe(ownerName);
    expect(row.summary).toBe(`Managed restore for ${seatName}: uptake unknown (no restore note 30 minutes after the audit was sent)`);
    expect(row.body).toContain("the last at 2026-11-21T03:00:00.000Z");
    expect(row.body).toContain("whether the seat took up the restore is unknown");
    expect(row.body).toContain("OpenRig resends nothing.");
    expect(row.body).toContain("send it a restore request naming this map: /maps/attempt-up/RESTORE-MAP.md.");
    expect(row.body).not.toMatch(/undeliverable|restore failed/);
    expect(row.evidenceRef).toBe("/maps/attempt-up/RESTORE-MAP.md");
    expect(row.tags).toEqual(expect.arrayContaining(["restore-uptake", "attempt:attempt-up"]));
    expect(send).toHaveBeenCalledTimes(1);
  } finally { db.close(); }
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
  physicalWriter?: string;
  reportAlias?: boolean;
  wakeExpected?: boolean;
  resolvedParent?: string;
  unreadable?: boolean;
  humanFailure?: "missing" | "registry-unavailable" | "unregistered" | "ambiguous";
  createFailure?: boolean;
  expected: string;
  detail?: string;
}
const humanAddress = "alice@external";
const routes: RouteCase[] = [
  { name: "actual delegation parent precedes the configured agent", parent: true, chosen: "receiver@notice", receiverStatus: "running", expected: "owner@notice" },
  { name: "idle parent remains owner", parent: true, parentStatus: "idle", expected: "owner@notice" },
  { name: "stopped parent stays ahead of the configured agent", parent: true, parentStatus: "exited", chosen: "receiver@notice", receiverStatus: "running", expected: "owner@notice", detail: "recorded state stopped (exited)" },
  { name: "unknown parent remains owner", parent: true, parentStatus: "unknown", expected: "owner@notice" },
  { name: "missing parent seat keeps its eligible address", resolvedParent: "owner@notice", expected: "owner@notice", wakeExpected: false },
  { name: "self parent goes to the person despite configured agents", resolvedParent: "writer@notice", chosen: "receiver@notice", receiverStatus: "running", kernelStatus: "running", expected: humanAddress, detail: "is the seat this notice is about" },
  { name: "logical parent alias cannot recover its own physical seat", resolvedParent: "writer@notice", physicalWriter: "r42-original", kernelStatus: "running", expected: humanAddress, detail: "is the seat this notice is about" },
  { name: "physical parent spelling cannot recover its own logical seat", resolvedParent: "original@notice", physicalWriter: "original@notice", reportAlias: true, kernelStatus: "running", expected: humanAddress, detail: "is the seat this notice is about" },
  { name: "registered person parent alias gets human-safe content", resolvedParent: "alice@notice", kernelStatus: "running", expected: humanAddress, detail: "resolves to a registered person" },
  { name: "ineligible parent rig goes to the person despite configured agents", resolvedParent: "owner@not-created", chosen: "receiver@notice", receiverStatus: "running", kernelStatus: "running", expected: humanAddress, detail: "cannot hold this notice in its destination rig" },
  { name: "parentless with a configured running agent goes to the person", chosen: "receiver@notice", receiverStatus: "running", expected: humanAddress },
  { name: "parentless with a configured idle agent goes to the person", chosen: "receiver@notice", receiverStatus: "idle", expected: humanAddress },
  { name: "parentless with a configured stopped agent goes to the person", chosen: "receiver@notice", receiverStatus: "exited", kernelStatus: "running", expected: humanAddress },
  { name: "parentless with a configured missing agent goes to the person", chosen: "receiver@notice", kernelStatus: "running", expected: humanAddress },
  { name: "parentless with a configured unknown agent goes to the person", chosen: "receiver@notice", receiverStatus: "unknown", expected: humanAddress },
  { name: "unreadable receiver telemetry does not change the person fallback", chosen: "receiver@notice", receiverStatus: "unknown", unreadable: true, expected: humanAddress },
  { name: "parentless with a running kernel goes to the person", kernelStatus: "running", expected: humanAddress },
  { name: "parentless with a stopped kernel goes to the person", kernelStatus: "exited", expected: humanAddress },
  { name: "self receiving agent is not consulted", chosen: "writer@notice", kernelStatus: "running", expected: humanAddress },
  { name: "registered person receiver alias stays on the human route", chosen: "alice@notice", kernelStatus: "running", expected: humanAddress },
  { name: "absent receiver rig is not consulted", chosen: "receiver@not-created", kernelStatus: "running", expected: humanAddress },
  { name: "no parent goes to the person, never an unrelated running seat", expected: humanAddress },
  { name: "no registered person falls back to the kernel with a reason", humanFailure: "missing", kernelStatus: "running", expected: KERNEL_OPERATOR_SESSION },
  { name: "unreadable person registry falls back to the kernel with a reason", humanFailure: "registry-unavailable", kernelStatus: "running", expected: KERNEL_OPERATOR_SESSION },
  { name: "an unregistered person selection falls back to the kernel with a reason", humanFailure: "unregistered", kernelStatus: "running", expected: KERNEL_OPERATOR_SESSION },
  { name: "ambiguous people fall back to the kernel with a reason", humanFailure: "ambiguous", kernelStatus: "running", expected: KERNEL_OPERATOR_SESSION },
  { name: "person resolution failure uses the configured receiver before the kernel", humanFailure: "missing", chosen: "receiver@notice", receiverStatus: "exited", kernelStatus: "running", expected: "receiver@notice" },
  { name: "fallback still excludes the failing seat's physical receiver alias", humanFailure: "missing", physicalWriter: "original@notice", reportAlias: true, chosen: "original@notice", kernelStatus: "running", expected: KERNEL_OPERATOR_SESSION },
  { name: "fallback still excludes a registered-person receiver alias", humanFailure: "unregistered", chosen: "alice@notice", kernelStatus: "running", expected: KERNEL_OPERATOR_SESSION },
  { name: "fallback still excludes an ineligible destination rig", humanFailure: "missing", chosen: "receiver@not-created", kernelStatus: "running", expected: KERNEL_OPERATOR_SESSION },
  { name: "an eligible parent does not need person resolution", humanFailure: "missing", parent: true, expected: "owner@notice" },
  { name: "no person or receiver preserves the unresolved case", humanFailure: "missing", expected: "unresolved" },
  { name: "a self receiver without a kernel preserves the unresolved case", humanFailure: "missing", chosen: "writer@notice", expected: "unresolved" },
  { name: "queue creation failure is not a person-resolution failure", createFailure: true, kernelStatus: "running", expected: humanAddress },
];

describe.each(["restore", "preparation"] as const)("%s recovery routing", (kind) => {
  it.each(routes)("$name", async (route) => {
    const db = createDb(); migrate(db, ALL_MIGRATIONS);
    const human = { entityId: "alice", class: "human", displayName: "Owner", address: humanAddress,
      connectorBindings: [], prefs: {}, subscriptions: [] } as unknown as HumanFragment;
    const selected = vi.spyOn(humanSelection, "workflowHumanDestination").mockReturnValue(humanAddress);
    vi.mocked(queueOwner.readReceivingAgentSetting).mockReturnValue({ session: route.chosen ?? null });
    try {
      const rigs = new RigRepository(db), sessions = new SessionRegistry(db), rig = rigs.createRig("notice");
      const seat = (name: string, status: string, physical?: string) => {
        const node = rigs.addNode(rig.id, name, { runtime: "claude-code" });
        const session = physical ?? `${name}@notice`;
        const row = sessions.registerSession(node.id, session);
        sessions.updateBinding(node.id, { tmuxSession: session });
        sessions.updateStatus(row.id, status);
        return node;
      };
      const writer = seat("writer", "running", route.physicalWriter); seat("unrelated", "running");
      const failedSession = route.reportAlias ? "writer@notice" : route.physicalWriter ?? "writer@notice";
      if (route.receiverStatus) seat("receiver", route.receiverStatus);
      if (route.parent) { const owner = seat("owner", route.parentStatus ?? "running"); rigs.addEdge(rig.id, owner.id, writer.id, "delegates_to"); }
      if (route.resolvedParent) vi.spyOn(queueOwner, "defaultResolveOrchestrator").mockReturnValue(route.resolvedParent);
      if (route.kernelStatus) {
        const row = sessions.registerSession(rigs.addNode(rigs.createRig("kernel").id, "operator-agent", { runtime: "claude-code" }).id, KERNEL_OPERATOR_SESSION);
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
      const loadHumans = (): LoadResult => route.humanFailure === "registry-unavailable"
        ? { ok: false, error: "fixture person registry unreadable" }
        : { ok: true, entities: route.humanFailure === "missing" ? [] : route.humanFailure === "ambiguous"
          ? [human, { ...human, entityId: "bob", address: "bob@external" }] : [human] };
      let personError: unknown;
      if (route.humanFailure) selected.mockImplementation(() => {
        try { return humanSelection.resolveWorkflowHumanDestination(
          () => route.humanFailure === "unregistered" ? "not-registered@external" : null, loadHumans); }
        catch (error) { personError = error; throw error; }
      });
      const validateRig = makeTopologyDestinationCheck({
        findRigsByName: name => db.prepare("SELECT id FROM rigs WHERE name=? AND archived_at IS NULL").all(name),
        loadHumanRegistry: loadHumans, sharedChannels: () => [],
      });
      const queue = new QueueRepository(db, new EventBus(db), { validateRig,
        loadHumanRegistry: loadHumans, transport: { send } });
      const restore: RestoreDeliveryFailure = { sessionName: failedSession, attemptId: "routing-attempt",
        mapPath: "/private/maps/RESTORE-MAP.md", markerPath: "/private/markers/restore.json",
        lastDelivery: { stage: "restore_prompt", at: "2026-01-01T00:00:00Z", ok: false, reason: "target_activity_unknown", failures: 2 } };
      const prep: PreparationFailure = { sessionName: failedSession, occupantGeneration: "generation-one", attemptId: "routing-attempt",
        endedAttempts: 3, reason: "typing_guard_enabled", mapPath: restore.mapPath, statePath: "/private/maps/COMPACTION-STATE.json",
        inputBox: { status: "unknown", confidence: "low", cursor: null, evidence: ["/private/pane-evidence"] } };
      const report = (repository: QueueRepository, changed = false) => kind === "restore"
        ? reportRestoreDeliveryFailure(db, repository, changed ? { ...restore, lastDelivery: { ...restore.lastDelivery, reason: "typing_guard_enabled" } } : restore)
        : reportPreparationFailure(db, repository, changed ? { ...prep, attemptId: "next-attempt", endedAttempts: 4 } : prep);
      if (route.createFailure) {
        const error = new Error("fixture queue write failed");
        vi.spyOn(queue, "create").mockRejectedValue(error);
        await expect(report(queue)).rejects.toBe(error);
        expect(selected).toHaveBeenCalledTimes(1);
        expect(queueOwner.readReceivingAgentSetting).not.toHaveBeenCalled();
        return;
      }
      if (route.expected === "unresolved") {
        await expect(report(queue)).rejects.toMatchObject({ code: "workflow_human_destination_unavailable" });
        expect(queue.list({ limit: 20 })).toEqual([]);
        expect(send).not.toHaveBeenCalled();
        return;
      }
      await report(queue);
      const rows = queue.list({ limit: 20 }); expect(rows).toHaveLength(1);
      const id = rows[0]!.qitemId, row = queue.getById(id)!;
      expect(row.destinationSession).toBe(route.expected);
      expect(row.state).toBe("pending"); expect(row.claimedAt).toBeNull();
      if (route.expected === humanAddress) {
        expect(send).not.toHaveBeenCalled();
        expect(row.evidenceRef).toBeNull();
        expect(row.body).toContain("No eligible independent delegating parent could be resolved");
        expect(row.body).not.toContain("/private/");
      } else {
        expect(send).toHaveBeenCalledTimes(route.wakeExpected === false ? 0 : 1);
        if (route.wakeExpected !== false) expect(send.mock.calls[0]![0]).toBe(route.expected);
        else expect(row.lastNudgeResult).toContain("unroutable");
        expect(row.evidenceRef).toBe(kind === "restore" ? restore.mapPath : prep.statePath);

      }
      if (route.detail) expect(row.body).toContain(route.detail);
      if (route.humanFailure && !route.parent) {
        expect(row.body).toContain("The registered person could not be resolved:");
        expect(row.body).toContain((personError as Error).message);
        expect(row.body).toContain("This is a receiver fallback, not the person's selection.");
      }
      if (route.parent) expect(selected).not.toHaveBeenCalled();
      // A new repository/changed configuration does not reroute or wake an existing notice.
      vi.mocked(queueOwner.readReceivingAgentSetting).mockReturnValue({ session: "unrelated@notice" });
      const restarted = new QueueRepository(db, new EventBus(db), { validateRig,
        loadHumanRegistry: loadHumans, transport: { send } });
      await report(restarted, true); await report(restarted, true);
      expect(restarted.getById(id)?.destinationSession).toBe(route.expected);
      expect(restarted.list({ limit: 20 })).toHaveLength(1);
      if (route.expected === humanAddress) expect(JSON.stringify(restarted.listTransitions(id))).not.toContain("/private/");
      else expect(send).toHaveBeenCalledTimes(route.wakeExpected === false ? 0 : 1);
      if (kind === "restore") {
        await reportRestoreDeliveryFailure(db, restarted, { ...restore, lastDelivery: { ...restore.lastDelivery,
          stage: "compliance_prompt", ok: true, reason: "delivered", failures: 0 } }, { completed: true });
        expect(restarted.getById(id)).toMatchObject({ state: "done", destinationSession: route.expected });
        await report(restarted, true);
        expect(restarted.getById(id)).toMatchObject({ state: "pending", destinationSession: route.expected });
        expect(restarted.list({ limit: 20 })).toHaveLength(1);
      }
      await restarted.update({ qitemId: id, actorSession: route.expected, state: "done", closureReason: "no-follow-on" });
      await report(restarted, true);
      expect(restarted.getById(id)?.state).toBe("done");
      expect(send).toHaveBeenCalledTimes(route.expected === humanAddress || route.wakeExpected === false ? 0 : 1);
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

it("updates a persisted registered-person alias without adding agent-only preparation evidence", async () => {
  const db = createDb(); migrate(db, ALL_MIGRATIONS);
  try {
    new RigRepository(db).createRig("notice");
    const human = { entityId: "alice", class: "human", displayName: "Alice", address: humanAddress,
      connectorBindings: [], prefs: {}, subscriptions: [] } as unknown as HumanFragment;
    const loadHumanRegistry = () => ({ ok: true as const, entities: [human] });
    const validateRig = makeTopologyDestinationCheck({
      findRigsByName: name => db.prepare("SELECT id FROM rigs WHERE name=? AND archived_at IS NULL").all(name),
      loadHumanRegistry, sharedChannels: () => [],
    });
    const queue = new QueueRepository(db, new EventBus(db), { validateRig, loadHumanRegistry });
    const failure: PreparationFailure = { sessionName: "writer@notice", occupantGeneration: "alias-generation", attemptId: "later",
      endedAttempts: 4, reason: "typing_guard_enabled", mapPath: "/private/map", statePath: "/private/state",
      inputBox: { status: "unknown", confidence: "low", cursor: null, evidence: ["/private/reading"] } };
    const key = createHash("sha256").update(`${failure.sessionName}\0${failure.occupantGeneration}`).digest("hex").slice(0, 24);
    const qitemId = `qitem-compaction-preparation-${key}`;
    await queue.create({ qitemId, sourceSession: failure.sessionName, destinationSession: "alice@notice", body: "Earlier person notice", summary: "Earlier evidence", nudge: false });
    await reportPreparationFailure(db, queue, failure);
    expect(queue.getById(qitemId)?.destinationSession).toBe("alice@notice");
    expect(queue.listTransitions(qitemId).at(-1)?.transitionNote).toContain("4 ended unsent attempts");
    expect(JSON.stringify(queue.listTransitions(qitemId))).not.toContain("/private/");
  } finally { db.close(); }
});

// Completion is distinct from an intermediate delivery: only the final owed stage retires the notice.
it.each(["delivered", "delivered_over_unreadable_pane"])("closes only the completed attempt's open notice without another wake: %s", async (reason) => {
  const db = createDb(); migrate(db, ALL_MIGRATIONS);
  try {
    const send = vi.fn(async () => ({ ok: true, verified: true }));
    const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, transport: { send } });
    const failure: RestoreDeliveryFailure = { sessionName: "writer@demo", attemptId: "completed", mapPath: "/maps/restore.md",
      lastDelivery: { stage: "compliance_prompt", at: "2026-01-01T00:00:00Z", ok: false, reason: "target_activity_unknown", failures: 2 } };
    for (const id of ["completed", "other"]) await queue.create({ qitemId: `qitem-compaction-restore-${id}`, sourceSession: "writer@demo", destinationSession: "owner@demo", body: "Restore still owed", nudge: false });
    const landed = { ...failure, lastDelivery: { ...failure.lastDelivery, ok: true, reason, failures: 0, at: "2026-01-01T00:01:00Z",
      ...(reason === "delivered_over_unreadable_pane" ? { activity: { state: "unknown" as const, reason: "no_activity_signal" } } : {}) } };
    await reportRestoreDeliveryFailure(db, queue, landed, { completed: true });
    const row = queue.getById("qitem-compaction-restore-completed")!;
    expect(row).toMatchObject({ state: "done", closureReason: "no-follow-on" });
    expect(row.summary).toContain("compliance_prompt delivered at 2026-01-01T00:01:00Z");
    const closed = queue.listTransitions(row.qitemId).at(-1)!;
    expect(closed.actorSession).toBe("system:compaction");
    expect(closed.transitionNote).toContain("not proof the seat read it");
    if (reason === "delivered_over_unreadable_pane") expect(closed.transitionNote).toContain("unreadable pane");
    expect(queue.getById("qitem-compaction-restore-other")?.state).toBe("pending");
    const before = queue.listTransitions(row.qitemId);
    await reportRestoreDeliveryFailure(db, queue, landed, { completed: true });
    expect(queue.listTransitions(row.qitemId)).toEqual(before);
    expect(send).not.toHaveBeenCalled();
  } finally { db.close(); }
});

it.each(["intermediate", "failed", "owner-closed", "absent"])("preserves a notice without completed owed stages or after owner disposition: %s", async (kind) => {
  const db = createDb(); migrate(db, ALL_MIGRATIONS);
  try {
    const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    const id = "qitem-compaction-restore-kept";
    if (kind !== "absent") await queue.create({ qitemId: id, sourceSession: "writer@demo", destinationSession: "owner@demo", body: "owed", nudge: false });
    if (kind === "owner-closed") queue.update({ qitemId: id, actorSession: "owner@demo", state: "done", closureReason: "no-follow-on", resolution: "Handled by owner" });
    const before = queue.listTransitions(id);
    await reportRestoreDeliveryFailure(db, queue, { sessionName: "writer@demo", attemptId: "kept", mapPath: "/maps/restore.md",
      lastDelivery: { stage: kind === "intermediate" ? "restore_prompt" : "compliance_prompt", at: "2026-01-01T00:01:00Z", ok: kind !== "failed", reason: "delivery", failures: 0 } }, { completed: true });
    expect(queue.getById(id)?.state).toBe(kind === "absent" ? undefined : kind === "owner-closed" ? "done" : "pending");
    if (kind === "owner-closed" || kind === "absent") expect(queue.listTransitions(id)).toEqual(before);
  } finally { db.close(); }
});
