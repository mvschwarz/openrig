import { describe, it, expect, vi } from "vitest";
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
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
import {
  reconcileSeatPoolNode,
  reconcileSeatPoolsAtStartup,
  type SeatPoolReconcileResult,
} from "../src/domain/seat-pool-registration.js";
import { makeSeatPoolExecutor, seatPoolQueueEffects, type SeatPoolExecutorDeps } from "../src/domain/seat-pool-executor.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { ArbitratedSeatState } from "../src/domain/activity-taxonomy.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import type { ConvergeResult } from "../src/domain/topology-converge.js";

// #3395 (Piece 1): the seat pool's whole-rig holds. While a hold stands, a cycle moves and adds nothing and records the
// cause; drain and comeback join these holds in later changes. The job is unarmed in the daemon, so each test composes
// the executor and an engine that has the seat-pool policy, and drives `rig down`, `rig up` and `rig launch --seats`
// through the real teardown and restore orchestrators. The add's call is a fake that records it and creates no node.

const RIG = "pool-rig";
const SPEC: SeatPoolSpec = {
  max: 4, min: 0, dispatchAfterSeconds: 60, idleGraceSeconds: 300, cooldownSeconds: 60, dispatchTag: null, cwdTemplate: null, drain: false,
};
const IDLE_SINCE = "2026-11-18T10:00:00.000Z";
const FALLBACK_ACTOR = "system:queue-fallback";
const RIG_ROOT = "/project/rigs/pool-rig";
/** Every seat's saved conversation: restore resumes it and finds it in the pane's process tree. */
const TOKEN = "00000000-0000-4000-8000-000000000086";

/** A short wait, so a row created after it is younger than the rows created before. */
const later = () => new Promise((resolve) => setTimeout(resolve, 5));

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

function idleState(nodeId: string): ArbitratedSeatState {
  return {
    seatNodeId: nodeId, activity: "idle-at-prompt", needsInput: { count: 0, reason: null }, needsInputEvidence: null,
    backgroundWork: null, decidedBy: null, seq: 1, changedAt: IDLE_SINCE, rungs: [], lastSwap: null,
  } as unknown as ArbitratedSeatState;
}

/** tmux as teardown sees it: every kill succeeds unless a test blocks it. */
function teardownTmux(): TmuxAdapter {
  return {
    killSession: vi.fn(async () => ({ ok: true })),
    createSession: vi.fn(async () => ({ ok: true })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    hasSession: vi.fn(async () => false),
    sendText: vi.fn(async () => ({ ok: true })),
    sendKeys: vi.fn(async () => ({ ok: true })),
    getPanePid: vi.fn(async () => null),
    getPaneCommand: vi.fn(async () => null),
    capturePaneContent: vi.fn(async () => null),
  } as unknown as TmuxAdapter;
}

/** tmux as restore sees it: sessions are created, and none was alive before. */
function restoreTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "bash"),
    getPanePid: vi.fn(async () => 1234),
    capturePaneContent: vi.fn(async () => ""),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [{ id: "%1", index: 0, cwd: "/", width: 80, height: 24, active: true }],
    hasSession: async () => false,
  } as unknown as TmuxAdapter;
}

/** The pane's process tree after a resume: the native Claude child carries the saved conversation. */
function resumedClaudeRows() {
  const startedAt = "Sat Jan  1 12:00:00 2000";
  return [
    { pid: 1234, ppid: 1, pgid: 1234, tpgid: 1235, executableName: "bash", command: "-bash", startedAt },
    { pid: 1235, ppid: 1234, pgid: 1235, tpgid: 1235, executableName: "sh", command: "/bin/sh /tmp/openrig-tmux-send.txt", startedAt },
    { pid: 1236, ppid: 1235, pgid: 1235, tpgid: 1235, executableName: "claude", command: `/opt/claude.exe --resume ${TOKEN}`, startedAt },
  ];
}

/** The Claude runtime as restore drives it: ready, and resuming the saved conversation. */
function claudeAdapter(): RuntimeAdapter {
  return {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: TOKEN, resumeType: "claude_id" })),
  };
}

type Model = { rigId: string; nodeId: string; logicalId: string; podId: string; session: string };
type Agent = { nodeId: string; session: string };

/** `drain`: compose the drain's effects, with the capture and the stop as spies (the stop succeeds). */
function poolWorld(db: Database.Database = fullDb(), opts: { drain?: boolean } = {}) {
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
  /** Runs after each real move, before the cycle sees its result. */
  const hooks: { afterMove?: () => void } = {};
  const effects = seatPoolQueueEffects(queue);
  const exporter = new RigSpecExporter({ rigRepo, sessionRegistry: sessions, podRepo });
  /** The add's call: recorded, and ended with no node. */
  const converge = vi.fn(async (): Promise<ConvergeResult> => ({
    kind: "add_member", supported: true, outcome: { ok: false, code: "rig_not_found", message: "the add's call is a fake here" },
  }));
  const deps: SeatPoolExecutorDeps = {
    db, rigRepo, slots, jobsRepo,
    queue: { ...effects, moveRow: async (input) => { const result = await effects.moveRow(input); hooks.afterMove?.(); return result; } },
    heldCount: (id) => outbox.heldCount(id),
    confirmedStopped: (id) => nodeExecutorConfirmedStopped(db, id),
    seatState: (id) => activity.get(id) ?? null,
    custody: (ids, fn) => guard.custody(ids, fn),
    now: () => clock.now,
    add: { exportMember: (rigId, nodeId) => exporter.exportedRawMemberFromNode(rigId, nodeId), converge, makeFolder: vi.fn() },
  };
  const capture = vi.fn((_rigId: string) => ({ snapshotId: "snap-drain" }));
  const stopSeat = vi.fn(async (_input: { seatRef: string; reason: string; expected: { nodeId: string; sessionId: string } }) => ({ ok: true as const }));
  const refresh = vi.fn(async (_input: { rigId: string; nodeId: string; sessionId: string }) => {});
  if (opts.drain) deps.drain = { lifecycle: (ids, fn) => guard.lifecycle(ids, fn), refresh, capture, stopSeat };
  const reg = { db, rigRepo, jobsRepo, warn: vi.fn() };
  /** An engine and an executor over this database: a new pair is what a daemon restart gives. */
  const compose = () => {
    const executor = makeSeatPoolExecutor(deps);
    const engine = new WatchdogPolicyEngine({
      jobsRepo, historyLog: history, eventBus: bus, deliver: async () => ({ status: "ok" }),
      additionalPolicies: [makeSeatPoolPolicy({ cycle: (job) => executor.cycle(job) })],
    });
    return { executor, engine };
  };
  let composed = compose();
  /** A daemon restart: the start loop over the stored blocks, then a new executor and engine. */
  const restart = () => {
    const results = reconcileSeatPoolsAtStartup(reg);
    composed = compose();
    return results;
  };

  const snapshotRepo = new SnapshotRepository(db);
  const checkpointStore = new CheckpointStore(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry: sessions, eventBus: bus, snapshotRepo, checkpointStore });
  const downTmux = teardownTmux();
  downTmux.deliveryGuard = guard;
  const teardown = new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry: sessions, tmuxAdapter: downTmux, snapshotCapture, eventBus: bus });
  const upTmux = restoreTmux();
  const restorer = new RestoreOrchestrator({
    db, rigRepo, sessionRegistry: sessions, eventBus: bus, snapshotRepo, snapshotCapture, checkpointStore,
    nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry: sessions, eventBus: bus, tmuxAdapter: upTmux }),
    tmuxAdapter: upTmux,
    claudeResume: {
      canResume: vi.fn((type: string | null) => type === "claude_name" || type === "claude_id"),
      resume: vi.fn(async () => ({ ok: true as const })),
    } as unknown as ClaudeResumeAdapter,
    codexResume: { canResume: vi.fn(() => false), resume: vi.fn(async () => ({ ok: true as const })) } as unknown as CodexResumeAdapter,
    listProcesses: async () => resumedClaudeRows(),
  });
  const adapters = { "claude-code": claudeAdapter() };
  /** `rig up`: restore the snapshot with the runtime adapters, as the route does. */
  const up = (snapshotId: string, opts: { cwdOverride?: string } = {}) => restorer.restore(snapshotId, { adapters, ...opts });
  /** `rig launch --seats`. */
  const launchSeats = (rigId: string, logicalIds: string[]) => restorer.launchNodeSubset(rigId, logicalIds, { adapters });

  /** A running session for a node, with what restore needs to resume it. */
  const seatSession = (nodeId: string, name: string) => {
    const session = sessions.registerSession(nodeId, name);
    db.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = ?, restore_policy = 'resume_if_possible' WHERE id = ?")
      .run(TOKEN, session.id);
    db.prepare(`INSERT OR IGNORE INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime)
      VALUES (?, '[]', '[]', '[]', 'claude-code')`).run(nodeId);
    sessions.updateStatus(session.id, "running");
    return session;
  };
  /** A model member with a stored block, in a rig of its own; with a running session unless told otherwise. */
  const model = (opts: { session?: boolean; cwd?: string | null } = {}): Model => {
    const rig = rigRepo.createRig(RIG);
    const pod = podRepo.createPod(rig.id, "dev", "Dev");
    const cwd = opts.cwd === undefined ? "/tmp" : opts.cwd;
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: pod.id, pool: { spec: SPEC }, ...(cwd ? { cwd } : {}) });
    const m = { rigId: rig.id, nodeId: node.id, logicalId: node.logicalId, podId: pod.id, session: `dev-impl@${RIG}` };
    if (opts.session !== false) seatSession(node.id, m.session);
    return m;
  };
  /** A pool agent with a running session, idle at its prompt. */
  const agent = (m: Pick<Model, "rigId" | "nodeId" | "logicalId" | "podId">, n: number, phase: SeatPoolSlotPhase = "live"): Agent => {
    const node = rigRepo.addNode(m.rigId, `${m.logicalId}-s${n}`, { runtime: "claude-code", podId: m.podId, cwd: "/tmp" });
    slots.insert({ modelNodeId: m.nodeId, slotNumber: n, nodeId: node.id, phase, at: IDLE_SINCE });
    const a = { nodeId: node.id, session: `dev-impl-s${n}@${RIG}` };
    seatSession(node.id, a.session);
    activity.set(node.id, idleState(node.id));
    return a;
  };
  /** The agent free again after a lifecycle step changed its sessions: its latest session running, idle at its prompt. */
  const ready = (a: Agent) => {
    const latest = db.prepare("SELECT id, status FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(a.nodeId) as { id: string; status: string };
    if (latest.status !== "running") sessions.updateStatus(latest.id, "running");
    activity.set(a.nodeId, idleState(a.nodeId));
  };
  const row = async (destination: string, tags?: string[]) => (await queue.create({
    sourceSession: `lead@${RIG}`, destinationSession: destination, body: "work", nudge: false, ...(tags ? { tags } : {}),
  })).qitemId;
  const jobOf = (result: SeatPoolReconcileResult): WatchdogJob => {
    if (!("job" in result)) throw new Error(`no job: ${JSON.stringify(result)}`);
    return result.job;
  };
  const jobFor = (m: Model) => jobOf(reconcileSeatPoolNode(reg, m.nodeId));
  /** One evaluation through the engine; returns its notes, or the engine's own outcome when it ran no policy. */
  const evaluate = async (jobId: string) => (await composed.engine.evaluate(jobsRepo.getByIdOrThrow(jobId))).outcome;
  const notesOf = async (jobId: string) => ((await evaluate(jobId)) as { notes?: Record<string, unknown> }).notes ?? {};
  const destinationOf = (qitemId: string) => queue.getById(qitemId)!.destinationSession;
  const rerouted = (qitemId: string) => queue.transitionLog.listForQitem(qitemId).filter((t) => t.actorSession === FALLBACK_ACTOR);
  const events = (rigId: string, type: string) =>
    (db.prepare("SELECT seq FROM events WHERE rig_id = ? AND type = ? ORDER BY seq").all(rigId, type) as Array<{ seq: number }>).map((e) => e.seq);
  const down = async (rigId: string) => {
    const result = await teardown.teardown(rigId);
    expect(result.errors).toEqual([]);
    return result;
  };
  /** What an add leaves behind: the call, the slot rows and the operation ids reserved. */
  const addTrace = () => ({
    calls: converge.mock.calls.length,
    slots: (db.prepare("SELECT COUNT(*) AS n FROM seat_pool_slots").get() as { n: number }).n,
    operations: (db.prepare("SELECT COUNT(*) AS n FROM operation_correlations").get() as { n: number }).n,
  });
  return {
    db, bus, rigRepo, podRepo, slots, sessions, queue, outbox, jobsRepo, history, guard, activity, clock, hooks, deps, reg, refresh, capture, stopSeat,
    exporter, converge,
    get engine() { return composed.engine; }, get executor() { return composed.executor; },
    restart, compose, teardown, downTmux, restorer, up, launchSeats, snapshotCapture, checkpointStore,
    model, agent, ready, row, jobOf, jobFor, evaluate, notesOf, destinationOf, rerouted, events, down, addTrace,
  };
}

/** The held report of a cycle in the `rig.stopped` hold. */
const rigStopped = (seq: number) => ({ cause: "rig stopped", seq, message: `held: rig stopped (event ${seq})` });

describe("seat-pool holds: the whole pool through rig down and up (#3395 Piece 1)", () => {
  it("After `rig down` a `rig.stopped` row exists and cycles make no add, drain or move while slots keep their phases, and a `rig up` whose `restore.completed` is `fully_restored` releases the hold so the next cycle moves the row.", async () => {
    const w = poolWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      const q = await w.row(m.session);
      // a second row: with one free agent, the plan would also add one
      await later();
      await w.row(m.session);
      const slotsBefore = w.slots.forModel(m.nodeId);
      const addBefore = w.addTrace();

      const stoppedDown = await w.down(m.rigId);
      const [stopped] = w.events(m.rigId, "rig.stopped");
      expect(stopped).toBeDefined();
      w.ready(s1);
      for (let cycle = 0; cycle < 2; cycle++) {
        const notes = await w.notesOf(job.jobId);
        expect(notes.held).toEqual(rigStopped(stopped!));
        expect(notes).not.toHaveProperty("moved");
        expect(w.destinationOf(q)).toBe(m.session);
        expect(w.slots.forModel(m.nodeId)).toEqual(slotsBefore);
        // no add is reserved or issued
        expect(notes).not.toHaveProperty("add");
        await w.executor.idle();
        expect(w.addTrace()).toEqual(addBefore);
      }

      const up = await w.up(stoppedDown.snapshotId!);
      expect(up.ok, JSON.stringify(up)).toBe(true);
      expect(up.ok && up.result.rigResult, JSON.stringify(up)).toBe("fully_restored");
      const completed = w.events(m.rigId, "restore.completed");
      expect(completed.at(-1)!).toBeGreaterThan(stopped!);
      w.ready(s1);
      const notes = await w.notesOf(job.jobId);
      expect(notes).not.toHaveProperty("held");
      expect(notes.moved).toEqual([{ qitemId: q, from: m.session, to: s1.session }]);
      expect(w.destinationOf(q)).toBe(s1.session);
      // released, the row left over gets an add (here the fake call creates no node, and the slot row goes)
      expect(notes.add).toMatchObject({ issued: [{ slotNumber: 2 }] });
      await w.executor.idle();
      expect(w.slots.forModel(m.nodeId)).toEqual(slotsBefore);

      // a second `rig down`: the hold starts from the latest `rig.stopped`, not the first one the up released
      const s2 = w.agent(m, 2);
      await w.down(m.rigId);
      const stoppedAgain = w.events(m.rigId, "rig.stopped");
      expect(stoppedAgain).toHaveLength(2);
      expect(stoppedAgain[1]!).toBeGreaterThan(completed.at(-1)!);
      const q2 = await w.row(m.session);
      w.ready(s1);
      w.ready(s2);
      const addHeld = w.addTrace();
      const again = await w.notesOf(job.jobId);
      expect(again.held).toEqual(rigStopped(stoppedAgain[1]!));
      expect(again).not.toHaveProperty("moved");
      expect(again).not.toHaveProperty("add");
      await w.executor.idle();
      expect(w.addTrace()).toEqual(addHeld);
      expect(w.destinationOf(q2)).toBe(m.session);
      expect(w.rerouted(q2)).toEqual([]);
    } finally {
      w.db.close();
    }
  });

  it.each([
    ["A `restore.completed` with `partially_restored` after the `rig.stopped` also releases the hold.", "partially_restored"],
    ["A `restore.completed` with `rigResult: failed` after the `rig.stopped` also releases the hold.", "failed"],
  ] as const)("%s", async (_title, rigResult) => {
    const w = poolWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      const q = await w.row(m.session);
      await w.down(m.rigId);
      w.ready(s1);
      expect((await w.notesOf(job.jobId)).held).toMatchObject({ cause: "rig stopped" });

      w.bus.emit({
        type: "restore.completed", rigId: m.rigId, snapshotId: "s",
        result: { snapshotId: "s", preRestoreSnapshotId: null, rigResult, nodes: [], warnings: [] },
      });
      const notes = await w.notesOf(job.jobId);
      expect(notes).not.toHaveProperty("held");
      expect(notes.moved).toEqual([{ qitemId: q, from: m.session, to: s1.session }]);
    } finally {
      w.db.close();
    }
  });

  it("After `rig down`, a `rig up` refused with 409 `not_attempted` stays held across a restart, and the next completed `rig up` releases it.", async () => {
    const w = poolWorld();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "seat-pool-hold-"));
    try {
      // a model with a checkpoint and no folder: `rig up` is refused before it starts, as `rig up` without `--cwd` is
      const m = w.model({ cwd: null });
      w.checkpointStore.createCheckpoint(m.nodeId, { summary: "Was working on the pool", keyArtifacts: [] });
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      const q = await w.row(m.session);
      const stoppedDown = await w.down(m.rigId);
      const [stopped] = w.events(m.rigId, "rig.stopped");
      const before = (w.db.prepare("SELECT MAX(seq) AS seq FROM events").get() as { seq: number }).seq;

      const refused = await w.up(stoppedDown.snapshotId!);
      expect(refused.ok).toBe(false);
      expect(!refused.ok && "result" in refused && refused.result?.rigResult).toBe("not_attempted");
      expect(w.db.prepare("SELECT type FROM events WHERE seq > ? AND type LIKE 'restore.%'").all(before)).toEqual([]);

      w.restart();
      w.ready(s1);
      const held = await w.notesOf(job.jobId);
      expect(held.held).toEqual(rigStopped(stopped!));
      expect(held).not.toHaveProperty("moved");
      expect(w.destinationOf(q)).toBe(m.session);

      const up = await w.up(stoppedDown.snapshotId!, { cwdOverride: cwd });
      expect(up.ok, JSON.stringify(up)).toBe(true);
      w.ready(s1);
      const notes = await w.notesOf(job.jobId);
      expect(notes).not.toHaveProperty("held");
      expect(notes.moved).toEqual([{ qitemId: q, from: m.session, to: s1.session }]);
    } finally {
      w.db.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("A cycle started while teardown holds the leases with its kill blocked makes no effect (it ends with `guard_target_changed` or reads `rig.stopped`), and the next cycle is held.", async () => {
    const w = poolWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      const q = await w.row(m.session);
      const killGate = deferred<{ ok: true }>();
      const killing = deferred();
      w.downTmux.killSession = vi.fn(() => { killing.resolve(); return killGate.promise; }) as unknown as TmuxAdapter["killSession"];

      const stopping = w.teardown.teardown(m.rigId);
      await killing.promise;
      const cycle = w.evaluate(job.jobId);
      // the cycle waits for the model's lease, which teardown holds
      const tick = Symbol("tick");
      expect(await Promise.race([cycle, new Promise((r) => setTimeout(() => r(tick), 50))])).toBe(tick);
      killGate.resolve({ ok: true });
      await stopping;
      const notes = ((await cycle) as { notes?: Record<string, unknown> }).notes ?? {};

      expect(notes).not.toHaveProperty("moved");
      expect(w.destinationOf(q)).toBe(m.session);
      expect(w.rerouted(q)).toEqual([]);
      const custody = notes.custody as { code?: string } | undefined;
      const held = notes.held as { cause?: string } | undefined;
      expect(custody?.code === "guard_target_changed" || held?.cause === "rig stopped", JSON.stringify(notes)).toBe(true);

      w.ready(s1);
      const [stopped] = w.events(m.rigId, "rig.stopped");
      const next = await w.notesOf(job.jobId);
      expect(next.held).toEqual(rigStopped(stopped!));
      expect(next).not.toHaveProperty("moved");
    } finally {
      w.db.close();
    }
  });

  it("Without a `rig.stopped`, a restore that throws after launching a seat holds nothing, and the seat it left ready receives rows.", async () => {
    const w = poolWorld();
    const notice = vi.spyOn(RestoreOrchestrator.prototype as never, "noticeBareShells").mockRejectedValueOnce(new Error("boom") as never);
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      const q = await w.row(m.session);
      const snapshot = w.snapshotCapture.captureSnapshot(m.rigId, "manual");
      for (const s of w.sessions.getSessionsForRig(m.rigId)) w.sessions.markDetached(s.id);

      const thrown = await w.up(snapshot.id);
      expect(thrown).toMatchObject({ ok: false, code: "restore_error" });
      expect(w.events(m.rigId, "rig.stopped")).toEqual([]);
      const [started] = w.events(m.rigId, "restore.started");
      expect(started).toBeDefined();
      expect(w.events(m.rigId, "restore.completed")).toEqual([]);

      // the seat the restore launched is running, and idle at its prompt
      const latest = w.db.prepare("SELECT status FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(s1.nodeId);
      expect(latest).toEqual({ status: "running" });
      w.ready(s1);
      const notes = await w.notesOf(job.jobId);
      expect(notes).not.toHaveProperty("held");
      expect(notes.restore).toEqual({
        seq: started, completed: false,
        message: `restore at event ${started} has no restore.completed; nothing is held without a rig.stopped`,
      });
      expect(notes.moved).toEqual([{ qitemId: q, from: m.session, to: s1.session }]);
    } finally {
      notice.mockRestore();
      w.db.close();
    }
  });

  it("After `rig down`, a `rig up` that throws stays held until a later `restore.completed`.", async () => {
    const w = poolWorld();
    const notice = vi.spyOn(RestoreOrchestrator.prototype as never, "noticeBareShells").mockRejectedValueOnce(new Error("boom") as never);
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      const q = await w.row(m.session);
      const stoppedDown = await w.down(m.rigId);
      const [stopped] = w.events(m.rigId, "rig.stopped");

      expect(await w.up(stoppedDown.snapshotId!)).toMatchObject({ ok: false, code: "restore_error" });
      expect(w.events(m.rigId, "restore.completed")).toEqual([]);
      w.ready(s1);
      const held = await w.notesOf(job.jobId);
      expect(held.held).toEqual(rigStopped(stopped!));
      expect(held).not.toHaveProperty("moved");
      expect(w.destinationOf(q)).toBe(m.session);

      const up = await w.up(stoppedDown.snapshotId!);
      expect(up.ok, JSON.stringify(up)).toBe(true);
      w.ready(s1);
      const notes = await w.notesOf(job.jobId);
      expect(notes).not.toHaveProperty("held");
      expect(notes.moved).toEqual([{ qitemId: q, from: m.session, to: s1.session }]);
    } finally {
      notice.mockRestore();
      w.db.close();
    }
  });

  it("After `rig down`, a `rig launch --seats` of every seat stays held until a later `restore.completed`.", async () => {
    const w = poolWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      const q = await w.row(m.session);
      const stoppedDown = await w.down(m.rigId);
      const [stopped] = w.events(m.rigId, "rig.stopped");

      const logicalIds = w.rigRepo.getRig(m.rigId)!.nodes.map((n) => n.logicalId);
      const launched = await w.launchSeats(m.rigId, logicalIds);
      expect(launched.ok, JSON.stringify(launched)).toBe(true);
      const [seats] = w.events(m.rigId, "restore.subset_completed");
      expect(seats).toBeGreaterThan(stopped!);
      w.ready(s1);
      const held = await w.notesOf(job.jobId);
      expect(held.held).toEqual({
        ...rigStopped(stopped!),
        exit: `seats launched with \`rig launch --seats\` (event ${seats}) do not end the hold; run \`rig down\`, then \`rig up\``,
      });
      const exit = (held.held as { exit: string }).exit;
      expect(exit.indexOf("`rig down`")).toBeLessThan(exit.indexOf("`rig up`"));
      expect(held).not.toHaveProperty("moved");
      expect(w.destinationOf(q)).toBe(m.session);

      const up = await w.up(stoppedDown.snapshotId!);
      expect(up.ok, JSON.stringify(up)).toBe(true);
      w.ready(s1);
      const notes = await w.notesOf(job.jobId);
      expect(notes).not.toHaveProperty("held");
      expect(notes.moved).toEqual([{ qitemId: q, from: m.session, to: s1.session }]);
    } finally {
      w.db.close();
    }
  });
});

// The instantiator, for re-applying the spec the way `rig launch` does.
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

function instantiatorFor(w: ReturnType<typeof poolWorld>) {
  const tmux = {
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
  const nodeLauncher = new NodeLauncher({ db: w.db, rigRepo: w.rigRepo, sessionRegistry: w.sessions, eventBus: w.bus, tmuxAdapter: tmux });
  const startupOrchestrator = new StartupOrchestrator({ db: w.db, sessionRegistry: w.sessions, eventBus: w.bus, tmuxAdapter: tmux, sleep: async () => {} });
  const files: Record<string, string> = {
    [`${RIG_ROOT}/agents/impl/agent.yaml`]: `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`,
  };
  const fsOps: AgentResolverFsOps = {
    readFile: (p: string) => { if (p in files) return files[p]!; throw new Error(`Not found: ${p}`); },
    exists: (p: string) => p in files,
  };
  const inst = new PodRigInstantiator({
    db: w.db, rigRepo: w.rigRepo, podRepo: w.podRepo, sessionRegistry: w.sessions, eventBus: w.bus, nodeLauncher, startupOrchestrator,
    fsOps, adapters: { "claude-code": mockAdapter("claude-code"), codex: mockAdapter("codex"), terminal: mockAdapter("terminal") },
    tmuxAdapter: tmux,
  } as unknown as ConstructorParameters<typeof PodRigInstantiator>[0]);
  const spec = (pool: unknown) => stringifyYaml({
    version: "0.2", name: RIG,
    pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "codex", cwd: ".", pool }], edges: [] }],
    edges: [],
  });
  const materialize = async (pool: unknown): Promise<Model> => {
    const mat = await inst.materialize(spec(pool), RIG_ROOT);
    if (!mat.ok) throw new Error(JSON.stringify(mat));
    const rig = w.rigRepo.getRig(mat.result.rigId)!;
    const node = rig.nodes.find((n) => n.logicalId === "dev.impl")!;
    return { rigId: rig.rig.id, nodeId: node.id, logicalId: node.logicalId, podId: node.podId!, session: `dev-impl@${RIG}` };
  };
  /** Re-apply the spec over the rig, as `rig launch` does (the seats freed first, so it re-applies), then reconcile. */
  const reapply = async (m: Model, pool: unknown) => {
    for (const s of w.sessions.getSessionsForRig(m.rigId)) {
      w.sessions.markDetached(s.id);
      w.sessions.clearBinding(s.nodeId);
    }
    const launched = await inst.launchMaterialized(spec(pool), RIG_ROOT, m.rigId);
    expect(launched, JSON.stringify(launched)).toMatchObject({ ok: true });
    return reconcileSeatPoolNode(w.reg, m.nodeId);
  };
  return { materialize, reapply };
}

describe("seat-pool holds: the job's own state and its model (#3395 Piece 1)", () => {
  it("Stopping the job while its policy awaits I/O between two effects prevents any later effect, and re-apply and a daemon restart leave it `stopped`.", async () => {
    const w = poolWorld();
    try {
      const block = { max: 4, dispatch_after_s: 60 };
      const inst = instantiatorFor(w);
      const m = await inst.materialize(block);
      const job = w.jobFor(m);
      const s1 = w.agent(m, 1);
      const s2 = w.agent(m, 2);
      const q1 = await w.row(m.session);
      const q2 = await w.row(m.session);
      // a third row: with two free agents, the plan also adds one
      await later();
      await w.row(m.session);
      const addBefore = w.addTrace();

      // the operator stops the job while the first move's I/O is in flight
      let moves = 0;
      w.hooks.afterMove = () => { if (++moves === 1) w.jobsRepo.stop(job.jobId); };
      expect(await w.evaluate(job.jobId)).toMatchObject({ action: "skip", reason: "job_not_active" });
      expect(moves).toBe(1);
      const destinations = [w.destinationOf(q1), w.destinationOf(q2)];
      expect(destinations.filter((d) => d === m.session)).toHaveLength(1);
      expect(destinations.filter((d) => d === s1.session || d === s2.session)).toHaveLength(1);
      const waiting = destinations[0] === m.session ? q1 : q2;
      w.hooks.afterMove = undefined;

      const direct = await w.executor.cycle({ jobId: job.jobId, context: (parseYaml(job.specYaml) as { context: Record<string, unknown> }).context });
      expect(direct).toMatchObject({ notes: { held: { cause: "job stopped", message: "held: job stopped" } } });
      expect((direct as { notes?: Record<string, unknown> }).notes).not.toHaveProperty("moved");

      // re-apply with a new block, then a daemon restart
      expect(await inst.reapply(m, { ...block, max: 5 })).toMatchObject({ outcome: "stopped", job: { jobId: job.jobId } });
      w.restart();
      const stored = w.jobsRepo.getByIdOrThrow(job.jobId);
      expect(stored.state).toBe("stopped");
      expect((parseYaml(stored.specYaml) as { context: { pool: { max: number } } }).context.pool.max).toBe(5);
      w.ready(s1);
      w.ready(s2);
      expect(await w.evaluate(job.jobId)).toMatchObject({ action: "skip", reason: "job_not_active" });
      expect(w.destinationOf(waiting)).toBe(m.session);
      expect(w.rerouted(waiting)).toEqual([]);
      // no add was reserved or issued, in the evaluation stopped between moves or after
      await w.executor.idle();
      expect(w.addTrace()).toEqual(addBefore);
    } finally {
      w.db.close();
    }
  });

  it("A stored block that can't be read holds the pool, raises an advisory, and removes nothing.", async () => {
    const w = poolWorld();
    try {
      const m = w.model();
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      const q = await w.row(m.session);
      // a second row: with one free agent, the plan would also add one
      await later();
      await w.row(m.session);
      const slotsBefore = w.slots.forModel(m.nodeId);
      const addBefore = w.addTrace();
      w.db.prepare("UPDATE nodes SET pool = ? WHERE id = ?").run(JSON.stringify({ max: 2, min: 5 }), m.nodeId);

      const notes = await w.notesOf(job.jobId);
      expect(notes.held).toEqual({ cause: "pool block unreadable", message: "held: pool block unreadable" });
      expect(notes.advisory).toMatch(/^the stored pool block can't be read \(/);
      expect(notes).not.toHaveProperty("moved");
      expect(w.destinationOf(q)).toBe(m.session);
      expect(w.jobsRepo.getByIdOrThrow(job.jobId).state).toBe("active");
      expect(w.slots.forModel(m.nodeId)).toEqual(slotsBefore);
      expect(w.rigRepo.getNodePool(m.nodeId)).toMatchObject({ raw: { max: 2, min: 5 }, error: expect.any(String) });
      expect(w.sessions.getSessionsForRig(m.rigId).some((s) => s.nodeId === s1.nodeId)).toBe(true);
      // no add is reserved or issued
      expect(notes).not.toHaveProperty("add");
      await w.executor.idle();
      expect(w.addTrace()).toEqual(addBefore);
    } finally {
      w.db.close();
    }
  });

  it("After the model node is deleted, the job has no effect and reports that the model node is gone.", async () => {
    const w = poolWorld();
    try {
      const m = w.model({ session: false });
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      const q = await w.row(m.session);

      w.rigRepo.deleteNode(m.nodeId);
      const notes = await w.notesOf(job.jobId);
      expect(notes).toEqual({ modelNodeId: m.nodeId, slots: [], held: { cause: "model node gone", message: "held: model node gone" } });
      expect(w.queue.getById(q)).toMatchObject({ state: "pending", destinationSession: m.session });
      expect(w.rerouted(q)).toEqual([]);
      expect(w.jobsRepo.getByIdOrThrow(job.jobId).state).toBe("active");
      // the agent stays as an ordinary member, with its session
      expect(w.rigRepo.getRig(m.rigId)!.nodes.map((n) => n.id)).toContain(s1.nodeId);
      expect(w.sessions.getSessionsForRig(m.rigId).some((s) => s.nodeId === s1.nodeId)).toBe(true);
    } finally {
      w.db.close();
    }
  });

  it("With `min: 0`, one free `live` agent and two pending rows to the model, `rig seat stop` of the model writes no `rig.stopped`, the next cycle moves one row to the free agent and issues one add from the model's stored settings, and no hold is reported.", async () => {
    const w = poolWorld();
    try {
      const m = w.model();
      // stored settings of the model that the new agent takes
      w.rigRepo.setNodeClaudeMcp(m.nodeId, "none");
      w.rigRepo.setNodeStatuslineThrottle(m.nodeId, 45);
      const s1 = w.agent(m, 1);
      const job = w.jobFor(m);
      const q1 = await w.row(m.session);
      await later();
      const q2 = await w.row(m.session);

      const stopTmux = {
        ...teardownTmux(),
        probeSession: vi.fn(async () => ({ state: "present" as const })),
        deliveryGuard: w.guard,
      } as unknown as TmuxAdapter;
      const lifecycle = new SeatLifecycleService({ db: w.db, rigRepo: w.rigRepo, sessionRegistry: w.sessions, eventBus: w.bus, tmuxAdapter: stopTmux });
      expect(await lifecycle.stopSeat({ seatRef: m.session, reason: "the operator stops the model only" })).toMatchObject({ ok: true });
      expect(stopTmux.killSession).toHaveBeenCalledWith(m.session);
      expect(w.events(m.rigId, "rig.stopped")).toEqual([]);

      const notes = await w.notesOf(job.jobId);
      expect(notes).not.toHaveProperty("held");
      expect(notes.moved).toEqual([{ qitemId: q1, from: m.session, to: s1.session }]);
      expect(w.destinationOf(q2)).toBe(m.session);
      const issued = (notes.add as { issued: Array<{ slotNumber: number; logicalId: string; attempt: { id: string; status: string } }> }).issued;
      expect(issued).toEqual([{ slotNumber: 2, logicalId: "dev.impl-s2", attempt: { id: expect.any(String), status: "in_flight", message: `in flight (attempt ${issued[0]!.attempt.id})` } }]);
      await w.executor.idle();
      expect(w.converge).toHaveBeenCalledTimes(1);
      const [rigId, op, rigRoot, opts] = w.converge.mock.calls[0] as unknown as [string, { kind: string; pod: string; member: Record<string, unknown> }, string, Record<string, unknown>];
      expect(rigId).toBe(m.rigId);
      expect(rigRoot).toBe(".");
      expect(opts).toEqual(expect.objectContaining({ recordCreated: expect.any(Function) }));
      expect(op).toMatchObject({ kind: "add_member", pod: "dev" });
      expect(op.member).toEqual({
        id: "impl-s2", agent_ref: "", profile: "default", runtime: "claude-code", cwd: "/tmp",
        claude_mcp: "none", statusline_throttle: 45, restore_policy: "resume_if_possible", keep_alive: false,
      });
    } finally {
      w.db.close();
    }
  });
});

describe("seat-pool holds: no drain while held (#3395 Piece 1)", () => {
  /** A pool with one free agent idle past `idle_grace_s` and nothing to do: unheld, the cycle drains it. */
  const drainablePool = () => {
    const w = poolWorld(fullDb(), { drain: true });
    const m = w.model();
    const s1 = w.agent(m, 1);
    const job = w.jobFor(m);
    return { w, m, s1, job };
  };
  const expectNoDrain = (w: ReturnType<typeof poolWorld>, m: Model, notes: Record<string, unknown>) => {
    expect(notes).not.toHaveProperty("drains");
    expect(w.capture).not.toHaveBeenCalled();
    expect(w.stopSeat).not.toHaveBeenCalled();
    expect(w.slots.forModel(m.nodeId).map((s) => s.phase)).toEqual(["live"]);
  };

  it("While the job is stopped, no drain is planned and no capture or `stopSeat` is made.", async () => {
    const { w, m, job } = drainablePool();
    try {
      w.jobsRepo.stop(job.jobId);
      // the engine evaluates only active jobs: the executor is asked directly, as the policy would hand it the job
      const stored = w.jobsRepo.getByIdOrThrow(job.jobId);
      const result = await w.executor.cycle({ jobId: stored.jobId, context: (parseYaml(stored.specYaml) as { context: Record<string, unknown> }).context });
      const notes = (result as { notes: Record<string, unknown> }).notes;
      expect(notes.held).toEqual({ cause: "job stopped", message: "held: job stopped" });
      expectNoDrain(w, m, notes);
    } finally {
      w.db.close();
    }
  });

  it("From `rig down` until a later `restore.completed`, no drain is planned and no capture or `stopSeat` is made; once released, the free agent is drained.", async () => {
    const { w, m, s1, job } = drainablePool();
    try {
      const { snapshotId } = await w.down(m.rigId);
      const stopped = w.events(m.rigId, "rig.stopped").at(-1)!;
      w.ready(s1);
      const notes = await w.notesOf(job.jobId);
      expect(notes.held).toEqual(rigStopped(stopped));
      expectNoDrain(w, m, notes);

      expect(snapshotId).toBeTruthy();
      const restored = await w.up(snapshotId!);
      expect(restored.ok, JSON.stringify(restored)).toBe(true);
      w.ready(s1);
      const released = await w.notesOf(job.jobId);
      expect(released).not.toHaveProperty("held");
      expect(released.drains).toEqual([
        expect.objectContaining({ slotNumber: 1, outcome: "drained", phase: "drained", stop: { cause: "drain", result: "stopped" } }),
      ]);
      // the drain's normal path: the resume refresh ran before the capture
      expect(w.refresh).toHaveBeenCalledTimes(1);
      expect(w.capture).toHaveBeenCalledTimes(1);
      expect(w.stopSeat).toHaveBeenCalledTimes(1);
    } finally {
      w.db.close();
    }
  });

  it("While the stored block can't be read, no drain is planned and no capture or `stopSeat` is made.", async () => {
    const { w, m, job } = drainablePool();
    try {
      w.db.prepare("UPDATE nodes SET pool = ? WHERE id = ?").run(JSON.stringify({ max: 2, min: 5 }), m.nodeId);
      const notes = await w.notesOf(job.jobId);
      expect(notes.held).toEqual({ cause: "pool block unreadable", message: "held: pool block unreadable" });
      expectNoDrain(w, m, notes);
    } finally {
      w.db.close();
    }
  });
});
