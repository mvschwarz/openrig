// A wake the send gate holds (a latest person-waiting hook over an unreadable pane) must still reach someone.
// The gate reads the store's retained hook; the wake ladder must read the same evidence through the production
// reader, also after the activity service is rebuilt and for a hook source the oracle does not yet trust (Codex).
// Harness adapted from review50-r2's PR #1001 review (real hook route, SQLite store, activity service, transport,
// parked-owner policy, queue and ladder; only terminal I/O and the final orchestrator delivery are inert).
import { it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { migrate } from "../src/db/migrate.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { activityRoutes } from "../src/routes/activity.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeParkedOwnerConsumerPolicy, makeRigAnchor, PARKED_OWNER_POLICY_NAME, REFUSED_PREFIX } from "../src/domain/policies/parked-owner-consumer.js";
import { runWakeLadderTick, makePermissionPromptReader, makePromptStateReader, classifyPromptAfterRefusal, queueRecoveryOwnsWake } from "../src/domain/queue-wake-ladder.js";
import { startWakeLadderScheduler } from "../src/index.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(runtime = "claude-code", permissionPromptReader?: (sessionName: string) => Promise<boolean | null>, pane = "unrecognized provider content",
  withStructural = false, operator = false) {
  const db = createFullTestDb(); databases.push(db);
  const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), bus = new EventBus(db);
  const rig = rigRepo.createRig(operator ? "kernel" : "r1001"), node = rigRepo.addNode(rig.id,
    operator ? "operator.agent" : "worker.a", { role: operator ? "operator" : "worker", runtime });
  const name = operator ? "operator-agent@kernel" : "worker-a@r1001", session = sessionRegistry.registerSession(node.id, name);
  sessionRegistry.updateStatus(session.id, "running"); sessionRegistry.updateBinding(node.id, { tmuxSession: name });
  const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
  const clock = { value: new Date() }, now = () => clock.value;
  let currentGeneration: string | null = generation;
  const store = new AgentActivityStore({ db, eventBus: bus, now,
    resolveOccupantGeneration: () => currentGeneration,
    isRegisteredOccupantGeneration: (id, g) => Boolean(db.prepare("SELECT 1 FROM occupant_tenures WHERE node_id=? AND generation_uuid=?").get(id, g)),
  });
  const paste = vi.fn(async () => ({ ok: true as const })), enter = vi.fn(async () => ({ ok: true as const }));
  const screen = { value: pane };
  const tmux = { hasSession: async () => true, probeSession: async () => ({ state: "present" as const }),
    getPaneCommand: async () => runtime === "codex" ? "codex" : "claude", getPanePid: async () => null,
    listPanes: async () => [], hasSessionEnv: async () => false, capturePaneContent: async () => screen.value,
    sendText: paste, sendKeys: enter, readPaneLastActivity: async () => now().getTime() / 1000 - 120,
  };
  // The structural capture over the same pane, when a cell needs the oracle to read it (#2515).
  const structural = withStructural ? new SeatStructuralActivityService(tmux as never, now) : undefined;
  const newOracle = () => new SeatActivityService({ tmux: tmux as never, defaultWindowSeconds: 3, now,
    permissionPromptReader, structuralActivity: structural,
    permissionPromptChanged: permissionPromptReader ? (sessionName, confirmed, permissionRuntime) => {
      const latest = store.getLatestForNode({ sessionName });
      store.recordHookEvent({ sessionName, runtime: permissionRuntime, generation: latest?.generation,
        hookEvent: confirmed ? "PermissionPromptConfirmed" : "PermissionPromptCleared" });
    } : undefined,
  });
  let oracle = newOracle();
  const app = new Hono();
  app.use("*", async (c, next) => {
    for (const [key, value] of Object.entries({ agentActivityStore: store, seatActivityService: oracle,
      activityHookToken: "local-fixture-token", sessionRegistry, eventBus: bus })) c.set(key as never, value as never);
    await next();
  });
  app.route("/activity", activityRoutes);
  async function hook(event: string, subtype: string | null, ageMs: number, turnId?: string) {
    const r = await app.request("/activity/hooks", { method: "POST", headers: { "content-type": "application/json",
      "x-openrig-activity-token": "local-fixture-token" }, body: JSON.stringify({ runtime, sessionName: name,
        generation, hookEvent: event, subtype, turnId, occurredAt: new Date(now().getTime() - ageMs).toISOString() }) });
    expect(r.status).toBe(200);
  }
  const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux as never, agentActivityStore: store,
    now, sleep: async () => undefined, activityEndpointFile: () => null });
  // The production composition (index.ts): the oracle first, then the gate's retained-hook evidence.
  const readPromptState = makePromptStateReader({ db,
    getSeatState: (nodeId) => oracle.getSeatState(nodeId),
    getLatestHook: (sessionName) => store.getLatestForNode({ sessionName }) });
  return { db, bus, node, name, generation, store, hook, transport, paste, enter, clock, readPromptState,
    oracle: () => oracle, reconstruct: () => { oracle = newOracle(); }, structural, show: (next: string) => { screen.value = next; },
    changeGeneration: (g: string | null) => { currentGeneration = g; } };
}

async function refuseAndClimb(f: ReturnType<typeof fixture>, oracleAlone?: "unknown" | "blocked") {
  await f.oracle().pollAllRunningTmuxSeats(f.db);
  const repo = new QueueRepository(f.db, f.bus, { validateRig: () => true });
  const row = await repo.create({ sourceSession: "planner@r1001", destinationSession: f.name,
    body: "finish synthetic assigned work", summary: "synthetic obligation", nudge: false });
  repo.claim({ qitemId: row.qitemId, destinationSession: f.name });
  const history: Array<Record<string, unknown>> = [];
  const policy = makeParkedOwnerConsumerPolicy({
    // The parked diagnosis is not under test; the refusal and what follows it are.
    diagnoseRig: () => ({ seats: [{ sessionName: f.name, parked: true,
      activity: { value: "idle-at-prompt", needsInput: { count: 0, reason: null } },
      obligations: { items: [{ qitemId: row.qitemId, state: "in-progress", summary: row.summary }], held: [] } }] }),
    history: { listForJob: () => history as never, countForJob: () => history.length },
    rows: { listTransitions: (id) => repo.listTransitions(id),
      appendNote: (id, note) => { repo.update({ qitemId: id, actorSession: "watchdog@system", transitionNote: note }); return { ok: true }; },
      recordNudgeResult: (id, result) => repo.recordNudgeAttempt(id, result), listOpenIds: () => [row.qitemId],
      recoveryOwnsWake: (id) => queueRecoveryOwnsWake(f.db, repo.getById(id)),
    },
  });
  const job = { jobId: "fixture-job", policy: PARKED_OWNER_POLICY_NAME, target: { session: makeRigAnchor("r1001") }, context: {} };
  const wake = await policy.evaluate(job as never);
  expect(wake.action).toBe("send");
  const sent = await f.transport.send(f.name, "synthetic assigned-work wake");
  expect(sent).toMatchObject({ ok: false, reason: "target_needs_input" });
  history.push({ historyId: "history", jobId: job.jobId, evaluatedAt: new Date().toISOString(), outcome: "sent", skipReason: null,
    deliveryTargetSession: f.name, deliveryStatus: "failed", deliveryMessage: "synthetic wake",
    evaluationNotes: { ...(wake as { notes?: Record<string, unknown> }).notes, deliveryReason: sent.error } });
  await policy.evaluate(job as never);
  const refused = repo.listTransitions(row.qitemId).find((t) => t.transitionNote?.startsWith(REFUSED_PREFIX));
  expect(refused).toBeTruthy();
  const targets: string[] = [];
  for (const ageMs of [60_000, 3_600_000, 86_400_000]) {
    f.clock.value = new Date(Date.now() + ageMs);
    await f.oracle().pollAllRunningTmuxSeats(f.db);
    if (oracleAlone) expect(classifyPromptAfterRefusal(f.oracle().getSeatState(f.node.id), refused!.ts)).toBe(oracleAlone);
    const result = await runWakeLadderTick({ db: f.db, queueRepo: repo, now: f.clock.value,
      resolveOrchestrator: () => "lead@r1001", readPromptState: f.readPromptState,
      retryIntervalSeconds: 1, attemptWake: async (_id, target) => { targets.push(target); return "verified"; }, log: () => {} });
    expect(result.outcome).not.toBe("failed");
  }
  expect(f.paste).not.toHaveBeenCalled();
  expect(f.enter).not.toHaveBeenCalled();
  expect(repo.getById(row.qitemId)?.state).toBe("in-progress");
  return { targets, repo, policy, job };
}

it.each([false, true])("a held Claude wake escalates to the orchestrator (activity service rebuilt=%s)", async (rebuilt) => {
  const f = fixture();
  await f.hook("Notification", "permission_prompt", 600_000);
  if (rebuilt) f.reconstruct(); // same durable DB and occupant, a new daemon service
  expect((await refuseAndClimb(f, rebuilt ? "unknown" : undefined)).targets).toContain("lead@r1001");
});

// #81: Claude's usage-limit dialog is a choice prompt that no hook announces, so the seat's own evidence stays unknown and
// only the transport's refusal knows it waits. Before the fix the refused wake escalated to no one.
it("a Claude seat at a choice prompt no hook announced: the refused wake reaches its orchestrator after one retry interval", async () => {
  const dialog = ["You've hit your weekly limit. What do you want to do?", "❯ 1. Stop and wait for the limit to reset",
    "  2. Switch to another account", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n");
  const f = fixture("claude-code", undefined, dialog);
  const { targets, repo } = await refuseAndClimb(f, "unknown");
  const refusals = repo.list({ limit: 1000 }).flatMap(r => repo.listTransitions(r.qitemId))
    .filter(t => t.transitionNote?.startsWith(REFUSED_PREFIX));
  expect(refusals.map(t => t.transitionNote).join("\n")).toContain("(selection_prompt)");
  expect(targets).toEqual(["lead@r1001"]);
});

it.each([false, true])("a held Codex wake escalates to the orchestrator (activity service rebuilt=%s)", async rebuilt => {
  const f = fixture("codex");
  await f.hook("PermissionRequest", null, 600_000);
  if (rebuilt) f.reconstruct();
  expect((await refuseAndClimb(f, rebuilt ? "unknown" : "blocked")).targets).toContain("lead@r1001");
});

// review50-r2 F2: a later, generation-valid clearing hook ends the held episode from the same evidence,
// so the prompt alert retires and the parked owner can receive its next wake.
it.each([["codex", "PermissionRequest", null, "Stop"], ["claude-code", "Notification", "permission_prompt", "Stop"],
  ["codex", "PermissionRequest", null, "PermissionPromptCleared"]] as const)(
  "a later clearing hook ends the held %s episode: the alert retires and the next wake is sent", async (runtime, event, subtype, clearingEvent) => {
    const f = fixture(runtime);
    await f.hook(event, subtype, 600_000);
    f.reconstruct();
    const { targets, repo, policy, job } = await refuseAndClimb(f, "unknown");
    expect(targets).toContain("lead@r1001");
    const alerts = () => repo.list({ state: ["pending", "in-progress", "blocked"], limit: 1000 })
      .filter((r) => r.tags?.includes("wake-prompt-refusal"));
    expect(alerts()).toHaveLength(1);
    f.clock.value = new Date(f.clock.value.getTime() + 10_000);
    await f.hook(clearingEvent, null, 0);
    await f.oracle().pollAllRunningTmuxSeats(f.db);
    expect((await f.transport.send(f.name, "synthetic follow-on after prompt clearance")).ok).toBe(true);
    await runWakeLadderTick({ db: f.db, queueRepo: repo, now: f.clock.value,
      resolveOrchestrator: () => "lead@r1001", readPromptState: f.readPromptState, retryIntervalSeconds: 1,
      attemptWake: async (_id, target) => { targets.push(target); return "verified"; }, log: () => {} });
    expect(alerts()).toHaveLength(0);
    expect((await policy.evaluate(job as never)).action).toBe("send");
  });

it.each(["turn-a", "turn-b"])("an in-flight all-clear cannot retire a refused-wake alert after request %s, even after reconstruction", async turnId => {
  const reader = vi.fn(async (): Promise<boolean | null> => true);
  const f = fixture("codex", reader);
  await f.hook("PermissionRequest", null, 0, "turn-a");
  f.clock.value = new Date(f.clock.value.getTime() + 3_000);
  await f.oracle().pollAllRunningTmuxSeats(f.db);
  expect(f.oracle().getSeatState(f.node.id)?.needsInput.count).toBe(1);
  const { repo, targets } = await refuseAndClimb(f, "blocked");
  const alerts = () => repo.list({ state: ["pending", "in-progress", "blocked"], limit: 1000 })
    .filter(row => row.tags?.includes("wake-prompt-refusal"));
  expect(alerts()).toHaveLength(1);
  let finishCapture!: (visible: boolean) => void;
  reader.mockImplementationOnce(() => new Promise(resolve => { finishCapture = resolve; }));
  f.clock.value = new Date(f.clock.value.getTime() + 1_000);
  const polling = f.oracle().pollAllRunningTmuxSeats(f.db);
  await vi.waitFor(() => expect(finishCapture).toBeTypeOf("function"));
  f.clock.value = new Date(f.clock.value.getTime() + 1);
  await f.hook("PermissionRequest", null, 0, turnId);
  f.clock.value = new Date(f.clock.value.getTime() + 1);
  finishCapture(false);
  await polling;
  f.reconstruct();
  await runWakeLadderTick({ db: f.db, queueRepo: repo, now: f.clock.value,
    resolveOrchestrator: () => "lead@r1001", readPromptState: f.readPromptState, retryIntervalSeconds: 1,
    attemptWake: async (_id, target) => { targets.push(target); return "verified"; }, log: () => {} });
  expect(alerts()).toHaveLength(1);
  expect(f.store.getLatestForNode({ sessionName: f.name })?.rawEvent).toBe("PermissionPromptConfirmed");
  expect(f.readPromptState(f.name, new Date(f.clock.value.getTime() - 1).toISOString())).toBe("blocked");
  expect(targets).not.toContain(f.name);
  expect(f.paste).not.toHaveBeenCalled();
  expect(f.enter).not.toHaveBeenCalled();
});

it.each([["codex", 0], ["codex", 600_000], ["claude-code", 0], ["claude-code", 600_000]] as const)("a confirmed %s permission clear survives %sms of clock aging without claiming idle or bypassing generation", async (runtime, ageMs) => {
  const f = fixture(runtime);
  const refusedAt = f.clock.value.toISOString();
  f.clock.value = new Date(f.clock.value.getTime() + 10_000);
  await f.hook("PermissionPromptCleared", null, 0);
  const clearedAt = f.clock.value.toISOString();
  f.reconstruct();
  f.clock.value = new Date(f.clock.value.getTime() + ageMs);
  expect(f.store.getLatestForNode({ sessionName: f.name })?.state).toBe("unknown");
  expect(f.readPromptState(f.name, refusedAt)).toBe("clear");
  expect(f.readPromptState(f.name, clearedAt)).toBe("unknown");
  f.changeGeneration("successor-generation");
  expect(f.readPromptState(f.name, refusedAt)).toBe("unknown");
  f.changeGeneration(null);
  expect(f.readPromptState(f.name, refusedAt)).toBe("unknown");
});

it("a Claude pane clearance persists through reconstruction and retires the refused-wake alert without sending", async () => {
  let visible = true;
  const f = fixture("claude-code", async () => visible);
  await f.hook("UserPromptSubmit", null, 0);
  await f.hook("PreToolUse", null, 0);
  await f.hook("Notification", "permission_prompt", 0);
  const { repo, targets } = await refuseAndClimb(f, "blocked");
  await f.hook("PreToolUse", null, 0);
  expect(f.store.getLatestForNode({ sessionName: f.name })?.state).toBe("needs_input");
  expect(await f.transport.send(f.name, "must not land on the open approval")).toMatchObject({ ok: false, reason: "target_needs_input" });
  visible = false;
  f.clock.value = new Date(f.clock.value.getTime() + 1_000);
  await f.oracle().pollAllRunningTmuxSeats(f.db);
  expect(f.store.getLatestForNode({ sessionName: f.name })).toMatchObject({ state: "unknown", rawEvent: "PermissionPromptCleared" });
  f.reconstruct();
  await runWakeLadderTick({ db: f.db, queueRepo: repo, now: f.clock.value,
    resolveOrchestrator: () => "lead@r1001", readPromptState: f.readPromptState, retryIntervalSeconds: 1,
    attemptWake: async (_id, target) => { targets.push(target); return "verified"; }, log: () => {} });
  expect(repo.list({ state: ["pending", "in-progress", "blocked"], limit: 1000 })
    .filter(row => row.tags?.includes("wake-prompt-refusal"))).toHaveLength(0);
  expect(targets).not.toContain(f.name);
  expect(f.paste).not.toHaveBeenCalled();
  expect(f.enter).not.toHaveBeenCalled();
});

it("the reader keeps the oracle's verdicts; only a newer, generation-valid moved-on hook clears", async () => {
  const f = fixture();
  const refusedAt = new Date(f.clock.value.getTime() - 30_000).toISOString();
  await f.hook("Notification", "permission_prompt", 600_000);
  expect(f.readPromptState(f.name, refusedAt)).toBe("blocked");
  // A successor generation's oracle-free read does not revive the previous occupant's hook.
  f.changeGeneration("successor-generation");
  expect(f.readPromptState(f.name, refusedAt)).toBe("unknown");
  f.changeGeneration(null);
  expect(f.readPromptState(f.name, refusedAt)).toBe("unknown");
  // The hook route also feeds each fixture's oracle; these reads isolate the store fallback (no oracle).
  const fallbackOnly = (fx: ReturnType<typeof fixture>) =>
    makePromptStateReader({ db: fx.db, getLatestHook: (sessionName) => fx.store.getLatestForNode({ sessionName }) });
  const g = fixture();
  await g.hook("Notification", "permission_prompt", 600_000);
  await g.hook("UserPromptSubmit", null, 20_000); // answered after the refusal: the hold ends, the episode clears
  expect(fallbackOnly(g)(g.name, refusedAt)).toBe("clear");
  const older = fixture();
  await older.hook("Notification", "permission_prompt", 600_000);
  await older.hook("Stop", null, 60_000); // older than the refusal: cannot clear it
  expect(fallbackOnly(older)(older.name, refusedAt)).toBe("unknown");
  const foreign = fixture();
  await foreign.hook("Notification", "permission_prompt", 600_000);
  await foreign.hook("Stop", null, 0);
  foreign.changeGeneration("successor-generation"); // a mismatched occupant's hook cannot clear it either
  expect(fallbackOnly(foreign)(foreign.name, refusedAt)).toBe("unknown");
  // An oracle verdict, when it has one, still decides.
  const clearReader = makePromptStateReader({ db: g.db,
    getSeatState: () => ({ activity: "idle-at-prompt", needsInput: { count: 0, reason: null },
      needsInputEvidence: { observedAt: g.clock.value.toISOString() } }) as never,
    getLatestHook: () => ({ state: "needs_input", evidenceSource: "runtime_hook", reason: "permission_prompt", sampledAt: g.clock.value.toISOString() }) as never });
  expect(clearReader(g.name, refusedAt)).toBe("clear");
});

it("the production scheduler keeps a current Claude prompt alert when an older Stop arrives later", async () => {
  const f = fixture();
  await f.hook("Notification", "permission_prompt", 600_000);
  const { repo } = await refuseAndClimb(f, "blocked");
  const alerts = () => repo.list({ state: ["pending", "in-progress", "blocked"], limit: 1000 })
    .filter(row => row.tags?.includes("wake-prompt-refusal"));
  expect(alerts()).toHaveLength(1);
  await f.hook("Notification", "permission_prompt", 0);
  await f.hook("Stop", null, 1000);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(f.clock.value);
  const scheduler = startWakeLadderScheduler({ rigRepo: { db: f.db }, queueRepo: repo, agentActivityStore: f.store })!;
  try {
    await scheduler.runTickNow();
    expect(alerts()).toHaveLength(1);
    expect(f.paste).not.toHaveBeenCalled();
    expect(f.enter).not.toHaveBeenCalled();
  } finally {
    await scheduler.stop();
    vi.useRealTimers();
  }
});

// #2515: a native Codex choice that the person answers on screen, with no hook after it. The structural frame observes the
// choice and then the empty composer, so the refused wake isn't escalated, and the next wake is sent once.
const codexScreen = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
it("a Codex wake refused at a native choice the person then answers: no escalation, and the next wake is sent once", async () => {
  const f = fixture("codex", undefined, codexScreen("./fixtures/codex-trust-0.156.1.txt"), true);
  // The occupant as OpenRig records it: the binding's pane, and the pane process the identity reconciler verified.
  new SessionRegistry(f.db).updateBinding(f.node.id, { tmuxPane: "%5" });
  new SeatIdentityStore(f.db).upsert({ nodeId: f.node.id, verdict: "verified", evidenceSource: null, reason: null,
    evidence: { registeredPane: "%5", observedPanePid: 4100, observedPid: 4101, observedCommand: "codex", matchedLayer: 1 },
    sessionName: f.name, observedAt: f.clock.value.toISOString() });
  // The sweep's batched capture: the screen with the pane and process tmux reported for it.
  const screen = { value: codexScreen("./fixtures/codex-trust-0.156.1.txt") };
  const observe = async () => {
    await f.structural!.pollSeat(f.name, new Map([[f.name, { text: screen.value, capturedAt: f.clock.value, pane: { id: "%5", pid: 4100 } }]]),
      "codex", null, f.clock.value);
    await f.oracle().pollAllRunningTmuxSeats(f.db);
  };
  await observe();
  expect(f.oracle().getSeatState(f.node.id)?.needsInput).toMatchObject({ count: 1, reason: "selection_prompt" });
  const repo = new QueueRepository(f.db, f.bus, { validateRig: () => true });
  const row = await repo.create({ sourceSession: "planner@r1001", destinationSession: f.name,
    body: "finish synthetic assigned work", summary: "synthetic obligation", nudge: false });
  repo.claim({ qitemId: row.qitemId, destinationSession: f.name });
  const history: Array<Record<string, unknown>> = [];
  const policy = makeParkedOwnerConsumerPolicy({
    diagnoseRig: () => ({ seats: [{ sessionName: f.name, parked: true,
      activity: { value: "idle-at-prompt", needsInput: { count: 0, reason: null } },
      obligations: { items: [{ qitemId: row.qitemId, state: "in-progress", summary: row.summary }], held: [] } }] }),
    history: { listForJob: () => history as never, countForJob: () => history.length },
    rows: { listTransitions: (id) => repo.listTransitions(id),
      appendNote: (id, note) => { repo.update({ qitemId: id, actorSession: "watchdog@system", transitionNote: note }); return { ok: true }; },
      recordNudgeResult: (id, result) => repo.recordNudgeAttempt(id, result), listOpenIds: () => [row.qitemId],
      recoveryOwnsWake: (id) => queueRecoveryOwnsWake(f.db, repo.getById(id)),
    },
  });
  const job = { jobId: "fixture-job", policy: PARKED_OWNER_POLICY_NAME, target: { session: makeRigAnchor("r1001") }, context: {} };
  const wake = await policy.evaluate(job as never);
  expect(wake.action).toBe("send");
  const sent = await f.transport.send(f.name, "synthetic assigned-work wake");
  expect(sent).toMatchObject({ ok: false, reason: "target_needs_input" });
  history.push({ historyId: "history", jobId: job.jobId, evaluatedAt: new Date().toISOString(), outcome: "sent", skipReason: null,
    deliveryTargetSession: f.name, deliveryStatus: "failed", deliveryMessage: "synthetic wake",
    evaluationNotes: { ...(wake as { notes?: Record<string, unknown> }).notes, deliveryReason: sent.error } });
  await policy.evaluate(job as never);
  const refused = repo.listTransitions(row.qitemId).find((t) => t.transitionNote?.startsWith(REFUSED_PREFIX));
  expect(refused?.transitionNote).toContain("(selection_prompt)");
  expect(f.readPromptState(f.name, refused!.ts)).toBe("blocked"); // still open: nothing is typed into it
  // The person answers the choice; no hook follows.
  f.show(codexScreen("./fixtures/input-box/codex-0.160.0/idle.txt"));
  screen.value = codexScreen("./fixtures/input-box/codex-0.160.0/idle.txt");
  f.clock.value = new Date(Date.now() + 2_000);
  await observe();
  expect(f.readPromptState(f.name, refused!.ts)).toBe("clear");
  const targets: string[] = [];
  const alerts = () => repo.list({ state: ["pending", "in-progress", "blocked"], limit: 1000 })
    .filter((r) => r.tags?.includes("wake-prompt-refusal"));
  for (const ageMs of [2_000, 3_600_000]) {
    f.clock.value = new Date(Date.now() + ageMs);
    await observe();
    await runWakeLadderTick({ db: f.db, queueRepo: repo, now: f.clock.value,
      resolveOrchestrator: () => "lead@r1001", readPromptState: f.readPromptState, retryIntervalSeconds: 1,
      attemptWake: async (_id, target) => { targets.push(target); return "verified"; }, log: () => {} });
  }
  expect(targets).not.toContain("lead@r1001");
  expect(alerts()).toHaveLength(0);
  expect(f.paste).not.toHaveBeenCalled();
  // The next wake goes through normal delivery, once.
  expect((await policy.evaluate(job as never)).action).toBe("send");
  expect((await f.transport.send(f.name, "synthetic assigned-work wake")).ok).toBe(true);
  expect(f.paste).toHaveBeenCalledTimes(1);
});


function permissionFixture(operator = false) {
  const f = fixture("claude-code", undefined, "unrecognized provider content", false, operator);
  // The shared core fixture deliberately omits these production queue extensions.
  migrate(f.db, [queueItemSummarySchema, queueItemEvidenceRefSchema]);
  return f;
}

// Exercise the production scheduler wiring and hook store, without a refused wake,
// original queue work, native terminal, or gateway installation.
it.each(["running", "idle"])("a hook-only permission at a row-less %s seat alerts once in the Feed and clears on answer", async status => {
  const f = permissionFixture();
  f.db.prepare("UPDATE sessions SET status=? WHERE session_name=?").run(status, f.name);
  const repo = new QueueRepository(f.db, f.bus, { validateRig: () => true });
  await f.hook("Notification", "permission_prompt", 0);
  expect(repo.list({ limit: 100 })).toEqual([]);
  const scheduler = startWakeLadderScheduler({ rigRepo: { db: f.db }, queueRepo: repo, agentActivityStore: f.store })!;
  try {
    await scheduler.runTickNow();
    const alerts = repo.list({ limit: 100 }).filter(r => r.tags?.includes("wake-prompt-refusal"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.destinationSession).toBe("human@kernel");
    expect(alerts[0]!.evidenceRef).toContain(`rig telemetry events --start retained --node ${f.node.id}`);
    expect(repo.listAttention().map(r => r.qitemId)).toContain(alerts[0]!.qitemId);
    await scheduler.runTickNow();
    expect(repo.list({ limit: 100 })).toHaveLength(1);
    f.clock.value = new Date(f.clock.value.getTime() + 1000);
    await f.hook("PermissionPromptCleared", null, 0);
    await scheduler.runTickNow();
    expect(repo.getById(alerts[0]!.qitemId)?.state).toBe("done");
    expect(repo.listAttention()).toEqual([]);
    expect(f.paste).not.toHaveBeenCalled();
    expect(f.enter).not.toHaveBeenCalled();
  } finally { await scheduler.stop(); }
});

it.each([false, true])("a hook-only operator permission alerts elsewhere, never back to the prompted operator (old carrier=%s)", async oldCarrier => {
  const f = permissionFixture(true);
  const repo = new QueueRepository(f.db, f.bus, { validateRig: () => true });
  if (oldCarrier) await repo.create({ sourceSession: "daemon@kernel", destinationSession: f.name,
    body: "Existing prompt alert", summary: "Operator needs an answer", nudge: false,
    tags: ["wake-escalation", "wake-prompt-refusal", `prompt-destination:${f.name}`] });
  await f.hook("Notification", "permission_prompt", 0);
  const scheduler = startWakeLadderScheduler({ rigRepo: { db: f.db }, queueRepo: repo, agentActivityStore: f.store })!;
  try {
    await scheduler.runTickNow();
    await scheduler.runTickNow();
    const alerts = repo.list({ limit: 100 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.destinationSession).toBe("human@kernel");
    expect(alerts[0]!.destinationSession).not.toBe(f.name);
    expect(alerts[0]!.evidenceRef).toContain(`rig telemetry events --start retained --node ${f.node.id}`);
    expect(repo.listAttention().map(r => r.qitemId)).toEqual([alerts[0]!.qitemId]);
    expect(repo.list({ destinationSession: f.name, limit: 100 })).toEqual([]);
    expect(f.paste).not.toHaveBeenCalled();
    expect(f.enter).not.toHaveBeenCalled();
  } finally { await scheduler.stop(); }
});

it.each([null, "different-generation"])("a hook-only permission with unresolved or mismatched occupant %s stays unknown", async generation => {
  const f = permissionFixture();
  const repo = new QueueRepository(f.db, f.bus, { validateRig: () => true });
  await f.hook("Notification", "permission_prompt", 6 * 60_000);
  f.changeGeneration(generation);
  const scheduler = startWakeLadderScheduler({ rigRepo: { db: f.db }, queueRepo: repo, agentActivityStore: f.store })!;
  try {
    await scheduler.runTickNow();
    expect(repo.list({ limit: 100 })).toEqual([]);
    expect(f.paste).not.toHaveBeenCalled();
    expect(f.enter).not.toHaveBeenCalled();
  } finally { await scheduler.stop(); }
});


it("a later confirmation of the same hook-only permission does not reopen its owner's disposition", async () => {
  const f = permissionFixture(), repo = new QueueRepository(f.db, f.bus, { validateRig: () => true });
  await f.hook("Notification", "permission_prompt", 0);
  const scheduler = startWakeLadderScheduler({ rigRepo: { db: f.db }, queueRepo: repo, agentActivityStore: f.store })!;
  try {
    await scheduler.runTickNow();
    const alerts = repo.listAttention();
    expect(alerts).toHaveLength(1);
    repo.update({ qitemId: alerts[0]!.qitemId, actorSession: "human@kernel", state: "done", closureReason: "no-follow-on" });
    f.clock.value = new Date(f.clock.value.getTime() + 1000);
    await f.hook("PermissionPromptConfirmed", null, 0);
    await scheduler.runTickNow();
    expect(repo.listAttention()).toEqual([]);
    expect(repo.list({ limit: 100 })).toHaveLength(1);
    expect(repo.getById(alerts[0]!.qitemId)?.state).toBe("done");
  } finally { await scheduler.stop(); }
});


it("a hook-only clear after the owner closes an alert gives a later prompt one new alert", async () => {
  const f = permissionFixture(), repo = new QueueRepository(f.db, f.bus, { validateRig: () => true });
  await f.hook("Notification", "permission_prompt", 0);
  const scheduler = startWakeLadderScheduler({ rigRepo: { db: f.db }, queueRepo: repo, agentActivityStore: f.store })!;
  try {
    await scheduler.runTickNow();
    const first = repo.listAttention()[0]!;
    expect(first).toBeDefined();
    repo.update({ qitemId: first.qitemId, actorSession: "human@kernel", state: "done", closureReason: "no-follow-on" });
    f.clock.value = new Date(f.clock.value.getTime() + 1000);
    await f.hook("PermissionPromptCleared", null, 0);
    await scheduler.runTickNow();
    expect(repo.getById(first.qitemId)?.state).toBe("done");
    expect(repo.listAttention()).toEqual([]);
    f.clock.value = new Date(f.clock.value.getTime() + 1000);
    await f.hook("Notification", "permission_prompt", 0);
    await scheduler.runTickNow();
    await scheduler.runTickNow();
    expect(repo.list({ limit: 100 })).toHaveLength(2);
    expect(repo.listAttention()).toHaveLength(1);
    expect(repo.listAttention()[0]!.qitemId).not.toBe(first.qitemId);
  } finally { await scheduler.stop(); }
});

it("the timer sees a retained hook-only prompt arriving after its read, even when the next read is over 300 seconds later", async () => {
  vi.useFakeTimers();
  const f = permissionFixture(), repo = new QueueRepository(f.db, f.bus, { validateRig: () => true });
  const read = f.store.getLatestForNode.bind(f.store);
  let posted = false;
  const hookRead = vi.spyOn(f.store, "getLatestForNode").mockImplementation(input => {
    f.clock.value = new Date();
    const result = read(input);
    if (!posted) {
      posted = true;
      // The hook arrives after this tick's inventory read, while that tick still runs.
      f.store.recordHookEvent({ sessionName: f.name, runtime: "claude-code", generation: f.generation,
        hookEvent: "Notification", subtype: "permission_prompt" });
      vi.setSystemTime(Date.now() + 10_000);
    }
    return result;
  });
  const scheduler = startWakeLadderScheduler({ rigRepo: { db: f.db }, queueRepo: repo, agentActivityStore: f.store })!;
  try {
    await vi.advanceTimersByTimeAsync(300_000);
    expect(posted).toBe(true);
    expect(repo.listAttention()).toEqual([]);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(repo.listAttention()).toHaveLength(1);
    expect(hookRead).toHaveBeenCalledTimes(3); // inventory per tick, then one destination-scoped send read
    f.clock.value = new Date();
    await f.hook("PermissionPromptCleared", null, 0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(repo.listAttention()).toEqual([]); // retained clear is still clear at the following tick
    expect(f.paste).not.toHaveBeenCalled();
  } finally { await scheduler.stop(); hookRead.mockRestore(); vi.useRealTimers(); }
});

it("one failed hook-only inventory read does not hide a healthy seat and only the destination is re-read", async () => {
  const f = permissionFixture(), repo = new QueueRepository(f.db, f.bus, { validateRig: () => true });
  const bad = new RigRepository(f.db).addNode(f.node.rigId, "worker.bad", { role: "worker", runtime: "claude-code" });
  const badName = "worker-bad@r1001", registry = new SessionRegistry(f.db);
  const badSession = registry.registerSession(bad.id, badName);
  registry.updateStatus(badSession.id, "running");
  await f.hook("Notification", "permission_prompt", 0);
  const log = vi.fn(), reads: string[] = [];
  const reader = makePermissionPromptReader({ db: f.db, log, getLatestHook: destination => {
    reads.push(destination);
    if (destination === badName) throw new Error("fixture hook unavailable");
    return f.store.getLatestForNode({ sessionName: destination });
  } });
  const result = await runWakeLadderTick({ db: f.db, queueRepo: repo, readPermissionPrompts: reader, log });
  expect(result.outcome).not.toBe("failed");
  expect(repo.listAttention()).toHaveLength(1);
  expect(repo.listAttention()[0]!.tags).toContain(`prompt-destination:${f.name}`);
  expect(reads.filter(name => name === badName)).toHaveLength(1);
  expect(reads.filter(name => name === f.name)).toHaveLength(2);
  expect(log.mock.calls.flat().join(" ")).toContain(badName);
});

it("a failed hook-only send-boundary re-read is contained and named", async () => {
  const f = permissionFixture(), repo = new QueueRepository(f.db, f.bus, { validateRig: () => true });
  await f.hook("Notification", "permission_prompt", 0);
  const read = makePermissionPromptReader({ db: f.db,
    getLatestHook: destination => f.store.getLatestForNode({ sessionName: destination }) });
  const log = vi.fn();
  const reader = vi.fn((destination?: string) => {
    if (reader.mock.calls.length === 2) throw new Error("fixture send read unavailable");
    return read(destination);
  });
  const result = await runWakeLadderTick({ db: f.db, queueRepo: repo, readPermissionPrompts: reader, log });
  expect(result.outcome).not.toBe("failed");
  expect(reader.mock.calls[1]).toEqual([f.name]);
  expect(log.mock.calls.flat().join(" ")).toContain(f.name);
  const alert = repo.list({ limit: 100 })[0]!;
  expect(repo.listTransitions(alert.qitemId).some(t => t.transitionNote?.includes("operator rung resolved"))).toBe(false);
});


it.each(["open", "closed"])("a mismatched hook-only clear preserves a %s alert without moving its boundary", async disposition => {
  const f = permissionFixture(), repo = new QueueRepository(f.db, f.bus, { validateRig: () => true });
  await f.hook("Notification", "permission_prompt", 0);
  const scheduler = startWakeLadderScheduler({ rigRepo: { db: f.db }, queueRepo: repo, agentActivityStore: f.store })!;
  try {
    await scheduler.runTickNow();
    const alert = repo.listAttention()[0]!;
    expect(alert).toBeDefined();
    if (disposition === "closed") repo.update({ qitemId: alert.qitemId, actorSession: "human@kernel", state: "done", closureReason: "no-follow-on" });
    const state = repo.getById(alert.qitemId)!.state;
    f.clock.value = new Date(f.clock.value.getTime() + 1000);
    await f.hook("PermissionPromptCleared", null, 0);
    f.changeGeneration("different-generation");
    expect(f.store.getLatestForNode({ sessionName: f.name })).toMatchObject({
      state: "unknown", reason: "generation_mismatch", generationProvenance: "resolved", stale: true,
    });
    await scheduler.runTickNow();
    expect(repo.getById(alert.qitemId)?.state).toBe(state);
    expect(repo.listTransitions(alert.qitemId).some(t => t.actorSession === "wake-ladder@system"
      && t.transitionNote === "prompt escalation: the seat's prompt read clear")).toBe(false);
    expect(repo.list({ limit: 100 })).toHaveLength(1);
  } finally { await scheduler.stop(); }
});

it("a row-less Claude PermissionRequest raises one permission alert", async () => {
  const f = permissionFixture(), repo = new QueueRepository(f.db, f.bus, { validateRig: () => true });
  await f.hook("PermissionRequest", null, 0);
  expect(repo.list({ limit: 100 })).toEqual([]);
  const scheduler = startWakeLadderScheduler({ rigRepo: { db: f.db }, queueRepo: repo, agentActivityStore: f.store })!;
  try {
    await scheduler.runTickNow();
    await scheduler.runTickNow();
    const alerts = repo.listAttention();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.destinationSession).toBe("human@kernel");
    expect(alerts[0]!.evidenceRef).toContain(`rig telemetry events --start retained --node ${f.node.id}`);
    expect(repo.list({ limit: 100 })).toHaveLength(1);
    expect(f.paste).not.toHaveBeenCalled();
    expect(f.enter).not.toHaveBeenCalled();
  } finally { await scheduler.stop(); }
});

it("a later occupant's clear does not retire the earlier permission alert", async () => {
  const f = permissionFixture(), repo = new QueueRepository(f.db, f.bus, { validateRig: () => true });
  await f.hook("Notification", "permission_prompt", 0);
  const scheduler = startWakeLadderScheduler({ rigRepo: { db: f.db }, queueRepo: repo, agentActivityStore: f.store })!;
  try {
    await scheduler.runTickNow();
    const alert = repo.listAttention()[0]!;
    expect(alert).toBeDefined();
    await runWakeLadderTick({ db: f.db, queueRepo: repo, now: f.clock.value, log: () => {},
      readPermissionPrompts: () => [{ destination: f.name, state: "clear", episode: "later-occupant",
        observedAt: f.clock.value.toISOString(), evidenceRef: "retained hook" }] });
    expect(repo.getById(alert.qitemId)?.state).toBe("pending");
    expect(repo.listTransitions(alert.qitemId).some(t => t.transitionNote === "prompt escalation: the seat's prompt read clear")).toBe(false);
  } finally { await scheduler.stop(); }
});

it("an existing Feed permission carrier gains missing hook evidence", async () => {
  const f = permissionFixture(), repo = new QueueRepository(f.db, f.bus, { validateRig: () => true });
  await f.hook("Notification", "permission_prompt", 0);
  const scheduler = startWakeLadderScheduler({ rigRepo: { db: f.db }, queueRepo: repo, agentActivityStore: f.store })!;
  try {
    await scheduler.runTickNow();
    const alert = repo.listAttention()[0]!;
    expect(alert.destinationSession).toBe("human@kernel");
    f.db.prepare("UPDATE queue_items SET evidence_ref=NULL WHERE qitem_id=?").run(alert.qitemId);
    await scheduler.runTickNow();
    expect(repo.getById(alert.qitemId)?.evidenceRef).toContain(`rig telemetry events --start retained --node ${f.node.id}`);
    expect(repo.list({ limit: 100 })).toHaveLength(1);
  } finally { await scheduler.stop(); }
});

// C4's shape: a builder answered one permission prompt and met the next about 14 s later, before any tick read clear. Each
// prompt is keyed by its own start. The seat keeps one alert, and its owner hears of each new prompt once.
function promptEpisodeFixture() {
  const f = permissionFixture(), repo = new QueueRepository(f.db, f.bus, { validateRig: () => true });
  // The seat's lead owns the alert: a live session on this host, named from the seat's own address.
  const lead = f.name.replace(/^worker-a/, "lead-a"), registry = new SessionRegistry(f.db);
  const leadNode = new RigRepository(f.db).addNode(f.node.rigId, "lead.a", { role: "lead", runtime: "claude-code" });
  registry.updateStatus(registry.registerSession(leadNode.id, lead).id, "running");
  const read = makePermissionPromptReader({ db: f.db,
    getLatestHook: destination => f.store.getLatestForNode({ sessionName: destination, order: "source" }),
    getPromptStart: (destination, generation) => f.store.findPermissionPromptStart({ sessionName: destination, generation }) });
  const woken: string[] = [];
  const tick = (reader = read) => runWakeLadderTick({ db: f.db, queueRepo: repo, now: f.clock.value, log: () => {},
    resolveOrchestrator: () => lead, readPermissionPrompts: reader, retryIntervalSeconds: 1,
    attemptWake: async (_id, target) => { woken.push(target); return "verified"; } });
  const later = async (ms: number, event: string, subtype: string | null) => {
    f.clock.value = new Date(f.clock.value.getTime() + ms);
    await f.hook(event, subtype, 0);
    return f.clock.value.toISOString();
  };
  const alerts = () => repo.list({ limit: 100 }).filter(r => r.tags?.includes("wake-prompt-refusal"));
  const newPromptNotes = (id: string) => repo.listTransitions(id)
    .filter(t => t.transitionNote?.startsWith("prompt escalation: a new permission prompt joined this alert"));
  return { f, repo, lead, leadNode, read, woken, tick, later, alerts, newPromptNotes };
}

it.each(["open", "owner-held"])("a second permission prompt at a seat whose alert is %s wakes the alert's owner once, with one transition and no new row", async hold => {
  const { f, repo, lead, woken, tick, later, alerts, newPromptNotes } = promptEpisodeFixture();
  await later(0, "Notification", "permission_prompt");
  await tick();
  expect(alerts()).toHaveLength(1);
  const id = alerts()[0]!.qitemId;
  expect(alerts()[0]!.destinationSession).toBe(lead);
  expect(woken).toEqual([lead]); // the orchestrator rung, for the first prompt
  if (hold === "owner-held") repo.update({ qitemId: id, actorSession: lead, state: "blocked", blockedOn: "external:answer" });
  await later(14_000, "Notification", "permission_prompt");
  await tick();
  await tick();
  expect(woken).toEqual([lead, lead]);
  expect(newPromptNotes(id)).toHaveLength(1);
  expect(newPromptNotes(id)[0]!.transitionNote).toContain(`woke ${lead} outcome=verified`);
  expect(repo.list({ limit: 100 })).toHaveLength(1);
  expect(repo.getById(id)?.state).toBe(hold === "open" ? "pending" : "blocked");
  expect(f.paste).not.toHaveBeenCalled();
});

it.each([
  ["a pane confirmation after its notification", "Notification", "permission_prompt", "PermissionPromptConfirmed", null],
  ["its notification six seconds after its PermissionRequest", "PermissionRequest", null, "Notification", "permission_prompt"],
] as const)("one prompt's two hooks wake no one again: %s", async (_, firstEvent, firstSubtype, secondEvent, secondSubtype) => {
  const { repo, lead, woken, tick, later, alerts, newPromptNotes } = promptEpisodeFixture();
  await later(0, firstEvent, firstSubtype);
  await tick();
  const id = alerts()[0]!.qitemId;
  await later(6_000, secondEvent, secondSubtype);
  await tick();
  await tick();
  expect(woken).toEqual([lead]);
  expect(newPromptNotes(id)).toEqual([]);
  expect(repo.list({ limit: 100 })).toHaveLength(1);
});

it("without a prompt's own start, a second prompt keeps the occupant's key and wakes no one again", async () => {
  const { f, repo, lead, woken, tick, later, alerts, newPromptNotes } = promptEpisodeFixture();
  const generationOnly = makePermissionPromptReader({ db: f.db,
    getLatestHook: destination => f.store.getLatestForNode({ sessionName: destination, order: "source" }) });
  await later(0, "Notification", "permission_prompt");
  await tick(generationOnly);
  const id = alerts()[0]!.qitemId;
  await later(14_000, "Notification", "permission_prompt");
  await tick(generationOnly);
  await tick(generationOnly);
  expect(woken).toEqual([lead]);
  expect(newPromptNotes(id)).toEqual([]);
  expect(repo.list({ limit: 100 })).toHaveLength(1);
  expect(repo.getById(id)!.tags).toContain(`prompt-episode:${f.name}|permission-hook:${f.generation}|after:start`);
});

it("a prompt starts at the newest prompt hook in the occupant's unbroken run of permission hooks", async () => {
  const { f, later } = promptEpisodeFixture();
  const start = (generation = f.generation) => f.store.findPermissionPromptStart({ sessionName: f.name, generation });
  const first = await later(0, "Notification", "permission_prompt");
  await later(1_000, "PermissionPromptConfirmed", null);
  expect(start()).toBe(first);
  const second = await later(14_000, "Notification", "permission_prompt");
  await later(1_000, "PermissionPromptConfirmed", null);
  expect(start()).toBe(second);
  expect(start("another-occupant")).toBeNull();
  await later(1_000, "Stop", null);
  await later(1_000, "PermissionPromptConfirmed", null);
  expect(start()).toBeNull(); // the turn ended, and no prompt hook came after it
});

it("the production reader keys each prompt by its own start; an alert owner with no session records a new one without a wake", async () => {
  const f = permissionFixture(), repo = new QueueRepository(f.db, f.bus, { validateRig: () => true });
  const key = () => `prompt-episode:${f.name}|permission-hook:${f.generation}`
    + `|prompt:${f.store.findPermissionPromptStart({ sessionName: f.name, generation: f.generation })}|after:start`;
  await f.hook("Notification", "permission_prompt", 0);
  const scheduler = startWakeLadderScheduler({ rigRepo: { db: f.db }, queueRepo: repo, agentActivityStore: f.store })!;
  try {
    await scheduler.runTickNow();
    const alert = repo.listAttention()[0]!, first = key();
    expect(alert.tags).toContain(first);
    f.clock.value = new Date(f.clock.value.getTime() + 14_000);
    await f.hook("Notification", "permission_prompt", 0);
    await scheduler.runTickNow();
    await scheduler.runTickNow();
    expect(key()).not.toBe(first);
    expect(repo.getById(alert.qitemId)!.tags).toEqual(expect.arrayContaining([first, key()]));
    expect(repo.listTransitions(alert.qitemId).map(t => t.transitionNote).filter(n => n?.startsWith("prompt escalation: a new permission prompt"))).toEqual([
      `prompt escalation: a new permission prompt joined this alert; ${alert.destinationSession} not woken: it has no session on this host`]);
    expect(repo.list({ limit: 100 })).toHaveLength(1);
    expect(f.paste).not.toHaveBeenCalled();
    expect(f.enter).not.toHaveBeenCalled();
  } finally { await scheduler.stop(); }
});

// F1-F4: a request's run of hooks, a start read late, the reread before a new-prompt wake, and a deferred wake.
it("a request owns every notification after it in its run: a third hook keeps the prompt's start and wakes no one again", async () => {
  const { f, lead, woken, tick, later, alerts, newPromptNotes } = promptEpisodeFixture();
  const request = await later(0, "PermissionRequest", null);
  await tick();
  const id = alerts()[0]!.qitemId;
  await later(6_000, "Notification", "permission_prompt");
  await tick();
  await later(6_000, "Notification", "permission_prompt");
  await tick();
  await tick();
  expect(f.store.findPermissionPromptStart({ sessionName: f.name, generation: f.generation })).toBe(request);
  expect(woken).toEqual([lead]);
  expect(newPromptNotes(id)).toEqual([]);
});

it("an owner-held alert first keyed by its occupant records the first readable prompt with no wake; the next prompt wakes the owner once", async () => {
  const { f, repo, lead, woken, tick, later, alerts, newPromptNotes } = promptEpisodeFixture();
  let readable = false;
  const flaky = makePermissionPromptReader({ db: f.db, log: () => {},
    getLatestHook: destination => f.store.getLatestForNode({ sessionName: destination, order: "source" }),
    getPromptStart: (destination, generation) => {
      if (!readable) throw new Error("retained events unreadable");
      return f.store.findPermissionPromptStart({ sessionName: destination, generation });
    } });
  const startKey = () => `prompt-episode:${f.name}|permission-hook:${f.generation}`
    + `|prompt:${f.store.findPermissionPromptStart({ sessionName: f.name, generation: f.generation })}|after:start`;
  await later(0, "Notification", "permission_prompt");
  await tick(flaky);
  const id = alerts()[0]!.qitemId;
  expect(repo.getById(id)!.tags).toContain(`prompt-episode:${f.name}|permission-hook:${f.generation}|after:start`);
  expect(woken).toEqual([lead]);
  repo.update({ qitemId: id, actorSession: lead, state: "blocked", blockedOn: "external:answer" });

  readable = true;
  await tick(flaky);
  const first = startKey();
  expect(repo.getById(id)!.tags).toContain(first);
  expect(woken).toEqual([lead]); // recorded with no wake
  expect(newPromptNotes(id)).toEqual([]);
  expect(repo.getById(id)!.state).toBe("blocked");

  await later(14_000, "Notification", "permission_prompt");
  await tick(flaky);
  await tick(flaky);
  expect(startKey()).not.toBe(first);
  expect(woken).toEqual([lead, lead]);
  expect(newPromptNotes(id)).toHaveLength(1);
  expect(repo.getById(id)!.tags).toEqual(expect.arrayContaining([first, startKey()]));
  expect(repo.getById(id)!.state).toBe("blocked");
  expect(repo.list({ limit: 100 })).toHaveLength(1);
});

it("a prompt whose start is read only after its alert was closed keeps that close; a prompt that starts after the close alerts", async () => {
  const { f, repo, lead, woken, tick, later } = promptEpisodeFixture();
  let readable = false;
  const flaky = makePermissionPromptReader({ db: f.db, log: () => {},
    getLatestHook: destination => f.store.getLatestForNode({ sessionName: destination, order: "source" }),
    getPromptStart: (destination, generation) => {
      if (!readable) throw new Error("retained events unreadable");
      return f.store.findPermissionPromptStart({ sessionName: destination, generation });
    } });
  const open = () => repo.list({ limit: 100 }).filter(r => r.tags?.includes("wake-prompt-refusal")
    && ["pending", "in-progress", "blocked"].includes(r.state));
  await later(0, "Notification", "permission_prompt");
  await tick(flaky);
  const id = open()[0]!.qitemId;
  expect(repo.getById(id)!.tags).toContain(`prompt-episode:${f.name}|permission-hook:${f.generation}|after:start`);
  await repo.update({ qitemId: id, actorSession: lead, state: "done", closureReason: "no-follow-on" });
  readable = true; // the same retained hook, its start readable now
  await tick(flaky);
  await tick(flaky);
  expect(open()).toEqual([]);
  expect(woken).toEqual([lead]);
  await later(15_000, "Notification", "permission_prompt");
  await tick(flaky);
  expect(open()).toHaveLength(1);
});

it("a new prompt that clears while the tick awaits hook reviews gets no stale wake", async () => {
  const { f, repo, lead, read, woken, tick, later, alerts, newPromptNotes } = promptEpisodeFixture();
  await later(0, "Notification", "permission_prompt");
  await tick();
  const id = alerts()[0]!.qitemId;
  await later(14_000, "Notification", "permission_prompt");
  await runWakeLadderTick({ db: f.db, queueRepo: repo, now: f.clock.value, log: () => {},
    resolveOrchestrator: () => lead, readPermissionPrompts: read, retryIntervalSeconds: 1,
    // The seat moves on while this read is pending: its next turn starts, so the second prompt is gone.
    readHookReviews: async () => { await later(1_000, "UserPromptSubmit", null); return []; },
    attemptWake: async (_id, target) => { woken.push(target); return "verified"; } });
  expect(woken).toEqual([lead]);
  expect(newPromptNotes(id)).toEqual([]);
});

it.each([
  ["its hook read fails, so it returns unknown", "hook"],
  ["its start read fails, so it returns blocked without a start", "start"],
] as const)("a new prompt the reread can't identify stays owed: %s", async (_, failing) => {
  const { f, repo, lead, read, woken, tick, later, alerts, newPromptNotes } = promptEpisodeFixture();
  const broken = makePermissionPromptReader({ db: f.db, log: () => {},
    getLatestHook: destination => {
      if (failing === "hook") throw new Error("retained events unreadable");
      return f.store.getLatestForNode({ sessionName: destination, order: "source" });
    },
    getPromptStart: (destination, generation) => {
      if (failing === "start") throw new Error("retained events unreadable");
      return f.store.findPermissionPromptStart({ sessionName: destination, generation });
    } });
  // The tick's whole-inventory read stays healthy; only its scoped reread of the seat goes through the failing reader.
  let scopedFails = false;
  const reader = (destination?: string) => destination !== undefined && scopedFails ? broken(destination) : read(destination);
  await later(0, "Notification", "permission_prompt");
  await tick(reader);
  const id = alerts()[0]!.qitemId;
  const second = await later(14_000, "Notification", "permission_prompt");
  scopedFails = true;
  await tick(reader);
  await tick(reader);
  expect(woken).toEqual([lead]);
  expect(newPromptNotes(id)).toEqual([]);
  expect(repo.getById(id)!.tags!.some(t => t.includes(`|prompt:${second}|`))).toBe(false);
  scopedFails = false;
  await tick(reader);
  await tick(reader);
  expect(woken).toEqual([lead, lead]);
  expect(newPromptNotes(id)).toHaveLength(1);
  expect(newPromptNotes(id)[0]!.transitionNote).toContain(`woke ${lead} outcome=verified`);
});

it("a new prompt's wake that a drain defers stays owed on a pending alert, and goes once when the drain lets go", async () => {
  const { f, repo, lead, read, later, alerts, newPromptNotes } = promptEpisodeFixture();
  let draining = false;
  const attempts: string[] = [];
  const tick = () => runWakeLadderTick({ db: f.db, queueRepo: repo, now: f.clock.value, log: () => {},
    resolveOrchestrator: () => lead, readPermissionPrompts: read, retryIntervalSeconds: 1,
    attemptWake: async (_id, target) => { if (draining) return "deferred:rig_delivery_drain"; attempts.push(target); return "verified"; } });
  await later(0, "Notification", "permission_prompt");
  await tick();
  const id = alerts()[0]!.qitemId;
  expect(repo.getById(id)!.state).toBe("pending");
  await later(14_000, "Notification", "permission_prompt");
  draining = true;
  await tick();
  expect(newPromptNotes(id)).toEqual([]);
  draining = false;
  const before = attempts.length;
  await tick();
  await tick();
  expect(newPromptNotes(id)).toHaveLength(1);
  expect(newPromptNotes(id)[0]!.transitionNote).toContain(`woke ${lead} outcome=verified`);
  expect(attempts.slice(before)).toContain(lead);
});

// The production wake path, through the repository's delivery ID to a transport that keeps native input's receipt rule: a
// known delivery ID returns its earlier receipt and offers no new input.
it("each new prompt's owner wake is its own delivery, and a repeat of one prompt's wake reuses that delivery", async () => {
  const { f, repo, lead, leadNode, read, later, alerts, newPromptNotes } = promptEpisodeFixture();
  new SessionRegistry(f.db).updateBinding(leadNode.id, { tmuxSession: lead });
  const sends: string[] = [], inputs = new Set<string>();
  repo.attachTransport({ send: async (_session, _text, opts) => {
    sends.push(opts!.deliveryId!);
    inputs.add(opts!.deliveryId!);
    return { ok: true, verified: true };
  } });
  const tick = () => runWakeLadderTick({ db: f.db, queueRepo: repo, now: f.clock.value, log: () => {},
    resolveOrchestrator: () => lead, readPermissionPrompts: read, retryIntervalSeconds: 1 });
  await later(0, "Notification", "permission_prompt");
  await tick();
  const id = alerts()[0]!.qitemId;
  expect(inputs.size).toBe(1); // the orchestrator rung, for the first prompt
  const second = await later(14_000, "Notification", "permission_prompt");
  await tick();
  await tick();
  expect(newPromptNotes(id)).toHaveLength(1);
  expect(inputs.size).toBe(2); // new input, not the first wake's receipt
  // The second prompt's handled mark is lost (a crash between its send and its tag write), so its wake goes again.
  const tags = repo.getById(id)!.tags!.filter(t => !t.includes(`|prompt:${second}|`));
  f.db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(JSON.stringify(tags), id);
  await tick();
  expect(sends).toHaveLength(3);
  expect(sends[2]).toBe(sends[1]);
  expect(inputs.size).toBe(2);
});

it("after a drain defers the first rung, a new prompt on the pending alert gets one wake in the tick, from the rung", async () => {
  const { f, repo, lead, read, later, alerts, newPromptNotes } = promptEpisodeFixture();
  let draining = true;
  const attempts: string[] = [];
  const tick = () => runWakeLadderTick({ db: f.db, queueRepo: repo, now: f.clock.value, log: () => {},
    resolveOrchestrator: () => lead, readPermissionPrompts: read, retryIntervalSeconds: 1,
    attemptWake: async (_id, target) => { if (draining) return "deferred:rig_delivery_drain"; attempts.push(target); return "verified"; } });
  await later(0, "Notification", "permission_prompt");
  await tick();
  const id = alerts()[0]!.qitemId;
  expect(attempts).toEqual([]);
  expect(repo.getById(id)!.state).toBe("pending");
  const second = await later(14_000, "Notification", "permission_prompt");
  draining = false;
  await tick();
  expect(attempts).toEqual([lead]);
  expect(newPromptNotes(id)).toEqual([]);
  expect(repo.getById(id)!.tags!.some(t => t.includes(`|prompt:${second}|`))).toBe(true);
  expect(repo.listTransitions(id).some(t => t.transitionNote?.startsWith(`escalation-rung: orchestrator -> ${lead} outcome=verified`))).toBe(true);
  await tick();
  expect(attempts).toEqual([lead]);
});

// The rung's wake was delivered on native input, then a restart lost its markers before they were written. A prompt that
// joins after that is in the rung's resend, which is a new delivery, not the first one's receipt.
it("a rung delivered on native input whose markers were lost: once a new prompt joins, the rung's resend is new input", async () => {
  const { f, repo, lead, leadNode, read, later, alerts } = promptEpisodeFixture();
  new SessionRegistry(f.db).updateBinding(leadNode.id, { tmuxSession: lead });
  const inputs = new Set<string>();
  repo.attachTransport({ send: async (_session, _text, opts) => {
    inputs.add(opts!.deliveryId!); // a known delivery ID returns its receipt and offers nothing new, as native input does
    return { ok: true, verified: true };
  } });
  const tick = () => runWakeLadderTick({ db: f.db, queueRepo: repo, now: f.clock.value, log: () => {},
    resolveOrchestrator: () => lead, readPermissionPrompts: read, retryIntervalSeconds: 1 });
  await later(0, "Notification", "permission_prompt");
  await tick();
  const id = alerts()[0]!.qitemId;
  expect(inputs.size).toBe(1);
  f.db.prepare("DELETE FROM queue_transitions WHERE qitem_id = ? AND (transition_note LIKE 'escalation-rung:%' OR transition_note LIKE 'ladder-exhausted:%')").run(id);
  await later(14_000, "Notification", "permission_prompt");
  await tick();
  expect(inputs.size).toBe(2);
  await tick();
  expect(inputs.size).toBe(2);
});
