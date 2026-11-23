import { describe, it, expect, vi } from "vitest";
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
import { SeatPoolSlotsRepository, type SeatPoolSlotPhase } from "../src/domain/seat-pool-slots.js";
import type { SeatPoolSpec } from "../src/domain/seat-pool-spec.js";
import { WatchdogJobsRepository, type WatchdogJob } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { makeSeatPoolPolicy } from "../src/domain/policies/seat-pool.js";
import { reconcileSeatPoolNode } from "../src/domain/seat-pool-registration.js";
import {
  makeSeatPoolExecutor,
  seatPoolQueueEffects,
  type SeatPoolExecutorDeps,
  type SeatPoolSeatStop,
} from "../src/domain/seat-pool-executor.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import type { ArbitratedSeatState } from "../src/domain/activity-taxonomy.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";

// #3395 (Piece 1): the seat pool drains a free agent idle past `idle_grace_s`. Under the agent's lifecycle lease it
// reads the agent again, captures an `auto-rehydrate` snapshot while the agent still runs, and stops it with the
// checked stop; the node, its sessions and its history stay. The job is unarmed in the daemon, so each test composes
// the executor itself, with the real delivery guard and snapshot capture, and a checked stop that behaves as the seat
// lifecycle service's does for the session it is given.

const RIG = "drain-rig";
const SPEC: SeatPoolSpec = {
  max: 4, min: 0, dispatchAfterSeconds: 60, idleGraceSeconds: 300, cooldownSeconds: 60, dispatchTag: null, cwdTemplate: null, drain: false,
};
const IDLE_SINCE = "2026-11-18T10:00:00.000Z";

function idleState(nodeId: string, changedAt = IDLE_SINCE): ArbitratedSeatState {
  return {
    seatNodeId: nodeId, activity: "idle-at-prompt", needsInput: { count: 0, reason: null }, needsInputEvidence: null,
    backgroundWork: null, decidedBy: null, seq: 1, changedAt, rungs: [], lastSwap: null,
  } as unknown as ArbitratedSeatState;
}

function busyState(nodeId: string): ArbitratedSeatState {
  return { ...idleState(nodeId), activity: "active" } as unknown as ArbitratedSeatState;
}

type Model = { rigId: string; nodeId: string; logicalId: string; podId: string; session: string };
type Agent = { nodeId: string; session: string };

function drainWorld() {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  const rigRepo = new RigRepository(db);
  const podRepo = new PodRepository(db);
  const slots = new SeatPoolSlotsRepository(db);
  const sessions = new SessionRegistry(db);
  const queue = new QueueRepository(db, bus, { resolveSessionAddresses: (name) => sessions.sessionAddresses(name) });
  const outbox = new OutboxHandler(db);
  queue.attachOutbox(outbox);
  const jobsRepo = new WatchdogJobsRepository(db);
  const history = new WatchdogHistoryLog(db);
  const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
  const snapshotRepo = new SnapshotRepository(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry: sessions, eventBus: bus, snapshotRepo, checkpointStore: new CheckpointStore(db) });
  const activity = new Map<string, ArbitratedSeatState>();
  const clock = { now: new Date(Date.now() + 3_600_000) };
  /** Runs when a drain asks for the agent's lifecycle lease, after its slot went to `draining`. */
  const hooks: { beforeLifecycle?: () => Promise<void> | void } = {};

  const latestOf = (nodeId: string) => db.prepare("SELECT id, status FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(nodeId) as { id: string; status: string } | undefined;
  /** Each capture: the snapshot, every session's status at that moment, how many stops came before it, and how many
   *  refreshes had finished before it. */
  const captures: Array<{ snapshotId: string; statuses: Map<string, string>; stopsBefore: number; refreshesBefore: number }> = [];
  const capturing = { fails: false };
  /** The resume metadata refresh: it finishes a tick later, and throws when `fails`. */
  const refreshing = { fails: false, finished: 0 };
  const refresh = vi.fn(async (_input: { rigId: string; nodeId: string; sessionId: string }) => {
    try {
      await new Promise((resolve) => setImmediate(resolve));
      if (refreshing.fails) throw new Error("resume probe failed");
    } finally {
      refreshing.finished += 1;
    }
  });
  /** Results the stop returns, one per call, before it falls back to stopping the expected session. */
  const stopResults: SeatPoolSeatStop[] = [];
  const stopSeat = vi.fn(async (input: {
    seatRef: string; reason: string; expected: { nodeId: string; sessionId: string };
    recheck?: () => { ok: false; code: "selection_changed"; message: string } | null;
  }): Promise<SeatPoolSeatStop> => {
    const queued = stopResults.shift();
    if (queued) return queued;
    const latest = latestOf(input.expected.nodeId);
    if (latest?.id !== input.expected.sessionId) return { ok: false, code: "selection_changed", message: "The selected seat or latest session changed." };
    sessions.updateStatus(latest.id, "stopped");
    return { ok: true };
  });
  const deps: SeatPoolExecutorDeps = {
    db, rigRepo, slots, jobsRepo,
    queue: seatPoolQueueEffects(queue),
    heldCount: (id) => outbox.heldCount(id),
    confirmedStopped: (id) => nodeExecutorConfirmedStopped(db, id),
    seatState: (id) => activity.get(id) ?? null,
    custody: (ids, fn) => guard.custody(ids, fn),
    now: () => clock.now,
    drain: {
      lifecycle: async (ids, fn) => { await hooks.beforeLifecycle?.(); return guard.lifecycle(ids, fn); },
      refresh,
      capture: (rigId) => {
        if (capturing.fails) throw new Error("disk full");
        const snapshot = snapshotCapture.captureSnapshot(rigId, "auto-rehydrate");
        const rows = db.prepare("SELECT id, status FROM sessions").all() as Array<{ id: string; status: string }>;
        captures.push({
          snapshotId: snapshot.id, statuses: new Map(rows.map((r) => [r.id, r.status])), stopsBefore: stopSeat.mock.calls.length,
          refreshesBefore: refreshing.finished,
        });
        return { snapshotId: snapshot.id };
      },
      stopSeat,
    },
  };
  const executor = makeSeatPoolExecutor(deps);
  const engine = new WatchdogPolicyEngine({
    jobsRepo, historyLog: history, eventBus: bus, deliver: async () => ({ status: "ok" }),
    additionalPolicies: [makeSeatPoolPolicy({ cycle: (job) => executor.cycle(job) })],
  });
  const reg = { db, rigRepo, jobsRepo, warn: vi.fn() };

  const seatSession = (nodeId: string, name: string) => {
    const session = sessions.registerSession(nodeId, name);
    sessions.updateStatus(session.id, "running");
    return session;
  };
  const model = (spec: SeatPoolSpec = SPEC): Model => {
    const rig = rigRepo.createRig(RIG);
    const pod = podRepo.createPod(rig.id, "dev", "Dev");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: pod.id, pool: { spec }, cwd: "/tmp" });
    const m = { rigId: rig.id, nodeId: node.id, logicalId: node.logicalId, podId: pod.id, session: `dev-impl@${RIG}` };
    seatSession(node.id, m.session);
    return m;
  };
  /** A pool agent with a running session, idle at its prompt since IDLE_SINCE. */
  const agent = (m: Model, n: number, phase: SeatPoolSlotPhase = "live"): Agent => {
    const node = rigRepo.addNode(m.rigId, `${m.logicalId}-s${n}`, { runtime: "claude-code", podId: m.podId, cwd: "/tmp" });
    slots.insert({ modelNodeId: m.nodeId, slotNumber: n, nodeId: node.id, phase, at: IDLE_SINCE });
    const a = { nodeId: node.id, session: `dev-impl-s${n}@${RIG}` };
    seatSession(node.id, a.session);
    activity.set(node.id, idleState(node.id));
    return a;
  };
  const jobFor = (m: Model): WatchdogJob => {
    const result = reconcileSeatPoolNode(reg, m.nodeId);
    if (!("job" in result)) throw new Error(`no job: ${JSON.stringify(result)}`);
    return result.job;
  };
  /** One evaluation through the engine, as the armed job would run; returns its notes. */
  const cycle = async (jobId: string) =>
    ((await engine.evaluate(jobsRepo.getByIdOrThrow(jobId))).outcome as { notes: Record<string, unknown> }).notes;
  const phases = (m: Model) => slots.forModel(m.nodeId).map((s) => s.phase);
  const row = async (destination: string) => (await queue.create({
    sourceSession: `lead@${RIG}`, destinationSession: destination, body: "work", nudge: false,
  })).qitemId;
  return {
    db, rigRepo, slots, sessions, queue, jobsRepo, snapshotRepo, activity, clock, hooks, captures, capturing, stopResults, stopSeat,
    refresh, refreshing, guard, bus, engine, latestOf, seatSession, model, agent, jobFor, cycle, phases, row,
  };
}

/** The seat lifecycle service's real checked stop, composed as the daemon composes it (startup.ts), over a tmux whose
 *  liveness probe (`has-session`) waits until the test releases it. `commands` is every tmux command it ran. */
function realCheckedStop(w: ReturnType<typeof drainWorld>, a: Agent) {
  w.sessions.updateBinding(a.nodeId, { attachmentType: "tmux", tmuxSession: a.session, tmuxPane: "%1" });
  const commands: string[] = [];
  let named: string | undefined;
  let probing!: () => void;
  const probed = new Promise<void>((resolve) => { probing = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const adapter = new TmuxAdapter(async (command) => {
    commands.push(command);
    if (command.includes("has-session")) { probing(); await released; return ""; }
    if (command.includes("list-panes")) { named = /=([^:']+):/.exec(command)?.[1] ?? named; return "%1|0|/tmp|120|40|1"; }
    if (command.startsWith("tmux show-environment")) {
      const bound = w.db.prepare("SELECT node_id FROM bindings WHERE tmux_session = ?").get(named) as { node_id: string } | undefined;
      return `OPENRIG_NODE_ID=${bound?.node_id ?? ""}`;
    }
    if (command.startsWith("tmux display-message")) return "$7|4242|1700000000";
    if (command.includes("detach-client") || command.includes("kill-session")) return "";
    throw new Error(`unexpected tmux command: ${command}`);
  });
  adapter.deliveryGuard = w.guard;
  const service = new SeatLifecycleService({ db: w.db, rigRepo: w.rigRepo, sessionRegistry: w.sessions, eventBus: w.bus, tmuxAdapter: adapter });
  w.stopSeat.mockImplementation(async ({ seatRef, reason, expected, recheck }) => {
    const stopped = await service.stopSeat({ seatRef, reason, operator: null, expected, ...(recheck ? { recheck } : {}) });
    if (stopped.ok) return { ok: true };
    return { ok: false, code: stopped.code, message: stopped.message, ...(stopped.partialEffect ? { partialEffect: true } : {}) };
  });
  /** The stop's effects that reached tmux. */
  const effectsSent = () => commands.filter((c) => c.includes("detach-client") || c.includes("kill-session"));
  return { commands, probed, release, effectsSent };
}

describe("seat-pool drain: re-read under the lifecycle lease (#3395 Piece 1)", () => {
  it("A row that reaches an agent during its drain is seen by the re-read under the lifecycle lease, the slot goes back to `live`, and nothing is stopped.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      let q: string | undefined;
      // the row arrives after the slot went to `draining`, before the lease is held
      w.hooks.beforeLifecycle = async () => {
        expect(w.phases(m)).toEqual(["draining"]);
        q = await w.row(s1.session);
      };

      const notes = await w.cycle(job.jobId);
      expect(notes.drains).toEqual([{ slotNumber: 1, session: s1.session, phase: "live", outcome: "returned", code: "work_arrived" }]);
      expect(w.phases(m)).toEqual(["live"]);
      expect(w.captures).toEqual([]);
      expect(w.stopSeat).not.toHaveBeenCalled();
      expect(w.latestOf(s1.nodeId)?.status).toBe("running");
      expect(w.queue.getById(q!)).toMatchObject({ state: "pending", destinationSession: s1.session });
    } finally {
      w.db.close();
    }
  });

  it("An agent relaunched since the drain's plan read is left alone.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      const planned = w.latestOf(s1.nodeId)!;
      let relaunched: string | undefined;
      // a relaunch between the plan and the lease: a new session for the same node, idle at its prompt
      w.hooks.beforeLifecycle = () => {
        relaunched = w.seatSession(s1.nodeId, s1.session).id;
        w.activity.set(s1.nodeId, idleState(s1.nodeId));
      };

      const notes = await w.cycle(job.jobId);
      expect(relaunched).not.toBe(planned.id);
      expect(w.latestOf(s1.nodeId)?.id).toBe(relaunched);
      expect(notes.drains).toEqual([{ slotNumber: 1, session: s1.session, phase: "live", outcome: "left", code: "relaunched" }]);
      expect(w.phases(m)).toEqual(["live"]);
      expect(w.captures).toEqual([]);
      expect(w.stopSeat).not.toHaveBeenCalled();
      expect(w.latestOf(s1.nodeId)?.status).toBe("running");
    } finally {
      w.db.close();
    }
  });

  it("A row admitted to an agent while the checked stop's liveness probe is paused is seen at the stop's final step: nothing is detached or killed, the agent keeps the row and its slot goes back to `live`.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      const { commands, probed, release, effectsSent } = realCheckedStop(w, s1);

      const run = w.cycle(job.jobId);
      await probed;
      // the row arrives while the stop's probe is paused, after every earlier check
      const q = await w.row(s1.session);
      release();
      const notes = await run;

      expect(commands.some((c) => c.includes("has-session"))).toBe(true);
      expect(effectsSent()).toEqual([]);
      expect(w.latestOf(s1.nodeId)?.status).toBe("running");
      expect(w.queue.getById(q)).toMatchObject({ state: "pending", destinationSession: s1.session });
      expect(notes.drains).toEqual([{
        slotNumber: 1, session: s1.session, phase: "live", outcome: "returned", code: "work_arrived", snapshotId: w.captures[0]!.snapshotId,
      }]);
      expect(w.phases(m)).toEqual(["live"]);
    } finally {
      w.db.close();
    }
  });

  it("A pool block changed while the checked stop's liveness probe is paused, now keeping the agent, is seen at the stop's final step: nothing is detached or killed, and the slot stays `draining`.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      const { probed, release, effectsSent } = realCheckedStop(w, s1);

      const run = w.cycle(job.jobId);
      await probed;
      // after the read under the lease: a readable block whose `min` now keeps the one agent
      const stored = w.db.prepare("SELECT pool FROM nodes WHERE id = ?").get(m.nodeId) as { pool: string };
      w.db.prepare("UPDATE nodes SET pool = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(stored.pool), min: 1 }), m.nodeId);
      release();
      const notes = await run;

      expect(effectsSent()).toEqual([]);
      expect(w.latestOf(s1.nodeId)?.status).toBe("running");
      expect(notes.drains).toEqual([{
        slotNumber: 1, session: s1.session, phase: "draining", outcome: "draining", code: "pool_block_changed", snapshotId: w.captures[0]!.snapshotId,
      }]);
      expect(w.phases(m)).toEqual(["draining"]);
      // nothing was stopped, so the attempt record goes, and the next evaluation gives the slot back to `live`
      expect(w.slots.stopOutcome(w.slots.forModel(m.nodeId)[0]!.slotId)).toBeNull();
      await w.cycle(job.jobId);
      expect(w.phases(m)).toEqual(["live"]);
      expect(effectsSent()).toEqual([]);
    } finally {
      w.db.close();
    }
  });

  it("A row admitted while a retried stop's liveness probe is paused is seen at the stop's final step: nothing more is detached or killed, the agent keeps the row, and the slot stays `draining` with the earlier attempt on record.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      w.stopResults.push({ ok: false, code: "stop_uncertain", message: "The kill was sent but the session could not be confirmed gone.", partialEffect: true });
      await w.cycle(job.jobId);
      expect(w.phases(m)).toEqual(["draining"]);
      const { probed, release, effectsSent } = realCheckedStop(w, s1);

      const run = w.cycle(job.jobId);
      await probed;
      // the row arrives while the retry's probe is paused, after the retry's own read under the lease
      const q = await w.row(s1.session);
      release();
      const notes = await run;

      expect(effectsSent()).toEqual([]);
      expect(w.latestOf(s1.nodeId)?.status).toBe("running");
      expect(w.queue.getById(q)).toMatchObject({ state: "pending", destinationSession: s1.session });
      expect(notes.drains).toEqual([{ slotNumber: 1, session: s1.session, phase: "draining", outcome: "draining", code: "work_arrived" }]);
      expect(w.phases(m)).toEqual(["draining"]);
      expect(w.slots.stopOutcome(w.slots.forModel(m.nodeId)[0]!.slotId)).toMatchObject({ result: "unconfirmed", partialEffect: true });
    } finally {
      w.db.close();
    }
  });
});

describe("seat-pool drain: the capture and the confirmed stop (#3395 Piece 1)", () => {
  it("The drain captures an `auto-rehydrate` snapshot while the agent still runs, right before the confirmed stop, and never after it, then marks the slot `drained`.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      const session = w.latestOf(s1.nodeId)!;

      const notes = await w.cycle(job.jobId);
      expect(w.captures).toHaveLength(1);
      const [capture] = w.captures;
      // captured while the agent's session still ran, before any stop
      expect(capture!.statuses.get(session.id)).toBe("running");
      expect(capture!.stopsBefore).toBe(0);
      expect(w.snapshotRepo.getSnapshot(capture!.snapshotId)).toMatchObject({ rigId: m.rigId, kind: "auto-rehydrate" });
      // the checked stop of the session the plan read
      expect(w.stopSeat).toHaveBeenCalledTimes(1);
      expect(w.stopSeat.mock.calls[0]![0]).toMatchObject({ seatRef: s1.session, expected: { nodeId: s1.nodeId, sessionId: session.id } });
      expect(notes.drains).toEqual([{
        slotNumber: 1, session: s1.session, phase: "drained", outcome: "drained", snapshotId: capture!.snapshotId,
        stop: { cause: "drain", result: "stopped" },
      }]);
      expect(w.phases(m)).toEqual(["drained"]);
      // the node and its session stay
      expect(w.rigRepo.getRig(m.rigId)!.nodes.map((n) => n.id)).toContain(s1.nodeId);
      expect(w.latestOf(s1.nodeId)).toEqual({ id: session.id, status: "stopped" });

      // never after it: the next cycles capture nothing more
      await w.cycle(job.jobId);
      expect(w.captures).toHaveLength(1);
      expect(w.stopSeat).toHaveBeenCalledTimes(1);
    } finally {
      w.db.close();
    }
  });

  it("A `rig down` that begins while the drain refreshes the agent's resume metadata holds it before the capture: nothing is captured or stopped, and the slot stays `draining` with no attempt on record.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      let stopped: number | undefined;
      // the hold begins while the refresh runs, after every earlier check
      w.refresh.mockImplementationOnce(async () => { stopped = w.bus.emit({ type: "rig.stopped", rigId: m.rigId }).seq; });

      const notes = await w.cycle(job.jobId);
      expect(w.refresh).toHaveBeenCalledTimes(1);
      expect(w.captures).toEqual([]);
      expect(w.stopSeat).not.toHaveBeenCalled();
      expect(w.latestOf(s1.nodeId)?.status).toBe("running");
      expect(notes.held).toEqual({ cause: "rig stopped", seq: stopped, message: `held: rig stopped (event ${stopped})` });
      expect(notes.drains).toEqual([{ slotNumber: 1, session: s1.session, phase: "draining", outcome: "draining", code: "rig_stopped" }]);
      expect(w.phases(m)).toEqual(["draining"]);
      expect(w.slots.stopOutcome(w.slots.forModel(m.nodeId)[0]!.slotId)).toBeNull();
    } finally {
      w.db.close();
    }
  });

  it("The drain refreshes the agent's resume metadata before the capture, and a refresh that fails still captures and stops: refresh, capture, then stop.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      const session = w.latestOf(s1.nodeId)!;
      w.refreshing.fails = true;

      const notes = await w.cycle(job.jobId);
      expect(w.refresh).toHaveBeenCalledTimes(1);
      expect(w.refresh).toHaveBeenCalledWith({ rigId: m.rigId, nodeId: s1.nodeId, sessionId: session.id });
      expect(w.captures).toHaveLength(1);
      // the refresh had finished before the capture, and the capture came before the stop
      expect(w.captures[0]).toMatchObject({ refreshesBefore: 1, stopsBefore: 0 });
      expect(w.stopSeat).toHaveBeenCalledTimes(1);
      expect(notes.drains).toEqual([{
        slotNumber: 1, session: s1.session, phase: "drained", outcome: "drained", snapshotId: w.captures[0]!.snapshotId,
        stop: { cause: "drain", result: "stopped" },
      }]);
      expect(w.latestOf(s1.nodeId)?.status).toBe("stopped");
    } finally {
      w.db.close();
    }
  });

  it("A drain whose stop returns `session_not_live` marks the slot `drained` and is reported `absent`, not `stopped`.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      w.stopResults.push({ ok: false, code: "session_not_live", message: "Session is absent in tmux; there is nothing to stop." });

      const notes = await w.cycle(job.jobId);
      expect(notes.drains).toEqual([expect.objectContaining({
        slotNumber: 1, session: s1.session, phase: "drained", outcome: "drained",
        stop: { cause: "drain", result: "absent", code: "session_not_live", message: "Session is absent in tmux; there is nothing to stop." },
      })]);
      expect(w.phases(m)).toEqual(["drained"]);
      expect(w.captures).toHaveLength(1);
    } finally {
      w.db.close();
    }
  });

  it("A drain whose stop is unknown leaves the slot `draining`, reported `unconfirmed`, and checks it again next cycle.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      const session = w.latestOf(s1.nodeId)!;
      w.stopResults.push({ ok: false, code: "stop_uncertain", message: "The kill was sent but the session could not be confirmed gone.", partialEffect: true });

      const first = await w.cycle(job.jobId);
      expect(first.drains).toEqual([expect.objectContaining({
        slotNumber: 1, phase: "draining", outcome: "draining",
        stop: { cause: "drain", result: "unconfirmed", code: "stop_uncertain", message: "The kill was sent but the session could not be confirmed gone." },
      })]);
      expect(w.phases(m)).toEqual(["draining"]);
      expect(w.captures).toHaveLength(1);

      // the next cycle stops the same session again, with no new capture, and the confirmed absence ends it
      w.stopResults.push({ ok: false, code: "session_not_live", message: "Session is absent in tmux; there is nothing to stop." });
      const second = await w.cycle(job.jobId);
      expect(w.stopSeat).toHaveBeenCalledTimes(2);
      expect(w.stopSeat.mock.calls[1]![0]).toMatchObject({ seatRef: s1.session, expected: { nodeId: s1.nodeId, sessionId: session.id } });
      expect(w.captures).toHaveLength(1);
      expect(second.drains).toEqual([{
        slotNumber: 1, session: s1.session, phase: "drained", outcome: "drained",
        stop: { cause: "drain", result: "absent", code: "session_not_live", message: "Session is absent in tmux; there is nothing to stop." },
      }]);
      expect(w.phases(m)).toEqual(["drained"]);
    } finally {
      w.db.close();
    }
  });

  it("An unconfirmed stop known to have had no effect is not tried again: the slot goes back to `live`, and an agent that got a row since is not stopped.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      w.stopResults.push({ ok: false, code: "tmux_probe_failed", message: "The tmux probe failed; stop refuses rather than kill blind." });

      const first = await w.cycle(job.jobId);
      expect(first.drains).toEqual([expect.objectContaining({ slotNumber: 1, phase: "draining", stop: expect.objectContaining({ result: "unconfirmed", code: "tmux_probe_failed" }) })]);
      expect(w.latestOf(s1.nodeId)?.status).toBe("running");

      const q = await w.row(s1.session);
      const second = await w.cycle(job.jobId);
      expect(second.drains).toEqual([{ slotNumber: 1, session: s1.session, phase: "live", outcome: "returned", code: "drain_not_finished" }]);
      expect(w.stopSeat).toHaveBeenCalledTimes(1);
      expect(w.phases(m)).toEqual(["live"]);
      expect(w.latestOf(s1.nodeId)?.status).toBe("running");
      expect(w.queue.getById(q)).toMatchObject({ state: "pending", destinationSession: s1.session });
    } finally {
      w.db.close();
    }
  });

  it("An unconfirmed stop after an attempted kill is not tried again while the agent has work: the slot stays `draining` and nothing more is stopped until it is free.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      w.stopResults.push({ ok: false, code: "stop_uncertain", message: "The kill was sent but the session could not be confirmed gone.", partialEffect: true });
      await w.cycle(job.jobId);
      expect(w.phases(m)).toEqual(["draining"]);

      const q = await w.row(s1.session);
      const second = await w.cycle(job.jobId);
      expect(second.drains).toEqual([{ slotNumber: 1, session: s1.session, phase: "draining", outcome: "draining", code: "work_arrived" }]);
      expect(w.stopSeat).toHaveBeenCalledTimes(1);
      expect(w.latestOf(s1.nodeId)?.status).toBe("running");
      expect(w.queue.getById(q)).toMatchObject({ state: "pending", destinationSession: s1.session });
    } finally {
      w.db.close();
    }
  });

  it("A retry that is itself refused with no effect keeps the earlier attempted kill on record, so the next cycle tries the same session again.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      w.stopResults.push(
        { ok: false, code: "stop_uncertain", message: "The kill was sent but the session could not be confirmed gone.", partialEffect: true },
        { ok: false, code: "tmux_probe_failed", message: "The tmux probe failed; stop refuses rather than kill blind." },
      );
      await w.cycle(job.jobId);
      const second = await w.cycle(job.jobId);
      expect(second.drains).toEqual([expect.objectContaining({ phase: "draining", stop: expect.objectContaining({ result: "unconfirmed", code: "tmux_probe_failed" }) })]);

      const third = await w.cycle(job.jobId);
      expect(w.stopSeat).toHaveBeenCalledTimes(3);
      expect(third.drains).toEqual([expect.objectContaining({ slotNumber: 1, session: s1.session, phase: "drained", stop: { cause: "drain", result: "stopped" } })]);
      expect(w.captures).toHaveLength(1);
    } finally {
      w.db.close();
    }
  });

  it("An unconfirmed stop is tried again only on the session it recorded: an agent relaunched since is reported `changed_owner` and goes back to `live`.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      const recorded = w.latestOf(s1.nodeId)!;
      w.stopResults.push({ ok: false, code: "stop_uncertain", message: "The kill was sent but the session could not be confirmed gone.", partialEffect: true });
      await w.cycle(job.jobId);

      const relaunched = w.seatSession(s1.nodeId, s1.session).id;
      const second = await w.cycle(job.jobId);
      expect(w.stopSeat).toHaveBeenCalledTimes(2);
      expect(w.stopSeat.mock.calls[1]![0]).toMatchObject({ expected: { nodeId: s1.nodeId, sessionId: recorded.id } });
      expect(second.drains).toEqual([expect.objectContaining({ slotNumber: 1, phase: "live", outcome: "left", stop: expect.objectContaining({ result: "changed_owner" }) })]);
      expect(w.latestOf(s1.nodeId)).toEqual({ id: relaunched, status: "running" });
      expect(w.captures).toHaveLength(1);
    } finally {
      w.db.close();
    }
  });

  it("A drain whose stop finds a keep_alive agent already down is reported `absent`, not `stopped`.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      w.agent(m, 1);
      const job = w.jobFor(m);
      w.stopResults.push({ ok: true, alreadyDown: true, message: "The session was already gone; the stop is recorded so it stays down." });

      const notes = await w.cycle(job.jobId);
      expect(notes.drains).toEqual([expect.objectContaining({
        slotNumber: 1, phase: "drained", outcome: "drained",
        stop: { cause: "drain", result: "absent", code: "already_down", message: "The session was already gone; the stop is recorded so it stays down." },
      })]);
    } finally {
      w.db.close();
    }
  });

  it("A capture that fails before the drain's stop leaves the agent running and the slot `draining`.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      w.capturing.fails = true;

      const notes = await w.cycle(job.jobId);
      expect(notes.drains).toEqual([{
        slotNumber: 1, session: s1.session, phase: "draining", outcome: "draining", code: "capture_failed", message: "disk full",
      }]);
      expect(w.phases(m)).toEqual(["draining"]);
      expect(w.stopSeat).not.toHaveBeenCalled();
      expect(w.latestOf(s1.nodeId)?.status).toBe("running");

      // nothing was stopped, so the next cycle gives the agent back to `live` and a later plan decides again
      const next = await w.cycle(job.jobId);
      expect(next.drains).toEqual([{ slotNumber: 1, session: s1.session, phase: "live", outcome: "returned", code: "drain_not_finished" }]);
      expect(w.phases(m)).toEqual(["live"]);
      expect(w.stopSeat).not.toHaveBeenCalled();
    } finally {
      w.db.close();
    }
  });
  it("A daemon exit after the drain's stop took effect and before its result was written leaves the slot `draining` with the attempt on record, and the next cycle stops the recorded session again, never giving back to `live` an agent that no longer runs.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      const session = w.latestOf(s1.nodeId)!;
      // the stop takes effect, then the daemon exits before the drain writes its result
      w.stopSeat.mockImplementationOnce(async () => {
        w.sessions.updateStatus(session.id, "stopped");
        throw new Error("daemon exited");
      });
      await w.cycle(job.jobId).catch(() => undefined);
      expect(w.latestOf(s1.nodeId)?.status).toBe("stopped");
      expect(w.phases(m)).toEqual(["draining"]);

      const next = await w.cycle(job.jobId);
      expect(next.drains).toEqual([expect.objectContaining({ slotNumber: 1, session: s1.session, phase: "drained", outcome: "drained" })]);
      expect(w.phases(m)).toEqual(["drained"]);
      expect(w.stopSeat).toHaveBeenCalledTimes(2);
      expect(w.stopSeat.mock.calls[1]![0]).toMatchObject({ seatRef: s1.session, expected: { nodeId: s1.nodeId, sessionId: session.id } });
      // stopped again, never captured again
      expect(w.captures).toHaveLength(1);
    } finally {
      w.db.close();
    }
  });

  it("A pool block that becomes unreadable while a drain waits for the agent's lifecycle lease captures nothing and stops nothing, and the slot stays `draining` in the hold.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      w.hooks.beforeLifecycle = () => {
        w.db.prepare("UPDATE nodes SET pool = ? WHERE id = ?").run(JSON.stringify({ max: 2, min: 5 }), m.nodeId);
      };

      const notes = await w.cycle(job.jobId);
      expect(w.captures).toEqual([]);
      expect(w.stopSeat).not.toHaveBeenCalled();
      expect(w.latestOf(s1.nodeId)?.status).toBe("running");
      expect(notes.held).toEqual({ cause: "pool block unreadable", message: "held: pool block unreadable" });
      expect(notes.drains).toEqual([{ slotNumber: 1, session: s1.session, phase: "draining", outcome: "draining", code: "pool_block_changed" }]);
      expect(w.phases(m)).toEqual(["draining"]);
    } finally {
      w.db.close();
    }
  });

  it("An unconfirmed stop after an attempted kill is not tried again in a cycle whose pool block became unreadable while it waited for the lease: no second stop, and the slot stays `draining`.", async () => {
    const w = drainWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      w.stopResults.push({ ok: false, code: "stop_uncertain", message: "The kill was sent but the session could not be confirmed gone.", partialEffect: true });
      await w.cycle(job.jobId);
      expect(w.phases(m)).toEqual(["draining"]);
      w.hooks.beforeLifecycle = () => {
        w.db.prepare("UPDATE nodes SET pool = ? WHERE id = ?").run(JSON.stringify({ max: 2, min: 5 }), m.nodeId);
      };

      const second = await w.cycle(job.jobId);
      expect(w.stopSeat).toHaveBeenCalledTimes(1);
      expect(second.held).toEqual({ cause: "pool block unreadable", message: "held: pool block unreadable" });
      expect(second.drains).toEqual([{ slotNumber: 1, session: s1.session, phase: "draining", outcome: "draining", code: "pool_block_changed" }]);
      expect(w.phases(m)).toEqual(["draining"]);
      expect(w.latestOf(s1.nodeId)?.status).toBe("running");
    } finally {
      w.db.close();
    }
  });
});

describe("seat-pool drain: after `pool: {}` (#3395 Piece 1)", () => {
  it("After `pool: {}`, the job drains free agents with the last spec stored on its row, leaves busy agents `live`, and ends (`terminal`) once every agent is `drained`.", async () => {
    const w = drainWorld();
    try {
      const m = w.model({ ...SPEC, min: 2, cooldownSeconds: 3600 });
      const s1 = w.agent(m, 1);
      const s2 = w.agent(m, 2);
      const job = w.jobFor(m);
      // `pool: {}` clears the stored block; the job keeps the block it was ensured with
      w.db.prepare("UPDATE nodes SET pool = NULL WHERE id = ?").run(m.nodeId);
      expect(w.rigRepo.getNodePool(m.nodeId)).toBeUndefined();
      w.activity.set(s1.nodeId, busyState(s1.nodeId));

      // the free agent is drained (min and the cooldown don't hold it), the busy one stays `live`, and the job runs on
      const first = await w.engine.evaluate(w.jobsRepo.getByIdOrThrow(job.jobId));
      expect(first.outcome).toMatchObject({ action: "skip", reason: "seat_pool_report" });
      expect((first.outcome as { notes: Record<string, unknown> }).notes.drains).toEqual([
        expect.objectContaining({ slotNumber: 2, session: s2.session, outcome: "drained", stop: { cause: "drain", result: "stopped" } }),
      ]);
      expect(w.phases(m)).toEqual(["live", "drained"]);
      expect(w.jobsRepo.getByIdOrThrow(job.jobId).state).toBe("active");

      // once the busy agent is free and idle past idle_grace_s, it is drained and the job ends
      w.activity.set(s1.nodeId, idleState(s1.nodeId));
      const second = await w.engine.evaluate(w.jobsRepo.getByIdOrThrow(job.jobId));
      expect(second.outcome).toMatchObject({ action: "terminal", reason: "seat_pool_removed_drained" });
      expect(w.phases(m)).toEqual(["drained", "drained"]);
      expect(w.jobsRepo.getByIdOrThrow(job.jobId).state).toBe("terminal");
      // the nodes stay
      expect(w.rigRepo.getRig(m.rigId)!.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([m.nodeId, s1.nodeId, s2.nodeId]));
    } finally {
      w.db.close();
    }
  });
});
