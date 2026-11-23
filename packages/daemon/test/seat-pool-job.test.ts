import { describe, it, expect, vi } from "vitest";
import type Database from "better-sqlite3";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { SeatPoolSlotsRepository, type SeatPoolSlotPhase } from "../src/domain/seat-pool-slots.js";
import type { SeatPoolSpec } from "../src/domain/seat-pool-spec.js";
import { WatchdogJobsRepository, type WatchdogJob } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { makeSeatPoolPolicy, planSeatPool } from "../src/domain/policies/seat-pool.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { nodeExecutorConfirmedStopped } from "../src/domain/node-inventory.js";
import {
  makeSeatPoolExecutor,
  readSeatPoolState,
  seatPoolQueueEffects,
  type SeatPoolExecutorDeps,
} from "../src/domain/seat-pool-executor.js";
import type { ArbitratedSeatState } from "../src/domain/activity-taxonomy.js";
import {
  reconcileSeatPoolNode,
  reconcileSeatPoolsAtStartup,
  resolveSeatPoolModel,
  seatPoolJobInput,
  type SeatPoolReconcileResult,
} from "../src/domain/seat-pool-registration.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// #3395 (Piece 1): the seat-pool job, one per model member, registered by the registration module. Nothing in the
// daemon calls that module or runs the policy yet, so these tests call the module themselves and evaluate the job with
// an engine of their own that has the seat-pool policy, composed with the executor as startup composes it.

const AT = "2026-11-18T10:00:00.000Z";
const RIG_ROOT = "/project/rigs/pool-rig";

// Every field off its default, so a field read from the wrong place shows.
const SPEC: SeatPoolSpec = {
  max: 4, min: 1, dispatchAfterSeconds: 45, idleGraceSeconds: 120, cooldownSeconds: 90,
  dispatchTag: "role:impl", cwdTemplate: "/work/{rig}/{slot}", drain: false,
};
const BLOCK = { max: 4, min: 1, dispatch_after_s: 45, idle_grace_s: 120, cooldown_s: 90, dispatch_tag: "role:impl", cwd_template: "/work/{rig}/{slot}" };

type Model = { rigId: string; nodeId: string; logicalId: string; podId: string | null; session: string };

/** The pool's world: the repositories, an engine that has the seat-pool policy and its executor, and the
 *  registration's deps. */
/** Every migration: the executor reads the outbox's held messages and the engine writes its history. */
function fullDb(): Database.Database {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  return db;
}

function world(db: Database.Database = fullDb()) {
  const rigRepo = new RigRepository(db);
  const podRepo = new PodRepository(db);
  const slots = new SeatPoolSlotsRepository(db);
  const jobsRepo = new WatchdogJobsRepository(db);
  const history = new WatchdogHistoryLog(db);
  const bus = new EventBus(db);
  const sessions = new SessionRegistry(db);
  const queue = new QueueRepository(db, bus, { resolveSessionAddresses: (name) => sessions.sessionAddresses(name) });
  const outbox = new OutboxHandler(db);
  queue.attachOutbox(outbox);
  const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
  /** Each node's activity, as the seat activity service would give it. */
  const activity = new Map<string, ArbitratedSeatState>();
  const clock = { now: new Date(Date.now() + 3_600_000) }; // past every row's dispatch_after_s
  const executorDeps: SeatPoolExecutorDeps = {
    db, rigRepo, slots, jobsRepo, queue: seatPoolQueueEffects(queue),
    heldCount: (id) => outbox.heldCount(id),
    confirmedStopped: (id) => nodeExecutorConfirmedStopped(db, id),
    seatState: (id) => activity.get(id) ?? null,
    custody: (ids, fn) => guard.custody(ids, fn),
    now: () => clock.now,
  };
  /** An engine and an executor over this database: a new pair is what a daemon restart gives. */
  const compose = () => {
    const executor = makeSeatPoolExecutor(executorDeps);
    const engine = new WatchdogPolicyEngine({
      jobsRepo,
      historyLog: history,
      eventBus: bus,
      deliver: async () => ({ status: "ok" }),
      additionalPolicies: [makeSeatPoolPolicy({ cycle: (job) => executor.cycle(job) })],
    });
    return { executor, engine };
  };
  const { engine, executor } = compose();
  const warn = vi.fn<(message: string) => void>();
  const reg = { db, rigRepo, jobsRepo, warn };

  /** A model member with a stored block, in a rig of its own. */
  const model = (rigName: string): Model => {
    const rig = rigRepo.createRig(rigName);
    const pod = podRepo.createPod(rig.id, "dev", "Dev");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: pod.id, pool: { spec: SPEC } });
    return { rigId: rig.id, nodeId: node.id, logicalId: node.logicalId, podId: pod.id, session: `dev-impl@${rigName}` };
  };
  /** A pool agent of a model: its node and its slot row, seeded straight into the table. */
  const agent = (m: Pick<Model, "rigId" | "nodeId" | "logicalId" | "podId">, n: number, phase: SeatPoolSlotPhase) => {
    const node = rigRepo.addNode(m.rigId, `${m.logicalId}-s${n}`, { runtime: "claude-code", ...(m.podId ? { podId: m.podId } : {}) });
    slots.insert({ modelNodeId: m.nodeId, slotNumber: n, nodeId: node.id, phase, at: AT });
    return node;
  };
  const jobRows = (session: string) => db.prepare(
    "SELECT job_id AS jobId, state FROM watchdog_jobs WHERE policy = 'seat-pool' AND target_session = ? ORDER BY registered_at, job_id",
  ).all(session) as Array<{ jobId: string; state: string }>;
  const nonterminal = (session: string) => jobRows(session).filter((row) => row.state !== "terminal");
  const evaluate = async (jobId: string) => (await engine.evaluate(jobsRepo.getByIdOrThrow(jobId))).outcome;
  return {
    db, rigRepo, podRepo, slots, jobsRepo, history, engine, executor, executorDeps, compose, sessions, queue, activity, clock,
    warn, reg, model, agent, jobRows, nonterminal, evaluate,
  };
}

/** A seat idle at its prompt since `changedAt`, with nothing asked of it and no background work. */
function idleState(nodeId: string, changedAt: string): ArbitratedSeatState {
  return {
    seatNodeId: nodeId, activity: "idle-at-prompt", needsInput: { count: 0 }, needsInputEvidence: null, backgroundWork: null,
    decidedBy: null, seq: 1, changedAt, rungs: [], lastSwap: null,
  } as unknown as ArbitratedSeatState;
}

/** The `context` of a job's spec: the model node id and the block it was last ensured with. */
const contextOf = (job: WatchdogJob) => (parseYaml(job.specYaml) as { context: Record<string, unknown> }).context;

const jobOf = (result: SeatPoolReconcileResult): WatchdogJob => {
  if (!("job" in result)) throw new Error(`no job: ${JSON.stringify(result)}`);
  return result.job;
};

// The instantiator, for the controls that re-apply the spec the way `rig launch` does.
function mockTmux(): TmuxAdapter {
  return {
    startServer: vi.fn(async () => {}),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    probeSession: vi.fn(async () => ({ state: "absent" as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

function mockAdapter(runtime: string): RuntimeAdapter {
  return {
    runtime,
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
}

function instantiatorWorld() {
  const w = world();
  const sessionRegistry = new SessionRegistry(w.db);
  const eventBus = new EventBus(w.db);
  const tmux = mockTmux();
  const nodeLauncher = new NodeLauncher({ db: w.db, rigRepo: w.rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const startupOrchestrator = new StartupOrchestrator({ db: w.db, sessionRegistry, eventBus, tmuxAdapter: tmux, sleep: async () => {} });
  const files: Record<string, string> = {
    [`${RIG_ROOT}/agents/impl/agent.yaml`]: `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`,
  };
  const fsOps: AgentResolverFsOps = {
    readFile: (p: string) => { if (p in files) return files[p]!; throw new Error(`Not found: ${p}`); },
    exists: (p: string) => p in files,
  };
  const inst = new PodRigInstantiator({
    db: w.db, rigRepo: w.rigRepo, podRepo: w.podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
    fsOps, adapters: { "claude-code": mockAdapter("claude-code"), codex: mockAdapter("codex"), terminal: mockAdapter("terminal") },
    tmuxAdapter: tmux,
  } as unknown as ConstructorParameters<typeof PodRigInstantiator>[0]);
  /** The rig spec, with the `pool` key only when given. */
  const spec = (pool?: unknown) => stringifyYaml({
    version: "0.2", name: "pool-rig",
    pods: [{
      id: "dev", label: "Dev",
      members: [{ id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "codex", cwd: ".", ...(pool === undefined ? {} : { pool }) }],
      edges: [],
    }],
    edges: [],
  });
  /** Free the seats so the next launch re-applies the spec instead of refusing a running seat. */
  const clearOccupancy = (rigId: string) => {
    for (const s of sessionRegistry.getSessionsForRig(rigId)) {
      sessionRegistry.markDetached(s.id);
      sessionRegistry.clearBinding(s.nodeId);
    }
  };
  /** Re-apply the spec over the rig, as `rig launch` does, and then reconcile the model node, as the arm will. */
  const reapply = async (rigId: string, modelNodeId: string, pool?: unknown) => {
    clearOccupancy(rigId);
    const launched = await inst.launchMaterialized(spec(pool), RIG_ROOT, rigId);
    expect(launched, JSON.stringify(launched)).toMatchObject({ ok: true });
    return reconcileSeatPoolNode(w.reg, modelNodeId);
  };
  const materialize = async (pool?: unknown) => {
    const mat = await inst.materialize(spec(pool), RIG_ROOT);
    if (!mat.ok) throw new Error(JSON.stringify(mat));
    const rig = w.rigRepo.getRig(mat.result.rigId)!;
    const node = rig.nodes.find((n) => n.logicalId === "dev.impl")!;
    const m = { rigId: rig.rig.id, nodeId: node.id, logicalId: node.logicalId, podId: node.podId ?? null, session: "dev-impl@pool-rig" };
    return m;
  };
  return { ...w, inst, spec, reapply, materialize };
}

describe("seat-pool job registration (#3395 Piece 1)", () => {
  it("After the job ends (`terminal`), the next ensure registers exactly one replacement, which finds the same agents through the model node.", async () => {
    const w = world();
    try {
      const m = w.model("pool-rig");
      const first = reconcileSeatPoolNode(w.reg, m.nodeId);
      expect(first).toMatchObject({ nodeId: m.nodeId, outcome: "registered", replaced: "none" });
      expect(jobOf(first)).toMatchObject({
        policy: "seat-pool", targetSession: m.session, targetGeneration: null, registeredBySession: "daemon@kernel", intervalSeconds: 60, state: "active",
      });
      expect(contextOf(jobOf(first))).toEqual({ model_node_id: m.nodeId, pool: { ...BLOCK, drain: false } });
      const a1 = w.agent(m, 1, "live");
      const a2 = w.agent(m, 2, "drained");
      // another model's pool, in another rig: its agents are not this job's
      const other = w.model("other-rig");
      const otherAgent = w.agent(other, 1, "live");
      const otherJob = jobOf(reconcileSeatPoolNode(w.reg, other.nodeId));
      const before = await w.evaluate(jobOf(first).jobId);

      w.jobsRepo.markTerminal(jobOf(first).jobId, "ended");
      const next = reconcileSeatPoolNode(w.reg, m.nodeId);
      expect(next).toMatchObject({ outcome: "registered", replaced: "terminal" });
      const replacement = jobOf(next);
      expect(replacement.jobId).not.toBe(jobOf(first).jobId);
      expect(w.nonterminal(m.session)).toEqual([{ jobId: replacement.jobId, state: "active" }]);
      expect(w.jobRows(m.session)).toHaveLength(2);
      // a second ensure keeps that one job
      expect(reconcileSeatPoolNode(w.reg, m.nodeId)).toMatchObject({ outcome: "active", job: { jobId: replacement.jobId } });
      expect(w.nonterminal(m.session)).toHaveLength(1);

      const slots = [
        { slotNumber: 1, nodeId: a1.id, phase: "live" },
        { slotNumber: 2, nodeId: a2.id, phase: "drained" },
      ];
      const after = await w.evaluate(replacement.jobId);
      expect(after).toEqual({
        action: "skip", reason: "seat_pool_report",
        notes: { modelNodeId: m.nodeId, block: "stored", spec: SPEC, slots },
      });
      expect(after).toEqual(before);
      expect(w.history.listForJob(replacement.jobId)[0]?.evaluationNotes).toMatchObject({ modelNodeId: m.nodeId, slots });
      expect(await w.evaluate(otherJob.jobId)).toMatchObject({
        notes: { modelNodeId: other.nodeId, slots: [{ slotNumber: 1, nodeId: otherAgent.id, phase: "live" }] },
      });
    } finally {
      w.db.close();
    }
  });

  it("`pool: {}` and then the block again keeps the same agents and exactly one job.", async () => {
    const w = instantiatorWorld();
    try {
      const m = await w.materialize(BLOCK);
      const job = jobOf(reconcileSeatPoolNode(w.reg, m.nodeId));
      const a1 = w.agent(m, 1, "live");
      const a2 = w.agent(m, 2, "drained");
      const slotsBefore = w.slots.forModel(m.nodeId);

      // `pool: {}` clears the stored block; the reconcile does not arm a node with no block and leaves the job be
      expect(await w.reapply(m.rigId, m.nodeId, {})).toEqual({ nodeId: m.nodeId, outcome: "no_block" });
      expect(w.rigRepo.getNodePool(m.nodeId)).toBeUndefined();
      expect(w.nonterminal(m.session)).toEqual([{ jobId: job.jobId, state: "active" }]);

      // the block again: the same job, refreshed with it, and the same agents
      const again = await w.reapply(m.rigId, m.nodeId, { ...BLOCK, max: 6 });
      expect(again).toMatchObject({ outcome: "active", job: { jobId: job.jobId } });
      expect(contextOf(jobOf(again))).toEqual({ model_node_id: m.nodeId, pool: { ...BLOCK, max: 6, drain: false } });
      expect(w.jobRows(m.session)).toEqual([{ jobId: job.jobId, state: "active" }]);
      expect(w.slots.forModel(m.nodeId)).toEqual(slotsBefore);
      expect(w.rigRepo.getRig(m.rigId)!.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([m.nodeId, a1.id, a2.id]));
      expect(await w.evaluate(job.jobId)).toMatchObject({
        notes: {
          block: "stored", spec: { ...SPEC, max: 6 },
          slots: [{ slotNumber: 1, nodeId: a1.id, phase: "live" }, { slotNumber: 2, nodeId: a2.id, phase: "drained" }],
        },
      });
    } finally {
      w.db.close();
    }
  });

  it("A re-apply without the `pool` key changes nothing: same stored block, same job, same slots.", async () => {
    const w = instantiatorWorld();
    try {
      const m = await w.materialize(BLOCK);
      const job = jobOf(reconcileSeatPoolNode(w.reg, m.nodeId));
      w.agent(m, 1, "live");
      w.agent(m, 2, "draining");
      const blockBefore = w.rigRepo.getNodePool(m.nodeId);
      const slotsBefore = w.slots.forModel(m.nodeId);
      expect(blockBefore).toEqual({ spec: SPEC });

      const again = await w.reapply(m.rigId, m.nodeId);
      expect(again).toMatchObject({ outcome: "active", job: { jobId: job.jobId, specYaml: job.specYaml, state: "active" } });
      expect(w.rigRepo.getNodePool(m.nodeId)).toEqual(blockBefore);
      expect(w.slots.forModel(m.nodeId)).toEqual(slotsBefore);
      expect(w.jobRows(m.session)).toEqual([{ jobId: job.jobId, state: "active" }]);
    } finally {
      w.db.close();
    }
  });
});

describe("the seat-pool job and the operator's stop (#3395 Piece 1)", () => {
  it("A job the operator stopped stays `stopped` across re-apply and daemon restart, takes the new spec, and makes no add, drain or move.", async () => {
    const w = instantiatorWorld();
    try {
      const m = await w.materialize(BLOCK);
      const job = jobOf(reconcileSeatPoolNode(w.reg, m.nodeId));
      const s1 = w.agent(m, 1, "live");
      const row = await w.queue.create({
        sourceSession: "lead@pool-rig", destinationSession: m.session, body: "work", nudge: false, tags: [SPEC.dispatchTag!],
      });

      expect(w.jobsRepo.stop(job.jobId).state).toBe("stopped");
      const reapplied = await w.reapply(m.rigId, m.nodeId, { ...BLOCK, max: 6 });
      expect(reapplied).toMatchObject({ outcome: "stopped", job: { jobId: job.jobId, state: "stopped" } });
      expect(contextOf(w.jobsRepo.getByIdOrThrow(job.jobId)).pool).toMatchObject({ max: 6 });

      // s1 is free once the re-apply is done (it detaches the seats' sessions): a plan would move the row to it
      const session = w.sessions.registerSession(s1.id, "dev-impl-s1@pool-rig");
      w.sessions.updateStatus(session.id, "running");
      w.activity.set(s1.id, idleState(s1.id, AT));
      const read = readSeatPoolState(w.executorDeps, resolveSeatPoolModel(w.db, m.nodeId)!, w.slots.forModel(m.nodeId));
      expect(planSeatPool({ ...SPEC, max: 6 }, read, w.clock.now.getTime()).intents)
        .toContainEqual({ kind: "dispatch", qitemId: row.qitemId, from: m.session, slotNumber: 1 });
      const slotsBefore = w.slots.forModel(m.nodeId);

      // daemon restart: the start loop, then a new engine and executor over the same database
      expect(reconcileSeatPoolsAtStartup(w.reg)).toContainEqual(expect.objectContaining({ nodeId: m.nodeId, outcome: "stopped" }));
      const restarted = w.compose();
      const stored = w.jobsRepo.getByIdOrThrow(job.jobId);
      expect(stored.state).toBe("stopped");
      expect(contextOf(stored).pool).toMatchObject({ max: 6 });

      for (const engine of [w.engine, restarted.engine]) {
        expect((await engine.evaluate(w.jobsRepo.getByIdOrThrow(job.jobId))).outcome).toMatchObject({ action: "skip", reason: "job_not_active" });
      }
      const direct = await restarted.executor.cycle({ jobId: job.jobId, context: contextOf(stored) });
      expect(direct).toMatchObject({ action: "skip", reason: "seat_pool_report", notes: { held: { cause: "job stopped", message: "held: job stopped" } } });
      expect((direct as { notes?: Record<string, unknown> }).notes).not.toHaveProperty("moved");

      expect(w.jobsRepo.getByIdOrThrow(job.jobId).state).toBe("stopped");
      expect(w.queue.getById(row.qitemId)).toMatchObject({ state: "pending", destinationSession: m.session });
      expect(w.queue.transitionLog.listForQitem(row.qitemId).some((t) => t.actorSession === "system:queue-fallback")).toBe(false);
      expect(w.slots.forModel(m.nodeId)).toEqual(slotsBefore);
    } finally {
      w.db.close();
    }
  });
});

describe("seat-pool job registration: also tested, without a numbered control", () => {
  it("At daemon start, a node with an ambiguous seat-pool job is logged and gets no job picked, and a node that throws does not stop the others.", () => {
    const w = world();
    try {
      const alpha = w.model("alpha");
      const bravo = w.model("bravo");
      const charlie = w.model("charlie");
      const delta = w.model("delta");
      const noBlock = w.rigRepo.addNode(alpha.rigId, "dev.plain", { runtime: "claude-code", ...(alpha.podId ? { podId: alpha.podId } : {}) });
      const deltaJob = jobOf(reconcileSeatPoolNode(w.reg, delta.nodeId));
      w.db.prepare("UPDATE watchdog_jobs SET state = 'paused' WHERE job_id = ?").run(deltaJob.jobId);
      const bravoModel = resolveSeatPoolModel(w.db, bravo.nodeId)!;
      const dup1 = w.jobsRepo.register(seatPoolJobInput(bravoModel, SPEC));
      const dup2 = w.jobsRepo.register(seatPoolJobInput(bravoModel, SPEC));
      const ensure = w.jobsRepo.ensureAutoRegistration.bind(w.jobsRepo);
      vi.spyOn(w.jobsRepo, "ensureAutoRegistration").mockImplementation((input, aliases) => {
        if (input.targetSession === alpha.session) throw new Error("disk I/O error");
        return ensure(input, aliases);
      });

      const results = reconcileSeatPoolsAtStartup(w.reg);
      expect(results.map((r) => [r.nodeId, r.outcome])).toEqual([
        [alpha.nodeId, "failed"],
        [bravo.nodeId, "ambiguous"],
        [charlie.nodeId, "registered"],
        [delta.nodeId, "ambiguous"],
      ]);
      expect(results.map((r) => r.nodeId)).not.toContain(noBlock.id);
      expect(results[1]).toMatchObject({ code: "auto_registration_ambiguous" });
      expect(results[3]).toMatchObject({ code: "auto_registration_state_invalid" });
      expect(w.jobRows(delta.session)).toEqual([{ jobId: deltaJob.jobId, state: "paused" }]);
      // no row picked: both stay as they were, neither retired
      expect(w.jobRows(bravo.session)).toEqual(
        [{ jobId: dup1.jobId, state: "active" }, { jobId: dup2.jobId, state: "active" }].sort((a, b) => a.jobId.localeCompare(b.jobId)),
      );
      expect(w.nonterminal(alpha.session)).toEqual([]);
      expect(w.nonterminal(charlie.session)).toHaveLength(1);
      const warnings = w.warn.mock.calls.map((call) => call[0]);
      expect(warnings).toHaveLength(3);
      expect(warnings[0]).toContain(`node_id="${alpha.nodeId}"`);
      expect(warnings[0]).toContain("disk I/O error");
      expect(warnings[1]).toContain(`node_id="${bravo.nodeId}"`);
      expect(warnings[1]).toContain("auto_registration_ambiguous");
      expect(warnings[1]).toContain(dup1.jobId);
      expect(warnings[1]).toContain(dup2.jobId);
      expect(warnings[2]).toContain(`node_id="${delta.nodeId}"`);
      expect(warnings[2]).toContain("auto_registration_state_invalid");
      expect(warnings[2]).toContain(deltaJob.jobId);
    } finally {
      w.db.close();
    }
  });

  it("A stored block that can't be read leaves the job as it is, and the job reports the block as unusable.", async () => {
    const w = world();
    try {
      const m = w.model("pool-rig");
      const job = jobOf(reconcileSeatPoolNode(w.reg, m.nodeId));
      w.db.prepare("UPDATE nodes SET pool = ? WHERE id = ?").run(JSON.stringify({ max: 2, min: 5 }), m.nodeId);
      expect(reconcileSeatPoolNode(w.reg, m.nodeId)).toEqual({ nodeId: m.nodeId, outcome: "unusable", error: "pool.max: must be at least min (5)" });
      expect(w.jobsRepo.getByIdOrThrow(job.jobId)).toEqual(job);
      expect(await w.evaluate(job.jobId)).toMatchObject({
        reason: "seat_pool_report", notes: { modelNodeId: m.nodeId, block: "unusable", error: "pool.max: must be at least min (5)" },
      });
    } finally {
      w.db.close();
    }
  });

  it("Stopping the seat-pool job while the pool has agents is allowed, and the agents stay plain members.", async () => {
    const w = world();
    try {
      const m = w.model("pool-rig");
      const job = jobOf(reconcileSeatPoolNode(w.reg, m.nodeId));
      const a1 = w.agent(m, 1, "live");
      const a2 = w.agent(m, 2, "drained");
      const slotsBefore = w.slots.forModel(m.nodeId);

      expect(w.jobsRepo.stop(job.jobId).state).toBe("stopped");
      expect(w.slots.forModel(m.nodeId)).toEqual(slotsBefore);
      const members = w.rigRepo.getRig(m.rigId)!.nodes.filter((n) => n.id === a1.id || n.id === a2.id);
      expect(members.map((n) => n.logicalId).sort()).toEqual(["dev.impl-s1", "dev.impl-s2"]);
      expect(await w.evaluate(job.jobId)).toMatchObject({ action: "skip", reason: "job_not_active" });

      // the next ensure gives it the current block and leaves it stopped
      w.rigRepo.setNodePool(m.nodeId, { spec: { ...SPEC, max: 7 } });
      const ensured = reconcileSeatPoolNode(w.reg, m.nodeId);
      expect(ensured).toMatchObject({ outcome: "stopped", job: { jobId: job.jobId, state: "stopped" } });
      expect(contextOf(jobOf(ensured)).pool).toMatchObject({ max: 7 });
      expect(w.jobRows(m.session)).toEqual([{ jobId: job.jobId, state: "stopped" }]);
    } finally {
      w.db.close();
    }
  });
});
