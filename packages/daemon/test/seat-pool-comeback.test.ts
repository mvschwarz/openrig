import { describe, it, expect, vi, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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
import { makeSeatPoolPolicy } from "../src/domain/policies/seat-pool.js";
import { reconcileSeatPoolNode, type SeatPoolReconcileResult } from "../src/domain/seat-pool-registration.js";
import {
  makeSeatPoolExecutor, seatPoolQueueEffects, type SeatPoolAddDeps, type SeatPoolComebackDeps, type SeatPoolExecutorDeps,
  type SeatPoolSeatStop,
} from "../src/domain/seat-pool-executor.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { convergeOp, type ConvergeResult } from "../src/domain/topology-converge.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { ArbitratedSeatState } from "../src/domain/activity-taxonomy.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import type { SnapshotData } from "../src/domain/types.js";

// #3395 (Piece 1): the seat pool brings a drained agent back. The next add after a drain picks the newest snapshot
// that is restore-usable, holds the agent's node and recorded one active occupant for it, and launches the agent's own
// node through `launchSingleNode` with that explicit `snapshotId`. The job is unarmed in the daemon, so each test
// composes the executor and an engine that has the seat-pool policy over a real instantiator, the real member add, a
// drain whose capture is the real `auto-rehydrate` snapshot, and the real restore orchestrator and snapshot repository,
// whose terminal and Claude are fakes that record what each launch was given.

const RIG = "pool-rig";
const IDLE_SINCE = "2026-11-18T10:00:00.000Z";
const AGENT_YAML = `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
/** The block the drain runs under: no agent is wanted, so a free agent idle past its grace is drained. */
const DRAINING: SeatPoolSpec = {
  max: 3, min: 0, dispatchAfterSeconds: 60, idleGraceSeconds: 300, cooldownSeconds: 60, dispatchTag: null, cwdTemplate: null, drain: false,
};

const cleanups: Array<() => void> = [];
/** Every call the restore orchestrator's `launchSingleNode` received through the orchestrator itself, in each test. */
const launchCalls: unknown[][] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  // No call without an explicit snapshot id, in any test.
  for (const call of launchCalls.splice(0)) {
    expect(typeof (call[2] as { snapshotId?: unknown } | undefined)?.snapshotId, JSON.stringify(call.slice(0, 2))).toBe("string");
  }
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

/** One harness launch as the fake Claude saw it: the terminal session, the binding and the conversation it resumed. */
interface HarnessLaunch { session: string; binding: NodeBinding; resumeToken: string | undefined }

function comebackWorld() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seat-pool-comeback-")));
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
  const harness: HarnessLaunch[] = [];
  const claude: RuntimeAdapter = {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async (binding: NodeBinding, opts?: { resumeToken?: string }) => {
      const token = opts?.resumeToken ?? randomUUID();
      harness.push({ session: binding.tmuxSession!, binding, resumeToken: opts?.resumeToken });
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
  const converge = vi.fn<SeatPoolAddDeps["converge"]>(async (rigId, op, rigRoot, opts): Promise<ConvergeResult> =>
    convergeOp({ instantiator: inst }, rigId, op, rigRoot, opts));

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
  // Every call that reaches the orchestrator's own launchSingleNode is recorded for the check after each test.
  const realLaunch = restorer.launchSingleNode.bind(restorer);
  restorer.launchSingleNode = (async (...args: Parameters<RestoreOrchestrator["launchSingleNode"]>) => {
    launchCalls.push(args);
    return realLaunch(...args);
  }) as RestoreOrchestrator["launchSingleNode"];

  /** Runs between the comeback's selection and its call, with the snapshot it is about to send. */
  const hooks: { beforeLaunch?: (snapshotId: string) => void } = {};
  const select = vi.fn<SeatPoolComebackDeps["select"]>((rigId, nodeId, logicalId) => snapshotRepo.selectComebackSnapshot(rigId, nodeId, logicalId));
  const launch = vi.fn<SeatPoolComebackDeps["launch"]>(async (rigId, logicalId, opts) => {
    hooks.beforeLaunch?.(opts.snapshotId);
    return restorer.launchSingleNode(rigId, logicalId, { snapshotId: opts.snapshotId, adapters, fsOps: { exists: (p) => fs.existsSync(p) } });
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
  const executor = makeSeatPoolExecutor(deps);
  const engine = new WatchdogPolicyEngine({
    jobsRepo, historyLog: history, eventBus: bus, deliver: async () => ({ status: "ok" }),
    additionalPolicies: [makeSeatPoolPolicy({ cycle: (job) => executor.cycle(job) })],
  });
  const reg = { db, rigRepo, jobsRepo, warn: vi.fn() };

  type Model = { rigId: string; nodeId: string; logicalId: string; session: string; jobId: string };
  /** The model member, instantiated and launched, with its job. */
  const model = async (opts: { member?: Record<string, unknown>; pool?: Record<string, unknown> } = {}): Promise<Model> => {
    const spec = stringifyYaml({
      version: "0.2", name: RIG,
      pods: [{ id: "dev", label: "Dev", edges: [], members: [{
        id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: modelCwd,
        pool: opts.pool ?? { max: 3, min: 1 }, ...opts.member,
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
  /** One evaluation through the engine; its notes. */
  const notesOf = async (jobId: string) =>
    (((await engine.evaluate(jobsRepo.getByIdOrThrow(jobId))).outcome) as { notes?: Record<string, unknown> }).notes ?? {};
  const nodeOf = (rigId: string, logicalId: string) => rigRepo.getRig(rigId)!.nodes.find((n) => n.logicalId === logicalId);
  const nodesNamed = (logicalId: string) => (db.prepare("SELECT id FROM nodes WHERE logical_id = ?").all(logicalId) as Array<{ id: string }>).map((r) => r.id);
  const sessionsOf = (nodeId: string) =>
    db.prepare("SELECT id, status FROM sessions WHERE node_id = ? ORDER BY created_at, id").all(nodeId) as Array<{ id: string; status: string }>;
  const correlations = () => db.prepare("SELECT operation_id, node_ids_json FROM operation_correlations").all() as
    Array<{ operation_id: string; node_ids_json: string }>;
  const row = async (destination: string) => (await queue.create({
    sourceSession: `lead@${RIG}`, destinationSession: destination, body: "work", nudge: false,
  })).qitemId;

  /** The pool's own agents as the real add creates them: one cycle that adds `count`, settled running and idle. */
  const serve = async (m: Model, count = 1) => {
    const notes = await notesOf(m.jobId);
    expect((notes.add as { issued?: unknown[] } | undefined)?.issued, JSON.stringify(notes.add)).toHaveLength(count);
    await executor.idle();
    const agents = slots.forModel(m.nodeId);
    expect(agents.map((s) => s.phase)).toEqual(Array.from({ length: count }, () => "live"));
    for (const slot of agents) activity.set(slot.nodeId!, idleState(slot.nodeId!));
    return agents.map((s) => ({ nodeId: s.nodeId!, logicalId: `dev.impl-s${s.slotNumber}` }));
  };
  /** No agent wanted any more: the next cycle drains the free agents, each captured (B) right before its stop. */
  const drain = async (m: Model, count = 1) => {
    rigRepo.setNodePool(m.nodeId, { spec: DRAINING });
    const notes = await notesOf(m.jobId);
    const drains = notes.drains as Array<{ slotNumber: number; outcome: string; snapshotId?: string }>;
    expect(drains.map((d) => d.outcome), JSON.stringify(notes)).toEqual(Array.from({ length: count }, () => "drained"));
    expect(slots.forModel(m.nodeId).map((s) => s.phase)).toEqual(Array.from({ length: count }, () => "drained"));
    return new Map(drains.map((d) => [d.slotNumber, d.snapshotId!]));
  };
  /** Past the drain's cooldown. */
  const afterCooldown = () => { clock.now = new Date(clock.now.getTime() + (DRAINING.cooldownSeconds + 60) * 1000); };

  /** The usual history: an `auto-periodic` snapshot A before the agent exists, the agent added and running, then drained
   *  with its pool capture B, and a row waiting for the model so the next cycle wants one agent, past the cooldown. */
  const drainedAgent = async (opts: { member?: Record<string, unknown> } = {}) => {
    const m = await model(opts);
    const a = snapshotCapture.captureSnapshot(m.rigId, "auto-periodic").id;
    const [w1] = await serve(m);
    const b = (await drain(m)).get(1)!;
    return { m, w1: w1!, a, b };
  };
  const wantOne = async (m: Model) => {
    await row(m.session);
    afterCooldown();
  };

  return {
    root, db, bus, rigRepo, slots, sessions, queue, jobsRepo, activity, clock, inst, exporter, converge, snapshotRepo, snapshotCapture,
    restorer, adapters, hooks, select, launch, stopSeat, harness, executor, engine, panes,
    model, notesOf, nodeOf, nodesNamed, sessionsOf, correlations, row, serve, drain, afterCooldown, drainedAgent, wantOne,
  };
}

type World = ReturnType<typeof comebackWorld>;
type SettledEntry = { slotNumber: number; logicalId: string; nodeId?: string; warning?: string; attempt: Record<string, unknown> };
type ComebackEntry = { slotNumber: number; logicalId: string; nodeId: string; snapshotId?: string; attempt?: Record<string, unknown>; hold?: Record<string, unknown>; code?: string };

/** The cycle that brings the agent back, and the next one, which reports what settled. */
async function comeBack(w: World, jobId: string) {
  const notes = await w.notesOf(jobId);
  await w.executor.idle();
  const next = await w.notesOf(jobId);
  return { notes, next, settled: (next.settled ?? []) as SettledEntry[] };
}

describe("seat-pool comeback: the drained agent comes back on its own node (#3395 Piece 1)", () => {
  it("The next add after a drain brings back `dev.impl-s1` on the same node through `launchSingleNode` with an explicit `snapshotId`, and never creates a second node with that name.", async () => {
    const w = comebackWorld();
    const { m, w1, b } = await w.drainedAgent();
    expect(w.nodesNamed("dev.impl-s1")).toEqual([w1.nodeId]);
    // the add itself went through the converge path once, for the first number
    expect(w.converge).toHaveBeenCalledTimes(1);
    await w.wantOne(m);

    const { notes, settled } = await comeBack(w, m.jobId);
    const add = notes.add as { comebacks: ComebackEntry[]; issued?: unknown };
    expect(add.comebacks).toEqual([{
      slotNumber: 1, logicalId: "dev.impl-s1", nodeId: w1.nodeId, snapshotId: b,
      attempt: { id: expect.any(String), status: "in_flight", message: expect.stringMatching(/^in flight \(attempt /) },
    }]);
    // no new number: the add is the comeback
    expect(add).not.toHaveProperty("issued");
    expect(w.launch.mock.calls).toEqual([[m.rigId, "dev.impl-s1", { snapshotId: b }]]);
    expect(w.converge).toHaveBeenCalledTimes(1);
    expect(settled).toEqual([expect.objectContaining({ slotNumber: 1, logicalId: "dev.impl-s1", nodeId: w1.nodeId, attempt: expect.objectContaining({ status: "running" }) })]);
    expect(w.slots.forModel(m.nodeId).map((s) => [s.slotNumber, s.nodeId, s.phase])).toEqual([[1, w1.nodeId, "live"]]);
    expect(w.nodesNamed("dev.impl-s1")).toEqual([w1.nodeId]);
    expect(w.nodesNamed("dev.impl-s2")).toEqual([]);
    expect(JSON.stringify(settled)).not.toContain("\"stop\"");
  });

  it("A reused slot comes back through `launchSingleNode` with its own sessions and stored settings, without `addMemberToPod`.", async () => {
    const w = comebackWorld();
    const { m, w1 } = await w.drainedAgent({ member: { statusline_throttle: 30 } });
    const sessionsBefore = w.sessionsOf(w1.nodeId);
    expect(sessionsBefore.map((s) => s.status)).toEqual(["stopped"]);
    const settingsBefore = w.exporter.exportedRawMemberFromNode(m.rigId, w1.nodeId);
    const addMember = vi.spyOn(w.inst, "addMemberToPod");
    await w.wantOne(m);

    const { settled } = await comeBack(w, m.jobId);
    expect(settled[0]!.attempt).toMatchObject({ status: "running" });
    expect(JSON.stringify(settled)).not.toContain("\"stop\"");
    expect(addMember).not.toHaveBeenCalled();
    expect(w.converge).toHaveBeenCalledTimes(1);
    // the same node, its earlier sessions kept (the launch marks them superseded) and one new session running
    const sessionsAfter = w.sessionsOf(w1.nodeId);
    expect(sessionsAfter.slice(0, sessionsBefore.length).map((s) => s.id)).toEqual(sessionsBefore.map((s) => s.id));
    expect(sessionsAfter).toHaveLength(sessionsBefore.length + 1);
    expect(sessionsAfter.at(-1)!.status).toBe("running");
    // the same stored settings
    expect(w.exporter.exportedRawMemberFromNode(m.rigId, w1.nodeId)).toEqual(settingsBefore);
    expect(w.nodeOf(m.rigId, "dev.impl-s1")!.statuslineThrottle).toBe(30);
  });

  it("A reused slot whose stored settings differ from the model's comes back with its own settings and a warning naming the fields that differ.", async () => {
    const w = comebackWorld();
    const { m, w1 } = await w.drainedAgent({ member: { statusline_throttle: 30 } });
    // the model's settings change after the agent was created
    w.rigRepo.setNodeClaudeMcp(m.nodeId, "none");
    w.rigRepo.setNodeStatuslineThrottle(m.nodeId, 45);
    const own = w.exporter.exportedRawMemberFromNode(m.rigId, w1.nodeId);
    await w.wantOne(m);

    const { settled } = await comeBack(w, m.jobId);
    expect(settled).toEqual([expect.objectContaining({
      slotNumber: 1, attempt: expect.objectContaining({ status: "running" }),
      warning: "the slot's stored settings differ from the model's (claude_mcp, statusline_throttle); it comes back with its own",
    })]);
    expect(JSON.stringify(settled)).not.toContain("\"stop\"");
    // its own settings, stored and launched
    expect(w.exporter.exportedRawMemberFromNode(m.rigId, w1.nodeId)).toEqual(own);
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
    expect(agent.statuslineThrottle).toBe(30);
    expect(agent.claudeMcp ?? null).toBeNull();
    const launched = w.harness.filter((h) => h.session === `dev-impl-s1@${RIG}`).at(-1)!;
    expect(launched.binding.claudeMcp ?? null).toBeNull();
  });

  it("A reused slot whose stored settings match the model's comes back with no warning.", async () => {
    const w = comebackWorld();
    const { m } = await w.drainedAgent();
    await w.wantOne(m);
    const { notes, settled } = await comeBack(w, m.jobId);
    expect(notes.add).not.toHaveProperty("issued");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ slotNumber: 1, attempt: { status: "running", snapshotSelection: { mode: "explicit" } } });
    expect(settled[0]).not.toHaveProperty("warning");
  });

  it("A reused slot with no `cwd_template` whose model's folder changed comes back in its own folder with a warning naming `cwd`.", async () => {
    const w = comebackWorld();
    const { m, w1 } = await w.drainedAgent();
    const ownFolder = w.nodeOf(m.rigId, "dev.impl-s1")!.cwd;
    // the model's folder changes after the agent took it
    expect(w.rigRepo.setNodeCwd(m.nodeId, `${ownFolder}-moved`, w.nodeOf(m.rigId, "dev.impl")!.cwd)).toBe(true);
    await w.wantOne(m);

    const { settled } = await comeBack(w, m.jobId);
    expect(settled).toEqual([expect.objectContaining({
      slotNumber: 1, nodeId: w1.nodeId, attempt: expect.objectContaining({ status: "running" }),
      warning: "the slot's stored settings differ from the model's (cwd); it comes back with its own",
    })]);
    expect(w.nodeOf(m.rigId, "dev.impl-s1")!.cwd).toBe(ownFolder);
  });

  it("An add with a `drained` slot eligible counts as one add and reuses the lowest eligible number.", async () => {
    // two eligible drained slots: the lower one comes back, the other stays drained
    {
      const w = comebackWorld();
      const m = await w.model({ pool: { max: 3, min: 2 } });
      const [s1, s2] = await w.serve(m, 2);
      await w.drain(m, 2);
      await w.wantOne(m);

      const { notes, settled } = await comeBack(w, m.jobId);
      const add = notes.add as { comebacks: ComebackEntry[] };
      expect(add.comebacks.map((c) => [c.slotNumber, c.nodeId, c.attempt?.status])).toEqual([[1, s1!.nodeId, "in_flight"]]);
      expect(add).not.toHaveProperty("issued");
      expect(w.launch.mock.calls.map((call) => call[1])).toEqual(["dev.impl-s1"]);
      expect(settled.map((s) => [s.slotNumber, s.attempt.status])).toEqual([[1, "running"]]);
      expect(w.slots.forModel(m.nodeId).map((s) => [s.slotNumber, s.nodeId, s.phase, s.attemptKind])).toEqual([
        [1, s1!.nodeId, "live", "comeback"], [2, s2!.nodeId, "drained", "add"],
      ]);
      expect(w.converge).toHaveBeenCalledTimes(2);
      expect(w.nodesNamed("dev.impl-s3")).toEqual([]);
    }

    const w = comebackWorld();
    const m = await w.model({ pool: { max: 3, min: 2 } });
    const [s1, s2] = await w.serve(m, 2);
    await w.drain(m, 2);
    // the lowest drained slot is not eligible: it carries a reuse hold
    w.db.prepare("UPDATE seat_pool_slots SET reuse_hold = ? WHERE node_id = ?").run(JSON.stringify({ code: "no_qualifying_snapshot" }), s1!.nodeId);
    await w.wantOne(m);

    const { notes, settled } = await comeBack(w, m.jobId);
    const add = notes.add as { comebacks: ComebackEntry[] };
    expect(add.comebacks.map((c) => [c.slotNumber, c.nodeId, c.attempt?.status])).toEqual([[2, s2!.nodeId, "in_flight"]]);
    expect(add).not.toHaveProperty("issued");
    expect(w.launch).toHaveBeenCalledTimes(1);
    expect(w.launch.mock.calls[0]![1]).toBe("dev.impl-s2");
    expect(settled.map((s) => [s.slotNumber, s.attempt.status])).toEqual([[2, "running"]]);
    expect(w.slots.forModel(m.nodeId).map((s) => [s.slotNumber, s.phase])).toEqual([[1, "drained"], [2, "live"]]);
    expect(w.converge).toHaveBeenCalledTimes(2);
    expect(w.nodesNamed("dev.impl-s3")).toEqual([]);
  });

  it("An add that settled `not_running` holds only the new number: an eligible `drained` slot still comes back in the same cycle, and the next unit takes no new number, naming the failed attempt.", async () => {
    const w = comebackWorld();
    const m = await w.model({ pool: { max: 3, min: 2 } });
    const [s1, s2] = await w.serve(m, 2);
    await w.drain(m, 2);
    // slot 1 is an add that settled not running: its outcome says so, and it keeps its reuse hold
    // (the UPDATE writes the outcome and the hold `settleAddNotRunning` writes, and the drain already left the slot `drained`;
    // the C67 test in seat-pool-add-lifecycle.test.ts takes the real path)
    const failedHold = { code: "not_running", observed: "exited" };
    w.db.prepare("UPDATE seat_pool_slots SET attempt_outcome = ?, reuse_hold = ? WHERE node_id = ?")
      .run(JSON.stringify({ status: "not_running", observed: "exited", call: null }), JSON.stringify(failedHold), s1!.nodeId);
    const failedAttempt = w.slots.forModel(m.nodeId)[0]!.attemptId!;
    // two rows wait for the model: the add wants two agents
    await w.row(m.session);
    await w.wantOne(m);

    const { notes, next, settled } = await comeBack(w, m.jobId);
    const add = notes.add as { comebacks: ComebackEntry[]; held?: string; failedAdd?: Record<string, unknown> };
    expect(add.comebacks.map((c) => [c.slotNumber, c.nodeId, c.attempt?.status])).toEqual([[2, s2!.nodeId, "in_flight"]]);
    expect(add.held).toBe(`held: failed add ${failedAttempt} (slot 1) settled not_running (exited)`);
    // the failed add holds the add's new number only, never the whole pool
    expect(notes).not.toHaveProperty("held");
    expect(add.failedAdd).toEqual({
      slotNumber: 1, nodeId: s1!.nodeId, attempt: { id: failedAttempt, status: "not_running", observed: "exited" }, reuseHold: failedHold,
    });
    expect(add).not.toHaveProperty("issued");
    expect(w.launch.mock.calls.map((call) => call[1])).toEqual(["dev.impl-s2"]);
    expect(settled.map((s) => [s.slotNumber, s.attempt.status])).toEqual([[2, "running"]]);
    // the next cycle moves a waiting row to the agent that came back, in the same cycle whose add names the failed attempt
    expect(next.moved).toEqual([{ qitemId: expect.any(String), from: m.session, to: `dev-impl-s2@${RIG}` }]);
    expect((next.add as { held?: string }).held).toBe(`held: failed add ${failedAttempt} (slot 1) settled not_running (exited)`);
    expect(next).not.toHaveProperty("held");
    expect(w.converge).toHaveBeenCalledTimes(2);
    expect(w.nodesNamed("dev.impl-s3")).toEqual([]);
  });

  it("A leftover add the cycle settles `not_running` from its row starts the cooldown before that cycle's add: an eligible `drained` slot does not come back in that cycle nor 30 s later, and comes back once `cooldown_s` has passed since the settle.", async () => {
    const w = comebackWorld();
    const { m, w1, b } = await w.drainedAgent();
    // slot 1 carries a reuse hold for now, so the next add takes a new number, slot 2
    w.db.prepare("UPDATE seat_pool_slots SET reuse_hold = ? WHERE node_id = ?").run(JSON.stringify({ code: "no_qualifying_snapshot" }), w1.nodeId);
    // slot 2's call returns with its startup not ready: its result is unknown, and it stays issued once its call is over
    const converge = w.converge.getMockImplementation()!;
    w.converge.mockImplementationOnce(async (...args) => {
      const result = await converge(...args);
      w.db.prepare("UPDATE sessions SET startup_status = 'pending' WHERE node_id = ?").run(w.nodeOf(m.rigId, "dev.impl-s2")!.id);
      return result;
    });
    await w.wantOne(m);
    const first = await w.notesOf(m.jobId);
    await w.executor.idle();
    expect((first.add as { issued: Array<{ logicalId: string }> }).issued.map((i) => i.logicalId)).toEqual(["dev.impl-s2"]);
    const s2 = w.nodeOf(m.rigId, "dev.impl-s2")!;
    const leftover = w.slots.forModel(m.nodeId).find((s) => s.slotNumber === 2)!;
    expect(leftover).toMatchObject({ nodeId: s2.id, phase: "adding", attemptKind: "add", attemptState: "issued" });
    expect(JSON.parse(leftover.attemptOutcome!)).toMatchObject({ status: "unknown" });
    expect(w.launch).not.toHaveBeenCalled();

    // slot 1 is eligible again, drained outside its cooldown; slot 2's session exits, and a second row makes the plan
    // want one more agent
    w.db.prepare("UPDATE seat_pool_slots SET reuse_hold = NULL WHERE node_id = ?").run(w1.nodeId);
    w.sessions.updateStatus(w.sessionsOf(s2.id).at(-1)!.id, "exited");
    await w.row(m.session);
    const settle = await w.notesOf(m.jobId);
    await w.executor.idle();
    expect(settle.settled).toEqual([{ slotNumber: 2, logicalId: "dev.impl-s2", nodeId: s2.id, attempt: { id: leftover.attemptId, status: "not_running", observed: "exited" } }]);
    expect(w.launch).not.toHaveBeenCalled();
    expect(settle.add).toEqual({ skipped: "cooldown" });
    expect(w.slots.forModel(m.nodeId).map((s) => [s.slotNumber, s.phase, s.reuseHold === null])).toEqual([[1, "drained", true], [2, "drained", false]]);

    // 30 s later, still inside the cooldown the settle started (the drain left the model's pool on `DRAINING`)
    const cooldownMs = DRAINING.cooldownSeconds * 1000;
    w.clock.now = new Date(w.clock.now.getTime() + 30_000);
    await w.notesOf(m.jobId);
    await w.executor.idle();
    expect(w.launch).not.toHaveBeenCalled();

    // past `cooldown_s` since the settle, slot 1 comes back
    w.clock.now = new Date(w.clock.now.getTime() + cooldownMs - 30_000 + 1_000);
    const { settled } = await comeBack(w, m.jobId);
    expect(w.launch.mock.calls).toEqual([[m.rigId, "dev.impl-s1", { snapshotId: b }]]);
    expect(settled).toEqual([expect.objectContaining({ slotNumber: 1, nodeId: w1.nodeId, attempt: expect.objectContaining({ status: "running" }) })]);
  });
});

describe("seat-pool comeback: which snapshot it sends (#3395 Piece 1)", () => {
  it("Control: with an older `auto-periodic` snapshot A taken before `w1` existed and a newer pool capture B holding `w1`, `launchSingleNode` without `snapshotId` picks A and returns `no_matching_nodes`.", async () => {
    const w = comebackWorld();
    const { m, a, b } = await w.drainedAgent();
    expect(w.snapshotRepo.getSnapshot(a)!.kind).toBe("auto-periodic");
    expect(w.snapshotRepo.getSnapshot(b)!.kind).toBe("auto-rehydrate");
    // B is the newer of the two, and A ranks first without an explicit id
    const ids = w.snapshotRepo.listSnapshots(m.rigId).map((s) => s.id);
    expect(ids.indexOf(b)).toBeLessThan(ids.indexOf(a));
    expect(w.snapshotRepo.findLatestRestoreUsable(m.rigId)?.id).toBe(a);
    const selected = w.snapshotRepo.selectRestoreUsable(m.rigId);
    expect(selected.ok && selected.snapshot.id).toBe(a);

    // the control call, made by the test, not by the pool
    const control = await RestoreOrchestrator.prototype.launchSingleNode.call(w.restorer, m.rigId, "dev.impl-s1");
    expect(control).toMatchObject({ ok: false, code: "no_matching_nodes" });
  });

  it("The pool's comeback of `w1` sends `snapshotId = B`, and `w1` runs on the same node id with `snapshotSelection.snapshotId = B` and `mode: \"explicit\"`.", async () => {
    const w = comebackWorld();
    const { m, w1, b } = await w.drainedAgent();
    await w.wantOne(m);

    const { next, settled } = await comeBack(w, m.jobId);
    expect(w.launch.mock.calls).toEqual([[m.rigId, "dev.impl-s1", { snapshotId: b }]]);
    expect(settled).toEqual([{
      slotNumber: 1, logicalId: "dev.impl-s1", nodeId: w1.nodeId,
      attempt: { id: expect.any(String), status: "running", snapshotSelection: { snapshotId: b, mode: "explicit" } },
    }]);
    // the slot as reported, the same node id, running
    const slotViews = next.slots as Array<Record<string, unknown>>;
    expect(slotViews).toEqual([{
      slotNumber: 1, nodeId: w1.nodeId, phase: "live",
      attempt: { id: settled[0]!.attempt.id, status: "running", snapshotSelection: { snapshotId: b, mode: "explicit" } },
    }]);
    const latest = w.sessionsOf(w1.nodeId).at(-1)!;
    expect(latest.status).toBe("running");
    expect(JSON.parse(w.slots.forModel(m.nodeId)[0]!.attemptResult!)).toEqual({ nodeId: w1.nodeId, sessionId: latest.id });
    // the comeback's report is an attempt, never a stop
    expect(JSON.stringify(settled)).not.toContain("\"stop\"");
  });

  it("With a later `auto-periodic` snapshot C taken after the drain, where `w1` is absent, the comeback picks B, never C.", async () => {
    const w = comebackWorld();
    const { m, w1, b } = await w.drainedAgent();
    const c = w.snapshotCapture.captureSnapshot(m.rigId, "auto-periodic").id;
    expect(w.snapshotRepo.findLatestRestoreUsable(m.rigId)?.id).toBe(c);
    await w.wantOne(m);

    const { settled } = await comeBack(w, m.jobId);
    expect(w.select).toHaveBeenCalledWith(m.rigId, w1.nodeId, "dev.impl-s1");
    const selection = w.select.mock.results[0]!.value as ReturnType<SnapshotRepository["selectComebackSnapshot"]>;
    expect(selection.chosen?.id).toBe(b);
    expect(selection.failed).toEqual([{ snapshotId: c, condition: 3 }]);
    expect(w.launch.mock.calls.map((call) => call[2].snapshotId)).toEqual([b]);
    expect(settled[0]!.attempt).toMatchObject({ status: "running", snapshotSelection: { snapshotId: b, mode: "explicit" } });
  });
});

describe("seat-pool comeback: recorded conflicting occupants (#3395 Piece 1)", () => {
  /** B's data with a second session row for `w1`, both running at capture, and `w1`'s occupant entry as `edit` leaves
   *  it (both rows as recorded candidates by default), stored as a newer `manual` capture D. */
  const conflictingCapture = (w: World, rigId: string, b: string, nodeId: string, edit?: (data: SnapshotData) => void) => {
    const data = structuredClone(w.snapshotRepo.getSnapshot(b)!.data);
    const first = data.sessions.find((s) => s.nodeId === nodeId)!;
    first.status = "running";
    data.sessions.push({ ...first, id: `${first.id}-b`, sessionName: `${first.sessionName}-b` });
    data.activeOccupantsByNode = { ...data.activeOccupantsByNode, [nodeId]: { kind: "ambiguous", candidateIds: [first.id, `${first.id}-b`] } };
    edit?.(data);
    return { d: w.snapshotRepo.createSnapshot(rigId, "manual", data).id, candidateIds: [first.id, `${first.id}-b`] };
  };

  it("A newer capture that recorded two live occupants for `w1` holds only that slot `drained` with `conflicting_occupants` naming the snapshot and both candidates, launches nothing, never falls back to the older pool capture B, and the add takes a new number.", async () => {
    const w = comebackWorld();
    const { m, w1, b } = await w.drainedAgent();
    const { d, candidateIds } = conflictingCapture(w, m.rigId, b, w1.nodeId);
    const sessionsBefore = w.sessionsOf(w1.nodeId);
    const phaseChangedAt = w.slots.forModel(m.nodeId)[0]!.phaseChangedAt;
    await w.wantOne(m);

    const notes = await w.notesOf(m.jobId);
    await w.executor.idle();
    const hold = { code: "conflicting_occupants", nodeId: w1.nodeId, snapshotId: d, candidateIds, read: 1, failed: [] };
    expect((notes.add as { comebacks: ComebackEntry[] }).comebacks).toEqual([{ slotNumber: 1, logicalId: "dev.impl-s1", nodeId: w1.nodeId, hold }]);
    expect(w.launch).not.toHaveBeenCalled();
    expect(w.slots.forModel(m.nodeId)[0]).toMatchObject({ slotNumber: 1, nodeId: w1.nodeId, phase: "drained", phaseChangedAt, reuseHold: JSON.stringify(hold) });
    expect((notes.add as { issued: Array<{ logicalId: string }> }).issued.map((i) => i.logicalId)).toEqual(["dev.impl-s2"]);

    for (let cycle = 0; cycle < 2; cycle++) {
      const again = await w.notesOf(m.jobId);
      await w.executor.idle();
      expect((again.slots as Array<Record<string, unknown>>).find((s) => s.slotNumber === 1)).toMatchObject({ phase: "drained", reuseHold: hold });
    }
    expect(w.select).toHaveBeenCalledTimes(1);
    expect(w.launch.mock.calls.map((call) => call[1])).not.toContain("dev.impl-s1");
    expect(w.sessionsOf(w1.nodeId)).toEqual(sessionsBefore);
  });

  it.each([
    ["missing", (nodeId: string) => (data: SnapshotData) => { delete data.activeOccupantsByNode![nodeId]; }],
    ["a resolved occupant naming no session", (nodeId: string) => (data: SnapshotData) => {
      data.activeOccupantsByNode![nodeId] = { kind: "resolved", sessionId: "sess-gone" };
    }],
  ])("A newer capture whose occupant entry for `w1` is %s fails condition 1, and the comeback still brings `w1` back from B.", async (_label, edit) => {
    const w = comebackWorld();
    const { m, w1, b } = await w.drainedAgent();
    const { d } = conflictingCapture(w, m.rigId, b, w1.nodeId, edit(w1.nodeId));
    await w.wantOne(m);

    const { notes, settled } = await comeBack(w, m.jobId);
    const selection = w.select.mock.results[0]!.value as ReturnType<SnapshotRepository["selectComebackSnapshot"]>;
    expect(selection.conflict).toBeUndefined();
    expect(selection.failed).toEqual([{ snapshotId: d, condition: 1 }]);
    expect((notes.add as { comebacks: ComebackEntry[] }).comebacks).toEqual([{ slotNumber: 1, logicalId: "dev.impl-s1", nodeId: w1.nodeId, snapshotId: b, attempt: expect.any(Object) }]);
    expect(w.launch.mock.calls).toEqual([[m.rigId, "dev.impl-s1", { snapshotId: b }]]);
    expect(settled[0]!.attempt).toMatchObject({ status: "running", snapshotSelection: { snapshotId: b, mode: "explicit" } });
  });

  it("A newer capture whose candidates for `w1` were not running at capture, as after a reboot, is named as an unknown occupancy on the comeback, which still brings `w1` back from B.", async () => {
    const w = comebackWorld();
    const { m, w1, b } = await w.drainedAgent();
    const { d, candidateIds } = conflictingCapture(w, m.rigId, b, w1.nodeId, (data) => {
      for (const s of data.sessions) if (s.nodeId === w1.nodeId) s.status = "detached";
    });
    await w.wantOne(m);

    const { notes, settled } = await comeBack(w, m.jobId);
    const comebacks = (notes.add as { comebacks: Array<ComebackEntry & { unknownOccupants?: unknown }> }).comebacks;
    expect(comebacks).toEqual([{
      slotNumber: 1, logicalId: "dev.impl-s1", nodeId: w1.nodeId, snapshotId: b, attempt: expect.any(Object),
      unknownOccupants: [{ snapshotId: d, candidateIds, detail: expect.stringContaining("multiple live occupant candidates") }],
    }]);
    expect(w.launch.mock.calls).toEqual([[m.rigId, "dev.impl-s1", { snapshotId: b }]]);
    expect(settled[0]!.attempt).toMatchObject({ status: "running", snapshotSelection: { snapshotId: b, mode: "explicit" } });
  });
});

describe("seat-pool comeback: no qualifying snapshot, and a refusal before the launch (#3395 Piece 1)", () => {
  it("With B deleted, the comeback makes no launch call and creates no session or node, the slot stays `drained` with `no_qualifying_snapshot` naming how many snapshots were read and the condition each one failed (A: condition 2), and repeated cycles call nothing.", async () => {
    const w = comebackWorld();
    const { m, w1, a, b } = await w.drainedAgent();
    w.db.prepare("DELETE FROM snapshots WHERE id = ?").run(b);
    expect(w.snapshotRepo.listSnapshots(m.rigId).map((s) => s.id)).toEqual([a]);
    const sessionsBefore = w.sessionsOf(w1.nodeId);
    const phaseChangedAt = w.slots.forModel(m.nodeId)[0]!.phaseChangedAt;
    // the operation of the add that created the agent, and nothing else for it
    const agentOperations = () => w.correlations().filter((c) => c.node_ids_json.includes(w1.nodeId));
    const operationsBefore = agentOperations();
    expect(operationsBefore).toHaveLength(1);
    await w.wantOne(m);

    const notes = await w.notesOf(m.jobId);
    await w.executor.idle();
    const hold = { code: "no_qualifying_snapshot", nodeId: w1.nodeId, read: 1, failed: [{ snapshotId: a, condition: 2 }] };
    expect((notes.add as { comebacks: ComebackEntry[] }).comebacks).toEqual([{ slotNumber: 1, logicalId: "dev.impl-s1", nodeId: w1.nodeId, hold }]);
    expect(w.launch).not.toHaveBeenCalled();
    expect(w.slots.forModel(m.nodeId)[0]).toMatchObject({ slotNumber: 1, nodeId: w1.nodeId, phase: "drained", phaseChangedAt, attemptKind: "add" });
    // the next number proceeds, never under the drained agent's name
    expect((notes.add as { issued: Array<{ logicalId: string }> }).issued.map((i) => i.logicalId)).toEqual(["dev.impl-s2"]);

    for (let cycle = 0; cycle < 2; cycle++) {
      const again = await w.notesOf(m.jobId);
      await w.executor.idle();
      // reported every cycle
      expect((again.slots as Array<Record<string, unknown>>).find((s) => s.slotNumber === 1)).toMatchObject({ phase: "drained", reuseHold: hold });
    }
    expect(w.select).toHaveBeenCalledTimes(1);
    expect(w.launch).not.toHaveBeenCalled();
    expect(w.nodesNamed("dev.impl-s1")).toEqual([w1.nodeId]);
    expect(w.sessionsOf(w1.nodeId)).toEqual(sessionsBefore);
    // no operation is reserved for the drained agent
    expect(agentOperations()).toEqual(operationsBefore);
  });

  it("With B's data corrupted, the slot stays `drained` with `no_qualifying_snapshot` naming condition 1, and no call is made.", async () => {
    const w = comebackWorld();
    const { m, w1, a, b } = await w.drainedAgent();
    w.db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run("{broken", b);
    await w.wantOne(m);

    const notes = await w.notesOf(m.jobId);
    await w.executor.idle();
    const hold = { code: "no_qualifying_snapshot", nodeId: w1.nodeId, read: 2, failed: [{ snapshotId: b, condition: 1 }, { snapshotId: a, condition: 2 }] };
    expect((notes.add as { comebacks: ComebackEntry[] }).comebacks).toEqual([{ slotNumber: 1, logicalId: "dev.impl-s1", nodeId: w1.nodeId, hold }]);
    expect(w.launch).not.toHaveBeenCalled();
    expect(w.slots.forModel(m.nodeId)[0]).toMatchObject({ phase: "drained", reuseHold: JSON.stringify(hold) });
    expect(w.sessionsOf(w1.nodeId).map((s) => s.status)).toEqual(["stopped"]);
  });

  it("If B disappears between selection and call, the slot ends `drained` with the hold `snapshot_not_found`, and that snapshot is never sent again.", async () => {
    const w = comebackWorld();
    const { m, w1, b } = await w.drainedAgent();
    const phaseChangedAt = w.slots.forModel(m.nodeId)[0]!.phaseChangedAt;
    w.hooks.beforeLaunch = (snapshotId) => { w.db.prepare("DELETE FROM snapshots WHERE id = ?").run(snapshotId); };
    await w.wantOne(m);

    const { notes, next, settled } = await comeBack(w, m.jobId);
    expect((notes.add as { comebacks: ComebackEntry[] }).comebacks[0]).toMatchObject({ slotNumber: 1, snapshotId: b, attempt: { status: "in_flight" } });
    expect(w.launch.mock.calls).toEqual([[m.rigId, "dev.impl-s1", { snapshotId: b }]]);
    expect(settled).toEqual([{
      slotNumber: 1, logicalId: "dev.impl-s1", nodeId: w1.nodeId,
      attempt: { id: expect.any(String), status: "refused", code: "snapshot_not_found", message: expect.any(String) },
    }]);
    expect(JSON.stringify(settled)).not.toContain("\"stop\"");
    const slot = w.slots.forModel(m.nodeId).find((s) => s.slotNumber === 1)!;
    expect(slot).toMatchObject({ nodeId: w1.nodeId, phase: "drained", attemptKind: "comeback", attemptState: "settled" });
    expect(JSON.parse(slot.reuseHold!)).toEqual({ code: "snapshot_not_found", snapshotId: b });
    expect((next.slots as Array<Record<string, unknown>>).find((s) => s.slotNumber === 1)).toMatchObject({
      phase: "drained", reuseHold: { code: "snapshot_not_found", snapshotId: b }, attempt: { status: "refused", code: "snapshot_not_found" },
    });
    // the refusal keeps the drain's time: the cooldown is not restarted, and the next number proceeds in the same cycle
    expect(slot.phaseChangedAt).toBe(phaseChangedAt);
    expect((next.add as { issued: Array<{ logicalId: string }> }).issued.map((i) => i.logicalId)).toEqual(["dev.impl-s2"]);
    expect(w.sessionsOf(w1.nodeId).map((s) => s.status)).toEqual(["stopped"]);

    for (let cycle = 0; cycle < 2; cycle++) {
      await w.notesOf(m.jobId);
      await w.executor.idle();
    }
    expect(w.launch).toHaveBeenCalledTimes(1);
    expect(w.select).toHaveBeenCalledTimes(1);
  });

  it("If B is corrupted between selection and call, the slot ends `drained` with the hold `snapshot_unusable`.", async () => {
    const w = comebackWorld();
    const { m, w1, b } = await w.drainedAgent();
    w.hooks.beforeLaunch = (snapshotId) => { w.db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run("{broken", snapshotId); };
    await w.wantOne(m);

    const { settled } = await comeBack(w, m.jobId);
    expect(w.launch.mock.calls).toEqual([[m.rigId, "dev.impl-s1", { snapshotId: b }]]);
    expect(settled).toEqual([expect.objectContaining({ slotNumber: 1, attempt: expect.objectContaining({ status: "refused", code: "snapshot_unusable" }) })]);
    expect(JSON.stringify(settled)).not.toContain("\"stop\"");
    const slot = w.slots.forModel(m.nodeId).find((s) => s.slotNumber === 1)!;
    expect(slot).toMatchObject({ nodeId: w1.nodeId, phase: "drained", attemptState: "settled" });
    expect(JSON.parse(slot.reuseHold!)).toEqual({ code: "snapshot_unusable", snapshotId: b });
    expect(w.sessionsOf(w1.nodeId).map((s) => s.status)).toEqual(["stopped"]);
  });
});

describe("seat-pool comeback: a launch not settled, and one never made (#3395 Piece 1)", () => {
  it("A comeback whose launch throws is not settled: the attempt stays issued with its outcome kept, reported in flight with the error's code, never as a refusal hold.", async () => {
    const w = comebackWorld();
    const { m, w1, b } = await w.drainedAgent();
    w.launch.mockRejectedValueOnce(Object.assign(new Error("the launch went away"), { code: "snapshot_not_found" }));
    await w.wantOne(m);

    const { settled } = await comeBack(w, m.jobId);
    expect(w.launch.mock.calls).toEqual([[m.rigId, "dev.impl-s1", { snapshotId: b }]]);
    expect(settled).toEqual([{
      slotNumber: 1, logicalId: "dev.impl-s1", nodeId: w1.nodeId,
      attempt: { id: expect.any(String), status: "in_flight", code: "snapshot_not_found", message: "the launch went away" },
    }]);
    const slot = w.slots.forModel(m.nodeId).find((s) => s.slotNumber === 1)!;
    expect(slot).toMatchObject({ nodeId: w1.nodeId, phase: "adding", attemptKind: "comeback", attemptState: "issued", reuseHold: null });
    expect(JSON.parse(slot.attemptOutcome!)).toEqual({ ok: false, code: "snapshot_not_found", message: "the launch went away", threw: true });
    expect(w.sessionsOf(w1.nodeId).map((s) => s.status)).toEqual(["stopped"]);
  });

  it("A comeback whose launch rejects with no error value keeps its outcome as `launch_failed` and stays issued, reported in flight.", async () => {
    const w = comebackWorld();
    const { m, w1 } = await w.drainedAgent();
    w.launch.mockRejectedValueOnce(null);
    await w.wantOne(m);

    const { settled } = await comeBack(w, m.jobId);
    expect(settled).toEqual([{
      slotNumber: 1, logicalId: "dev.impl-s1", nodeId: w1.nodeId,
      attempt: { id: expect.any(String), status: "in_flight", code: "launch_failed", message: expect.any(String) },
    }]);
    const slot = w.slots.forModel(m.nodeId).find((s) => s.slotNumber === 1)!;
    expect(slot).toMatchObject({ nodeId: w1.nodeId, phase: "adding", attemptKind: "comeback", attemptState: "issued", reuseHold: null });
    expect(JSON.parse(slot.attemptOutcome!)).toMatchObject({ ok: false, code: "launch_failed", threw: true });
  });

  it("A comeback whose slot row is removed while its launch is pending reports nothing for that attempt.", async () => {
    const w = comebackWorld();
    const { m, w1 } = await w.drainedAgent();
    // the DELETE stands in for the ON DELETE CASCADE of a node deleted by hand
    w.launch.mockImplementationOnce(async () => {
      w.db.prepare("DELETE FROM seat_pool_slots WHERE node_id = ?").run(w1.nodeId);
      return { ok: false, code: "rig_not_found", message: "gone" };
    });
    await w.wantOne(m);

    const { notes, settled } = await comeBack(w, m.jobId);
    const attemptId = (notes.add as { comebacks: ComebackEntry[] }).comebacks[0]!.attempt!.id;
    expect(w.launch).toHaveBeenCalledTimes(1);
    expect(settled.some((s) => s.slotNumber === 1 || s.attempt.id === attemptId)).toBe(false);
    expect(w.slots.forModel(m.nodeId).some((s) => s.nodeId === w1.nodeId)).toBe(false);
  });

  it("A comeback whose issue fails with an unexpected error leaves the slot `drained` on its own row and node, and the next cycle brings it back.", async () => {
    const w = comebackWorld();
    const { m, w1, b } = await w.drainedAgent();
    await w.wantOne(m);
    const issue = vi.spyOn(w.slots, "issueAttempt").mockImplementationOnce(() => { throw new Error("disk I/O error"); });
    const stored = w.jobsRepo.getByIdOrThrow(m.jobId);
    const context = (parseYaml(stored.specYaml) as { context: Record<string, unknown> }).context;

    await expect(w.executor.cycle({ jobId: m.jobId, context })).rejects.toThrow("disk I/O error");
    await w.executor.idle();
    expect(issue).toHaveBeenCalledTimes(1);
    expect(w.launch).not.toHaveBeenCalled();
    expect(w.slots.forModel(m.nodeId).map((s) => [s.slotNumber, s.nodeId, s.phase, s.reuseHold])).toEqual([[1, w1.nodeId, "drained", null]]);
    expect(w.nodesNamed("dev.impl-s1")).toEqual([w1.nodeId]);
    expect(w.sessionsOf(w1.nodeId).map((s) => s.status)).toEqual(["stopped"]);

    const { settled } = await comeBack(w, m.jobId);
    expect(w.launch.mock.calls).toEqual([[m.rigId, "dev.impl-s1", { snapshotId: b }]]);
    expect(settled).toEqual([expect.objectContaining({ slotNumber: 1, nodeId: w1.nodeId, attempt: expect.objectContaining({ status: "running" }) })]);
    expect(w.slots.forModel(m.nodeId).map((s) => [s.slotNumber, s.phase])).toEqual([[1, "live"]]);
  });

  it("A comeback whose issue fails with an unexpected error, and whose return to `drained` would fail too, leaves the slot as the drain left it, with no reserved attempt, and the next cycle brings it back.", async () => {
    const w = comebackWorld();
    const { m, w1, b } = await w.drainedAgent();
    await w.wantOne(m);
    const slotId = w.slots.forModel(m.nodeId)[0]!.slotId;
    const before = w.slots.get(slotId);
    const issue = vi.spyOn(w.slots, "issueAttempt").mockImplementationOnce(() => { throw new Error("disk I/O error"); });
    const back = vi.spyOn(w.slots, "returnComebackToDrained").mockImplementationOnce(() => { throw new Error("disk I/O error"); });
    const stored = w.jobsRepo.getByIdOrThrow(m.jobId);
    const context = (parseYaml(stored.specYaml) as { context: Record<string, unknown> }).context;

    await expect(w.executor.cycle({ jobId: m.jobId, context })).rejects.toThrow("disk I/O error");
    await w.executor.idle();
    expect(issue).toHaveBeenCalledTimes(1);
    expect(w.launch).not.toHaveBeenCalled();
    expect(w.slots.get(slotId)).toEqual(before);
    issue.mockRestore();
    back.mockRestore();

    const { settled } = await comeBack(w, m.jobId);
    expect(w.launch.mock.calls).toEqual([[m.rigId, "dev.impl-s1", { snapshotId: b }]]);
    expect(settled).toEqual([expect.objectContaining({ slotNumber: 1, nodeId: w1.nodeId, attempt: expect.objectContaining({ status: "running" }) })]);
    expect(w.slots.forModel(m.nodeId).map((s) => [s.slotNumber, s.phase])).toEqual([[1, "live"]]);
  });

  it("A comeback issued in a cycle whose job is stopped while an earlier comeback of that cycle launches is never launched, and its slot is `drained` again with no reuse hold.", async () => {
    const w = comebackWorld();
    const m = await w.model({ pool: { max: 3, min: 2 } });
    const [, s2] = await w.serve(m, 2);
    await w.drain(m, 2);
    await w.row(m.session);
    await w.row(m.session);
    w.afterCooldown();
    let stops = 0;
    w.hooks.beforeLaunch = () => { if (stops++ === 0) w.jobsRepo.stop(m.jobId); };

    // the executor is asked directly: the engine records no evaluation of a job stopped before it reports
    const stored = w.jobsRepo.getByIdOrThrow(m.jobId);
    const context = (parseYaml(stored.specYaml) as { context: Record<string, unknown> }).context;
    const notes = ((await w.executor.cycle({ jobId: m.jobId, context })) as { notes: Record<string, unknown> }).notes;
    expect((notes.add as { comebacks: ComebackEntry[] }).comebacks.map((c) => [c.slotNumber, c.attempt?.status])).toEqual([[1, "in_flight"], [2, "in_flight"]]);
    await w.executor.idle();
    expect(w.launch.mock.calls.map((call) => call[1])).toEqual(["dev.impl-s1"]);
    const second = w.slots.forModel(m.nodeId).find((s) => s.slotNumber === 2)!;
    expect(second).toMatchObject({ nodeId: s2!.nodeId, phase: "drained", attemptKind: "comeback", attemptState: "settled", reuseHold: null });
    expect(JSON.parse(second.attemptOutcome!)).toEqual({ ok: false, code: "held", message: "held: job stopped", launched: false });
    expect(w.sessionsOf(s2!.nodeId).map((s) => s.status)).toEqual(["stopped"]);
  });
});

describe("seat-pool comeback: the agent's own restore setting (#3395 Piece 1)", () => {
  it("A comeback of a slot with `resume_if_possible` and a usable token resumes through `launchSingleNode`.", async () => {
    const w = comebackWorld();
    const { m, w1, b } = await w.drainedAgent({ member: { restore_policy: "resume_if_possible" } });
    const token = (w.db.prepare("SELECT resume_token FROM sessions WHERE node_id = ?").get(w1.nodeId) as { resume_token: string | null }).resume_token;
    expect(token).toBeTruthy();
    const harnessBefore = w.harness.length;
    await w.wantOne(m);

    const launched: unknown[] = [];
    w.launch.mockImplementationOnce(async (rigId, logicalId, opts) => {
      const result = await w.restorer.launchSingleNode(rigId, logicalId, { snapshotId: opts.snapshotId, adapters: w.adapters, fsOps: { exists: (p) => fs.existsSync(p) } });
      launched.push(result);
      return result;
    });
    const { settled } = await comeBack(w, m.jobId);
    expect(launched).toEqual([expect.objectContaining({ ok: true, launched: [expect.objectContaining({ nodeId: w1.nodeId, status: "resumed" })] })]);
    expect(w.harness.slice(harnessBefore)).toEqual([expect.objectContaining({ session: `dev-impl-s1@${RIG}`, resumeToken: token })]);
    expect(settled[0]!.attempt).toMatchObject({ status: "running", snapshotSelection: { snapshotId: b, mode: "explicit" } });
    expect(JSON.stringify(settled)).not.toContain("\"stop\"");
    expect(w.slots.forModel(m.nodeId)[0]!.phase).toBe("live");
  });

  it("A comeback of a slot with `relaunch_fresh` starts fresh through `launchSingleNode`.", async () => {
    const w = comebackWorld();
    const { m, w1, b } = await w.drainedAgent({ member: { restore_policy: "relaunch_fresh" } });
    const harnessBefore = w.harness.length;
    await w.wantOne(m);

    const launched: unknown[] = [];
    w.launch.mockImplementationOnce(async (rigId, logicalId, opts) => {
      const result = await w.restorer.launchSingleNode(rigId, logicalId, { snapshotId: opts.snapshotId, adapters: w.adapters, fsOps: { exists: (p) => fs.existsSync(p) } });
      launched.push(result);
      return result;
    });
    const { settled } = await comeBack(w, m.jobId);
    expect(launched).toEqual([expect.objectContaining({ ok: true, launched: [expect.objectContaining({ nodeId: w1.nodeId, status: "fresh-primed" })] })]);
    expect(w.harness.slice(harnessBefore)).toEqual([expect.objectContaining({ session: `dev-impl-s1@${RIG}`, resumeToken: undefined })]);
    expect(settled[0]!.attempt).toMatchObject({ status: "running", snapshotSelection: { snapshotId: b, mode: "explicit" } });
    expect(JSON.stringify(settled)).not.toContain("\"stop\"");
    expect(w.slots.forModel(m.nodeId)[0]!.phase).toBe("live");
  });
});

describe("seat-pool comeback: the executor's own entry point (#3395 Piece 1)", () => {
  it("The cycle brings a drained slot back only through the executor's `comeback`: without it, the slot stays `drained` and no new number takes its place.", async () => {
    const w = comebackWorld();
    const { m } = await w.drainedAgent();
    const comeback = w.executor.comeback;
    Object.assign(w.executor, { comeback: undefined });
    await w.wantOne(m);
    const notes = await w.notesOf(m.jobId);
    await w.executor.idle();
    expect((notes.add as { comebacks: ComebackEntry[] }).comebacks).toEqual([expect.objectContaining({ slotNumber: 1, code: "comeback_not_composed" })]);
    expect(notes.add).not.toHaveProperty("issued");
    expect(w.launch).not.toHaveBeenCalled();
    expect(w.slots.forModel(m.nodeId).map((s) => s.phase)).toEqual(["drained"]);

    Object.assign(w.executor, { comeback });
    const { settled } = await comeBack(w, m.jobId);
    expect(settled).toEqual([expect.objectContaining({ slotNumber: 1, attempt: expect.objectContaining({ status: "running", snapshotSelection: expect.objectContaining({ mode: "explicit" }) }) })]);
    expect(w.launch).toHaveBeenCalledTimes(1);
  });
});
