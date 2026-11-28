import { describe, it, expect, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { nodeExecutorConfirmedStopped } from "../src/domain/node-inventory.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { SeatPoolSlotsRepository, type SeatPoolSlotPhase } from "../src/domain/seat-pool-slots.js";
import type { SeatPoolSpec } from "../src/domain/seat-pool-spec.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { makeSeatPoolPolicy, planSeatPool } from "../src/domain/policies/seat-pool.js";
import { reconcileSeatPoolNode, resolveSeatPoolModel, type SeatPoolReconcileResult } from "../src/domain/seat-pool-registration.js";
import {
  makeSeatPoolExecutor,
  readSeatPoolState,
  seatPoolQueueEffects,
  type SeatPoolExecutorDeps,
} from "../src/domain/seat-pool-executor.js";
import type { ArbitratedSeatState } from "../src/domain/activity-taxonomy.js";
import type { SeatPoolDispatchGuardInput, SeatPoolDispatchGuardVerdict } from "../src/domain/seat-pool-dispatch-guard.js";

// #3395 (Piece 1): the seat-pool executor moves rows waiting for the model, or for a drained agent, to free pool agents.
// The job is unarmed in the daemon, so each test composes the executor and an engine that has the seat-pool policy.

const RIG = "pool-rig";
const SPEC: SeatPoolSpec = {
  max: 4, min: 0, dispatchAfterSeconds: 60, idleGraceSeconds: 300, cooldownSeconds: 60, dispatchTag: null, cwdTemplate: null, drain: false,
};
const IDLE_SINCE = "2026-11-18T10:00:00.000Z";
const FALLBACK_ACTOR = "system:queue-fallback";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** A seat at its prompt (or working), as the seat activity service arbitrates it. */
function seatState(nodeId: string, activity: string, changedAt: string): ArbitratedSeatState {
  return {
    seatNodeId: nodeId, activity, needsInput: { count: 0, reason: null }, needsInputEvidence: null, backgroundWork: null,
    decidedBy: null, seq: 1, changedAt, rungs: [], lastSwap: null,
  } as unknown as ArbitratedSeatState;
}

type AgentStatus = "running" | "idle" | "unknown" | "stopped" | "detached" | null;
type Model = { rigId: string; rigName: string; nodeId: string; logicalId: string; podId: string; session: string };
type Agent = { nodeId: string; session: string; sessionId: string | null };

/** Every migration: the pool reads the outbox's held messages and the engine writes its history. */
function fullDb(): Database.Database {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  return db;
}

/** `guardRunner: false` composes the executor without a dispatch guard runner. */
function poolWorld(db: Database.Database = fullDb(), opts: { guardRunner?: boolean } = {}) {
  const bus = new EventBus(db);
  const rigRepo = new RigRepository(db);
  const podRepo = new PodRepository(db);
  const slots = new SeatPoolSlotsRepository(db);
  const sessions = new SessionRegistry(db);
  /** Each seat's current occupant generation, as the queue stamps it on a claim. */
  const generations = new Map<string, string>();
  const queue = new QueueRepository(db, bus, {
    resolveSessionAddresses: (name) => sessions.sessionAddresses(name),
    resolveOccupantGeneration: (name) => generations.get(name) ?? null,
  });
  const outbox = new OutboxHandler(db);
  queue.attachOutbox(outbox); // a move's wake needs it
  const jobsRepo = new WatchdogJobsRepository(db);
  const history = new WatchdogHistoryLog(db);
  const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
  const activity = new Map<string, ArbitratedSeatState>();
  const clock = { now: new Date(Date.now() + 3_600_000) }; // past dispatch_after_s for rows created now
  /** beforeCustody runs when a cycle, its plan read, asks for the model's custody; afterMove after each real move,
   *  before the cycle sees its result. */
  const hooks: {
    beforeCustody?: () => void; afterMove?: () => void;
    /** The dispatch guard's answer for one move; unset: allow. */
    guard?: (input: SeatPoolDispatchGuardInput) => Promise<SeatPoolDispatchGuardVerdict>;
  } = {};
  /** Every call the executor made to the dispatch guard runner. */
  const guardCalls: SeatPoolDispatchGuardInput[] = [];
  const effects = seatPoolQueueEffects(queue);
  const deps: SeatPoolExecutorDeps = {
    db, rigRepo, slots, jobsRepo,
    queue: { ...effects, moveRow: async (input) => { const result = await effects.moveRow(input); hooks.afterMove?.(); return result; } },
    heldCount: (id) => outbox.heldCount(id),
    confirmedStopped: (id) => nodeExecutorConfirmedStopped(db, id),
    seatState: (id) => activity.get(id) ?? null,
    custody: (ids, fn) => { hooks.beforeCustody?.(); return guard.custody(ids, fn); },
    now: () => clock.now,
    ...(opts.guardRunner === false ? {} : {
      dispatchGuard: async (input: SeatPoolDispatchGuardInput) => {
        guardCalls.push(input);
        return hooks.guard ? hooks.guard(input) : { verdict: "allow" as const };
      },
    }),
  };
  const executor = makeSeatPoolExecutor(deps);
  const engine = new WatchdogPolicyEngine({
    jobsRepo, historyLog: history, eventBus: bus, deliver: async () => ({ status: "ok" }),
    additionalPolicies: [makeSeatPoolPolicy({ cycle: (job) => executor.cycle(job) })],
  });
  const reg = { db, rigRepo, jobsRepo, warn: vi.fn() };

  /** A model member with a stored block, in a rig of its own. */
  const model = (spec: SeatPoolSpec = SPEC, rigName = RIG): Model => {
    const rig = rigRepo.createRig(rigName);
    const pod = podRepo.createPod(rig.id, "dev", "Dev");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: pod.id, pool: { spec } });
    return { rigId: rig.id, rigName, nodeId: node.id, logicalId: node.logicalId, podId: pod.id, session: `dev-impl@${rigName}` };
  };
  /** A pool agent: its node, its slot row and, unless `status` is null, its session. */
  const agent = (m: Model, n: number, phase: SeatPoolSlotPhase, status: AgentStatus = "running", sessionName?: string): Agent => {
    const node = rigRepo.addNode(m.rigId, `${m.logicalId}-s${n}`, { runtime: "claude-code", podId: m.podId });
    slots.insert({ modelNodeId: m.nodeId, slotNumber: n, nodeId: node.id, phase, at: IDLE_SINCE });
    const canonical = `dev-impl-s${n}@${m.rigName}`;
    if (status === null) return { nodeId: node.id, session: canonical, sessionId: null };
    const session = sessions.registerSession(node.id, sessionName ?? canonical);
    if (status === "running" || status === "idle" || status === "unknown") sessions.updateStatus(session.id, status);
    else if (status === "stopped") sessions.markIntentionallyStopped(session.id);
    else sessions.markDetached(session.id);
    return { nodeId: node.id, session: canonical, sessionId: session.id };
  };
  const idle = (a: Agent, changedAt = IDLE_SINCE) => activity.set(a.nodeId, seatState(a.nodeId, "idle-at-prompt", changedAt));
  const working = (a: Agent) => activity.set(a.nodeId, seatState(a.nodeId, "working", IDLE_SINCE));
  const row = async (destination: string, tags?: string[]) => (await queue.create({
    sourceSession: `lead@${RIG}`, destinationSession: destination, body: "work", nudge: false, ...(tags ? { tags } : {}),
  })).qitemId;
  const jobFor = (m: Model) => {
    const result: SeatPoolReconcileResult = reconcileSeatPoolNode(reg, m.nodeId);
    if (!("job" in result)) throw new Error(`no job: ${JSON.stringify(result)}`);
    return result.job;
  };
  const evaluate = async (jobId: string) => (await engine.evaluate(jobsRepo.getByIdOrThrow(jobId))).outcome;
  const lastNotes = (jobId: string) => history.listForJob(jobId)[0]?.evaluationNotes as Record<string, unknown> | undefined;
  const read = (m: Model) => readSeatPoolState(deps, resolveSeatPoolModel(db, m.nodeId)!, slots.forModel(m.nodeId));
  const destinationOf = (qitemId: string) => queue.getById(qitemId)!.destinationSession;
  const rerouted = (qitemId: string) => queue.transitionLog.listForQitem(qitemId).filter((t) => t.actorSession === FALLBACK_ACTOR);
  /** A message held for an agent in the outbox. */
  const holdMessage = (a: Agent, id: string) => outbox.retain(
    { outboxId: id, senderSession: `lead@${RIG}`, destinationSession: a.session, body: "held" },
    { nodeId: a.nodeId, session: a.session, pane: null, occupant: null },
  );
  /** Hold the model's custody until the returned release: a cycle plans, then waits for the lease. */
  const holdModel = (m: Model) => {
    const gate = deferred();
    const planned = deferred();
    hooks.beforeCustody = () => planned.resolve();
    const lease = guard.custody([m.nodeId], () => gate.promise);
    return { planned: planned.promise, release: async () => { hooks.beforeCustody = undefined; gate.resolve(); await lease; } };
  };
  /** The node executor's confirmed stop for an agent's current session (the pane exited), as the identity reconciler
   *  records it. */
  const paneExited = (a: Agent) => new SeatIdentityStore(db).upsert({
    nodeId: a.nodeId, sessionName: a.session, verdict: "pane_missing", reason: "pane_exited", evidenceSource: "tmux_session",
    evidence: { registeredPane: null, observedPid: null, observedCommand: null, matchedLayer: null },
    observedAt: new Date(Date.now() + 1000).toISOString(),
  });
  return {
    db, bus, rigRepo, slots, sessions, generations, queue, outbox, jobsRepo, history, guard, activity, clock, hooks,
    guardCalls, deps, executor, engine, model, agent, idle, working, row, jobFor, evaluate, lastNotes, read, destinationOf,
    rerouted, holdMessage, holdModel, paneExited,
  };
}

describe("seat-pool dispatch: the move under the model's custody (#3395 Piece 1)", () => {
  it("A row claimed between the plan read and the move is skipped and logged, not counted as a failure, and left as it was.", async () => {
    const w = poolWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1, "live");
      w.idle(s1);
      const job = w.jobFor(m);
      const q = await w.row(m.session);

      const held = w.holdModel(m);
      const cycle = w.engine.evaluate(w.jobsRepo.getByIdOrThrow(job.jobId));
      await Promise.race([held.planned, cycle]);
      w.queue.claim({ qitemId: q, destinationSession: m.session });
      await held.release();
      await cycle;

      const notes = w.lastNotes(job.jobId)!;
      expect(notes.skipped).toEqual([{ qitemId: q, from: m.session, to: s1.session, code: "fallback_state_mismatch" }]);
      expect(notes).not.toHaveProperty("failed");
      expect(notes).not.toHaveProperty("moved");
      expect(w.history.listForJob(job.jobId)[0]).toMatchObject({ outcome: "skipped", skipReason: "seat_pool_report" });
      expect(w.queue.getById(q)).toMatchObject({ state: "in-progress", destinationSession: m.session });
      expect(w.rerouted(q)).toEqual([]);
      expect(w.db.prepare("SELECT outbox_id FROM outbox_entries WHERE outbox_id LIKE 'wake-intent-fallback-%'").all()).toEqual([]);
    } finally {
      w.db.close();
    }
  });

  it("A row rerouted elsewhere between the plan read and the move is skipped and logged, not counted as a failure.", async () => {
    const w = poolWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1, "live");
      w.idle(s1);
      const job = w.jobFor(m);
      const q = await w.row(m.session);

      const held = w.holdModel(m);
      const cycle = w.engine.evaluate(w.jobsRepo.getByIdOrThrow(job.jobId));
      await Promise.race([held.planned, cycle]);
      w.queue.routeToFallback(q, `other@${RIG}`, "operator");
      await held.release();
      await cycle;

      const notes = w.lastNotes(job.jobId)!;
      expect(notes.skipped).toEqual([{ qitemId: q, from: m.session, to: s1.session, code: "fallback_destination_mismatch" }]);
      expect(notes).not.toHaveProperty("failed");
      expect(notes).not.toHaveProperty("moved");
      expect(w.history.listForJob(job.jobId)[0]).toMatchObject({ outcome: "skipped", skipReason: "seat_pool_report" });
      expect(w.queue.getById(q)).toMatchObject({ state: "pending", destinationSession: `other@${RIG}` });
    } finally {
      w.db.close();
    }
  });
});

describe("seat-pool dispatch: also tested, without a numbered control", () => {
  it("The state reader's held messages and open rows keep an agent from receiving a row.", async () => {
    const w = poolWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1, "live");
      const s2 = w.agent(m, 2, "live");
      const s3 = w.agent(m, 3, "live");
      const s4 = w.agent(m, 4, "live");
      for (const a of [s1, s2, s3]) w.idle(a);
      w.working(s4);
      w.holdMessage(s2, "held-for-s2");
      const own = await w.row(s3.session);
      const job = w.jobFor(m);
      const q1 = await w.row(m.session);
      const q2 = await w.row(m.session);

      const agents = w.read(m).agents;
      expect(agents.map((a) => [a.slotNumber, a.heldCount, a.openRows])).toEqual([[1, 0, 0], [2, 1, 0], [3, 0, 1], [4, 0, 0]]);
      expect(agents.map((a) => a.idleAtPrompt)).toEqual([true, true, true, false]);

      await w.evaluate(job.jobId);
      const notes = w.lastNotes(job.jobId)!;
      expect(notes.moved).toHaveLength(1);
      expect(notes.moved).toEqual([{ qitemId: expect.any(String), from: m.session, to: s1.session }]);
      expect([w.destinationOf(q1), w.destinationOf(q2)].sort()).toEqual([m.session, s1.session].sort());
      expect(w.destinationOf(own)).toBe(s3.session);
      expect(w.queue.list({ destinationSession: s2.session, limit: 10 })).toEqual([]);
      expect(w.queue.list({ destinationSession: s4.session, limit: 10 })).toEqual([]);
    } finally {
      w.db.close();
    }
  });

  it("An agent that receives a held message between the plan read and the move does not receive the row, and the row stays where it was.", async () => {
    const w = poolWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1, "live");
      w.idle(s1);
      const job = w.jobFor(m);
      const q = await w.row(m.session);
      expect(w.read(m).agents[0]).toMatchObject({ heldCount: 0, idleAtPrompt: true, running: true });

      const held = w.holdModel(m);
      const cycle = w.engine.evaluate(w.jobsRepo.getByIdOrThrow(job.jobId));
      await Promise.race([held.planned, cycle]);
      w.holdMessage(s1, "held-in-between");
      await held.release();
      await cycle;

      const notes = w.lastNotes(job.jobId)!;
      expect(notes.skipped).toEqual([{ qitemId: q, from: m.session, to: s1.session, code: "agent_not_free" }]);
      expect(notes).not.toHaveProperty("moved");
      expect(notes).not.toHaveProperty("failed");
      expect(w.queue.getById(q)).toMatchObject({ state: "pending", destinationSession: m.session });
      expect(w.rerouted(q)).toEqual([]);

      // the message is still held: the next evaluation does not move the row either
      await w.evaluate(job.jobId);
      expect(w.history.listForJob(job.jobId)).toHaveLength(2);
      expect(w.history.listForJob(job.jobId).every((h) => !(h.evaluationNotes ?? {}).hasOwnProperty("moved"))).toBe(true);
      expect(w.queue.getById(q)).toMatchObject({ state: "pending", destinationSession: m.session });
    } finally {
      w.db.close();
    }
  });

  it("A pool agent whose latest session is `exited` (stopped on purpose) or `unknown` is not free and receives no row.", async () => {
    const w = poolWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1, "live", "stopped");
      const s2 = w.agent(m, 2, "live", "unknown");
      w.idle(s1);
      w.idle(s2);
      const job = w.jobFor(m);
      const q = await w.row(m.session);

      expect(w.read(m).agents).toEqual([
        expect.objectContaining({ slotNumber: 1, running: false, latestSessionStatus: "exited", idleAtPrompt: false, idleSince: null }),
        expect.objectContaining({ slotNumber: 2, running: false, latestSessionStatus: "unknown", idleAtPrompt: false, idleSince: null }),
      ]);
      await w.evaluate(job.jobId);
      expect(w.lastNotes(job.jobId)).not.toHaveProperty("moved");
      expect(w.queue.getById(q)).toMatchObject({ state: "pending", destinationSession: m.session });
      expect(w.rerouted(q)).toEqual([]);
    } finally {
      w.db.close();
    }
  });

  it("A pool agent whose latest session is `detached` is not free, is not drained, and its claimed rows are not moved.", async () => {
    const w = poolWorld();
    try {
      const spec = { ...SPEC, min: 0, idleGraceSeconds: 0 };
      const m = w.model(spec);
      const s1 = w.agent(m, 1, "live", "detached");
      w.idle(s1);
      const claimed = await w.row(s1.session);
      w.queue.claim({ qitemId: claimed, destinationSession: s1.session });
      // a second detached agent with no rows and no held messages: only the detached session keeps it from being free
      const s2 = w.agent(m, 2, "live", "detached");
      w.idle(s2);
      const job = w.jobFor(m);
      const q = await w.row(m.session);

      const read = w.read(m);
      expect(read.agents[0]).toMatchObject({ slotNumber: 1, running: false, latestSessionStatus: "detached", idleAtPrompt: false });
      expect(read.agents[1]).toMatchObject({ slotNumber: 2, running: false, latestSessionStatus: "detached", idleAtPrompt: false, openRows: 0, heldCount: 0 });
      expect(planSeatPool(spec, read, w.clock.now.getTime()).intents.filter((i) => i.kind === "drain")).toEqual([]);
      await w.evaluate(job.jobId);
      expect(w.lastNotes(job.jobId)).not.toHaveProperty("moved");
      expect(w.queue.getById(q)).toMatchObject({ state: "pending", destinationSession: m.session });
      expect(w.queue.getById(claimed)).toMatchObject({ state: "in-progress", destinationSession: s1.session });
      expect(w.rerouted(claimed)).toEqual([]);
    } finally {
      w.db.close();
    }
  });

  it("Every pool agent idle at its prompt is read with an `idleSince`, so the newest-first drain order never stalls behind a free agent with no idle time.", () => {
    const w = poolWorld();
    try {
      const spec = { ...SPEC, idleGraceSeconds: 0 };
      const m = w.model(spec);
      const s1 = w.agent(m, 1, "live");
      const s2 = w.agent(m, 2, "live");
      const s3 = w.agent(m, 3, "live");
      w.idle(s1, "2026-11-18T09:00:00.000Z");
      w.idle(s2, "2026-11-18T09:30:00.000Z");
      w.idle(s3, "");

      const read = w.read(m);
      expect(read.agents.filter((a) => a.idleAtPrompt).map((a) => a.idleSince)).toEqual([
        "2026-11-18T09:00:00.000Z", "2026-11-18T09:30:00.000Z", w.clock.now.toISOString(),
      ]);
      const plan = planSeatPool(spec, read, w.clock.now.getTime());
      expect(plan.surplus).toBeGreaterThan(0);
      // the newest free agent, the one with no readable idle time, is the first drained
      expect(plan.intents.filter((i) => i.kind === "drain")[0]).toEqual({ kind: "drain", slotNumber: 3, idleSince: w.clock.now.toISOString() });
    } finally {
      w.db.close();
    }
  });

  it("The state reader fills each agent's phase, running, idle state, open rows and held messages from the daemon's records, and a row's waiting time counts from its latest reroute.", async () => {
    const w = poolWorld();
    try {
      w.clock.now = new Date(); // the queue stamps rows and reroutes with the real clock
      const m = w.model();
      const s1 = w.agent(m, 1, "live");
      const s2 = w.agent(m, 2, "live");
      const s3 = w.agent(m, 3, "draining");
      const s4 = w.agent(m, 4, "drained", "stopped");
      const s5 = w.agent(m, 5, "adding", null);
      const s6 = w.agent(m, 6, "live");
      w.idle(s1, "2026-11-18T09:00:00.000Z");
      w.working(s2);
      w.idle(s6, "2026-11-18T09:10:00.000Z");
      w.holdMessage(s2, "held-for-s2");
      await w.row(s3.session);
      const job = w.jobFor(m);

      const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
      const a = await w.row(m.session);
      const b = await w.row(`other@${RIG}`);
      w.db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id IN (?, ?)").run(twoHoursAgo, a, b);
      w.queue.routeToFallback(b, m.session, "operator");
      const reroute = w.rerouted(b).at(-1)!;

      const read = w.read(m);
      const base = { attemptState: null, openRows: 0, heldCount: 0 };
      expect(read.agents).toEqual([
        { ...base, slotNumber: 1, nodeId: s1.nodeId, sessionName: s1.session, phase: "live", running: true, latestSessionStatus: "running",
          idleAtPrompt: true, idleSince: "2026-11-18T09:00:00.000Z" },
        { ...base, slotNumber: 2, nodeId: s2.nodeId, sessionName: s2.session, phase: "live", running: true, latestSessionStatus: "running",
          idleAtPrompt: false, idleSince: null, heldCount: 1 },
        { ...base, slotNumber: 3, nodeId: s3.nodeId, sessionName: s3.session, phase: "draining", running: true, latestSessionStatus: "running",
          idleAtPrompt: false, idleSince: null, openRows: 1 },
        { ...base, slotNumber: 4, nodeId: s4.nodeId, sessionName: s4.session, phase: "drained", running: false, latestSessionStatus: "exited",
          idleAtPrompt: false, idleSince: null },
        { ...base, slotNumber: 5, nodeId: s5.nodeId, sessionName: s5.session, phase: "adding", running: false, latestSessionStatus: null,
          idleAtPrompt: false, idleSince: null },
        { ...base, slotNumber: 6, nodeId: s6.nodeId, sessionName: s6.session, phase: "live", running: true, latestSessionStatus: "running",
          idleAtPrompt: true, idleSince: "2026-11-18T09:10:00.000Z" },
      ]);
      const pendingA = read.pending.find((p) => p.qitemId === a)!;
      const pendingB = read.pending.find((p) => p.qitemId === b)!;
      expect(pendingA).toEqual({ qitemId: a, destination: m.session, waitingSince: twoHoursAgo, tags: [] });
      expect(pendingB.waitingSince).toBe(reroute.ts);
      expect(pendingB.waitingSince).not.toBe(twoHoursAgo);

      // two free agents: the row waiting two hours moves, the row rerouted to the model just now does not
      await w.evaluate(job.jobId);
      expect(w.lastNotes(job.jobId)!.moved).toEqual([{ qitemId: a, from: m.session, to: s1.session }]);
      expect(w.destinationOf(a)).toBe(s1.session);
      expect(w.destinationOf(b)).toBe(m.session);
    } finally {
      w.db.close();
    }
  });

  it("Rows waiting for a drained pool agent, addressed by any of its names, are moved to a free agent, and the move expects the destination the row was stored with.", async () => {
    const w = poolWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1, "live");
      w.idle(s1);
      const physical = "r01-impl-two";
      const s2 = w.agent(m, 2, "drained", "running", physical);
      w.sessions.updateBinding(s2.nodeId, { tmuxSession: physical });
      expect(w.sessions.sessionAddresses(s2.session)).toEqual(expect.arrayContaining([s2.session, physical]));
      const job = w.jobFor(m);
      const q = await w.row(physical);

      const pending = w.read(m).pending;
      expect(pending).toEqual([expect.objectContaining({ qitemId: q, destination: s2.session })]);
      expect(w.read(m).rawDestination.get(q)).toBe(physical);

      const route = vi.spyOn(w.queue, "routeToFallback");
      try {
        await w.evaluate(job.jobId);
        expect(route).toHaveBeenCalledWith(q, s1.session, expect.any(String),
          { expectState: "pending", expectDestination: physical, wake: true });
      } finally {
        route.mockRestore();
      }
      expect(w.lastNotes(job.jobId)!.moved).toEqual([{ qitemId: q, from: physical, to: s1.session }]);
      expect(w.destinationOf(q)).toBe(s1.session);
    } finally {
      w.db.close();
    }
  });

  it("A pool agent whose latest session is `running` but whose executor is confirmed stopped is not free, and one whose latest session is `idle` receives the row.", async () => {
    const w = poolWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1, "live", "running");
      const s2 = w.agent(m, 2, "live", "idle");
      w.idle(s1);
      w.idle(s2);
      w.paneExited(s1);
      expect(nodeExecutorConfirmedStopped(w.db, s1.nodeId)).toBe(true);
      expect(nodeExecutorConfirmedStopped(w.db, s2.nodeId)).toBe(false);
      const job = w.jobFor(m);
      const q = await w.row(m.session);

      expect(w.read(m).agents).toEqual([
        expect.objectContaining({ slotNumber: 1, running: false, latestSessionStatus: "running", idleAtPrompt: false, idleSince: null }),
        expect.objectContaining({ slotNumber: 2, running: true, latestSessionStatus: "idle", idleAtPrompt: true, idleSince: IDLE_SINCE }),
      ]);
      await w.evaluate(job.jobId);
      expect(w.lastNotes(job.jobId)!.moved).toEqual([{ qitemId: q, from: m.session, to: s2.session }]);
      expect(w.queue.list({ destinationSession: s1.session, limit: 10 })).toEqual([]);
    } finally {
      w.db.close();
    }
  });

  it.each([
    ["can't be read", "unreadable"],
    ["is cleared", "cleared"],
    ["gets a `dispatch_tag`", "tagged"],
  ] as const)("When a re-apply changes the stored block between two moves (it %s), the next move and the rest are skipped with `pool_block_changed` and the notes carry the block as read then.", async (_title, change) => {
    const w = poolWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1, "live");
      const s2 = w.agent(m, 2, "live");
      w.idle(s1);
      w.idle(s2);
      const job = w.jobFor(m);
      const q1 = await w.row(m.session);
      const q2 = await w.row(m.session);
      const tagged: SeatPoolSpec = { ...SPEC, dispatchTag: "pool" };

      let moves = 0;
      w.hooks.afterMove = () => {
        if (++moves !== 1) return;
        if (change === "unreadable") w.db.prepare("UPDATE nodes SET pool = ? WHERE id = ?").run(JSON.stringify({ max: 2, min: 5 }), m.nodeId);
        else if (change === "cleared") w.rigRepo.setNodePool(m.nodeId, null);
        else w.rigRepo.setNodePool(m.nodeId, { spec: tagged });
      };
      await w.evaluate(job.jobId);
      expect(moves).toBe(1);

      const notes = w.lastNotes(job.jobId)!;
      const moved = notes.moved as Array<{ qitemId: string; from: string; to: string }>;
      expect(moved).toHaveLength(1);
      const waiting = moved[0]!.qitemId === q1 ? q2 : q1;
      const otherAgent = moved[0]!.to === s1.session ? s2.session : s1.session;
      expect(notes.skipped).toEqual([{ qitemId: waiting, from: m.session, to: otherAgent, code: "pool_block_changed" }]);
      expect(notes).not.toHaveProperty("failed");
      expect(w.destinationOf(waiting)).toBe(m.session);
      expect(w.rerouted(waiting)).toEqual([]);
      if (change === "unreadable") {
        expect(notes).toMatchObject({ block: "unusable", held: { cause: "pool block unreadable", message: "held: pool block unreadable" } });
        expect(notes.advisory).toMatch(/^the stored pool block can't be read \(/);
      } else if (change === "cleared") {
        expect(notes.block).toBe("none");
        expect(notes).not.toHaveProperty("held");
        expect(notes).not.toHaveProperty("advisory");
      } else {
        expect(notes).toMatchObject({ block: "stored", spec: tagged });
        expect(notes).not.toHaveProperty("held");
      }
    } finally {
      w.db.close();
    }
  });

  it("A row planned under the block without a `dispatch_tag` is not moved when a re-apply adds the tag while the cycle waits for the model's custody.", async () => {
    const w = poolWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1, "live");
      w.idle(s1);
      const job = w.jobFor(m);
      const q = await w.row(m.session);
      const tagged: SeatPoolSpec = { ...SPEC, dispatchTag: "pool" };

      const held = w.holdModel(m);
      const cycle = w.engine.evaluate(w.jobsRepo.getByIdOrThrow(job.jobId));
      await Promise.race([held.planned, cycle]);
      w.rigRepo.setNodePool(m.nodeId, { spec: tagged });
      await held.release();
      await cycle;

      const notes = w.lastNotes(job.jobId)!;
      expect(notes.skipped).toEqual([{ qitemId: q, from: m.session, to: s1.session, code: "pool_block_changed" }]);
      expect(notes).toMatchObject({ block: "stored", spec: tagged });
      expect(notes).not.toHaveProperty("moved");
      expect(w.queue.getById(q)).toMatchObject({ state: "pending", destinationSession: m.session });
      expect(w.rerouted(q)).toEqual([]);
    } finally {
      w.db.close();
    }
  });
});

describe("seat-pool dispatch: the dispatch guard (#4061)", () => {
  const GUARD = ["/usr/local/bin/pool-guard", "--strict"];
  const GUARDED: SeatPoolSpec = { ...SPEC, dispatchGuard: GUARD };

  it("With no `dispatch_guard` in the block, the guard runner is never called and the rows move as before.", async () => {
    const w = poolWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1, "live");
      w.idle(s1);
      const job = w.jobFor(m);
      const q = await w.row(m.session);
      w.hooks.guard = async () => ({ verdict: "veto" });

      await w.evaluate(job.jobId);
      expect(w.guardCalls).toEqual([]);
      const notes = w.lastNotes(job.jobId)!;
      expect(notes.moved).toEqual([{ qitemId: q, from: m.session, to: s1.session }]);
      expect(notes).not.toHaveProperty("skipped");
      expect(notes).not.toHaveProperty("guardErrors");
    } finally {
      w.db.close();
    }
  });

  it("The guard is asked once per planned move, with the block's argv, the row, where it waits and the agent it would go to; a block that keeps the same guard is not read as changed between two moves.", async () => {
    const w = poolWorld();
    try {
      const m = w.model(GUARDED);
      const s1 = w.agent(m, 1, "live");
      const s2 = w.agent(m, 2, "live");
      w.idle(s1);
      w.idle(s2);
      const job = w.jobFor(m);
      const q1 = await w.row(m.session);
      const q2 = await w.row(m.session);

      await w.evaluate(job.jobId);
      const notes = w.lastNotes(job.jobId)!;
      const moved = notes.moved as Array<{ qitemId: string; to: string }>;
      expect(moved).toHaveLength(2);
      expect(w.guardCalls).toEqual(moved.map((mv) => ({ argv: GUARD, qitemId: mv.qitemId, from: m.session, to: mv.to })));
      expect(new Set(moved.map((mv) => mv.qitemId))).toEqual(new Set([q1, q2]));
      expect(new Set(moved.map((mv) => mv.to))).toEqual(new Set([s1.session, s2.session]));
      expect(notes).not.toHaveProperty("skipped");
      expect(notes).not.toHaveProperty("guardErrors");
    } finally {
      w.db.close();
    }
  });

  it("A veto skips just that move with `guard_refused`: the row stays pending where it was, with no transition and the same waiting clock, the other rows still move, and the next cycle plans it again with no cooldown.", async () => {
    const w = poolWorld();
    try {
      const m = w.model(GUARDED);
      const s1 = w.agent(m, 1, "live");
      const s2 = w.agent(m, 2, "live");
      w.idle(s1);
      w.idle(s2);
      const job = w.jobFor(m);
      const q1 = await w.row(m.session);
      const q2 = await w.row(m.session);
      const transitionsBefore = w.queue.transitionLog.listForQitem(q1);
      const waitingBefore = w.read(m).pending.find((p) => p.qitemId === q1)!.waitingSince;
      w.hooks.guard = async (input) => (input.qitemId === q1 ? { verdict: "veto", message: "leased by another seat" } : { verdict: "allow" });

      await w.evaluate(job.jobId);
      let notes = w.lastNotes(job.jobId)!;
      const vetoed = notes.skipped as Array<{ qitemId: string; from: string; to: string; code: string; message?: string }>;
      expect(vetoed).toHaveLength(1);
      expect(vetoed[0]).toMatchObject({ qitemId: q1, from: m.session, code: "guard_refused", message: "leased by another seat" });
      expect(notes.moved).toEqual([{ qitemId: q2, from: m.session, to: expect.any(String) }]);
      expect(notes).not.toHaveProperty("failed");
      expect(notes).not.toHaveProperty("guardErrors");
      expect(w.queue.getById(q1)).toMatchObject({ state: "pending", destinationSession: m.session });
      expect(w.queue.transitionLog.listForQitem(q1)).toEqual(transitionsBefore);
      expect(w.rerouted(q1)).toEqual([]);
      expect(w.read(m).pending.find((p) => p.qitemId === q1)!.waitingSince).toBe(waitingBefore);

      // the next cycle, the guard letting it go: planned again and moved, with no cooldown in between
      w.hooks.guard = async () => ({ verdict: "allow" });
      const freeAgent = vetoed[0]!.to;
      await w.evaluate(job.jobId);
      notes = w.lastNotes(job.jobId)!;
      expect(notes.moved).toEqual([{ qitemId: q1, from: m.session, to: freeAgent }]);
      expect(w.destinationOf(q1)).toBe(freeAgent);
    } finally {
      w.db.close();
    }
  });

  it.each([
    ["returns an error", "error"],
    ["throws", "throws"],
    ["is not composed", "missing"],
  ] as const)("When the guard runner %s, the move goes ahead and the notes name the guard error.", async (_title, mode) => {
    const w = poolWorld(undefined, { guardRunner: mode !== "missing" });
    try {
      const m = w.model(GUARDED);
      const s1 = w.agent(m, 1, "live");
      w.idle(s1);
      const job = w.jobFor(m);
      const q = await w.row(m.session);
      if (mode === "error") w.hooks.guard = async () => ({ verdict: "error", message: "timed out after 2000 ms" });
      if (mode === "throws") w.hooks.guard = async () => { throw new Error("runner broke"); };

      await w.evaluate(job.jobId);
      const notes = w.lastNotes(job.jobId)!;
      expect(notes.moved).toEqual([{ qitemId: q, from: m.session, to: s1.session }]);
      const message = { error: "timed out after 2000 ms", throws: "runner broke", missing: "no guard runner composed" }[mode];
      expect(notes.guardErrors).toEqual([{ qitemId: q, from: m.session, to: s1.session, code: "guard_error", message }]);
      expect(notes).not.toHaveProperty("skipped");
      expect(notes).not.toHaveProperty("failed");
      expect(w.destinationOf(q)).toBe(s1.session);
    } finally {
      w.db.close();
    }
  });

  it("A block changed while the cycle waits for the model's custody is read before the guard: the guard planned under the old block is never run, and the moves are skipped with `pool_block_changed`.", async () => {
    const w = poolWorld();
    try {
      const m = w.model(GUARDED);
      const s1 = w.agent(m, 1, "live");
      w.idle(s1);
      const job = w.jobFor(m);
      const q = await w.row(m.session);

      const held = w.holdModel(m);
      const cycle = w.engine.evaluate(w.jobsRepo.getByIdOrThrow(job.jobId));
      await Promise.race([held.planned, cycle]);
      w.rigRepo.setNodePool(m.nodeId, { spec: SPEC });
      await held.release();
      await cycle;

      expect(w.guardCalls).toEqual([]);
      const notes = w.lastNotes(job.jobId)!;
      expect(notes.skipped).toEqual([{ qitemId: q, from: m.session, to: s1.session, code: "pool_block_changed" }]);
      expect(notes).not.toHaveProperty("moved");
      expect(w.queue.getById(q)).toMatchObject({ state: "pending", destinationSession: m.session });
    } finally {
      w.db.close();
    }
  });

  it("A block changed while the guard runs ends the moves with `pool_block_changed`, even when that guard vetoed: the old guard's answer is not recorded.", async () => {
    const w = poolWorld();
    try {
      const m = w.model(GUARDED);
      const s1 = w.agent(m, 1, "live");
      w.idle(s1);
      const job = w.jobFor(m);
      const q = await w.row(m.session);
      w.hooks.guard = async () => {
        w.rigRepo.setNodePool(m.nodeId, { spec: SPEC });
        return { verdict: "veto", message: "old guard" };
      };

      await w.evaluate(job.jobId);
      const notes = w.lastNotes(job.jobId)!;
      expect(notes.skipped).toEqual([{ qitemId: q, from: m.session, to: s1.session, code: "pool_block_changed" }]);
      expect(notes).toMatchObject({ block: "stored", spec: SPEC });
      expect(w.queue.getById(q)).toMatchObject({ state: "pending", destinationSession: m.session });
    } finally {
      w.db.close();
    }
  });

  it.each([
    ["the agent starts working", "agent_not_free"],
    ["the row is claimed", "fallback_state_mismatch"],
    ["a re-apply changes the block", "pool_block_changed"],
  ] as const)("The guard runs before the final re-check, which stays as it is: when %s while the guard runs, the move is skipped with `%s`.", async (_title, code) => {
    const w = poolWorld();
    try {
      const m = w.model(GUARDED);
      const s1 = w.agent(m, 1, "live");
      w.idle(s1);
      const job = w.jobFor(m);
      const q = await w.row(m.session);
      w.hooks.guard = async () => {
        if (code === "agent_not_free") w.working(s1);
        else if (code === "fallback_state_mismatch") w.queue.claim({ qitemId: q, destinationSession: m.session });
        else w.rigRepo.setNodePool(m.nodeId, { spec: { ...GUARDED, dispatchTag: "pool" } });
        return { verdict: "allow" };
      };

      await w.evaluate(job.jobId);
      expect(w.guardCalls).toHaveLength(1);
      const notes = w.lastNotes(job.jobId)!;
      expect(notes.skipped).toEqual([{ qitemId: q, from: m.session, to: s1.session, code }]);
      expect(notes).not.toHaveProperty("moved");
      expect(notes).not.toHaveProperty("failed");
      expect(w.queue.getById(q)!.destinationSession).toBe(m.session);
      expect(w.rerouted(q)).toEqual([]);
    } finally {
      w.db.close();
    }
  });
});

describe("seat-pool dispatch: a handover's release restarts the waiting clock (#4061)", () => {
  /** A row to the model, created at `createdAt`, claimed by the model's retiring occupant and released by its handover. */
  const releasedByHandover = async (w: ReturnType<typeof poolWorld>, m: Model, createdAt: string) => {
    const q = await w.row(m.session);
    w.db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(createdAt, q);
    w.generations.set(m.session, "gen-retiring");
    w.queue.claim({ qitemId: q, destinationSession: m.session });
    const before = w.queue.transitionLog.listForQitem(q);
    expect(w.queue.releaseClaimsByGeneration("gen-retiring")).toBe(1);
    const release = w.queue.transitionLog.listForQitem(q).at(-1)!;
    return { q, before, release };
  };

  it("A row a handover released back to the model waits `dispatch_after_s` again from the release, and its creation time and history do not change.", async () => {
    const w = poolWorld();
    try {
      w.clock.now = new Date(); // the queue stamps rows and transitions with the real clock
      const m = w.model();
      const s1 = w.agent(m, 1, "live");
      w.idle(s1, w.clock.now.toISOString());
      const job = w.jobFor(m);
      const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
      const { q, before, release } = await releasedByHandover(w, m, twoHoursAgo);

      expect(w.read(m).pending).toEqual([{ qitemId: q, destination: m.session, waitingSince: release.ts, tags: [] }]);
      w.clock.now = new Date(Date.parse(release.ts) + (SPEC.dispatchAfterSeconds - 1) * 1000);
      await w.evaluate(job.jobId);
      expect(w.lastNotes(job.jobId)).not.toHaveProperty("moved");
      expect(w.destinationOf(q)).toBe(m.session);

      w.clock.now = new Date(Date.parse(release.ts) + (SPEC.dispatchAfterSeconds + 1) * 1000);
      await w.evaluate(job.jobId);
      expect(w.lastNotes(job.jobId)!.moved).toEqual([{ qitemId: q, from: m.session, to: s1.session }]);
      expect(w.queue.getById(q)!.tsCreated).toBe(twoHoursAgo);
      const history = w.queue.transitionLog.listForQitem(q);
      expect(history.slice(0, before.length)).toEqual(before);
      expect(history[before.length]).toEqual(release);
    } finally {
      w.db.close();
    }
  });

  it("A released row goes behind a row that has waited longer at the model, even one created after it.", async () => {
    const w = poolWorld();
    try {
      w.clock.now = new Date();
      const m = w.model();
      const s1 = w.agent(m, 1, "live");
      w.idle(s1, w.clock.now.toISOString());
      const job = w.jobFor(m);
      const { q: released } = await releasedByHandover(w, m, new Date(Date.now() - 2 * 3_600_000).toISOString());
      const waiting = await w.row(m.session);
      w.db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(new Date(Date.now() - 30 * 60_000).toISOString(), waiting);

      w.clock.now = new Date(Date.now() + 3_600_000); // both rows past dispatch_after_s; one free agent
      await w.evaluate(job.jobId);
      expect(w.lastNotes(job.jobId)!.moved).toEqual([{ qitemId: waiting, from: m.session, to: s1.session }]);
      expect(w.destinationOf(released)).toBe(m.session);
    } finally {
      w.db.close();
    }
  });

  it("The latest of a reroute and a release restarts the clock, in either order.", async () => {
    const w = poolWorld();
    try {
      w.clock.now = new Date();
      const m = w.model();
      const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
      const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
      const backdate = (transitionId: number) =>
        w.db.prepare("UPDATE queue_transitions SET ts = ? WHERE transition_id = ?").run(twoHoursAgo, transitionId);
      const rerouteAndBack = (q: string) => {
        w.queue.routeToFallback(q, `other@${RIG}`, "operator");
        w.queue.routeToFallback(q, m.session, "operator");
        return w.rerouted(q).at(-1)!;
      };

      // released two hours ago, then rerouted back to the model now: the reroute counts
      const { q: releasedFirst, release } = await releasedByHandover(w, m, threeHoursAgo);
      backdate(release.transitionId);
      const reroute = rerouteAndBack(releasedFirst);
      // rerouted back to the model two hours ago, then released now: the release counts
      const reroutedFirst = await w.row(m.session);
      w.db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(threeHoursAgo, reroutedFirst);
      backdate(rerouteAndBack(reroutedFirst).transitionId);
      w.queue.claim({ qitemId: reroutedFirst, destinationSession: m.session });
      expect(w.queue.releaseClaimsByGeneration("gen-retiring")).toBe(1);
      const lateRelease = w.queue.transitionLog.listForQitem(reroutedFirst).at(-1)!;

      const waiting = new Map(w.read(m).pending.map((p) => [p.qitemId, p.waitingSince]));
      expect(waiting.get(releasedFirst)).toBe(reroute.ts);
      expect(waiting.get(reroutedFirst)).toBe(lateRelease.ts);
      expect(lateRelease.ts).not.toBe(twoHoursAgo);
    } finally {
      w.db.close();
    }
  });

  it("Only the queue's own release restarts the clock: the release's note recorded by an identified caller, or with a state other than pending, does not.", async () => {
    const w = poolWorld();
    try {
      w.clock.now = new Date();
      const m = w.model();
      const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
      const q = await w.row(m.session);
      w.db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(twoHoursAgo, q);
      const note = "released: claimant generation retired (seat handover)";
      w.queue.transitionLog.append({ qitemId: q, state: "pending", actorSession: "system", identityProvenance: "transport:v1", transitionNote: note });
      w.queue.transitionLog.append({ qitemId: q, state: "in-progress", actorSession: "system", transitionNote: note });

      expect(w.read(m).pending).toEqual([{ qitemId: q, destination: m.session, waitingSince: twoHoursAgo, tags: [] }]);
    } finally {
      w.db.close();
    }
  });
});
