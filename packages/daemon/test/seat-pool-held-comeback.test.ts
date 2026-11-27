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
import type { SeatPoolSpec } from "../src/domain/seat-pool-spec.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { makeSeatPoolPolicy, seatPoolCanReceive, seatPoolRoom } from "../src/domain/policies/seat-pool.js";
import { reconcileSeatPoolNode, type SeatPoolReconcileResult } from "../src/domain/seat-pool-registration.js";
import {
  makeSeatPoolExecutor, readSeatPoolAgents, seatPoolQueueEffects, type SeatPoolAddDeps, type SeatPoolComebackDeps,
  type SeatPoolExecutor, type SeatPoolExecutorDeps, type SeatPoolSeatStop,
} from "../src/domain/seat-pool-executor.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { convergeOp, type ConvergeResult } from "../src/domain/topology-converge.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { ArbitratedSeatState } from "../src/domain/activity-taxonomy.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";

// #3395 (Piece 1): a comeback that ends without proof that the agent runs holds its slot, and is never repeated. Each
// test composes the executor and an engine that has the seat-pool policy (the job is unarmed in the daemon) over a real
// instantiator, the real member add, a drain whose capture is the real `auto-rehydrate` snapshot, and the real restore
// orchestrator and snapshot repository, whose terminal and Claude are fakes. A comeback that awaits a decision holds the
// slot `drained`; one that needs attention holds it `live`; only a later change on the slot's node ends the hold, and the
// node's latest session decides how.

const RIG = "pool-rig";
const IDLE_SINCE = "2026-11-18T10:00:00.000Z";
const AGENT_YAML = `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
/** The block the drain runs under: no agent is wanted, so a free agent idle past its grace is drained. */
const DRAINING: SeatPoolSpec = {
  max: 3, min: 0, dispatchAfterSeconds: 60, idleGraceSeconds: 300, cooldownSeconds: 60, dispatchTag: null, cwdTemplate: null, drain: false,
};
/** The block the held comeback runs under: two agents at most, none kept. */
const HELD: SeatPoolSpec = { ...DRAINING, max: 2 };

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fullDb(): Database.Database {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  return db;
}

function idleState(nodeId: string): ArbitratedSeatState {
  return {
    seatNodeId: nodeId, activity: "idle-at-prompt", needsInput: { count: 0, reason: null }, needsInputEvidence: null,
    backgroundWork: null, decidedBy: null, seq: 1, changedAt: IDLE_SINCE, rungs: [], lastSwap: null,
  } as unknown as ArbitratedSeatState;
}

/** A launch never returns: the daemon went away with it. */
const never = () => new Promise<never>(() => {});

function heldWorld() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seat-pool-held-")));
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
  const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
  const activity = new Map<string, ArbitratedSeatState>();
  const clock = { now: new Date(Date.now() + 3_600_000) }; // past dispatch_after_s for rows created now

  // Each live terminal session's pane and the conversation Claude runs in it: what the launch observations read.
  const panes = new Map<string, number>();
  const conversations = new Map<string, { token: string; resumed: boolean }>();
  let nextPid = 100;
  const listProcesses = async (): Promise<NativeProcessRow[]> => [...panes].flatMap(([session, pid]) => {
    const conversation = conversations.get(session), startedAt = "Sun Nov 22 12:00:00 2026";
    const command = conversation ? (conversation.resumed ? `claude --resume ${conversation.token}` : `claude --session-id ${conversation.token}`) : "";
    return [
      { pid, ppid: 1, pgid: pid, tpgid: conversation ? pid + 1 : pid, executableName: "bash", command: "bash", startedAt },
      ...(conversation ? [{ pid: pid + 1, ppid: pid, pgid: pid + 1, tpgid: pid + 1, executableName: "claude", command, startedAt }] : []),
    ];
  });
  const tmux = {
    startServer: vi.fn(async () => {}),
    createSession: vi.fn(async (session: string) => {
      panes.set(session, nextPid += 2);
      conversations.delete(session);
      return { ok: true as const };
    }),
    killSession: vi.fn(async (session: string) => { panes.delete(session); return { ok: true as const }; }),
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async (session: string) => panes.has(session)),
    probeSession: vi.fn(async (session: string) => ({ state: panes.has(session) ? "present" as const : "absent" as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async (session: string) => panes.has(session)
      ? [{ id: `%${panes.get(session)}`, index: 0, active: true, cwd: root, width: 100, height: 30 }] : []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPanePid: vi.fn(async (target: string) => (target.startsWith("%") ? Number(target.slice(1)) : panes.get(target) ?? null)),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => "Claude Code\n>"),
  } as unknown as TmuxAdapter;
  /** What the harness launch in a terminal session returns; by default it runs the conversation it is given. */
  const hooks: {
    harness?: (session: string) => { ok: false; error: string; recovery?: string } | undefined;
    /** The adapters a comeback of this logical id launches with; by default the daemon's. */
    adapters?: (logicalId: string) => Record<string, RuntimeAdapter> | undefined;
    /** Runs before the comeback's launch; a promise that never settles stands for a daemon that went away. */
    beforeLaunch?: (logicalId: string) => Promise<void> | void;
    /** Runs once the launch returned, before the executor reads its result. */
    afterLaunch?: (logicalId: string) => Promise<void> | void;
    /** Runs on the member add's result, before the executor reads it; it may give another one. */
    afterAdd?: (result: ConvergeResult) => ConvergeResult | void | Promise<never>;
  } = {};
  const claude: RuntimeAdapter = {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async (binding: NodeBinding, opts?: { resumeToken?: string }) => {
      const override = hooks.harness?.(binding.tmuxSession!);
      if (override) return override;
      const token = opts?.resumeToken ?? randomUUID();
      conversations.set(binding.tmuxSession!, { token, resumed: !!opts?.resumeToken });
      return { ok: true as const, resumeToken: token, resumeType: "claude_id" };
    }),
  } as unknown as RuntimeAdapter;
  const adapters = { "claude-code": claude };
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry: sessions, eventBus: bus, tmuxAdapter: tmux });
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry: sessions, eventBus: bus, tmuxAdapter: tmux, listProcesses, sleep: async () => {} });
  const inst = new PodRigInstantiator({
    db, rigRepo, podRepo, sessionRegistry: sessions, eventBus: bus, nodeLauncher, startupOrchestrator,
    fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: (p: string) => fs.existsSync(p) },
    adapters, tmuxAdapter: tmux,
  } as unknown as ConstructorParameters<typeof PodRigInstantiator>[0]);
  const exporter = new RigSpecExporter({ rigRepo, sessionRegistry: sessions, podRepo });
  const converge = vi.fn<SeatPoolAddDeps["converge"]>(async (rigId, op, rigRoot, opts): Promise<ConvergeResult> => {
    const result = await convergeOp({ instantiator: inst }, rigId, op, rigRoot, opts);
    return (await hooks.afterAdd?.(result)) ?? result;
  });

  const snapshotRepo = new SnapshotRepository(db);
  const checkpointStore = new CheckpointStore(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry: sessions, eventBus: bus, snapshotRepo, checkpointStore });
  const restorer = new RestoreOrchestrator({
    db, rigRepo, sessionRegistry: sessions, eventBus: bus, snapshotRepo, snapshotCapture, checkpointStore, nodeLauncher,
    tmuxAdapter: tmux,
    claudeResume: {
      canResume: vi.fn((type: string | null) => type === "claude_name" || type === "claude_id"),
      resume: vi.fn(async () => ({ ok: true as const })),
    } as unknown as ClaudeResumeAdapter,
    codexResume: { canResume: vi.fn(() => false), resume: vi.fn(async () => ({ ok: true as const })) } as unknown as CodexResumeAdapter,
    listProcesses,
  });
  const teardown = new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry: sessions, tmuxAdapter: tmux, snapshotCapture, eventBus: bus });

  const select = vi.fn<SeatPoolComebackDeps["select"]>((rigId, nodeId, logicalId) => snapshotRepo.selectComebackSnapshot(rigId, nodeId, logicalId));
  /** The comeback's launch: launchSingleNode with the explicit snapshot, always. */
  const launch = vi.fn<SeatPoolComebackDeps["launch"]>(async (rigId, logicalId, opts) => {
    await hooks.beforeLaunch?.(logicalId);
    const result = await restorer.launchSingleNode(rigId, logicalId, {
      snapshotId: opts.snapshotId, adapters: hooks.adapters?.(logicalId) ?? adapters, fsOps: { exists: (p) => fs.existsSync(p) },
    });
    await hooks.afterLaunch?.(logicalId);
    return result;
  });
  /** The drain's checked stop: it stops the expected session (its terminal goes), as the seat lifecycle service does. */
  const stopSeat = vi.fn(async (input: { seatRef: string; expected: { nodeId: string; sessionId: string } }): Promise<SeatPoolSeatStop> => {
    const latest = db.prepare("SELECT id, session_name FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(input.expected.nodeId) as { id: string; session_name: string } | undefined;
    if (latest?.id !== input.expected.sessionId) return { ok: false, code: "selection_changed", message: "The selected seat or latest session changed." };
    sessions.updateStatus(latest.id, "stopped");
    panes.delete(latest.session_name);
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
      lifecycle: (ids, fn) => guard.lifecycle(ids, fn),
      refresh: vi.fn(async () => {}),
      capture: (rigId) => ({ snapshotId: snapshotCapture.captureSnapshot(rigId, "auto-rehydrate").id }),
      stopSeat,
    },
    add: { exportMember: (rigId, nodeId) => exporter.exportedRawMemberFromNode(rigId, nodeId), converge, makeFolder: vi.fn() },
    comeback: { select, launch },
  };
  /** The executor and the engine of one daemon process: a restart builds both again over the same database. */
  let executor: SeatPoolExecutor = makeSeatPoolExecutor(deps);
  const engineOf = (current: SeatPoolExecutor) => new WatchdogPolicyEngine({
    jobsRepo, historyLog: history, eventBus: bus, deliver: async () => ({ status: "ok" }),
    additionalPolicies: [makeSeatPoolPolicy({ cycle: (job) => current.cycle(job) })],
  });
  let engine = engineOf(executor);
  const reg = { db, rigRepo, jobsRepo, warn: vi.fn() };

  type Model = { rigId: string; nodeId: string; logicalId: string; session: string; jobId: string };
  /** The model member, instantiated and launched, with its job. */
  const model = async (opts: { pool?: Record<string, unknown> } = {}): Promise<Model> => {
    const spec = stringifyYaml({
      version: "0.2", name: RIG,
      pods: [{ id: "dev", label: "Dev", edges: [], members: [{
        id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: modelCwd,
        pool: opts.pool ?? { max: 3, min: 1 },
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
  /** A daemon restart: a new executor and engine over the same database, and the start's reconcile of the model. */
  const restart = (m: Model) => {
    executor = makeSeatPoolExecutor(deps);
    engine = engineOf(executor);
    const result = reconcileSeatPoolNode(reg, m.nodeId);
    if (!("job" in result)) throw new Error(`no job after restart: ${JSON.stringify(result)}`);
  };
  /** One evaluation through the engine; its notes. */
  const notesOf = async (jobId: string) =>
    (((await engine.evaluate(jobsRepo.getByIdOrThrow(jobId))).outcome) as { notes?: Record<string, unknown> }).notes ?? {};
  const nodeOf = (rigId: string, logicalId: string) => rigRepo.getRig(rigId)!.nodes.find((n) => n.logicalId === logicalId);
  const sessionsOf = (nodeId: string) =>
    db.prepare("SELECT id, status, startup_status AS startup FROM sessions WHERE node_id = ? ORDER BY created_at, id").all(nodeId) as
      Array<{ id: string; status: string; startup: string | null }>;
  const latestOf = (nodeId: string) => sessionsOf(nodeId).at(-1)!;
  const row = async (destination: string) => (await queue.create({
    sourceSession: `lead@${RIG}`, destinationSession: destination, body: "work", nudge: false,
  })).qitemId;
  /** Where each open row is now. */
  const owners = () => db.prepare("SELECT qitem_id AS id, destination_session AS destination FROM queue_items WHERE state IN ('pending', 'in-progress', 'blocked') ORDER BY qitem_id").all() as
    Array<{ id: string; destination: string }>;
  /** The events that name a node. */
  const eventsNaming = (nodeId: string, type?: string) =>
    (db.prepare(`SELECT seq, type FROM events WHERE payload LIKE ? ${type ? "AND type = ?" : ""} ORDER BY seq`)
      .all(`%${nodeId}%`, ...(type ? [type] : [])) as Array<{ seq: number; type: string }>);
  const slotOf = (m: Model, slotNumber: number) => slots.forModel(m.nodeId).find((s) => s.slotNumber === slotNumber)!;
  const holdOf = (m: Model, slotNumber: number) => JSON.parse(slotOf(m, slotNumber).reuseHold ?? "null") as Record<string, unknown> | null;
  const liveCount = (m: Model) => slots.forModel(m.nodeId).filter((s) => s.phase === "live").length;
  const launchesOf = (logicalId: string) => launch.mock.calls.filter((call) => call[1] === logicalId).length;
  /** A session someone else starts on a node, as `rig seat launch --fresh` would leave it, with its terminal present
   *  unless it is gone. */
  const personSession = (nodeId: string, sessionName: string, status: string, startup: "pending" | "ready" | "attention_required" | "failed") => {
    const s = sessions.registerSession(nodeId, sessionName);
    sessions.updateStatus(s.id, status as never);
    sessions.updateStartupStatus(s.id, startup);
    if (status === "running" || status === "idle") panes.set(sessionName, nextPid += 2);
    else panes.delete(sessionName);
    return s.id;
  };

  /** The pool's own agents as the real add creates them: one cycle that adds `count`, settled running and idle. */
  const serve = async (m: Model, count: number) => {
    const notes = await notesOf(m.jobId);
    expect((notes.add as { issued?: unknown[] } | undefined)?.issued, JSON.stringify(notes.add)).toHaveLength(count);
    await executor.idle();
    const agents = slots.forModel(m.nodeId);
    expect(agents.map((s) => s.phase)).toEqual(Array.from({ length: count }, () => "live"));
    for (const slot of agents) activity.set(slot.nodeId!, idleState(slot.nodeId!));
    return agents.map((s) => ({ nodeId: s.nodeId!, logicalId: `dev.impl-s${s.slotNumber}`, session: `dev-impl-s${s.slotNumber}@${RIG}` }));
  };
  /** No agent wanted any more: the next cycle drains the free agents, each captured right before its stop. */
  const drain = async (m: Model, count: number) => {
    rigRepo.setNodePool(m.nodeId, { spec: DRAINING });
    const notes = await notesOf(m.jobId);
    const drains = notes.drains as Array<{ outcome: string }>;
    expect(drains.map((d) => d.outcome), JSON.stringify(notes)).toEqual(Array.from({ length: count }, () => "drained"));
    for (const slot of slots.forModel(m.nodeId)) activity.delete(slot.nodeId!);
  };
  /** Past the drain's cooldown. */
  const afterCooldown = () => { clock.now = new Date(clock.now.getTime() + (DRAINING.cooldownSeconds + 60) * 1000); };
  /** Two drained agents, `s1` and `s2`, each with its pool capture and its conversation's resume token, under the held
   *  block (`max: 2`, `min: 0`), past the cooldown. */
  const twoDrained = async () => {
    const m = await model({ pool: { max: 3, min: 2 } });
    const [s1, s2] = await serve(m, 2);
    await drain(m, 2);
    rigRepo.setNodePool(m.nodeId, { spec: HELD });
    afterCooldown();
    // the drains above stopped both agents; from here on, any stop is the pool's
    stopSeat.mockClear();
    return { m, s1: s1!, s2: s2! };
  };
  /** `s1` drained and `s2` still `live` and busy, under the held block, past the cooldown. */
  const oneDrainedOneBusy = async () => {
    const m = await model({ pool: { max: 3, min: 2 } });
    const [s1, s2] = await serve(m, 2);
    activity.delete(s2!.nodeId);
    rigRepo.setNodePool(m.nodeId, { spec: DRAINING });
    const notes = await notesOf(m.jobId);
    expect((notes.drains as Array<{ slotNumber: number; outcome: string }>).map((d) => [d.slotNumber, d.outcome]), JSON.stringify(notes)).toEqual([[1, "drained"]]);
    activity.delete(s1!.nodeId);
    rigRepo.setNodePool(m.nodeId, { spec: HELD });
    afterCooldown();
    stopSeat.mockClear();
    return { m, s1: s1!, s2: s2! };
  };
  /** The cycle that brings an agent back, and the next one, which reports what settled. */
  const comeBack = async (m: Model) => {
    const notes = await notesOf(m.jobId);
    await executor.idle();
    const next = await notesOf(m.jobId);
    return { notes, next, settled: (next.settled ?? []) as Array<{ slotNumber: number; attempt: Record<string, unknown> }> };
  };
  /** Step 1: `s1` comes back with no runtime adapter, so its pod-aware resume ends `awaiting-decision`. */
  const heldS1 = async () => {
    const world = await twoDrained();
    hooks.adapters = (logicalId) => (logicalId === "dev.impl-s1" ? {} : undefined);
    await row(world.m.session);
    const first = await comeBack(world.m);
    return { ...world, ...first };
  };

  return {
    db, bus, rigRepo, slots, sessions, queue, activity, clock, panes, hooks, converge, launch, stopSeat, restorer, teardown, adapters, deps,
    executor: () => executor, model, restart, notesOf, nodeOf, sessionsOf, latestOf, row, owners, eventsNaming, slotOf, holdOf, liveCount,
    launchesOf, personSession, serve, drain, afterCooldown, twoDrained, oneDrainedOneBusy, comeBack, heldS1,
  };
}

type World = ReturnType<typeof heldWorld>;

/** Every view of a slot an evaluation reports. */
const slotView = (notes: Record<string, unknown>, slotNumber: number) =>
  (notes.slots as Array<Record<string, unknown>>).find((s) => s.slotNumber === slotNumber);

/** The agents as the executor reads them. */
const agentsOf = (w: World, nodeId: string) => readSeatPoolAgents(w.deps, w.slots.forModel(nodeId));

describe("seat-pool held comeback: a comeback that needs a decision (#3395 Piece 1)", () => {
  it("A comeback of pod-aware `s1` (`resume_if_possible`, a resume token, `adapters: {}`) ends `awaiting-decision`: `s1` is `drained` with the hold, its `error` contains `rig seat launch`, exactly one `restore.subset_completed` names `s1`, no session runs, and the node's earlier session and binding are back.", async () => {
    const w = heldWorld();
    const { m, s1 } = await w.twoDrained();
    const token = (w.db.prepare("SELECT resume_token FROM sessions WHERE node_id = ?").get(s1.nodeId) as { resume_token: string | null }).resume_token;
    expect(token).toEqual(expect.any(String));
    const earlier = w.sessionsOf(s1.nodeId);
    const binding = w.sessions.getBindingForNode(s1.nodeId);
    w.hooks.adapters = (logicalId) => (logicalId === "dev.impl-s1" ? {} : undefined);
    await w.row(m.session);

    const { notes, settled } = await w.comeBack(m);
    expect((notes.add as { comebacks: Array<{ slotNumber: number }> }).comebacks.map((c) => c.slotNumber)).toEqual([1]);
    expect(w.launchesOf("dev.impl-s1")).toBe(1);
    const slot = w.slotOf(m, 1);
    expect(slot).toMatchObject({ nodeId: s1.nodeId, phase: "drained", attemptKind: "comeback", attemptState: "settled" });
    const hold = w.holdOf(m, 1)!;
    expect(hold).toMatchObject({ code: "awaiting-decision", snapshotId: expect.any(String) });
    expect(hold.error).toContain("rig seat launch");
    // Reported in `attempt.status`, never as a stop, with no observation: nothing was probed.
    const attempt = settled.find((s) => s.slotNumber === 1)!.attempt;
    expect(attempt).toEqual({ id: slot.attemptId, status: "not_running", code: "awaiting-decision", message: hold.error });
    expect(JSON.stringify(settled)).not.toContain("\"stop\"");
    expect(JSON.stringify(settled)).not.toContain("observed");
    expect(w.stopSeat).not.toHaveBeenCalled();
    expect(w.eventsNaming(s1.nodeId, "restore.subset_completed")).toHaveLength(1);
    // No session runs; the one the launch made was rolled back, and the earlier one and the binding are back.
    expect(w.sessionsOf(s1.nodeId).filter((s) => s.status === "running" || s.status === "idle")).toEqual([]);
    for (const before of earlier) expect(w.sessionsOf(s1.nodeId).find((s) => s.id === before.id)?.status).toBe(before.status);
    expect(w.sessions.getBindingForNode(s1.nodeId)?.tmuxSession).toBe(binding?.tmuxSession);
    // Reported with the slot in every evaluation.
    const again = await w.notesOf(m.jobId);
    expect(slotView(again, 1)).toMatchObject({ phase: "drained", attempt, reuseHold: hold });
  });

  it("In later cycles `s2` is reused and then `s3` gets the next number, live agents never exceed `max`, the launch spy for `s1` stays at one call, and no new event names `s1`.", async () => {
    const w = heldWorld();
    const { m, s1, s2, next } = await w.heldS1();
    const lastSeq = (w.db.prepare("SELECT seq FROM events WHERE type = 'restore.subset_completed' AND payload LIKE ? ORDER BY seq DESC LIMIT 1")
      .get(`%${s1.nodeId}%`) as { seq: number }).seq;
    // the cycle after step 1 already goes on with the next eligible slot
    const issued: string[] = ((next.add as { comebacks?: Array<{ logicalId: string; attempt?: unknown }> } | undefined)?.comebacks ?? [])
      .filter((c) => c.attempt).map((c) => c.logicalId);
    expect(w.liveCount(m)).toBeLessThanOrEqual(HELD.max);
    await w.row(m.session);
    await w.row(m.session);
    for (let i = 0; i < 4; i++) {
      const notes = await w.notesOf(m.jobId);
      await w.executor().idle();
      const add = notes.add as { comebacks?: Array<{ logicalId: string; attempt?: unknown }>; issued?: Array<{ logicalId: string }> } | undefined;
      for (const c of add?.comebacks ?? []) if (c.attempt) issued.push(c.logicalId);
      for (const a of add?.issued ?? []) issued.push(a.logicalId);
      expect(w.liveCount(m)).toBeLessThanOrEqual(HELD.max);
      w.clock.now = new Date(w.clock.now.getTime() + 61_000);
    }
    expect(issued).toEqual(["dev.impl-s2", "dev.impl-s3"]);
    expect(w.slotOf(m, 2)).toMatchObject({ nodeId: s2.nodeId, phase: "live" });
    expect(w.slotOf(m, 3)).toMatchObject({ phase: "live" });
    expect(w.slotOf(m, 1)).toMatchObject({ nodeId: s1.nodeId, phase: "drained" });
    expect(w.holdOf(m, 1)).toMatchObject({ code: "awaiting-decision" });
    expect(w.launchesOf("dev.impl-s1")).toBe(1);
    // (the rig's roster, recorded again when `s3` is added, lists every node: it is not an event about `s1`)
    expect(w.eventsNaming(s1.nodeId).filter((e) => e.seq > lastSeq && e.type !== "topology.roster_recorded")).toEqual([]);
  });

  it("Rebuilding the executor from the same DB and reconciling keeps `s1`'s hold and `error`, and nothing is relaunched.", async () => {
    const w = heldWorld();
    const { m } = await w.heldS1();
    const before = w.slotOf(m, 1);
    w.restart(m);
    for (let i = 0; i < 2; i++) {
      await w.notesOf(m.jobId);
      await w.executor().idle();
    }
    const after = w.slotOf(m, 1);
    expect(after.reuseHold).toBe(before.reuseHold);
    expect(after).toMatchObject({ phase: "drained", attemptId: before.attemptId, attemptState: "settled" });
    expect((JSON.parse(after.reuseHold!) as { error: string }).error).toContain("rig seat launch");
    expect(w.launchesOf("dev.impl-s1")).toBe(1);
  });
});

describe("seat-pool held comeback: a daemon restart in the middle of a comeback (#3395 Piece 1)", () => {
  it("After a crash between the `restore.subset_completed` event and the outcome write, the restarted pool takes the event's `awaiting-decision` for `s1`, keeps it held, and launches nothing.", async () => {
    const w = heldWorld();
    const { m, s1 } = await w.twoDrained();
    w.hooks.adapters = (logicalId) => (logicalId === "dev.impl-s1" ? {} : undefined);
    // the launch records its event and returns, and the daemon goes away before the executor reads the result
    w.hooks.afterLaunch = () => never();
    await w.row(m.session);
    await w.notesOf(m.jobId);
    await vi.waitFor(() => expect(w.eventsNaming(s1.nodeId, "restore.subset_completed")).toHaveLength(1));
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "adding", attemptKind: "comeback", attemptState: "issued", attemptOutcome: null });

    w.hooks.afterLaunch = undefined;
    w.restart(m);
    const notes = await w.notesOf(m.jobId);
    await w.executor().idle();
    const settled = (notes.settled ?? []) as Array<{ slotNumber: number; attempt: Record<string, unknown> }>;
    expect(settled.find((s) => s.slotNumber === 1)?.attempt).toMatchObject({ status: "not_running", code: "awaiting-decision" });
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "drained", attemptState: "settled" });
    expect(w.holdOf(m, 1)).toMatchObject({ code: "awaiting-decision", error: expect.stringContaining("rig seat launch") });
    expect(w.launchesOf("dev.impl-s1")).toBe(1);
    expect(w.eventsNaming(s1.nodeId, "restore.subset_completed")).toHaveLength(1);
  });

  it("With no event after the crash, `s1` is `unknown`, takes room, and is not issued again.", async () => {
    const w = heldWorld();
    const { m, s1 } = await w.twoDrained();
    w.rigRepo.setNodePool(m.nodeId, { spec: { ...HELD, max: 1 } });
    // the daemon goes away before the launch records anything
    w.hooks.beforeLaunch = () => never();
    await w.row(m.session);
    await w.notesOf(m.jobId);
    expect(w.launchesOf("dev.impl-s1")).toBe(1);
    expect(w.eventsNaming(s1.nodeId, "restore.subset_completed")).toEqual([]);

    w.hooks.beforeLaunch = undefined;
    const adds = w.converge.mock.calls.length;
    w.restart(m);
    await w.row(m.session);
    for (let i = 0; i < 2; i++) {
      w.clock.now = new Date(w.clock.now.getTime() + 61_000);
      const notes = await w.notesOf(m.jobId);
      await w.executor().idle();
      expect(slotView(notes, 1)).toMatchObject({ phase: "adding", attempt: { status: "unknown" } });
      // it takes the only room: no other agent is brought back or added
      expect(notes).not.toHaveProperty("add");
    }
    expect(seatPoolRoom({ max: 1 }, agentsOf(w, m.nodeId))).toBe(0);
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "adding", attemptState: "issued" });
    expect(w.slotOf(m, 2)).toMatchObject({ phase: "drained" });
    expect(w.launchesOf("dev.impl-s1")).toBe(1);
    expect(w.launch).toHaveBeenCalledTimes(1);
    expect(w.converge).toHaveBeenCalledTimes(adds);
  });
});

describe("seat-pool held comeback: across rig down and rig up (#3395 Piece 1)", () => {
  it("`rig down` then `rig up` keeps `s1` down as a drained pool agent.", async () => {
    const w = heldWorld();
    const { m, s1 } = await w.heldS1();
    const hold = w.slotOf(m, 1).reuseHold;
    const down = await w.teardown.teardown(m.rigId, { force: true });
    expect(down.errors).toEqual([]);
    expect(down.snapshotId).toEqual(expect.any(String));
    const up = await w.restorer.restore(down.snapshotId!, { adapters: w.adapters, fsOps: { exists: (p) => fs.existsSync(p) } });
    expect(up.ok, JSON.stringify(up)).toBe(true);
    expect(JSON.stringify(up)).toMatch(new RegExp(`"keptDown":\\[[^\\]]*"nodeId":"${s1.nodeId}"[^\\]]*"reason":"drained pool agent, not started"`));
    expect(w.sessionsOf(s1.nodeId).filter((s) => s.status === "running" || s.status === "idle")).toEqual([]);
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "drained", reuseHold: hold });
    // the model came back
    expect(w.latestOf(m.nodeId).status).toBe("running");
    // and the pool, once the rig is up, still leaves `s1` alone
    await w.notesOf(m.jobId);
    await w.executor().idle();
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "drained", reuseHold: hold });
    expect(w.launchesOf("dev.impl-s1")).toBe(1);
  });
});

describe("seat-pool held comeback: a later session decides (#3395 Piece 1)", () => {
  it("With `s3` free and `s1` given a running session with startup `ready` that tmux reports present, the next cycle makes `s1` `live` with no hold, surplus drains `s3`, and no row changes owner.", async () => {
    const w = heldWorld();
    const { m, s1 } = await w.heldS1();
    await w.row(m.session);
    await w.row(m.session);
    for (let i = 0; i < 2; i++) {
      await w.notesOf(m.jobId);
      await w.executor().idle();
    }
    expect(w.slots.forModel(m.nodeId).map((s) => [s.slotNumber, s.phase])).toEqual([[1, "drained"], [2, "live"], [3, "live"]]);
    const s2 = w.slotOf(m, 2).nodeId!;
    const s3 = w.slotOf(m, 3).nodeId!;
    // `s2` works a row; `s3` is free and idle past its grace; nothing waits for the model
    w.db.prepare("UPDATE queue_items SET state = 'done' WHERE destination_session = ?").run(m.session);
    const work = await w.row(`dev-impl-s2@${RIG}`);
    w.queue.claim({ qitemId: work, destinationSession: `dev-impl-s2@${RIG}` });
    w.activity.set(s3, idleState(s3));
    w.afterCooldown();
    const before = w.owners();

    const sessionId = w.personSession(s1.nodeId, `dev-impl-s1@${RIG}`, "running", "ready");
    const notes = await w.notesOf(m.jobId);
    await w.executor().idle();
    expect(notes.laterChanges).toEqual([{
      slotNumber: 1, logicalId: "dev.impl-s1", nodeId: s1.nodeId,
      session: { id: sessionId, status: "running", startupStatus: "ready" }, read: "ready", phase: "live",
    }]);
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "live", reuseHold: null });
    expect((notes.drains as Array<{ slotNumber: number; outcome: string }>).map((d) => [d.slotNumber, d.outcome])).toEqual([[3, "drained"]]);
    expect(w.slotOf(m, 3)).toMatchObject({ nodeId: s3, phase: "drained" });
    expect(w.slotOf(m, 2)).toMatchObject({ nodeId: s2, phase: "live" });
    expect(w.owners()).toEqual(before);
    expect(w.launchesOf("dev.impl-s1")).toBe(1);
  });

  it("A later change on a held slot whose latest session is confirmed absent makes it `drained` and eligible, unless the hold is `awaiting-decision` and no later session reached `ready`.", async () => {
    // A refusal's hold: a later session that ends absent makes the slot eligible.
    const w = heldWorld();
    const { m, s1 } = await w.twoDrained();
    w.hooks.beforeLaunch = (logicalId) => {
      if (logicalId === "dev.impl-s1") w.db.prepare("DELETE FROM snapshots").run();
    };
    await w.row(m.session);
    await w.comeBack(m);
    w.hooks.beforeLaunch = undefined;
    expect(w.holdOf(m, 1)).toMatchObject({ code: "snapshot_not_found" });
    w.personSession(s1.nodeId, `dev-impl-s1@${RIG}`, "exited", "failed");
    let notes = await w.notesOf(m.jobId);
    expect((notes.laterChanges as Array<Record<string, unknown>>)[0]).toMatchObject({ slotNumber: 1, read: "absent", phase: "drained" });
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "drained", reuseHold: null });

    // A decision's hold: a later session that ends absent without reaching `ready` keeps it held; one that reached
    // `ready` before it ended makes it eligible.
    const v = heldWorld();
    const held = await v.heldS1();
    const hold = v.holdOf(held.m, 1);
    v.personSession(held.s1.nodeId, `dev-impl-s1@${RIG}`, "exited", "failed");
    notes = await v.notesOf(held.m.jobId);
    expect((notes.laterChanges as Array<Record<string, unknown>>)[0]).toMatchObject({ slotNumber: 1, read: "absent", phase: "drained", reuseHold: hold });
    expect(v.holdOf(held.m, 1)).toEqual(hold);
    // read once: the same session is not a change again
    notes = await v.notesOf(held.m.jobId);
    expect(notes).not.toHaveProperty("laterChanges");
    v.personSession(held.s1.nodeId, `dev-impl-s1@${RIG}`, "exited", "ready");
    notes = await v.notesOf(held.m.jobId);
    expect((notes.laterChanges as Array<Record<string, unknown>>)[0]).toMatchObject({ slotNumber: 1, read: "absent", phase: "drained" });
    expect(v.slotOf(held.m, 1)).toMatchObject({ phase: "drained", reuseHold: null });
    expect(v.launchesOf("dev.impl-s1")).toBe(1);
  });
});

describe("seat-pool held comeback: a comeback that needs attention (#3395 Piece 1)", () => {
  /** `s1` comes back and its harness launch asks for attention: the slot is `live` and held. */
  const attentionS1 = async (w: World) => {
    const world = await w.twoDrained();
    w.hooks.harness = (session) => (session === `dev-impl-s1@${RIG}` ? { ok: false, error: "resume picker is open", recovery: "attention_required" } : undefined);
    await w.row(world.m.session);
    const first = await w.comeBack(world.m);
    w.hooks.harness = undefined;
    return { ...world, ...first };
  };

  it("With `attention_required`, `s1` is `live` and held: it takes room, so only `s2` is added, and `s1` receives no rows.", async () => {
    const w = heldWorld();
    const { m, s1, settled, next } = await attentionS1(w);
    expect(settled.find((s) => s.slotNumber === 1)?.attempt).toMatchObject({ status: "attention_required" });
    expect(w.slotOf(m, 1)).toMatchObject({ nodeId: s1.nodeId, phase: "live", attemptState: "settled" });
    expect(w.holdOf(m, 1)).toMatchObject({ code: "attention_required" });
    expect(JSON.stringify(settled)).not.toContain("\"stop\"");
    // idle at its prompt, it is still not free
    w.activity.set(s1.nodeId, idleState(s1.nodeId));
    const agents = agentsOf(w, m.nodeId);
    expect(seatPoolCanReceive(HELD, agents, agents.find((a) => a.slotNumber === 1)!)).toBe(false);
    // `s1` takes room, not counted as serving: the cycle after it settled brought back only `s2`
    const comebacks = ((next.add as { comebacks?: Array<{ logicalId: string; attempt?: unknown }> } | undefined)?.comebacks ?? []);
    expect(comebacks.filter((c) => c.attempt).map((c) => c.logicalId)).toEqual(["dev.impl-s2"]);
    expect(seatPoolRoom(HELD, agents)).toBe(0);

    // with more work waiting, no third agent: `s1` holds its place under `max`
    const adds = w.converge.mock.calls.length;
    await w.row(m.session);
    await w.row(m.session);
    for (let i = 0; i < 3; i++) {
      w.clock.now = new Date(w.clock.now.getTime() + 61_000);
      await w.notesOf(m.jobId);
      await w.executor().idle();
    }
    expect(w.owners().filter((r) => r.destination === `dev-impl-s1@${RIG}`)).toEqual([]);
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "live" });
    expect(w.converge).toHaveBeenCalledTimes(adds);
    expect(w.nodeOf(m.rigId, "dev.impl-s3")).toBeUndefined();
    expect(w.stopSeat).not.toHaveBeenCalled();
    expect(w.launchesOf("dev.impl-s1")).toBe(1);
  });

  it("A `restore.outcome_reconciled` alone leaves `s1` held, and once `rig seat continue` brings that same session to `ready` and tmux reports it present, `s1` is `live` with no hold.", async () => {
    const w = heldWorld();
    const { m, s1 } = await attentionS1(w);
    const session = w.latestOf(s1.nodeId);
    expect(session.status).toBe("running");
    const attemptSeq = w.eventsNaming(s1.nodeId, "restore.subset_completed").at(-1)!.seq;
    w.bus.emit({
      type: "restore.outcome_reconciled", rigId: m.rigId, nodeId: s1.nodeId, attemptId: attemptSeq,
      from: "attention_required", to: "operator_recovered", evidence: { source: "operator" },
    });
    let notes = await w.notesOf(m.jobId);
    expect(notes).not.toHaveProperty("laterChanges");
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "live" });
    expect(w.holdOf(m, 1)).toMatchObject({ code: "attention_required" });

    // `rig seat continue` reruns startup on the same session, which now reads ready
    w.sessions.updateStartupStatus(session.id, "ready");
    notes = await w.notesOf(m.jobId);
    expect(notes.laterChanges).toEqual([expect.objectContaining({ slotNumber: 1, read: "ready", phase: "live", session: expect.objectContaining({ id: session.id }) })]);
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "live", reuseHold: null });
    const agent = agentsOf(w, m.nodeId).find((a) => a.slotNumber === 1)!;
    expect(agent.running).toBe(true);
    expect(w.launchesOf("dev.impl-s1")).toBe(1);
  });

  it("From step 1's held `s1`, a manual fresh launch with a runtime that never reads ready, whose startup fails and whose cleanup kill fails, returns `attention_required` with a running row, and across a cycle and a daemon restart `s1` stays `live`, held and counted, receives no rows, and is reported `attention_required`.", async () => {
    const w = heldWorld();
    const { m, s1 } = await w.heldS1();
    // what the manual launch leaves: a running session whose startup asks for attention, its terminal still there
    const sessionId = w.personSession(s1.nodeId, `dev-impl-s1@${RIG}`, "running", "attention_required");
    w.activity.set(s1.nodeId, idleState(s1.nodeId));
    await w.row(m.session);
    await w.row(m.session);
    const check = async () => {
      const notes = await w.notesOf(m.jobId);
      await w.executor().idle();
      expect(w.slotOf(m, 1)).toMatchObject({ phase: "live" });
      expect(w.holdOf(m, 1)).toMatchObject({ code: "attention_required", sessionId });
      expect(slotView(notes, 1)).toMatchObject({ phase: "live", attempt: { status: "attention_required" } });
      const agents = agentsOf(w, m.nodeId);
      expect(agents.find((a) => a.slotNumber === 1)).toMatchObject({ running: false });
      expect(seatPoolRoom(HELD, agents)).toBeLessThanOrEqual(1);
      expect(w.owners().filter((r) => r.destination === `dev-impl-s1@${RIG}`)).toEqual([]);
      w.clock.now = new Date(w.clock.now.getTime() + 61_000);
      return notes;
    };
    const first = await check();
    expect(first.laterChanges).toEqual([expect.objectContaining({ slotNumber: 1, read: "attention", phase: "live" })]);
    await check();
    w.restart(m);
    const afterRestart = await check();
    expect(afterRestart).not.toHaveProperty("laterChanges");
    // counted: with `s1` held, the pool brings back or adds only one more agent
    expect(w.slots.forModel(m.nodeId).filter((s) => s.phase === "live" || s.phase === "adding")).toHaveLength(2);
    expect(w.launchesOf("dev.impl-s1")).toBe(1);
    expect(w.stopSeat).not.toHaveBeenCalled();
  });

  it("A live session that is not a proven agent gives `alreadyRunning` (L6): the slot is `live` with no hold, takes room, and is free only once idle at its prompt.", async () => {
    const w = heldWorld();
    const { m, s1 } = await w.twoDrained();
    // the drained agent's session runs again in its terminal, started by no one the pool knows
    const session = w.latestOf(s1.nodeId);
    w.sessions.updateStatus(session.id, "running");
    w.panes.set(`dev-impl-s1@${RIG}`, 900);
    await w.row(m.session);

    const { settled } = await w.comeBack(m);
    expect(settled.find((s) => s.slotNumber === 1)?.attempt).toEqual({ id: w.slotOf(m, 1).attemptId, status: "already_running" });
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "live", reuseHold: null, attemptState: "settled", attemptResult: null });
    expect(JSON.stringify(settled)).not.toContain("\"stop\"");
    expect(w.latestOf(s1.nodeId).id).toBe(session.id);
    let agents = agentsOf(w, m.nodeId);
    expect(seatPoolRoom({ max: 1 }, agents.filter((a) => a.slotNumber === 1))).toBe(0);
    expect(seatPoolCanReceive(HELD, agents, agents.find((a) => a.slotNumber === 1)!)).toBe(false);
    w.activity.set(s1.nodeId, idleState(s1.nodeId));
    agents = agentsOf(w, m.nodeId);
    expect(seatPoolCanReceive(HELD, agents, agents.find((a) => a.slotNumber === 1)!)).toBe(true);
  });
});

describe("seat-pool held comeback: an add that needs attention (#3395 Piece 1)", () => {
  it("An add whose launch ends `failed` with its session still live, or `attention_required` or `left_attached`, leaves the slot `live` and held: it takes room, receives no rows, is never drained by surplus, and is reported by the E1 L10 row, with no `stop`.", async () => {
    const cases: Array<{ name: string; expected: Record<string, unknown>; arrange: (w: World) => void }> = [
      {
        name: "failed, its session still live",
        expected: { status: "attention_required", code: "failed" },
        arrange: (w) => {
          w.hooks.harness = () => ({ ok: false, error: "harness exited" });
          // the failed launch's session still runs
          w.hooks.afterAdd = (result) => {
            const node = (result as { outcome?: { ok: boolean; result?: { node: { nodeId: string } } } }).outcome?.result?.node;
            if (node) {
              const latest = w.latestOf(node.nodeId);
              w.sessions.updateStatus(latest.id, "running");
            }
          };
        },
      },
      {
        name: "attention_required",
        expected: { status: "attention_required" },
        arrange: (w) => { w.hooks.harness = () => ({ ok: false, error: "resume picker is open", recovery: "attention_required" }); },
      },
      {
        name: "left_attached",
        expected: { status: "left_attached" },
        arrange: (w) => {
          // the add reports the seat left attached while its session runs
          w.hooks.afterAdd = (result) => {
            const r = result as { outcome?: { ok: boolean; result?: { node: { status: string } } } };
            if (r.outcome?.ok && r.outcome.result) r.outcome.result.node.status = "left_attached";
            return result;
          };
        },
      },
    ];
    for (const c of cases) {
      const w = heldWorld();
      const m = await w.model({ pool: { max: 1, min: 1 } });
      c.arrange(w);
      await w.notesOf(m.jobId);
      await w.executor().idle();
      w.hooks.harness = undefined;
      w.hooks.afterAdd = undefined;
      const notes = await w.notesOf(m.jobId);
      const settled = (notes.settled ?? []) as Array<{ slotNumber: number; attempt: Record<string, unknown> }>;
      expect(settled.find((s) => s.slotNumber === 1)?.attempt, c.name).toMatchObject(c.expected);
      const slot = w.slotOf(m, 1);
      expect(slot, c.name).toMatchObject({ phase: "live", attemptKind: "add", attemptState: "settled" });
      expect(w.holdOf(m, 1), c.name).toMatchObject({ code: c.expected.code ?? c.expected.status });
      expect(JSON.stringify(notes), c.name).not.toContain("\"stop\"");
      // it takes the only room, and idle at its prompt it is still not free
      w.activity.set(slot.nodeId!, idleState(slot.nodeId!));
      let agents = agentsOf(w, m.nodeId);
      expect(seatPoolRoom({ max: 1 }, agents), c.name).toBe(0);
      expect(seatPoolCanReceive({ max: 1, drain: false }, agents, agents[0]!), c.name).toBe(false);
      await w.row(m.session);
      w.clock.now = new Date(w.clock.now.getTime() + 61_000);
      await w.notesOf(m.jobId);
      await w.executor().idle();
      expect(w.owners().filter((r) => r.destination === `dev-impl-s1@${RIG}`), c.name).toEqual([]);
      expect(w.converge, c.name).toHaveBeenCalledTimes(1);
      // no agent wanted any more, even under `drain: true`: it is never drained by the pool
      w.db.prepare("UPDATE queue_items SET state = 'done'").run();
      for (const spec of [{ ...DRAINING, max: 1 }, { ...DRAINING, max: 1, drain: true }]) {
        w.rigRepo.setNodePool(m.nodeId, { spec });
        w.clock.now = new Date(w.clock.now.getTime() + 600_000);
        const later = await w.notesOf(m.jobId);
        expect(later, c.name).not.toHaveProperty("drains");
      }
      agents = agentsOf(w, m.nodeId);
      expect(w.slotOf(m, 1), c.name).toMatchObject({ phase: "live" });
      expect(w.stopSeat, c.name).not.toHaveBeenCalled();
    }
  });
});

describe("seat-pool held comeback: a reserved comeback cancelled before its issue (#3395 Piece 1)", () => {
  it("A `reserved` comeback whose job becomes held, whose `max` drops, or that surplus reaches before issue is cancelled, reported `cancelled: not issued`, makes no `launchSingleNode` call, and the slot stays `drained` and eligible.", async () => {
    const causes: Array<{ code: string; arrange: (w: World, m: { rigId: string; nodeId: string; session: string }) => void }> = [
      { code: "rig_stopped", arrange: (w, m) => { w.bus.emit({ type: "rig.stopped", rigId: m.rigId }); } },
      { code: "max_lowered", arrange: (w, m) => { w.rigRepo.setNodePool(m.nodeId, { spec: { ...HELD, max: 0 } }); } },
      {
        // `s2` serves and becomes free while the work goes away: one free agent is enough, and the reservation is the
        // surplus
        code: "surplus",
        arrange: (w, m) => {
          w.db.prepare("UPDATE queue_items SET state = 'done' WHERE destination_session = ?").run(m.session);
          const s2 = w.nodeOf(m.rigId, "dev.impl-s2")!.id;
          w.activity.set(s2, idleState(s2));
        },
      },
    ];
    for (const cause of causes) {
      const w = heldWorld();
      const { m, s1 } = cause.code === "surplus" ? await w.oneDrainedOneBusy() : await w.twoDrained();
      await w.row(m.session);
      const reserve = w.slots.reserveComeback.bind(w.slots);
      vi.spyOn(w.slots, "reserveComeback").mockImplementationOnce((input) => {
        const reserved = reserve(input);
        cause.arrange(w, m);
        return reserved;
      });

      const notes = await w.notesOf(m.jobId);
      await w.executor().idle();
      expect(notes.add, cause.code).toEqual({
        cancelled: [{ slotNumber: 1, logicalId: "dev.impl-s1", attempt: { id: expect.any(String), status: "cancelled", message: "cancelled: not issued", code: cause.code } }],
      });
      expect(JSON.stringify(notes), cause.code).not.toContain("\"stop\"");
      expect(w.launch, cause.code).not.toHaveBeenCalled();
      const slot = w.slotOf(m, 1);
      expect(slot, cause.code).toMatchObject({ nodeId: s1.nodeId, phase: "drained", reuseHold: null, attemptKind: "comeback", attemptState: "settled" });
      expect(slotView(await w.notesOf(m.jobId), 1)?.attempt, cause.code).toMatchObject({ status: "cancelled", code: cause.code });
      // eligible: once the cause is gone, the next add brings it back
      if (cause.code === "rig_stopped") w.bus.emit({ type: "restore.completed", rigId: m.rigId, snapshotId: "none", result: { snapshotId: "none", preRestoreSnapshotId: null, rigResult: "fully_restored", nodes: [], warnings: [] } } as never);
      if (cause.code === "max_lowered") w.rigRepo.setNodePool(m.nodeId, { spec: HELD });
      if (cause.code === "surplus") await w.row(m.session);
      w.clock.now = new Date(w.clock.now.getTime() + 61_000);
      const again = await w.notesOf(m.jobId);
      await w.executor().idle();
      expect((again.add as { comebacks?: Array<{ slotNumber: number; attempt?: unknown }> } | undefined)?.comebacks?.filter((c) => c.attempt).map((c) => c.slotNumber), cause.code).toEqual([1]);
      expect(w.launch, cause.code).toHaveBeenCalledTimes(1);
    }
  });
});

describe("seat-pool held comeback: what a later change is measured from (#3395 Piece 1)", () => {
  it("A comeback a restart left `unknown` is settled by a later session on its node: ready, the slot is `live` with no hold, and nothing is launched again.", async () => {
    const w = heldWorld();
    const { m, s1 } = await w.twoDrained();
    w.rigRepo.setNodePool(m.nodeId, { spec: { ...HELD, max: 1 } });
    w.hooks.beforeLaunch = () => never();
    await w.row(m.session);
    await w.notesOf(m.jobId);
    w.hooks.beforeLaunch = undefined;
    w.restart(m);
    expect(slotView(await w.notesOf(m.jobId), 1)).toMatchObject({ phase: "adding", attempt: { status: "unknown" } });

    const sessionId = w.personSession(s1.nodeId, `dev-impl-s1@${RIG}`, "running", "ready");
    const notes = await w.notesOf(m.jobId);
    expect(notes.laterChanges).toEqual([expect.objectContaining({ slotNumber: 1, read: "ready", phase: "live", session: expect.objectContaining({ id: sessionId }) })]);
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "live", reuseHold: null, attemptState: "settled", attemptResult: null });
    expect(w.launchesOf("dev.impl-s1")).toBe(1);
  });

  it("A held `live` slot whose node a later restore launched and left awaiting a decision takes that outcome: it is `drained` and held, and is not brought back.", async () => {
    const w = heldWorld();
    const { m, s1 } = await w.twoDrained();
    w.hooks.harness = (session) => (session === `dev-impl-s1@${RIG}` ? { ok: false, error: "resume picker is open", recovery: "attention_required" } : undefined);
    await w.row(m.session);
    await w.comeBack(m);
    w.hooks.harness = undefined;
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "live" });
    // `rig down` ended its session; the `rig up` after it launched the node and stopped on a decision
    w.sessions.updateStatus(w.latestOf(s1.nodeId).id, "exited");
    w.bus.emit({
      type: "restore.completed", rigId: m.rigId, snapshotId: "up",
      result: { snapshotId: "up", preRestoreSnapshotId: null, rigResult: "partially_restored", warnings: [],
        nodes: [{ nodeId: s1.nodeId, logicalId: "dev.impl-s1", status: "awaiting-decision", error: "Original session unresumable: rig seat launch dev-impl-s1@pool-rig --fresh" }] },
    } as never);
    const notes = await w.notesOf(m.jobId);
    await w.executor().idle();
    expect(notes.laterChanges).toEqual([expect.objectContaining({ slotNumber: 1, read: "restore", restore: expect.objectContaining({ status: "awaiting-decision" }), phase: "drained" })]);
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "drained" });
    expect(w.holdOf(m, 1)).toMatchObject({ code: "awaiting-decision" });
    // read once: later cycles leave it held and launch nothing
    w.clock.now = new Date(w.clock.now.getTime() + 61_000);
    expect(await w.notesOf(m.jobId)).not.toHaveProperty("laterChanges");
    await w.executor().idle();
    expect(w.launchesOf("dev.impl-s1")).toBe(1);
  });

  it("A held `drained` slot whose own session only changes status (a stale row marked down) stays held: only a newer session is a change.", async () => {
    const w = heldWorld();
    const { m, s1 } = await w.heldS1();
    // the session the hold is measured from: the node's earlier one, back after the launch was rolled back
    const kept = w.sessionsOf(s1.nodeId).filter((s) => s.status !== "superseded").at(-1)!;
    w.sessions.updateStatus(kept.id, "exited");
    const notes = await w.notesOf(m.jobId);
    expect(notes).not.toHaveProperty("laterChanges");
    expect(w.holdOf(m, 1)).toMatchObject({ code: "awaiting-decision" });
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "drained" });
  });

  it("A later session whose startup is still pending puts the held slot back in `adding`, counted as an unknown result: it takes room and the pool adds nothing past `max`; once it reads ready, the slot is `live` with no hold.", async () => {
    const w = heldWorld();
    const { m, s1 } = await w.heldS1();
    w.rigRepo.setNodePool(m.nodeId, { spec: { ...HELD, max: 1 } });
    // the cycle after step 1 brought `s2` back; drop it out of the picture
    w.db.prepare("UPDATE queue_items SET state = 'done'").run();
    const sessionId = w.personSession(s1.nodeId, `dev-impl-s1@${RIG}`, "running", "pending");
    let notes = await w.notesOf(m.jobId);
    expect(notes.laterChanges).toEqual([expect.objectContaining({ slotNumber: 1, read: "unknown", phase: "adding" })]);
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "adding", attemptState: "issued" });
    expect(slotView(notes, 1)).toMatchObject({ attempt: { status: "unknown" } });
    expect(seatPoolRoom({ max: 1 }, agentsOf(w, m.nodeId).filter((a) => a.slotNumber === 1))).toBe(0);
    w.sessions.updateStartupStatus(sessionId, "ready");
    notes = await w.notesOf(m.jobId);
    expect(notes.laterChanges).toEqual([expect.objectContaining({ slotNumber: 1, read: "ready", phase: "live" })]);
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "live", reuseHold: null, attemptState: "settled" });
    expect(w.launchesOf("dev.impl-s1")).toBe(1);
  });

  it("An add cut off by a restart whose session runs with a startup that needs attention is held `live`, not left `unknown`.", async () => {
    const w = heldWorld();
    const m = await w.model({ pool: { max: 1, min: 1 } });
    // the add's call never returns to this process: the daemon goes away once the node and its session exist
    w.hooks.afterAdd = () => never();
    w.hooks.harness = () => ({ ok: false, error: "resume picker is open", recovery: "attention_required" });
    await w.notesOf(m.jobId);
    await vi.waitFor(() => expect(w.nodeOf(m.rigId, "dev.impl-s1")).toBeDefined());
    const node = w.nodeOf(m.rigId, "dev.impl-s1")!.id;
    await vi.waitFor(() => expect(w.latestOf(node)).toMatchObject({ status: "running", startup: "attention_required" }));
    w.hooks.harness = undefined;
    w.hooks.afterAdd = undefined;
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "adding", attemptState: "issued", attemptOutcome: null });
    w.restart(m);
    const notes = await w.notesOf(m.jobId);
    await w.executor().idle();
    expect(((notes.settled ?? []) as Array<{ attempt: Record<string, unknown> }>)[0]?.attempt).toMatchObject({ status: "attention_required" });
    expect(w.slotOf(m, 1)).toMatchObject({ phase: "live", attemptState: "settled" });
    expect(w.holdOf(m, 1)).toMatchObject({ code: "attention_required" });
    expect(w.converge).toHaveBeenCalledTimes(1);
  });
});
