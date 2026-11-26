import { describe, it, expect, vi, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
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
import { SeatPoolSlotsRepository } from "../src/domain/seat-pool-slots.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { makeSeatPoolPolicy, seatPoolRoom } from "../src/domain/policies/seat-pool.js";
import { reconcileSeatPoolNode, type SeatPoolReconcileResult } from "../src/domain/seat-pool-registration.js";
import {
  makeSeatPoolExecutor, readSeatPoolAgents, seatPoolQueueEffects,
  type SeatPoolAddDeps, type SeatPoolExecutor, type SeatPoolExecutorDeps, type SeatPoolSeatStop,
} from "../src/domain/seat-pool-executor.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { convergeOp, type ConvergeResult } from "../src/domain/topology-converge.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ArbitratedSeatState } from "../src/domain/activity-taxonomy.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";

// #3395 (Piece 1): the seat pool's add while `max` drops, and an add across a daemon restart. Just before the issue the
// cycle re-checks the block, the job, the holds and the surplus, and cancels a reservation they reach; an add with a node
// settles by its latest session (running, not running, or unknown and read again); and a new process settles the
// attempts no process runs any more by replaying the add's operation id, never issuing the add again. The job is unarmed
// in the daemon, so each test composes the executor and an engine that has the seat-pool policy, over a real
// instantiator whose terminal and Claude are fakes. A daemon restart is a new executor and engine (and a new delivery
// guard) over the same database; the old executor's call is left hanging, never resolved.

const RIG = "pool-rig";
const IDLE_SINCE = "2026-11-18T10:00:00.000Z";
const AGENT_YAML = `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function fullDb(): Database.Database {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  return db;
}

function idleState(nodeId: string, changedAt = IDLE_SINCE): ArbitratedSeatState {
  return {
    seatNodeId: nodeId, activity: "idle-at-prompt", needsInput: { count: 0, reason: null }, needsInputEvidence: null,
    backgroundWork: null, decidedBy: null, seq: 1, changedAt, rungs: [], lastSwap: null,
  } as unknown as ArbitratedSeatState;
}

type Attempt = { id: string; status: string; message?: string; code?: string; observed?: string };
type AddEntry = { slotNumber: number; logicalId: string; nodeId?: string; attempt: Attempt };
const issuedOf = (notes: Record<string, unknown>) => (notes.add as { issued: AddEntry[] }).issued;

function lifecycleWorld() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seat-pool-add-lifecycle-")));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "agents", "impl"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "impl", "agent.yaml"), AGENT_YAML);
  const modelCwd = path.join(root, "work");
  fs.mkdirSync(modelCwd);

  const db = fullDb();
  cleanups.push(() => db.close());
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
  const snapshotRepo = new SnapshotRepository(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry: sessions, eventBus: bus, snapshotRepo, checkpointStore: new CheckpointStore(db) });
  const activity = new Map<string, ArbitratedSeatState>();
  const clock = { now: new Date(Date.now() + 3_600_000) };

  const panes = new Map<string, number>();
  const conversations = new Map<string, string>();
  let nextPid = 100;
  const listProcesses = async (): Promise<NativeProcessRow[]> => [...panes].flatMap(([session, pid]) => {
    const token = conversations.get(session), startedAt = "Sun Nov 22 12:00:00 2026";
    return [
      { pid, ppid: 1, pgid: pid, tpgid: token ? pid + 1 : pid, executableName: "bash", command: "bash", startedAt },
      ...(token ? [{ pid: pid + 1, ppid: pid, pgid: pid + 1, tpgid: pid + 1, executableName: "claude", command: `claude --session-id ${token}`, startedAt }] : []),
    ];
  });
  const tmux = {
    startServer: vi.fn(async () => {}),
    createSession: vi.fn(async (session: string) => {
      panes.set(session, nextPid += 2);
      conversations.delete(session);
      return { ok: true as const };
    }),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    probeSession: vi.fn(async () => ({ state: "present" as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async (session: string) => panes.has(session)
      ? [{ id: `%${panes.get(session)}`, index: 0, active: true, cwd: root, width: 100, height: 30 }] : []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPanePid: vi.fn(async (target: string) => (target.startsWith("%") ? Number(target.slice(1)) : panes.get(target) ?? null)),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => "Claude Code\n>"),
  } as unknown as TmuxAdapter;
  const launchHarness = vi.fn(async (binding: NodeBinding): Promise<{ ok: true; resumeToken: string; resumeType: string } | { ok: false; error: string }> => {
    const token = randomUUID();
    conversations.set(binding.tmuxSession!, token);
    return { ok: true as const, resumeToken: token, resumeType: "claude_id" };
  });
  const claude: RuntimeAdapter = {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness,
  } as unknown as RuntimeAdapter;
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry: sessions, eventBus: bus, tmuxAdapter: tmux });
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry: sessions, eventBus: bus, tmuxAdapter: tmux, listProcesses, sleep: async () => {} });
  const inst = new PodRigInstantiator({
    db, rigRepo, podRepo, sessionRegistry: sessions, eventBus: bus, nodeLauncher, startupOrchestrator,
    fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: (p: string) => fs.existsSync(p) },
    adapters: { "claude-code": claude }, tmuxAdapter: tmux,
  } as unknown as ConstructorParameters<typeof PodRigInstantiator>[0]);
  const exporter = new RigSpecExporter({ rigRepo, sessionRegistry: sessions, podRepo });

  /** The add's call: the real converge path, with a hook before it and one after it, before the executor reads it. */
  const hooks: { beforeAdd?: () => Promise<void>; afterAdd?: (result: ConvergeResult) => Promise<void> | void } = {};
  const converge = vi.fn<SeatPoolAddDeps["converge"]>(async (rigId, op, rigRoot, opts): Promise<ConvergeResult> => {
    await hooks.beforeAdd?.();
    const result = await convergeOp({ instantiator: inst }, rigId, op, rigRoot, opts);
    await hooks.afterAdd?.(result);
    return result;
  });
  const latestOf = (nodeId: string) => db.prepare("SELECT id, status FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(nodeId) as { id: string; status: string };
  /** The checked stop: stops the expected session while it is still the node's latest. */
  const stopSeat = vi.fn(async (input: { seatRef: string; expected: { nodeId: string; sessionId: string } }): Promise<SeatPoolSeatStop> => {
    const latest = latestOf(input.expected.nodeId);
    if (latest?.id !== input.expected.sessionId) return { ok: false, code: "selection_changed", message: "The selected seat or latest session changed." };
    sessions.updateStatus(latest.id, "stopped");
    return { ok: true };
  });

  /** One daemon process: its delivery guard, executor and engine over the shared database. */
  const boot = () => {
    const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
    const deps: SeatPoolExecutorDeps = {
      db, rigRepo, slots, jobsRepo,
      queue: seatPoolQueueEffects(queue),
      heldCount: (id) => outbox.heldCount(id),
      confirmedStopped: (id) => nodeExecutorConfirmedStopped(db, id),
      seatState: (id) => activity.get(id) ?? null,
      custody: (ids, fn) => guard.custody(ids, fn),
      now: () => clock.now,
      drain: {
        lifecycle: (ids, fn) => guard.lifecycle(ids, fn),
        refresh: async () => {},
        capture: (rigId) => ({ snapshotId: snapshotCapture.captureSnapshot(rigId, "auto-rehydrate").id }),
        stopSeat,
      },
      add: { exportMember: (rigId, nodeId) => exporter.exportedRawMemberFromNode(rigId, nodeId), converge, makeFolder: vi.fn() },
    };
    const executor = makeSeatPoolExecutor(deps);
    const engine = new WatchdogPolicyEngine({
      jobsRepo, historyLog: history, eventBus: bus, deliver: async () => ({ status: "ok" }),
      additionalPolicies: [makeSeatPoolPolicy({ cycle: (job) => executor.cycle(job) })],
    });
    return { deps, executor, engine };
  };
  let proc: { deps: SeatPoolExecutorDeps; executor: SeatPoolExecutor; engine: WatchdogPolicyEngine } = boot();
  /** A daemon restart: a new process over the same database. The old one's add calls are left hanging. */
  const restart = () => { proc = boot(); };
  const reg = { db, rigRepo, jobsRepo, warn: vi.fn() };

  type Model = { rigId: string; nodeId: string; logicalId: string; session: string; jobId: string };
  const model = async (pool: Record<string, unknown>): Promise<Model> => {
    const spec = stringifyYaml({
      version: "0.2", name: RIG,
      pods: [{ id: "dev", label: "Dev", edges: [], members: [{
        id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: modelCwd, pool,
      }] }],
      edges: [],
    });
    const up = await inst.instantiate(spec, root);
    if (!up.ok) throw new Error(JSON.stringify(up));
    const node = rigRepo.getRig(up.result.rigId)!.nodes.find((n) => n.logicalId === "dev.impl")!;
    const result: SeatPoolReconcileResult = reconcileSeatPoolNode(reg, node.id);
    if (!("job" in result)) throw new Error(`no job: ${JSON.stringify(result)}`);
    return { rigId: up.result.rigId, nodeId: node.id, logicalId: node.logicalId, session: `dev-impl@${RIG}`, jobId: result.job.jobId };
  };
  /** The block re-applied with a new `max` and `min`, as a re-apply stores it. */
  const setMax = (m: Model, max: number, min: number) => {
    const stored = rigRepo.getNodePool(m.nodeId);
    if (!stored || !("spec" in stored)) throw new Error("no stored spec");
    rigRepo.setNodePool(m.nodeId, { spec: { ...stored.spec, max, min } });
    reconcileSeatPoolNode(reg, m.nodeId);
  };
  const outcomeOf = async (jobId: string) =>
    (await proc.engine.evaluate(jobsRepo.getByIdOrThrow(jobId))).outcome as { action: string; reason?: string; notes?: Record<string, unknown> };
  const notesOf = async (jobId: string) => (await outcomeOf(jobId)).notes ?? {};
  const correlations = () => (db.prepare("SELECT operation_id, rig_id, node_ids_json FROM operation_correlations").all() as
    Array<{ operation_id: string; rig_id: string | null; node_ids_json: string }>);
  const hashes = () => db.prepare("SELECT operation_id, request_hash FROM operation_correlations").all();
  const nodeOf = (rigId: string, logicalId: string) => rigRepo.getRig(rigId)!.nodes.find((n) => n.logicalId === logicalId);
  const row = async (destination: string) => (await queue.create({
    sourceSession: `lead@${RIG}`, destinationSession: destination, body: "work", nudge: false,
  })).qitemId;
  return {
    root, db, bus, rigRepo, slots, sessions, queue, history, activity, clock, hooks, converge, launchHarness, stopSeat,
    latestOf, model, setMax, outcomeOf, notesOf, correlations, hashes, nodeOf, row, restart,
    deps: () => proc.deps, executor: () => proc.executor,
  };
}

describe("seat-pool add: while max drops and across a restart (#3395 Piece 1)", () => {
  it("`max` going 1 to 0 between plan and issue leaves no operation row and no node, and the add is never called.", async () => {
    const w = lifecycleWorld();
    const m = await w.model({ max: 1, min: 1 });
    // the block is re-applied with `max: 0` right after the reservation, before the issue
    const reserve = w.slots.reserveAdd.bind(w.slots);
    vi.spyOn(w.slots, "reserveAdd").mockImplementationOnce((input) => { const r = reserve(input); w.setMax(m, 0, 0); return r; });

    const notes = await w.notesOf(m.jobId);
    await w.executor().idle();
    expect(notes.add).toEqual({
      cancelled: [{ slotNumber: 1, logicalId: "dev.impl-s1", attempt: { id: expect.any(String), status: "cancelled", message: "cancelled: not issued", code: "max_lowered" } }],
    });
    expect(JSON.stringify(notes)).not.toContain("\"stop\"");
    expect(w.correlations()).toEqual([]);
    expect(w.converge).not.toHaveBeenCalled();
    expect(w.slots.forModel(m.nodeId)).toEqual([]);
    expect(w.nodeOf(m.rigId, "dev.impl-s1")).toBeUndefined();
    expect(w.slots.nextSlot(m.nodeId)).toEqual({ slotNumber: 1, logicalId: "dev.impl-s1" });
  });

  it("`max` dropping to 0 while the add is `issued`: the add ends running, receives no rows, and drains only through the confirmed stop after `idle_grace_s`.", async () => {
    const w = lifecycleWorld();
    const m = await w.model({ max: 1, min: 1, idle_grace_s: 300, cooldown_s: 60 });
    const gate = deferred();
    w.hooks.beforeAdd = () => gate.promise;
    const id = issuedOf(await w.notesOf(m.jobId))[0]!.attempt.id;

    w.setMax(m, 0, 0);
    // issued: never cancelled or drained by sizing
    const during = await w.notesOf(m.jobId);
    expect(during.slots).toEqual([{ slotNumber: 1, nodeId: null, phase: "adding", attempt: { id, status: "in_flight", message: `in flight (attempt ${id})` } }]);
    expect(during).not.toHaveProperty("add");
    expect(during).not.toHaveProperty("drains");
    const q = await w.row(m.session);

    gate.resolve();
    await w.executor().idle();
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
    w.activity.set(agent.id, idleState(agent.id, w.clock.now.toISOString()));
    const settled = await w.notesOf(m.jobId);
    expect(settled.settled).toEqual([{ slotNumber: 1, logicalId: "dev.impl-s1", nodeId: agent.id, attempt: { id, status: "running" } }]);
    expect(settled).not.toHaveProperty("moved");
    expect(settled).not.toHaveProperty("drains");
    expect(w.stopSeat).not.toHaveBeenCalled();
    expect(w.queue.getById(q)).toMatchObject({ state: "pending", destinationSession: m.session });

    // inside `idle_grace_s`: nothing stopped
    w.clock.now = new Date(w.clock.now.getTime() + 299_000);
    expect(await w.notesOf(m.jobId)).not.toHaveProperty("drains");
    expect(w.stopSeat).not.toHaveBeenCalled();

    w.clock.now = new Date(w.clock.now.getTime() + 2_000);
    const drained = await w.notesOf(m.jobId);
    expect(drained.drains).toEqual([{
      slotNumber: 1, session: `dev-impl-s1@${RIG}`, phase: "drained", outcome: "drained", snapshotId: expect.any(String),
      stop: { cause: "drain", result: "stopped" },
    }]);
    expect(drained).not.toHaveProperty("moved");
    expect(w.stopSeat).toHaveBeenCalledTimes(1);
    expect(w.stopSeat.mock.calls[0]![0]).toMatchObject({ seatRef: `dev-impl-s1@${RIG}`, expected: { nodeId: agent.id } });
    expect(w.queue.getById(q)).toMatchObject({ state: "pending", destinationSession: m.session });
    expect(w.slots.forModel(m.nodeId).map((s) => [s.slotNumber, s.phase])).toEqual([[1, "drained"]]);
    expect(w.nodeOf(m.rigId, "dev.impl-s1")!.id).toBe(agent.id);
  });

  it("`max` drops to 0 and then the add fails in preflight: nothing is counted and no slot row is left.", async () => {
    const w = lifecycleWorld();
    const m = await w.model({ max: 1, min: 1 });
    const gate = deferred();
    w.hooks.beforeAdd = () => gate.promise;
    const id = issuedOf(await w.notesOf(m.jobId))[0]!.attempt.id;

    w.setMax(m, 0, 0);
    // a cycle reads `max: 0` while the add is issued: it is neither cancelled nor settled
    const during = await w.notesOf(m.jobId);
    expect(during.slots).toEqual([{ slotNumber: 1, nodeId: null, phase: "adding", attempt: { id, status: "in_flight", message: `in flight (attempt ${id})` } }]);
    expect(during).not.toHaveProperty("add");
    expect(during).not.toHaveProperty("settled");
    // the agent spec is gone when the add runs: the preflight refuses it before any node is created
    fs.rmSync(path.join(w.root, "agents", "impl", "agent.yaml"));
    gate.resolve();
    await w.executor().idle();

    const notes = await w.notesOf(m.jobId);
    expect(notes.settled).toEqual([{
      slotNumber: 1, logicalId: "dev.impl-s1", attempt: { id, status: "no_node", code: "preflight_failed", message: expect.any(String) },
    }]);
    expect(JSON.stringify(notes)).not.toContain("\"stop\"");
    expect(w.slots.forModel(m.nodeId)).toEqual([]);
    expect(readSeatPoolAgents(w.deps(), w.slots.forModel(m.nodeId))).toEqual([]);
    expect(w.nodeOf(m.rigId, "dev.impl-s1")).toBeUndefined();
    expect(w.slots.nextSlot(m.nodeId)).toEqual({ slotNumber: 1, logicalId: "dev.impl-s1" });
    expect(w.converge).toHaveBeenCalledTimes(1);
  });

  it("`max` drops to 0 and then the add ends `failed` with a node: the slot is `drained` and held, `room` is freed, and the slot is not retried; while it stays, no new number is taken, cycle after cycle, and the add's notes name that attempt.", async () => {
    const w = lifecycleWorld();
    const m = await w.model({ max: 1, min: 1 });
    const gate = deferred();
    w.hooks.beforeAdd = () => gate.promise;
    // the agent's launch fails, and its session exits
    w.launchHarness.mockResolvedValueOnce({ ok: false, error: "harness exited" });
    w.hooks.afterAdd = () => { w.sessions.updateStatus(w.latestOf(w.nodeOf(m.rigId, "dev.impl-s1")!.id).id, "exited"); };
    const id = issuedOf(await w.notesOf(m.jobId))[0]!.attempt.id;

    w.setMax(m, 0, 0);
    // a cycle reads `max: 0` while the add is issued: it is neither cancelled, settled nor issued again
    const during = await w.notesOf(m.jobId);
    expect(during.slots).toEqual([{ slotNumber: 1, nodeId: null, phase: "adding", attempt: { id, status: "in_flight", message: `in flight (attempt ${id})` } }]);
    expect(during).not.toHaveProperty("add");
    expect(during).not.toHaveProperty("settled");
    expect(w.converge).toHaveBeenCalledTimes(1);
    gate.resolve();
    await w.executor().idle();
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
    expect(agent).toBeDefined();

    const notes = await w.notesOf(m.jobId);
    const settled = notes.settled as AddEntry[];
    expect(settled).toHaveLength(1);
    expect(settled[0]).toEqual({ slotNumber: 1, logicalId: "dev.impl-s1", nodeId: agent.id, attempt: { id, status: "not_running", observed: "exited", message: "Harness launch failed: harness exited" } });
    expect(JSON.stringify(notes)).not.toContain("\"stop\"");
    expect(w.stopSeat).not.toHaveBeenCalled();
    const [slot] = w.slots.forModel(m.nodeId);
    expect(slot).toMatchObject({ nodeId: agent.id, phase: "drained", attemptState: "settled" });
    expect(JSON.parse(slot!.reuseHold!)).toEqual({ code: "failed", observed: "exited", error: "Harness launch failed: harness exited" });
    // the add's call ended `failed`, with the node it created
    expect(JSON.parse(slot!.attemptOutcome!).call).toMatchObject({ ok: true, status: "failed", nodeId: agent.id });
    // the node and its session stay
    expect(w.latestOf(agent.id).status).toBe("exited");

    // room: the drained slot takes none, and counts in no agent the pool serves with
    w.setMax(m, 1, 1);
    const agents = readSeatPoolAgents(w.deps(), w.slots.forModel(m.nodeId));
    expect(agents.map((a) => [a.slotNumber, a.phase, a.running])).toEqual([[1, "drained", false]]);
    expect(seatPoolRoom({ max: 1 }, agents)).toBe(1);
    // reported each cycle, never tried again, and no new number is taken while it stays, past each cooldown
    const reuseHold = { code: "failed", observed: "exited", error: "Harness launch failed: harness exited" };
    for (let i = 0; i < 3; i++) {
      w.clock.now = new Date(w.clock.now.getTime() + 61_000);
      const again = await w.notesOf(m.jobId);
      await w.executor().idle();
      expect(again.slots).toEqual([{ slotNumber: 1, nodeId: agent.id, phase: "drained", attempt: settled[0]!.attempt, reuseHold }]);
      expect(again.add).toEqual({
        held: `held: failed add ${id} (slot 1) settled not_running (exited)`,
        failedAdd: { slotNumber: 1, nodeId: agent.id, attempt: settled[0]!.attempt, reuseHold },
      });
      expect(JSON.stringify(again)).not.toContain("\"stop\"");
    }
    expect(w.nodeOf(m.rigId, "dev.impl-s2")).toBeUndefined();
    expect(w.converge).toHaveBeenCalledTimes(1);
    expect(w.correlations()).toHaveLength(1);
  });

  it("An add whose outcome is `unknown` holds no new number: with demand for one more agent, the next number is issued.", async () => {
    const w = lifecycleWorld();
    const m = await w.model({ max: 2, min: 1 });
    // the first agent's call returns with its startup not ready: its result is unknown
    w.hooks.afterAdd = () => { w.db.prepare("UPDATE sessions SET startup_status = 'pending' WHERE node_id = ?").run(w.nodeOf(m.rigId, "dev.impl-s1")!.id); };
    const id1 = issuedOf(await w.notesOf(m.jobId))[0]!.attempt.id;
    await w.executor().idle();
    const s1 = w.nodeOf(m.rigId, "dev.impl-s1")!;
    const unknown = await w.notesOf(m.jobId);
    expect(unknown.slots).toEqual([{ slotNumber: 1, nodeId: s1.id, phase: "adding", attempt: expect.objectContaining({ id: id1, status: "unknown" }) }]);

    w.hooks.afterAdd = undefined;
    w.setMax(m, 2, 2);
    const next = await w.notesOf(m.jobId);
    await w.executor().idle();
    expect(issuedOf(next).map((e) => e.logicalId)).toEqual(["dev.impl-s2"]);
    expect(next.add).not.toHaveProperty("held");
    expect(next.add).not.toHaveProperty("failedAdd");
    expect(w.converge).toHaveBeenCalledTimes(2);
  });

  it("An add whose node's executor is confirmed stopped while its session is not `exited` settles `not_running` with `observed: probe_absent`, and nothing is stopped.", async () => {
    const w = lifecycleWorld();
    const m = await w.model({ max: 1, min: 1 });
    // the agent's launch fails; its session is not marked exited, but the node's executor is confirmed stopped
    w.launchHarness.mockResolvedValueOnce({ ok: false, error: "harness exited" });
    let agentId: string | undefined;
    const confirmed = w.deps().confirmedStopped;
    w.deps().confirmedStopped = (nodeId) => nodeId === agentId || confirmed(nodeId);
    w.hooks.afterAdd = () => { agentId = w.nodeOf(m.rigId, "dev.impl-s1")!.id; };
    const id = issuedOf(await w.notesOf(m.jobId))[0]!.attempt.id;
    await w.executor().idle();
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
    expect(w.latestOf(agent.id).status).not.toBe("exited");

    const notes = await w.notesOf(m.jobId);
    expect(notes.settled).toEqual([{ slotNumber: 1, logicalId: "dev.impl-s1", nodeId: agent.id, attempt: { id, status: "not_running", observed: "probe_absent", message: "Harness launch failed: harness exited" } }]);
    expect(JSON.stringify(notes)).not.toContain("\"stop\"");
    expect(JSON.stringify(notes)).not.toContain("\"exited\"");
    expect(w.stopSeat).not.toHaveBeenCalled();
    expect(w.slots.forModel(m.nodeId)[0]).toMatchObject({ nodeId: agent.id, phase: "drained", attemptState: "settled" });
    expect(JSON.parse(w.slots.forModel(m.nodeId)[0]!.reuseHold!)).toEqual({ code: "failed", observed: "probe_absent", error: "Harness launch failed: harness exited" });
    expect(w.converge).toHaveBeenCalledTimes(1);
  });

  it("`max` going 2 to 1 with one free idle agent and one unknown add stops neither, and when the add later settles running it is the one drained, newest first.", async () => {
    const w = lifecycleWorld();
    const m = await w.model({ max: 2, min: 2, idle_grace_s: 300, cooldown_s: 60 });
    // the second agent's call returns with its startup not ready: its result is unknown
    let calls = 0;
    w.hooks.afterAdd = () => {
      if (++calls === 2) w.db.prepare("UPDATE sessions SET startup_status = 'pending' WHERE node_id = ?").run(w.nodeOf(m.rigId, "dev.impl-s2")!.id);
    };
    const first = issuedOf(await w.notesOf(m.jobId));
    expect(first.map((e) => e.slotNumber)).toEqual([1, 2]);
    const id2 = first[1]!.attempt.id;
    await w.executor().idle();
    const s1 = w.nodeOf(m.rigId, "dev.impl-s1")!, s2 = w.nodeOf(m.rigId, "dev.impl-s2")!;
    w.activity.set(s1.id, idleState(s1.id));
    w.activity.set(s2.id, idleState(s2.id));

    w.setMax(m, 1, 1);
    const unknown = await w.notesOf(m.jobId);
    expect(unknown.slots).toEqual([
      { slotNumber: 1, nodeId: s1.id, phase: "live", attempt: { id: first[0]!.attempt.id, status: "running" } },
      { slotNumber: 2, nodeId: s2.id, phase: "adding", attempt: { id: id2, status: "unknown", code: "not_settled", message: "unknown: latest session running, startup pending" } },
    ]);
    expect(unknown).not.toHaveProperty("drains");
    expect(JSON.stringify(unknown)).not.toContain("\"stop\"");
    expect(w.stopSeat).not.toHaveBeenCalled();
    expect(w.slots.forModel(m.nodeId).map((s) => [s.slotNumber, s.phase, s.attemptState])).toEqual([[1, "live", "settled"], [2, "adding", "issued"]]);

    // the unknown add settles running in the next cycle, and the one after drains it, the newest
    w.db.prepare("UPDATE sessions SET startup_status = 'ready' WHERE node_id = ?").run(s2.id);
    const settles = await w.notesOf(m.jobId);
    expect(settles.settled).toEqual([{ slotNumber: 2, logicalId: "dev.impl-s2", nodeId: s2.id, attempt: { id: id2, status: "running" } }]);
    expect(settles).not.toHaveProperty("drains");
    expect(w.stopSeat).not.toHaveBeenCalled();
    const drains = await w.notesOf(m.jobId);
    expect(drains.drains).toEqual([{
      slotNumber: 2, session: `dev-impl-s2@${RIG}`, phase: "drained", outcome: "drained", snapshotId: expect.any(String),
      stop: { cause: "drain", result: "stopped" },
    }]);
    expect(w.stopSeat).toHaveBeenCalledTimes(1);
    expect(w.stopSeat.mock.calls[0]![0]).toMatchObject({ seatRef: `dev-impl-s2@${RIG}`, expected: { nodeId: s2.id } });
    expect(w.slots.forModel(m.nodeId).map((s) => [s.slotNumber, s.phase])).toEqual([[1, "live"], [2, "drained"]]);
    expect(w.converge).toHaveBeenCalledTimes(2);
  });

  it("A daemon restart between plan and issue cancels the reservation, and no node exists.", async () => {
    const w = lifecycleWorld();
    const m = await w.model({ max: 1, min: 1 });
    // the daemon exits right after the reservation, before the issue
    const reserve = w.slots.reserveAdd.bind(w.slots);
    vi.spyOn(w.slots, "reserveAdd").mockImplementationOnce((input) => { reserve(input); throw new Error("daemon exited"); });
    await expect(w.executor().cycle({ jobId: m.jobId, context: { model_node_id: m.nodeId } })).rejects.toThrow("daemon exited");
    const [reserved] = w.slots.forModel(m.nodeId);
    expect(reserved).toMatchObject({ slotNumber: 1, nodeId: null, phase: "adding", attemptState: "reserved" });

    w.restart();
    const notes = await w.notesOf(m.jobId);
    await w.executor().idle();
    expect(notes.settled).toEqual([{
      slotNumber: 1, logicalId: "dev.impl-s1",
      attempt: { id: reserved!.attemptId, status: "cancelled", message: "cancelled: not issued", code: "interrupted_before_issue" },
    }]);
    expect(notes).not.toHaveProperty("add");
    expect(JSON.stringify(notes)).not.toContain("\"stop\"");
    expect(w.slots.forModel(m.nodeId)).toEqual([]);
    expect(w.correlations()).toEqual([]);
    expect(w.converge).not.toHaveBeenCalled();
    expect(w.nodeOf(m.rigId, "dev.impl-s1")).toBeUndefined();
  });

  it("Killing the daemon mid-add before the node is created leaves no node and no slot row, and the add is reported `not launched (interrupted before create)`.", async () => {
    const w = lifecycleWorld();
    const m = await w.model({ max: 1, min: 1 });
    // the daemon dies before the add creates anything: the call never returns
    w.hooks.beforeAdd = () => new Promise(() => {});
    const id = issuedOf(await w.notesOf(m.jobId))[0]!.attempt.id;
    expect(w.slots.forModel(m.nodeId)).toEqual([expect.objectContaining({ nodeId: null, phase: "adding", attemptState: "issued" })]);
    expect(w.correlations()).toEqual([{ operation_id: id, rig_id: null, node_ids_json: "[]" }]);
    const hashes = w.hashes();

    w.restart();
    const notes = await w.notesOf(m.jobId);
    await w.executor().idle();
    expect(notes.settled).toEqual([{
      slotNumber: 1, logicalId: "dev.impl-s1",
      attempt: { id, status: "no_node", code: "interrupted_before_create", message: "not launched (interrupted before create)" },
    }]);
    expect(JSON.stringify(notes)).not.toContain("\"stop\"");
    expect(w.slots.forModel(m.nodeId)).toEqual([]);
    expect(w.nodeOf(m.rigId, "dev.impl-s1")).toBeUndefined();
    expect(w.converge).toHaveBeenCalledTimes(1);
    expect(w.hashes()).toEqual(hashes);
    // the job's history keeps the report
    expect(JSON.stringify(w.history.listForJob(m.jobId))).toContain("not launched (interrupted before create)");
  });

  it("Killing the daemon mid-add after the node is created, the replayed `reserveOperation` classifies a launch that ends running as L5 and one that ends `failed` as L9, and exactly one add was ever issued.", async () => {
    for (const ends of ["running", "failed"] as const) {
      const w = lifecycleWorld();
      const m = await w.model({ max: 1, min: 1 });
      if (ends === "failed") w.launchHarness.mockResolvedValueOnce({ ok: false, error: "harness exited" });
      // the node and its session are written, then the daemon dies before the executor reads the call's result
      const reached = deferred();
      w.hooks.afterAdd = () => {
        if (ends === "failed") w.sessions.updateStatus(w.latestOf(w.nodeOf(m.rigId, "dev.impl-s1")!.id).id, "exited");
        reached.resolve();
        return new Promise(() => {});
      };
      const id = issuedOf(await w.notesOf(m.jobId))[0]!.attempt.id;
      await reached.promise;
      const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
      expect(w.slots.forModel(m.nodeId)).toEqual([expect.objectContaining({ nodeId: agent.id, phase: "adding", attemptState: "issued" })]);
      const hashes = w.hashes();

      w.restart();
      const notes = await w.notesOf(m.jobId);
      const next = await w.notesOf(m.jobId);
      await w.executor().idle();
      if (ends === "running") {
        expect(notes.settled).toEqual([{ slotNumber: 1, logicalId: "dev.impl-s1", nodeId: agent.id, attempt: { id, status: "running" } }]);
        expect(w.slots.forModel(m.nodeId)[0]).toMatchObject({ nodeId: agent.id, phase: "live", attemptState: "settled", reuseHold: null });
        expect(JSON.parse(w.slots.forModel(m.nodeId)[0]!.attemptResult!)).toEqual({ nodeId: agent.id, sessionId: w.latestOf(agent.id).id });
      } else {
        expect(notes.settled).toEqual([{ slotNumber: 1, logicalId: "dev.impl-s1", nodeId: agent.id, attempt: { id, status: "not_running", observed: "exited" } }]);
        expect(w.slots.forModel(m.nodeId)[0]).toMatchObject({ nodeId: agent.id, phase: "drained", attemptState: "settled" });
        // the call never returned: the hold says only what was observed
        expect(JSON.parse(w.slots.forModel(m.nodeId)[0]!.reuseHold!)).toEqual({ code: "not_running", observed: "exited" });
        expect(w.stopSeat).not.toHaveBeenCalled();
      }
      expect(JSON.stringify([notes, next])).not.toContain("\"stop\"");
      // exactly one add: one call across both processes, and one operation row, replayed with the same request
      expect(w.converge).toHaveBeenCalledTimes(1);
      expect(w.hashes()).toEqual(hashes);
      expect(w.correlations()).toEqual([{ operation_id: id, rig_id: m.rigId, node_ids_json: JSON.stringify([agent.id]) }]);
    }
  });

  it("A `reserved` add whose job becomes held before issue is cancelled, reported `cancelled: not issued`, and never called.", async () => {
    const w = lifecycleWorld();
    const m = await w.model({ max: 1, min: 1 });
    // `rig down` records `rig.stopped` right after the reservation, before the issue
    const reserve = w.slots.reserveAdd.bind(w.slots);
    vi.spyOn(w.slots, "reserveAdd").mockImplementationOnce((input) => {
      const r = reserve(input);
      w.bus.emit({ type: "rig.stopped", rigId: m.rigId });
      return r;
    });

    const notes = await w.notesOf(m.jobId);
    await w.executor().idle();
    const seq = (w.db.prepare("SELECT seq FROM events WHERE rig_id = ? AND type = 'rig.stopped'").get(m.rigId) as { seq: number }).seq;
    expect(notes.held).toEqual({ cause: "rig stopped", seq, message: `held: rig stopped (event ${seq})` });
    expect(notes.add).toEqual({
      cancelled: [{ slotNumber: 1, logicalId: "dev.impl-s1", attempt: { id: expect.any(String), status: "cancelled", message: "cancelled: not issued", code: "rig_stopped" } }],
    });
    expect(JSON.stringify(notes)).not.toContain("\"stop\"");
    expect(w.correlations()).toEqual([]);
    expect(w.converge).not.toHaveBeenCalled();
    expect(w.slots.forModel(m.nodeId)).toEqual([]);
    expect(w.nodeOf(m.rigId, "dev.impl-s1")).toBeUndefined();
  });

  it("A re-check that fails between the reservation and the issue leaves no reserved row, and the add is never called.", async () => {
    const w = lifecycleWorld();
    const m = await w.model({ max: 1, min: 1 });
    // the re-check's read of the slots fails right after the reservation
    const reserve = w.slots.reserveAdd.bind(w.slots);
    vi.spyOn(w.slots, "reserveAdd").mockImplementationOnce((input) => {
      const r = reserve(input);
      vi.spyOn(w.slots, "forModel").mockImplementationOnce(() => { throw new Error("slots unreadable"); });
      return r;
    });

    await w.notesOf(m.jobId).catch(() => ({}));
    await w.executor().idle();
    expect(w.slots.forModel(m.nodeId)).toEqual([]);
    expect(w.slots.nextSlot(m.nodeId)).toEqual({ slotNumber: 1, logicalId: "dev.impl-s1" });
    expect(w.correlations()).toEqual([]);
    expect(w.converge).not.toHaveBeenCalled();
    expect(w.stopSeat).not.toHaveBeenCalled();
  });

  it("An add whose settle fails after its call returned keeps the call on its row, and a later cycle settles it by that call.", async () => {
    const w = lifecycleWorld();
    const m = await w.model({ max: 1, min: 1 });
    // the launch fails while the session runs, ready; reading the slot after the call then fails once
    w.launchHarness.mockResolvedValueOnce({ ok: false, error: "harness exited" });
    w.hooks.afterAdd = () => {
      const latest = w.latestOf(w.nodeOf(m.rigId, "dev.impl-s1")!.id);
      w.sessions.updateStatus(latest.id, "running");
      w.sessions.updateStartupStatus(latest.id, "ready");
      vi.spyOn(w.slots, "get").mockImplementationOnce(() => { throw new Error("slot unreadable"); });
    };
    const id = issuedOf(await w.notesOf(m.jobId))[0]!.attempt.id;
    await w.executor().idle();
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
    const [kept] = w.slots.forModel(m.nodeId);
    expect(kept).toMatchObject({ nodeId: agent.id, phase: "adding", attemptState: "issued" });
    expect(JSON.parse(kept!.attemptOutcome!)).toMatchObject({ status: "unknown", code: "settle_failed", call: { ok: true, status: "failed", nodeId: agent.id } });

    // the next cycles read it again with the kept call: a failed launch whose session runs is not settled running
    for (let i = 0; i < 2; i++) {
      const notes = await w.notesOf(m.jobId);
      await w.executor().idle();
      expect(JSON.stringify(notes.settled ?? [])).not.toContain("\"running\"");
    }
    const [slot] = w.slots.forModel(m.nodeId);
    expect(slot).toMatchObject({ nodeId: agent.id, phase: "adding", attemptState: "issued", reuseHold: null });
    expect(JSON.parse(slot!.attemptOutcome!)).toMatchObject({ status: "unknown", call: { ok: true, status: "failed", nodeId: agent.id } });
    expect(w.converge).toHaveBeenCalledTimes(1);
    expect(w.stopSeat).not.toHaveBeenCalled();
    expect(id).toBe(slot!.attemptId);
  });

  it("A stored block that becomes unreadable while the cycle waits for custody holds the leftover adds too: the reservation a restart left stays until the block reads again.", async () => {
    const w = lifecycleWorld();
    const m = await w.model({ max: 1, min: 1 });
    const reserve = w.slots.reserveAdd.bind(w.slots);
    vi.spyOn(w.slots, "reserveAdd").mockImplementationOnce((input) => { reserve(input); throw new Error("daemon exited"); });
    await expect(w.executor().cycle({ jobId: m.jobId, context: { model_node_id: m.nodeId } })).rejects.toThrow("daemon exited");
    const [reserved] = w.slots.forModel(m.nodeId);
    const stored = w.rigRepo.getNodePool(m.nodeId)!;

    w.restart();
    // the block breaks after the cycle read it and before the custody lease is granted
    const deps = w.deps();
    const custody = deps.custody;
    deps.custody = (ids, fn) => {
      w.db.prepare("UPDATE nodes SET pool = ? WHERE id = ?").run(JSON.stringify({ max: 2, min: 5 }), m.nodeId);
      return custody(ids, fn);
    };
    const held = await w.notesOf(m.jobId);
    expect(held.held).toEqual({ cause: "pool block unreadable", message: "held: pool block unreadable" });
    expect(held.advisory).toMatch(/^the stored pool block can't be read \(/);
    expect(held).not.toHaveProperty("settled");
    expect(w.slots.forModel(m.nodeId)).toEqual([expect.objectContaining({ slotNumber: 1, attemptId: reserved!.attemptId, phase: "adding", attemptState: "reserved" })]);

    // readable again: the next cycle settles it
    deps.custody = custody;
    w.rigRepo.setNodePool(m.nodeId, stored);
    const notes = await w.notesOf(m.jobId);
    await w.executor().idle();
    expect(notes.settled).toEqual([{
      slotNumber: 1, logicalId: "dev.impl-s1",
      attempt: { id: reserved!.attemptId, status: "cancelled", message: "cancelled: not issued", code: "interrupted_before_issue" },
    }]);
    expect(JSON.stringify([held, notes])).not.toContain('"stop"');
    expect(w.stopSeat).not.toHaveBeenCalled();
    expect(w.converge).not.toHaveBeenCalled();
  });

  it("An add a cycle settles `not_running` from its row starts the cooldown before that cycle's drains: the free agent its plan picked is stopped only once `cooldown_s` has passed.", async () => {
    const w = lifecycleWorld();
    const m = await w.model({ max: 2, min: 2, idle_grace_s: 300, cooldown_s: 60 });
    // the second agent's call returns with its startup not ready: its result is unknown
    let calls = 0;
    w.hooks.afterAdd = () => {
      if (++calls === 2) w.db.prepare("UPDATE sessions SET startup_status = 'pending' WHERE node_id = ?").run(w.nodeOf(m.rigId, "dev.impl-s2")!.id);
    };
    const id2 = issuedOf(await w.notesOf(m.jobId))[1]!.attempt.id;
    await w.executor().idle();
    const s1 = w.nodeOf(m.rigId, "dev.impl-s1")!, s2 = w.nodeOf(m.rigId, "dev.impl-s2")!;
    w.activity.set(s1.id, idleState(s1.id));
    // the cycle that reports the first agent settled running; the second stays unknown
    await w.notesOf(m.jobId);
    // the unknown add's session then exits, and `max` drops to 0: the plan picks the free agent, and the same cycle
    // settles the exited add `not_running`, which drains its slot
    w.sessions.updateStatus(w.latestOf(s2.id).id, "exited");
    w.setMax(m, 0, 0);
    const notes = await w.notesOf(m.jobId);
    await w.executor().idle();
    expect(notes.settled).toEqual([{ slotNumber: 2, logicalId: "dev.impl-s2", nodeId: s2.id, attempt: { id: id2, status: "not_running", observed: "exited" } }]);
    expect(notes.drains).toEqual([{ slotNumber: 1, session: `dev-impl-s1@${RIG}`, phase: "live", outcome: "skipped", code: "cooldown" }]);
    expect(w.stopSeat).not.toHaveBeenCalled();
    expect(w.slots.forModel(m.nodeId).map((s) => [s.slotNumber, s.phase])).toEqual([[1, "live"], [2, "drained"]]);

    // past the cooldown, the free agent is drained
    w.clock.now = new Date(w.clock.now.getTime() + 61_000);
    const later = await w.notesOf(m.jobId);
    expect(later.drains).toEqual([{
      slotNumber: 1, session: `dev-impl-s1@${RIG}`, phase: "drained", outcome: "drained", snapshotId: expect.any(String),
      stop: { cause: "drain", result: "stopped" },
    }]);
    expect(w.stopSeat).toHaveBeenCalledTimes(1);
  });

  it("An add a cycle settles `not_running` from its row starts the cooldown before that cycle's add too: an eligible `drained` slot does not come back in it, and the add is skipped until `cooldown_s` has passed.", async () => {
    const w = lifecycleWorld();
    const m = await w.model({ max: 2, min: 2, idle_grace_s: 300, cooldown_s: 60 });
    // the second agent's call returns with its startup not ready: its result is unknown
    let calls = 0;
    w.hooks.afterAdd = () => {
      if (++calls === 2) w.db.prepare("UPDATE sessions SET startup_status = 'pending' WHERE node_id = ?").run(w.nodeOf(m.rigId, "dev.impl-s2")!.id);
    };
    const id2 = issuedOf(await w.notesOf(m.jobId))[1]!.attempt.id;
    await w.executor().idle();
    await w.notesOf(m.jobId);
    const s1 = w.nodeOf(m.rigId, "dev.impl-s1")!, s2 = w.nodeOf(m.rigId, "dev.impl-s2")!;
    // slot 1 was drained an hour ago, with no reuse hold: eligible to come back, outside its cooldown
    w.sessions.updateStatus(w.latestOf(s1.id).id, "exited");
    w.db.prepare("UPDATE seat_pool_slots SET phase = 'drained', phase_changed_at = ? WHERE node_id = ?")
      .run(new Date(w.clock.now.getTime() - 3_600_000).toISOString(), s1.id);
    // the unknown add's session then exits: the plan still counts it starting and adds one, and the same cycle settles
    // it `not_running`, which drains its slot
    w.sessions.updateStatus(w.latestOf(s2.id).id, "exited");
    const notes = await w.notesOf(m.jobId);
    await w.executor().idle();
    expect(notes.settled).toEqual([{ slotNumber: 2, logicalId: "dev.impl-s2", nodeId: s2.id, attempt: { id: id2, status: "not_running", observed: "exited" } }]);
    expect(notes.add).toEqual({ skipped: "cooldown" });
    expect(w.slots.forModel(m.nodeId).map((s) => [s.slotNumber, s.phase])).toEqual([[1, "drained"], [2, "drained"]]);

    // past the cooldown, the add runs again and reaches slot 1
    w.clock.now = new Date(w.clock.now.getTime() + 61_000);
    const later = await w.notesOf(m.jobId);
    expect(later.add).toEqual({ comebacks: [{ slotNumber: 1, logicalId: "dev.impl-s1", nodeId: s1.id, code: "comeback_not_composed" }] });
  });

  it("After `pool: {}`, the evaluation that ends the job reports what it settled: a reservation a restart left is in the terminal notes, with its attempt id.", async () => {
    const w = lifecycleWorld();
    const m = await w.model({ max: 1, min: 1 });
    const reserve = w.slots.reserveAdd.bind(w.slots);
    vi.spyOn(w.slots, "reserveAdd").mockImplementationOnce((input) => { reserve(input); throw new Error("daemon exited"); });
    await expect(w.executor().cycle({ jobId: m.jobId, context: { model_node_id: m.nodeId } })).rejects.toThrow("daemon exited");
    const [reserved] = w.slots.forModel(m.nodeId);
    // `pool: {}` clears the stored block; the job keeps the block it was ensured with
    w.db.prepare("UPDATE nodes SET pool = NULL WHERE id = ?").run(m.nodeId);

    w.restart();
    const outcome = await w.outcomeOf(m.jobId);
    expect(outcome).toMatchObject({ action: "terminal", reason: "seat_pool_removed_drained" });
    expect(outcome.notes!.settled).toEqual([{
      slotNumber: 1, logicalId: "dev.impl-s1",
      attempt: { id: reserved!.attemptId, status: "cancelled", message: "cancelled: not issued", code: "interrupted_before_issue" },
    }]);
    expect(w.slots.forModel(m.nodeId)).toEqual([]);
    expect(JSON.stringify(outcome.notes)).not.toContain('"stop"');
    expect(w.stopSeat).not.toHaveBeenCalled();
    expect(w.converge).not.toHaveBeenCalled();
  });
});
