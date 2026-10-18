import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readClaudeSelfReportEvidence } from "../src/adapters/claude-code-adapter.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { CLAUDE_ACTIVITY_RUNG_INVENTORY, CODEX_ACTIVITY_RUNG_INVENTORY } from "../src/domain/activity-taxonomy.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { buildExecutionView } from "../src/domain/execution-view.js";
import { PsProjectionService } from "../src/domain/ps-projection.js";
import { derivePickup } from "../src/domain/queue-pickup.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { archiveAgedTerminalTransitions } from "../src/domain/queue-retention.js";
import { runStuckSweep, STUCK_SWEEP_FINDING_TAG } from "../src/domain/queue-stuck-sweep.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { evidenceFromHookActivity } from "../src/routes/activity.js";

const SESSION = "worker@input-wait";
const NODE = "node-input-wait";
const advance = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000);

// The stub script can emit turn boundaries but has no permission/elicitation step.
// Exercise the real hook normalization, activity arbitration, queue projections and
// sweep over SQLite instead, with a clock that can outlast an unanswered prompt.
describe("claimed work waiting on human input (#331)", () => {
  let db: Database.Database;
  let queue: QueueRepository;
  let activity: SeatActivityService;
  let hooks: AgentActivityStore;
  let projector: ViewProjector;
  let ps: PsProjectionService;
  let seq: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-10-06T12:00:00Z");
    vi.stubEnv("OPENRIG_QUEUE_PICKUP_STALL_THRESHOLD_MINUTES", "3");
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-input-wait', 'input-wait')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, 'rig-input-wait', 'worker', 'claude-code')").run(NODE);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES ('session-input-wait', ?, ?, 'running', 'ready', ?)")
      .run(NODE, SESSION, new Date().toISOString());
    const bus = new EventBus(db);
    queue = new QueueRepository(db, bus, { validateRig: () => true });
    hooks = new AgentActivityStore({ db, eventBus: bus });
    activity = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3 });
    activity.declareRungInventory({ seatNodeId: NODE, sessionName: SESSION }, CLAUDE_ACTIVITY_RUNG_INVENTORY);
    queue.attachActivityReader(session => activity.getSeatStateBySession(session));
    projector = new ViewProjector(db, bus);
    projector.setExecutionDeps({ db, slicesRoot: () => null, seatActivity: activity });
    ps = new PsProjectionService({ db, seatActivity: activity, agentActivity: hooks });
    seq = 0;
  });

  afterEach(() => { db.close(); vi.useRealTimers(); vi.unstubAllEnvs(); });

  function hook(hookEvent: string, subtype: string | null = null, runtime = "claude-code") {
    const recorded = hooks.recordHookEvent({ runtime, sessionName: SESSION, nodeId: NODE, hookEvent, subtype, occurredAt: new Date().toISOString() });
    if (!recorded.ok) throw new Error(recorded.code);
    const evidence = evidenceFromHookActivity({ seatNodeId: NODE, sessionName: SESSION, runtime, activity: recorded.activity, seq: ++seq });
    if (evidence) activity.reportEvidence(evidence);
  }

  async function claimed(tags?: string[]) {
    const row = await queue.create({ sourceSession: "sender@input-wait", destinationSession: SESSION, body: "Work awaiting approval", nudge: false, tags });
    queue.claim({ qitemId: row.qitemId, destinationSession: SESSION });
    advance(240);
    return row.qitemId;
  }

  const sweep = () => runStuckSweep({ db, queueRepo: queue, now: new Date(), unclaimedAgeMinutes: 60, resolveOrchestrator: () => null, isRegisteredHost: () => false });
  const findings = () => queue.list({ limit: 100 }).filter(row => row.tags?.includes(STUCK_SWEEP_FINDING_TAG));
  const attention = () => ps.getEntries().find(entry => entry.rigId === "rig-input-wait")!.attentionCount;

  it.each(["working", "idle-at-prompt", "unknown"])("pending input takes precedence over %s activity and old claim age", ownerActivity => {
    const old = new Date(Date.now() - 3_600_000).toISOString();
    expect(derivePickup({ state: "in-progress", claimedAt: old, lastMeaningfulAt: old, lastHeartbeat: null, postClaimMotionCount: 0, activity: ownerActivity, needsInput: 1 }).state).toBe("needs-input");
  });

  it("keeps a long unanswered prompt visible across queue, pickup, execution and attention reads without a stall finding", async () => {
    const id = await claimed(["slice:OPR.9.9.331"]);
    const transitions = queue.transitionLog.listForQitem(id);
    hook("Notification", "permission_prompt");
    advance(24 * 3600);
    const receipt = queue.getByIdOrThrow(id).pickup!;
    expect(receipt.state).toBe("needs-input");
    const reason = activity.getSeatStateBySession(SESSION)!.needsInput.reason!;
    expect(receipt.evidence).toContain(reason);
    expect(queue.list({ destinationSession: SESSION }).find(row => row.qitemId === id)?.pickup).toEqual(receipt);
    expect(projector.show("pickup").rows.find(row => row.qitem_id === id)).toMatchObject({ pickup_state: "needs-input", pickup_evidence: receipt.evidence });
    const execution = await buildExecutionView({ db, slicesRoot: () => null, seatActivity: activity });
    expect(execution.q1_lanes).toContainEqual(expect.objectContaining({ qitem_id: id, pickup: receipt }));
    expect(execution.q5_park).toContainEqual(expect.objectContaining({ qitem_id: id, pickup_state: "needs-input", pickup_evidence: receipt.evidence, park_kind: "indeterminate" }));
    expect(queue.waitingView(id)!.nextBackstop).toMatchObject({ dueAt: null, intervalSeconds: null });
    expect(attention()).toBe(1);
    expect((await sweep()).outcome).toBe("clean");
    expect(findings()).toHaveLength(0);
    expect(queue.transitionLog.listForQitem(id)).toEqual(transitions);
  });

  it("honors a Claude waiting self-report without any lifecycle hook", async () => {
    const id = await claimed();
    let status = "waiting";
    const report = () => activity.reportEvidence(readClaudeSelfReportEvidence({
      seatNodeId: NODE, sessionName: SESSION, sessionsDir: "/unused",
      read: { listFiles: () => ["worker.json"], readFile: () => JSON.stringify({ name: SESSION, status, statusUpdatedAt: Date.now() }) },
    })!);
    report();
    expect(queue.getByIdOrThrow(id).pickup).toEqual({ state: "needs-input", evidence: "owner needs input: dialog owns input" });
    expect((await sweep()).outcome).toBe("clean");
    advance(1);
    status = "busy";
    report();
    expect(queue.getByIdOrThrow(id).pickup?.state).toBe("working");
  });

  it("keeps a confirmed Codex request out of pickup stalls until a fresh pane clear", async () => {
    const id = await claimed();
    db.prepare("UPDATE nodes SET runtime = 'codex' WHERE id = ?").run(NODE);
    let visible = true;
    activity = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3,
      permissionPromptReader: async () => visible });
    activity.declareRungInventory({ seatNodeId: NODE, sessionName: SESSION }, CODEX_ACTIVITY_RUNG_INVENTORY);
    ps = new PsProjectionService({ db, seatActivity: activity, agentActivity: hooks });
    hook("PermissionRequest", null, "codex");
    advance(4); // Codex's confirmation probe waits for automatic review to settle.
    await activity.observeSeat(SESSION);
    expect(queue.getByIdOrThrow(id).pickup?.state).toBe("needs-input");
    expect(attention()).toBe(1);
    expect((await sweep()).outcome).toBe("clean");

    visible = false;
    advance(1);
    await activity.observeSeat(SESSION);
    expect(queue.getByIdOrThrow(id).pickup?.state).toBe("stalled-after-claim");
    expect(attention()).toBe(0);
    expect((await sweep()).findings).toContainEqual(expect.objectContaining({ kind: "stalled-after-claim", qitemId: id, action: "created" }));
  });

  it.each([false, true])("closes a false stall and detects recurrence without fabricated queue progress (archived=%s)", async archived => {
    const id = await claimed();
    expect((await sweep()).findings).toContainEqual(expect.objectContaining({ kind: "stalled-after-claim", qitemId: id, action: "created" }));
    const original = findings()[0]!;
    const transitions = queue.transitionLog.listForQitem(id);
    advance(1);
    hook("Notification", "permission_prompt");
    expect((await sweep()).findings).toContainEqual(expect.objectContaining({ findingQitemId: original.qitemId, action: "closed" }));
    expect(queue.getByIdOrThrow(original.qitemId).state).toBe("done");
    expect(queue.waitingView(id)!.nextBackstop.dueAt).toBeNull();
    expect(attention()).toBe(1);

    if (archived) {
      advance(31 * 24 * 3600);
      expect(archiveAgedTerminalTransitions(db, { nowIso: new Date().toISOString() }).archivedRows).toBeGreaterThan(0);
    }
    advance(1);
    hook("UserPromptSubmit");
    expect(queue.getByIdOrThrow(id).pickup?.state).toBe("working");
    expect(attention()).toBe(0);
    expect((await sweep()).outcome).toBe("clean");
    advance(240);
    expect(queue.getByIdOrThrow(id).pickup?.state).toBe("stalled-after-claim");
    expect((await sweep()).findings).toContainEqual(expect.objectContaining({ kind: "stalled-after-claim", qitemId: id, action: "created" }));
    await Promise.all([sweep(), sweep()]);
    expect(findings()).toHaveLength(2);
    expect(findings().filter(row => row.state === "pending")).toHaveLength(1);
    expect(queue.transitionLog.listForQitem(id)).toEqual(transitions);

    // Another wait/clear cycle cannot resurrect either retired finding ID.
    advance(1);
    hook("Notification", "permission_prompt");
    await sweep();
    advance(1);
    hook("Stop");
    advance(240);
    await Promise.all([sweep(), sweep()]);
    expect(findings()).toHaveLength(3);
    expect(findings().filter(row => row.state === "pending")).toHaveLength(1);
  });

  it("an observed clear without working evidence restores stall detection immediately", async () => {
    const id = await claimed();
    hook("Notification", "elicitation_dialog");
    expect(queue.getByIdOrThrow(id).pickup?.state).toBe("needs-input");
    expect((await sweep()).outcome).toBe("clean");
    advance(1);
    activity.reportEvidence({ seatNodeId: NODE, sessionName: SESSION, rung: "needs-input-chrome", sourceId: "claude:chrome", seq: 1, observedAt: new Date().toISOString(), needsInput: { count: 0, reason: null } });
    expect(queue.getByIdOrThrow(id).pickup?.state).toBe("stalled-after-claim");
    expect(attention()).toBe(0);
    expect((await sweep()).findings).toContainEqual(expect.objectContaining({ kind: "stalled-after-claim", qitemId: id, action: "created" }));
  });

  it("does not let a pending prompt hide an explicit closure deadline", async () => {
    const id = await claimed();
    hook("Notification", "permission_prompt");
    const deadline = new Date(Date.now() - 60_000).toISOString();
    db.prepare("UPDATE queue_items SET closure_required_at = ? WHERE qitem_id = ?").run(deadline, id);
    expect(queue.waitingView(id)?.deadlineAt).toBe(deadline);
    expect(queue.waitingView(id)?.nextBackstop).toMatchObject({ mechanism: "queue-stuck-sweep:overdue", dueAt: deadline });
    expect((await sweep()).findings).toContainEqual(expect.objectContaining({ kind: "overdue-claim", qitemId: id, action: "created" }));
    expect(findings()).toHaveLength(1);
  });

  it.each([false, true])("keeps a manual disposition authoritative across input events (reopened=%s)", async reopened => {
    const id = await claimed();
    await sweep();
    const finding = findings()[0]!;
    if (reopened) {
      advance(1);
      hook("Notification", "permission_prompt");
      await sweep();
      await queue.update({ qitemId: finding.qitemId, actorSession: SESSION, state: "pending", reopen: true, transitionNote: "Review this recovery" });
    }
    await queue.update({ qitemId: finding.qitemId, actorSession: SESSION, state: "done", closureReason: "no-follow-on", transitionNote: "Reviewed; no further recovery needed" });
    advance(1);
    hook("Notification", "permission_prompt");
    await sweep();
    advance(1);
    hook("Stop");
    advance(240);
    expect(queue.getByIdOrThrow(id).pickup?.state).toBe("stalled-after-claim");
    expect((await sweep()).outcome).toBe("clean");
    expect(findings()).toHaveLength(1);
  });

  it("a replacement occupant does not inherit the previous occupant's input wait", async () => {
    const id = await claimed();
    hook("Notification", "permission_prompt");
    expect(queue.getByIdOrThrow(id).pickup?.state).toBe("needs-input");
    activity.declareOccupantSwap(NODE, "replacement");
    expect(queue.getByIdOrThrow(id).pickup?.state).toBe("stalled-after-claim");
  });

  it.each(["pending", "blocked", "done", "failed", "denied", "canceled", "handed-off"])("input on the owner does not replace %s obligation semantics", state => {
    const old = new Date(Date.now() - 3_600_000).toISOString();
    const receipt = derivePickup({ state, claimedAt: state === "pending" ? null : old, lastHeartbeat: null, postClaimMotionCount: 0, needsInput: 1 });
    expect(receipt.state).toBe(state === "pending" ? "unclaimed" : state === "blocked" ? "parked" : "terminal");
  });
});
