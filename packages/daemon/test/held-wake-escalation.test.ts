// A wake the send gate holds (a latest person-waiting hook over an unreadable pane) must still reach someone.
// The gate reads the store's retained hook; the wake ladder must read the same evidence through the production
// reader, also after the activity service is rebuilt and for a hook source the oracle does not yet trust (Codex).
// Harness adapted from review50-r2's PR #1001 review (real hook route, SQLite store, activity service, transport,
// parked-owner policy, queue and ladder; only terminal I/O and the final orchestrator delivery are inert).
import { it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { activityRoutes } from "../src/routes/activity.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeParkedOwnerConsumerPolicy, makeRigAnchor, PARKED_OWNER_POLICY_NAME, REFUSED_PREFIX } from "../src/domain/policies/parked-owner-consumer.js";
import { runWakeLadderTick, makePromptStateReader, classifyPromptAfterRefusal, queueRecoveryOwnsWake } from "../src/domain/queue-wake-ladder.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(runtime = "claude-code") {
  const db = createFullTestDb(); databases.push(db);
  const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), bus = new EventBus(db);
  const rig = rigRepo.createRig("r1001"), node = rigRepo.addNode(rig.id, "worker.a", { role: "worker", runtime });
  const name = "worker-a@r1001", session = sessionRegistry.registerSession(node.id, name);
  sessionRegistry.updateStatus(session.id, "running"); sessionRegistry.updateBinding(node.id, { tmuxSession: name });
  const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
  const clock = { value: new Date() }, now = () => clock.value;
  let currentGeneration: string | null = generation;
  const store = new AgentActivityStore({ db, eventBus: bus, now,
    resolveOccupantGeneration: () => currentGeneration,
    isRegisteredOccupantGeneration: (id, g) => Boolean(db.prepare("SELECT 1 FROM occupant_tenures WHERE node_id=? AND generation_uuid=?").get(id, g)),
  });
  const paste = vi.fn(async () => ({ ok: true as const })), enter = vi.fn(async () => ({ ok: true as const }));
  const tmux = { hasSession: async () => true, probeSession: async () => ({ state: "present" as const }),
    getPaneCommand: async () => runtime === "codex" ? "codex" : "claude", getPanePid: async () => null,
    listPanes: async () => [], hasSessionEnv: async () => false, capturePaneContent: async () => "unrecognized provider content",
    sendText: paste, sendKeys: enter, readPaneLastActivity: async () => now().getTime() / 1000 - 120,
  };
  const newOracle = () => new SeatActivityService({ tmux: tmux as never, defaultWindowSeconds: 3, now });
  let oracle = newOracle();
  const app = new Hono();
  app.use("*", async (c, next) => {
    for (const [key, value] of Object.entries({ agentActivityStore: store, seatActivityService: oracle,
      activityHookToken: "local-fixture-token", sessionRegistry, eventBus: bus })) c.set(key as never, value as never);
    await next();
  });
  app.route("/activity", activityRoutes);
  async function hook(event: string, subtype: string | null, ageMs: number) {
    const r = await app.request("/activity/hooks", { method: "POST", headers: { "content-type": "application/json",
      "x-openrig-activity-token": "local-fixture-token" }, body: JSON.stringify({ runtime, sessionName: name,
        generation, hookEvent: event, subtype, occurredAt: new Date(now().getTime() - ageMs).toISOString() }) });
    expect(r.status).toBe(200);
  }
  const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux as never, agentActivityStore: store,
    now, sleep: async () => undefined, activityEndpointFile: () => null });
  // The production composition (index.ts): the oracle first, then the gate's retained-hook evidence.
  const readPromptState = makePromptStateReader({ db,
    getSeatState: (nodeId) => oracle.getSeatState(nodeId),
    getLatestHook: (sessionName) => store.getLatestForNode({ sessionName }) });
  return { db, bus, node, name, hook, transport, paste, enter, clock, readPromptState,
    oracle: () => oracle, reconstruct: () => { oracle = newOracle(); },
    changeGeneration: (g: string | null) => { currentGeneration = g; } };
}

async function refuseAndClimb(f: ReturnType<typeof fixture>, oracleAlone?: "unknown") {
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
    // These cases need the gate's evidence: the in-memory oracle alone has none.
    if (oracleAlone) expect(classifyPromptAfterRefusal(f.oracle().getSeatState(f.node.id), refused!.ts)).toBe(oracleAlone);
    const result = await runWakeLadderTick({ db: f.db, queueRepo: repo, now: f.clock.value,
      resolveOrchestrator: () => "lead@r1001", readPromptState: f.readPromptState,
      retryIntervalSeconds: 1, attemptWake: async (_id, target) => { targets.push(target); return "verified"; }, log: () => {} });
    expect(result.outcome).not.toBe("failed");
  }
  expect(f.paste).not.toHaveBeenCalled();
  expect(f.enter).not.toHaveBeenCalled();
  expect(repo.getById(row.qitemId)?.state).toBe("in-progress");
  return targets;
}

it.each([false, true])("a held Claude wake escalates to the orchestrator (activity service rebuilt=%s)", async (rebuilt) => {
  const f = fixture();
  await f.hook("Notification", "permission_prompt", 600_000);
  if (rebuilt) f.reconstruct(); // same durable DB and occupant, a new daemon service
  expect(await refuseAndClimb(f, rebuilt ? "unknown" : undefined)).toContain("lead@r1001");
});

it("a held Codex wake escalates to the orchestrator (a PermissionRequest hook the oracle may not trust yet)", async () => {
  const f = fixture("codex");
  await f.hook("PermissionRequest", null, 600_000);
  expect(await refuseAndClimb(f, "unknown")).toContain("lead@r1001");
});

it("the reader keeps the oracle's verdicts and ends the hold on newer or foreign evidence", async () => {
  const f = fixture();
  const refusedAt = new Date(f.clock.value.getTime() - 30_000).toISOString();
  await f.hook("Notification", "permission_prompt", 600_000);
  expect(f.readPromptState(f.name, refusedAt)).toBe("blocked");
  // A successor generation's oracle-free read does not revive the previous occupant's hook.
  f.changeGeneration("successor-generation");
  expect(f.readPromptState(f.name, refusedAt)).toBe("unknown");
  f.changeGeneration(null);
  expect(f.readPromptState(f.name, refusedAt)).toBe("unknown");
  const g = fixture();
  await g.hook("Notification", "permission_prompt", 600_000);
  await g.hook("UserPromptSubmit", null, 20_000); // answered: a newer hook ends the retained hold
  expect(g.readPromptState(g.name, refusedAt)).toBe("unknown");
  // An oracle verdict, when it has one, still decides.
  const clearReader = makePromptStateReader({ db: g.db,
    getSeatState: () => ({ activity: "idle-at-prompt", needsInput: { count: 0, reason: null },
      needsInputEvidence: { observedAt: g.clock.value.toISOString() } }) as never,
    getLatestHook: () => ({ state: "needs_input", evidenceSource: "runtime_hook", reason: "permission_prompt", sampledAt: g.clock.value.toISOString() }) as never });
  expect(clearReader(g.name, refusedAt)).toBe("clear");
});
