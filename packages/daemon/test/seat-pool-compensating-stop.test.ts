import { describe, it, expect, vi, afterEach } from "vitest";
import type Database from "better-sqlite3";
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
  type SeatPoolAddDeps, type SeatPoolComebackLaunch, type SeatPoolExecutor, type SeatPoolExecutorDeps, type SeatPoolSeatStop,
} from "../src/domain/seat-pool-executor.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
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
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";

// #3395 (Piece 1): the compensating stop bound to the attempt (L15). An add or a comeback that settles running after a
// `rig down` newer than what it was issued on is stopped through the checked stop, with `expected` equal to the
// attempt's own session (`attempt_result`), and the result is reported in `stop.result`: `stopped`, `absent`,
// `changed_owner` or `unconfirmed`, never in `attempt.status`. The job is unarmed in the daemon, so each test composes
// the executor and an engine that has the seat-pool policy, over a real instantiator whose terminal and Claude are fakes
// and a real teardown over the same terminal (`rig down` waits for a launch's lifecycle lease and kills what it finds).
// The pool's checked stop is a fake that keeps the checked stop's contract: it stops the expected session only while it
// is the node's latest and present in the terminal, and returns `selection_changed` or `session_not_live` otherwise. A
// daemon restart is a new executor and engine (and a new delivery guard) over the same database.

const RIG = "pool-rig";
const AGENT_YAML = `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
/** Every seat's saved conversation: restore resumes it and finds it in the pane's process tree. */
const TOKEN = "00000000-0000-4000-8000-000000000088";

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

/** A few turns of the event loop, so a call that can go on does. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

type Stop = { cause: string; seq?: number; result: string; code?: string; message?: string };
type SlotNote = { slotNumber: number; nodeId: string | null; phase: string; attempt?: { id: string; status: string; code?: string; message?: string }; stop?: Stop; reuseHold?: Record<string, unknown> };
type StopInput = { seatRef: string; reason: string; expected?: { nodeId: string; sessionId: string }; recheck?: () => SeatPoolSeatStop | null };

function stopWorld() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seat-pool-compensating-stop-")));
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
  const checkpointStore = new CheckpointStore(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry: sessions, eventBus: bus, snapshotRepo, checkpointStore });
  const clock = { now: new Date(Date.now() + 3_600_000) };

  /** The terminal: one pane per live tmux session. A kill takes the pane away; a probe reads it. */
  const panes = new Map<string, number>();
  let nextPid = 100;
  const listProcesses = async (): Promise<NativeProcessRow[]> => [...panes].flatMap(([, pid]) => {
    const startedAt = "Sun Nov 22 12:00:00 2026";
    return [
      { pid, ppid: 1, pgid: pid, tpgid: pid + 1, executableName: "bash", command: "bash", startedAt },
      { pid: pid + 1, ppid: pid, pgid: pid + 1, tpgid: pid + 1, executableName: "claude", command: `claude --session-id ${TOKEN}`, startedAt },
    ];
  });
  const tmux = {
    startServer: vi.fn(async () => {}),
    createSession: vi.fn(async (session: string) => { panes.set(session, nextPid += 2); return { ok: true as const }; }),
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
  const launchHarness = vi.fn(async (_binding: NodeBinding): Promise<{ ok: true; resumeToken: string; resumeType: string } | { ok: false; error: string }> =>
    ({ ok: true as const, resumeToken: TOKEN, resumeType: "claude_id" }));
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
  const teardown = new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry: sessions, tmuxAdapter: tmux, snapshotCapture, eventBus: bus });

  /** `rig up` through the real restore orchestrator, on a terminal of its own where no session was alive before. */
  const upTmux = {
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
  const restorer = new RestoreOrchestrator({
    db, rigRepo, sessionRegistry: sessions, eventBus: bus, snapshotRepo, snapshotCapture, checkpointStore,
    nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry: sessions, eventBus: bus, tmuxAdapter: upTmux }),
    tmuxAdapter: upTmux,
    claudeResume: {
      canResume: vi.fn((type: string | null) => type === "claude_name" || type === "claude_id"),
      resume: vi.fn(async () => ({ ok: true as const })),
    } as unknown as ClaudeResumeAdapter,
    codexResume: { canResume: vi.fn(() => false), resume: vi.fn(async () => ({ ok: true as const })) } as unknown as CodexResumeAdapter,
    listProcesses: async () => [
      { pid: 1234, ppid: 1, pgid: 1234, tpgid: 1235, executableName: "bash", command: "-bash", startedAt: "Sat Jan  1 12:00:00 2000" },
      { pid: 1236, ppid: 1234, pgid: 1235, tpgid: 1235, executableName: "claude", command: `/opt/claude.exe --resume ${TOKEN}`, startedAt: "Sat Jan  1 12:00:00 2000" },
    ],
  });

  /** The add's call: the real converge path, with a hook before it and one after it, before the executor reads it. */
  const hooks: { beforeAdd?: () => Promise<void>; afterAdd?: (result: ConvergeResult) => Promise<void> | void } = {};
  const converge = vi.fn<SeatPoolAddDeps["converge"]>(async (rigId, op, rigRoot, opts): Promise<ConvergeResult> => {
    await hooks.beforeAdd?.();
    const result = await convergeOp({ instantiator: inst }, rigId, op, rigRoot, opts);
    await hooks.afterAdd?.(result);
    return result;
  });
  const sessionOf = (sessionId: string) => db.prepare("SELECT id, session_name AS name, status, intentionally_stopped AS onPurpose FROM sessions WHERE id = ?")
    .get(sessionId) as { id: string; name: string; status: string; onPurpose: number };
  const latestOf = (nodeId: string) => db.prepare("SELECT id, session_name AS name, status FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(nodeId) as { id: string; name: string; status: string } | undefined;
  /** The pool's checked stop. `before` runs first; `result` gives a scripted refusal in place of the kill. */
  const stopHooks: { before?: () => void; result?: () => SeatPoolSeatStop | undefined } = {};
  const stopSeat = vi.fn(async (input: StopInput): Promise<SeatPoolSeatStop> => {
    stopHooks.before?.();
    if (input.expected === undefined) return { ok: false, code: "invalid_stop_precondition", message: "no expected" };
    const latest = latestOf(input.expected.nodeId);
    if (latest?.id !== input.expected.sessionId) return { ok: false, code: "selection_changed", message: "The selected seat or latest session changed; review the stop precondition again." };
    if (!panes.has(latest.name)) return { ok: false, code: "session_not_live", message: `Session "${latest.name}" is absent in tmux; there is nothing to stop.` };
    const refused = input.recheck?.();
    if (refused) return refused;
    const scripted = stopHooks.result?.();
    if (scripted) return scripted;
    panes.delete(latest.name);
    db.prepare("UPDATE sessions SET status = 'exited', intentionally_stopped = 1 WHERE id = ?").run(latest.id);
    return { ok: true };
  });
  /** The comeback's effects, composed only where a test uses them. */
  const comeback: { select: ReturnType<typeof vi.fn>; launch: ReturnType<typeof vi.fn> } = {
    select: vi.fn(() => ({ chosen: { id: "snap-back" }, read: 1, failed: [] })),
    launch: vi.fn(async (): Promise<SeatPoolComebackLaunch> => ({ ok: false, code: "snapshot_not_found", message: "not composed" })),
  };

  /** One daemon process: its delivery guard (the terminal's too: launches and `rig down` take its lifecycle lease),
   *  executor and engine over the shared database. */
  const boot = (withComeback: boolean) => {
    const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
    tmux.deliveryGuard = guard;
    const deps: SeatPoolExecutorDeps = {
      db, rigRepo, slots, jobsRepo,
      queue: seatPoolQueueEffects(queue),
      heldCount: (id) => outbox.heldCount(id),
      confirmedStopped: (id) => nodeExecutorConfirmedStopped(db, id),
      seatState: () => null,
      custody: (ids, fn) => guard.custody(ids, fn),
      now: () => clock.now,
      drain: {
        lifecycle: (ids, fn) => guard.lifecycle(ids, fn),
        refresh: async () => {},
        capture: (rigId) => ({ snapshotId: snapshotCapture.captureSnapshot(rigId, "auto-rehydrate").id }),
        stopSeat,
      },
      add: { exportMember: (rigId, nodeId) => exporter.exportedRawMemberFromNode(rigId, nodeId), converge, makeFolder: vi.fn() },
      ...(withComeback ? { comeback: comeback as unknown as NonNullable<SeatPoolExecutorDeps["comeback"]> } : {}),
    };
    const executor = makeSeatPoolExecutor(deps);
    const engine = new WatchdogPolicyEngine({
      jobsRepo, historyLog: history, eventBus: bus, deliver: async () => ({ status: "ok" }),
      additionalPolicies: [makeSeatPoolPolicy({ cycle: (job) => executor.cycle(job) })],
    });
    return { deps, executor, engine };
  };
  let withComeback = false;
  let proc: { deps: SeatPoolExecutorDeps; executor: SeatPoolExecutor; engine: WatchdogPolicyEngine } = boot(withComeback);
  /** A daemon restart: a new process over the same database. */
  const restart = () => { proc = boot(withComeback); };
  const composeComeback = () => { withComeback = true; proc = boot(true); };
  const reg = { db, rigRepo, jobsRepo, warn: vi.fn() };

  type Model = { rigId: string; nodeId: string; jobId: string };
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
    return { rigId: up.result.rigId, nodeId: node.id, jobId: result.job.jobId };
  };
  const notesOf = async (jobId: string) =>
    ((await proc.engine.evaluate(jobsRepo.getByIdOrThrow(jobId))).outcome as { notes?: Record<string, unknown> }).notes ?? {};
  const slotsOf = (notes: Record<string, unknown>) => notes.slots as SlotNote[];
  const nodeOf = (rigId: string, logicalId: string) => rigRepo.getRig(rigId)!.nodes.find((n) => n.logicalId === logicalId);
  const events = (rigId: string, type: string) =>
    (db.prepare("SELECT seq FROM events WHERE rig_id = ? AND type = ? ORDER BY seq").all(rigId, type) as Array<{ seq: number }>).map((e) => e.seq);
  /** `rig down`, through the real teardown. */
  const down = async (rigId: string) => {
    const result = await teardown.teardown(rigId);
    expect(result.errors).toEqual([]);
    return result;
  };
  /** The slot's own `attempt_result`, as recorded. */
  const attemptResult = (modelNodeId: string) => JSON.parse(slots.forModel(modelNodeId)[0]!.attemptResult!) as Record<string, unknown>;
  /** The room the planner sees: `max` minus the slots that take room. */
  const room = (modelNodeId: string, max: number) => seatPoolRoom({ max }, readSeatPoolAgents(proc.deps, slots.forModel(modelNodeId)));
  /** Every call of the pool's checked stop carried `expected`, with a node and a session. */
  const everyStopExpected = () => stopSeat.mock.calls.every(([input]) =>
    typeof input.expected?.nodeId === "string" && input.expected.nodeId !== "" && typeof input.expected.sessionId === "string" && input.expected.sessionId !== "");
  /** `rig up` from the down's snapshot. */
  const up = (snapshotId: string) => restorer.restore(snapshotId, { adapters: { "claude-code": claude } });
  return {
    db, bus, rigRepo, slots, sessions, panes, tmux, hooks, stopHooks, converge, launchHarness, stopSeat, comeback,
    model, notesOf, slotsOf, nodeOf, events, down, up, restart, composeComeback, sessionOf, latestOf, attemptResult, room, everyStopExpected,
    deps: () => proc.deps, executor: () => proc.executor,
  };
}

/** An add issued, then held before it materializes its node, `rig down`, then the add let go: it settles running after
 *  the down. */
async function addSettlingAfterDown(w: ReturnType<typeof stopWorld>, m: { rigId: string; jobId: string }) {
  const gate = deferred();
  w.hooks.beforeAdd = () => gate.promise;
  const issued = await w.notesOf(m.jobId);
  const attemptId = (issued.add as { issued: Array<{ attempt: { id: string } }> }).issued[0]!.attempt.id;
  const result = await w.down(m.rigId);
  const seq = w.events(m.rigId, "rig.stopped").at(-1)!;
  gate.resolve();
  await w.executor().idle();
  return { attemptId, seq, snapshotId: result.snapshotId };
}

describe("seat-pool compensating stop bound to the attempt (#3395 Piece 1)", () => {
  it("An add held before its materialize, then `rig down`, then the add settling running: the pool's `stopSeat` carries `expected` equal to `attempt_result`, and the slot is `live`, stopped on purpose, reported as a successful stop that names the down.", async () => {
    const w = stopWorld();
    const m = await w.model({ max: 1, min: 1 });
    const { attemptId, seq } = await addSettlingAfterDown(w, m);
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;

    expect(w.stopSeat).toHaveBeenCalledTimes(1);
    const expected = w.attemptResult(m.nodeId);
    expect(w.stopSeat.mock.calls[0]![0].expected).toEqual(expected);
    expect(expected).toEqual({ nodeId: agent.id, sessionId: expect.any(String) });
    expect(w.sessionOf(expected.sessionId as string)).toMatchObject({ status: "exited", onPurpose: 1 });

    const notes = await w.notesOf(m.jobId);
    expect(notes.held).toEqual({ cause: "rig stopped", seq, message: `held: rig stopped (event ${seq})` });
    expect(notes.settled).toEqual([{
      slotNumber: 1, logicalId: "dev.impl-s1", nodeId: agent.id, attempt: { id: attemptId, status: "running" },
      stop: { cause: "rig_down", seq, result: "stopped" },
    }]);
    expect(w.slotsOf(notes)).toEqual([{
      slotNumber: 1, nodeId: agent.id, phase: "live", attempt: { id: attemptId, status: "running" },
      stop: { cause: "rig_down", seq, result: "stopped" },
    }]);
    expect(w.everyStopExpected()).toBe(true);
  });

  it("Variant with the node already created: the down waits for the launch's lease and kills the session first, the pool's stop gets `session_not_live`, and the slot stays `live`, its session stopped on purpose by the down, and is reported `absent`, not as a successful stop.", async () => {
    const w = stopWorld();
    const m = await w.model({ max: 1, min: 1 });
    // the add's launch is held after its node is created, under the launch's lifecycle lease
    const launching = deferred();
    const gate = deferred();
    w.launchHarness.mockImplementationOnce(async () => { launching.resolve(); await gate.promise; return { ok: true as const, resumeToken: "00000000-0000-4000-8000-000000000088", resumeType: "claude_id" }; });
    let downDone: Promise<unknown> | undefined;
    w.hooks.afterAdd = async () => { await downDone; };
    const issued = await w.notesOf(m.jobId);
    const attemptId = (issued.add as { issued: Array<{ attempt: { id: string } }> }).issued[0]!.attempt.id;
    await launching.promise;
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
    downDone = w.down(m.rigId);
    await settle();
    // the down waits for the launch's lease
    expect(w.events(m.rigId, "rig.stopped")).toEqual([]);
    gate.resolve();
    await downDone;
    await w.executor().idle();
    const seq = w.events(m.rigId, "rig.stopped").at(-1)!;

    const expected = w.attemptResult(m.nodeId);
    expect(expected).toEqual({ nodeId: agent.id, sessionId: expect.any(String) });
    expect(w.stopSeat).toHaveBeenCalledTimes(1);
    expect(w.stopSeat.mock.calls[0]![0].expected).toEqual(expected);
    expect(w.sessionOf(expected.sessionId as string)).toMatchObject({ status: "exited", onPurpose: 1 });
    const notes = await w.notesOf(m.jobId);
    const stop = { cause: "rig_down", seq, result: "absent", code: "session_not_live", message: expect.stringContaining("is absent in tmux") };
    expect(notes.settled).toEqual([{ slotNumber: 1, logicalId: "dev.impl-s1", nodeId: agent.id, attempt: { id: attemptId, status: "running" }, stop }]);
    expect(w.slotsOf(notes)).toEqual([{ slotNumber: 1, nodeId: agent.id, phase: "live", attempt: { id: attemptId, status: "running" }, stop }]);
    expect(w.everyStopExpected()).toBe(true);
  });

  it("A replacement between settle and stop gives `selection_changed`, the newer session keeps running, and the pool stops nothing.", async () => {
    const w = stopWorld();
    const m = await w.model({ max: 1, min: 1 });
    let newer: string | undefined;
    // someone relaunches the agent after the add settled and before the pool's stop
    w.stopHooks.before = () => {
      if (newer !== undefined) return;
      const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
      const session = w.sessions.registerSession(agent.id, "dev-impl-s1@pool-rig");
      w.sessions.updateStatus(session.id, "running");
      newer = session.id;
    };
    const { attemptId, seq } = await addSettlingAfterDown(w, m);
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;

    expect(w.stopSeat).toHaveBeenCalledTimes(1);
    const own = w.stopSeat.mock.calls[0]![0].expected!;
    expect(own).toEqual({ nodeId: agent.id, sessionId: expect.any(String) });
    expect(own.sessionId).not.toBe(newer);
    expect(w.latestOf(agent.id)).toMatchObject({ id: newer, status: "running" });
    expect(w.panes.has("dev-impl-s1@pool-rig")).toBe(true);
    const notes = await w.notesOf(m.jobId);
    expect(w.slotsOf(notes)).toEqual([{
      slotNumber: 1, nodeId: agent.id, phase: "live", attempt: { id: attemptId, status: "running" },
      stop: { cause: "rig_down", seq, result: "changed_owner", code: "selection_changed", message: expect.any(String) },
      reuseHold: { code: "changed_owner", seq },
    }]);
    // measured from the attempt's own session: the newer one is a later change, which the pool classifies by L13
    expect(w.attemptResult(m.nodeId)).toMatchObject({ held: true, nodeId: agent.id, sessionId: own.sessionId });
    expect(w.stopSeat).toHaveBeenCalledTimes(1);
    expect(w.everyStopExpected()).toBe(true);
  });

  it("A failed or uncertain compensating stop stays held and counted across a restart, reported with its real code and `message`.", async () => {
    const w = stopWorld();
    const m = await w.model({ max: 1, min: 1 });
    const uncertain = { ok: false as const, code: "stop_uncertain", message: "Checked stop did not complete: the kill was not confirmed.", partialEffect: true };
    w.stopHooks.result = () => uncertain;
    const { attemptId, seq } = await addSettlingAfterDown(w, m);
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
    const held = {
      slotNumber: 1, nodeId: agent.id, phase: "live", attempt: { id: attemptId, status: "running" },
      stop: { cause: "rig_down", seq, result: "unconfirmed", code: "stop_uncertain", message: uncertain.message },
      reuseHold: { code: "compensating_stop", seq },
    };
    expect(w.slotsOf(await w.notesOf(m.jobId))).toEqual([held]);

    w.restart();
    const after = await w.notesOf(m.jobId);
    expect(after.held).toMatchObject({ cause: "rig stopped", seq });
    expect(w.slotsOf(after)).toEqual([held]);
    await w.executor().idle();
    // read again after the restart, and still unconfirmed: held, and it takes the pool's only room
    expect(w.slotsOf(await w.notesOf(m.jobId))).toEqual([held]);
    expect(w.room(m.nodeId, 1)).toBe(0);
    expect(w.stopSeat.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(w.stopSeat.mock.calls.every(([input]) => input.expected?.sessionId === w.attemptResult(m.nodeId).sessionId)).toBe(true);
    expect(w.everyStopExpected()).toBe(true);
  });

  it("Control: `rig down` and a completed `rig up`, both before the add launches its session, make no `stopSeat` call.", async () => {
    const w = stopWorld();
    const m = await w.model({ max: 1, min: 1 });
    const gate = deferred();
    w.hooks.beforeAdd = () => gate.promise;
    const issued = await w.notesOf(m.jobId);
    const attemptId = (issued.add as { issued: Array<{ attempt: { id: string } }> }).issued[0]!.attempt.id;
    const result = await w.down(m.rigId);
    await w.up(result.snapshotId!);
    expect(w.events(m.rigId, "restore.completed").at(-1)!).toBeGreaterThan(w.events(m.rigId, "rig.stopped").at(-1)!);
    gate.resolve();
    await w.executor().idle();
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;

    expect(w.stopSeat).not.toHaveBeenCalled();
    const notes = await w.notesOf(m.jobId);
    expect(notes).not.toHaveProperty("held");
    expect(notes.settled).toEqual([{ slotNumber: 1, logicalId: "dev.impl-s1", nodeId: agent.id, attempt: { id: attemptId, status: "running" } }]);
    expect(w.slotsOf(notes)).toEqual([{ slotNumber: 1, nodeId: agent.id, phase: "live", attempt: { id: attemptId, status: "running" } }]);
    expect(JSON.stringify(notes)).not.toContain("\"stop\"");
  });

  it("An add issued before `rig down` whose result stays unknown leaves the slot `adding` and counted, and the pool makes no `stopSeat` call.", async () => {
    const w = stopWorld();
    const m = await w.model({ max: 1, min: 1 });
    // the add's session never reports its startup: its result can't be told
    w.hooks.afterAdd = () => {
      const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
      w.db.prepare("UPDATE sessions SET startup_status = 'pending' WHERE node_id = ?").run(agent.id);
    };
    const { attemptId, seq } = await addSettlingAfterDown(w, m);
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;

    expect(w.stopSeat).not.toHaveBeenCalled();
    const notes = await w.notesOf(m.jobId);
    expect(notes.held).toMatchObject({ cause: "rig stopped", seq });
    expect(w.slotsOf(notes)).toEqual([{
      slotNumber: 1, nodeId: agent.id, phase: "adding",
      attempt: { id: attemptId, status: "unknown", code: "not_settled", message: expect.stringContaining("startup pending") },
    }]);
    expect(w.room(m.nodeId, 1)).toBe(0);
    await w.executor().idle();
    expect(w.stopSeat).not.toHaveBeenCalled();
    expect(JSON.stringify(notes)).not.toContain("\"stop\"");
  });

  it("With no `attempt_result` (an `alreadyRunning` result, or a session that can't be told apart) the pool issues no compensating stop and classifies the slot by L13.", async () => {
    const w = stopWorld();
    const m = await w.model({ max: 1, min: 1 });
    await w.notesOf(m.jobId);
    await w.executor().idle();
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
    // the agent drained, then brought back by a comeback whose launch finds it already running, after `rig down`
    const slot = w.slots.forModel(m.nodeId)[0]!;
    expect(w.slots.setPhase({ slotId: slot.slotId, from: "live", to: "drained", at: new Date().toISOString() })).toBe(true);
    w.composeComeback();
    const launching = deferred();
    const gate = deferred<SeatPoolComebackLaunch>();
    w.comeback.launch.mockImplementationOnce(async () => { launching.resolve(); return gate.promise; });
    const issued = await w.notesOf(m.jobId);
    const comebackId = (issued.add as { comebacks: Array<{ attempt: { id: string } }> }).comebacks[0]!.attempt.id;
    await launching.promise;
    await w.down(m.rigId);
    gate.resolve({ ok: true, launched: [], alreadyRunning: [{ nodeId: agent.id, logicalId: "dev.impl-s1" }] });
    await w.executor().idle();

    expect(w.stopSeat).not.toHaveBeenCalled();
    expect(w.slots.forModel(m.nodeId)[0]!.attemptResult).toBeNull();
    const notes = await w.notesOf(m.jobId);
    expect(notes.settled).toEqual([{ slotNumber: 1, logicalId: "dev.impl-s1", nodeId: agent.id, attempt: { id: comebackId, status: "already_running" } }]);
    expect(w.slotsOf(notes)).toEqual([{ slotNumber: 1, nodeId: agent.id, phase: "live", attempt: { id: comebackId, status: "already_running" } }]);
    expect(JSON.stringify(notes)).not.toContain("\"stop\"");
  });

  it("A compensating stop that returned `stop_uncertain` is re-read on the next cycle; when tmux then confirms the session absent, the slot is reported `absent`, never `stopped`, and is no longer held.", async () => {
    const w = stopWorld();
    const m = await w.model({ max: 1, min: 1 });
    const uncertain = { ok: false as const, code: "stop_uncertain", message: "Checked stop did not complete: the kill was not confirmed.", partialEffect: true };
    let once = true;
    w.stopHooks.result = () => { if (!once) return undefined; once = false; return uncertain; };
    const { attemptId, seq } = await addSettlingAfterDown(w, m);
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
    expect(w.stopSeat).toHaveBeenCalledTimes(1);
    const slot = w.slots.forModel(m.nodeId)[0]!;
    expect(JSON.parse(slot.reuseHold!)).toEqual({ code: "compensating_stop", seq });
    expect(JSON.parse(slot.attemptOutcome!).stop).toMatchObject({ cause: "rig_down", seq, result: "unconfirmed", code: "stop_uncertain", message: uncertain.message });
    // the kill did take effect: tmux has no such session now, and the next cycle reads the stop again
    w.panes.delete("dev-impl-s1@pool-rig");
    const reread = await w.notesOf(m.jobId);
    expect(w.slotsOf(reread)[0]).toMatchObject({
      phase: "live", stop: { cause: "rig_down", seq, result: "unconfirmed", code: "stop_uncertain", message: uncertain.message },
      reuseHold: { code: "compensating_stop", seq },
    });
    await w.executor().idle();
    const notes = await w.notesOf(m.jobId);
    expect(w.stopSeat).toHaveBeenCalledTimes(2);
    expect(w.slotsOf(notes)).toEqual([{
      slotNumber: 1, nodeId: agent.id, phase: "live", attempt: { id: attemptId, status: "running" },
      stop: { cause: "rig_down", seq, result: "absent", code: "session_not_live", message: expect.stringContaining("is absent in tmux") },
    }]);
    expect(JSON.stringify(notes)).not.toContain("\"result\":\"stopped\"");
    expect(w.everyStopExpected()).toBe(true);
  });

  it("A compensating stop refused with `selection_changed` while the attempt's own session is still the node's latest is no change of owner: it stays `unconfirmed` and held with its real code and message, and the next cycle stops that session again.", async () => {
    const w = stopWorld();
    const m = await w.model({ max: 1, min: 1 });
    const refusal = { ok: false as const, code: "selection_changed", message: "The selected seat changed." };
    let once = true;
    w.stopHooks.result = () => { if (!once) return undefined; once = false; return refusal; };
    const { attemptId, seq } = await addSettlingAfterDown(w, m);
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
    const own = w.attemptResult(m.nodeId);
    expect(w.latestOf(agent.id)?.id).toBe(own.sessionId);
    const slot = w.slots.forModel(m.nodeId)[0]!;
    expect(JSON.parse(slot.reuseHold!)).toEqual({ code: "compensating_stop", seq });
    expect(JSON.parse(slot.attemptOutcome!).stop).toMatchObject({ cause: "rig_down", seq, result: "unconfirmed", code: "selection_changed", message: refusal.message });

    // the next cycle stops the attempt's own session again
    await w.notesOf(m.jobId);
    await w.executor().idle();
    expect(w.stopSeat).toHaveBeenCalledTimes(2);
    expect(w.stopSeat.mock.calls[1]![0].expected).toEqual(own);
    expect(w.sessionOf(own.sessionId as string)).toMatchObject({ status: "exited", onPurpose: 1 });
    expect(w.slotsOf(await w.notesOf(m.jobId))).toEqual([{
      slotNumber: 1, nodeId: agent.id, phase: "live", attempt: { id: attemptId, status: "running" },
      stop: { cause: "rig_down", seq, result: "stopped" },
    }]);
    expect(w.everyStopExpected()).toBe(true);
  });

  it("An unconfirmed compensating stop followed by a `rig up` that completes stops nothing more: the next cycle makes no `stopSeat` call, and the slot is `live` with no hold and no `stop`.", async () => {
    const w = stopWorld();
    const m = await w.model({ max: 1, min: 1 });
    const uncertain = { ok: false as const, code: "stop_uncertain", message: "Checked stop did not complete: the kill was not confirmed.", partialEffect: true };
    w.stopHooks.result = () => uncertain;
    const { attemptId, seq, snapshotId } = await addSettlingAfterDown(w, m);
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
    expect(w.stopSeat).toHaveBeenCalledTimes(1);
    expect(JSON.parse(w.slots.forModel(m.nodeId)[0]!.reuseHold!)).toEqual({ code: "compensating_stop", seq });

    await w.up(snapshotId!);
    expect(w.events(m.rigId, "restore.completed").at(-1)!).toBeGreaterThan(seq);
    await w.notesOf(m.jobId);
    await w.executor().idle();
    const notes = await w.notesOf(m.jobId);
    expect(w.stopSeat).toHaveBeenCalledTimes(1);
    expect(notes).not.toHaveProperty("held");
    expect(w.slotsOf(notes)).toEqual([{ slotNumber: 1, nodeId: agent.id, phase: "live", attempt: { id: attemptId, status: "running" } }]);
    expect(w.everyStopExpected()).toBe(true);
  });

  it("A `restore.completed` recorded while the compensating stop runs is seen at the stop's final step: nothing is stopped, the agent keeps running, and the slot is `live` with no hold and no `stop`.", async () => {
    const w = stopWorld();
    const m = await w.model({ max: 1, min: 1 });
    let rigId: string | undefined;
    w.stopHooks.before = () => {
      w.bus.emit({ type: "restore.completed", rigId: rigId!, snapshotId: "snap-up", result: { rigResult: "fully_restored", nodes: [] } } as unknown as Parameters<typeof w.bus.emit>[0]);
    };
    rigId = m.rigId;
    const { attemptId } = await addSettlingAfterDown(w, m);
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
    const own = w.attemptResult(m.nodeId);

    expect(w.stopSeat).toHaveBeenCalledTimes(1);
    expect(w.stopSeat.mock.calls[0]![0].expected).toEqual(own);
    expect(w.latestOf(agent.id)).toMatchObject({ id: own.sessionId, status: "running" });
    expect(w.panes.has("dev-impl-s1@pool-rig")).toBe(true);
    const notes = await w.notesOf(m.jobId);
    expect(notes.settled).toEqual([{ slotNumber: 1, logicalId: "dev.impl-s1", nodeId: agent.id, attempt: { id: attemptId, status: "running" } }]);
    expect(w.slotsOf(notes)).toEqual([{ slotNumber: 1, nodeId: agent.id, phase: "live", attempt: { id: attemptId, status: "running" } }]);
    expect(w.everyStopExpected()).toBe(true);
  });

  it("A comeback whose launch, held while `rig down` runs, settles running on its node is stopped through `stopSeat` with `expected` equal to its `attempt_result`, reported as a successful stop that names the down.", async () => {
    const w = stopWorld();
    const m = await w.model({ max: 1, min: 1 });
    await w.notesOf(m.jobId);
    await w.executor().idle();
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
    const slot = w.slots.forModel(m.nodeId)[0]!;
    expect(w.slots.setPhase({ slotId: slot.slotId, from: "live", to: "drained", at: new Date().toISOString() })).toBe(true);
    w.composeComeback();
    const launching = deferred();
    const gate = deferred();
    let launchedSession: string | undefined;
    w.comeback.launch.mockImplementationOnce(async (): Promise<SeatPoolComebackLaunch> => {
      launching.resolve();
      await gate.promise;
      // the launch starts the agent's session after the down
      const session = w.sessions.registerSession(agent.id, "dev-impl-s1@pool-rig");
      w.sessions.updateStatus(session.id, "running");
      w.panes.set("dev-impl-s1@pool-rig", 900);
      launchedSession = session.id;
      return { ok: true, launched: [{ nodeId: agent.id, logicalId: "dev.impl-s1", status: "launched" }] };
    });
    const issued = await w.notesOf(m.jobId);
    const comebackId = (issued.add as { comebacks: Array<{ attempt: { id: string } }> }).comebacks[0]!.attempt.id;
    await launching.promise;
    await w.down(m.rigId);
    const seq = w.events(m.rigId, "rig.stopped").at(-1)!;
    gate.resolve();
    await w.executor().idle();

    expect(w.attemptResult(m.nodeId)).toEqual({ nodeId: agent.id, sessionId: launchedSession });
    expect(w.stopSeat).toHaveBeenCalledTimes(1);
    expect(w.stopSeat.mock.calls[0]![0].expected).toEqual(w.attemptResult(m.nodeId));
    expect(w.sessionOf(launchedSession!)).toMatchObject({ status: "exited", onPurpose: 1 });
    const notes = await w.notesOf(m.jobId);
    const stop = { cause: "rig_down", seq, result: "stopped" };
    expect(notes.settled).toEqual([{ slotNumber: 1, logicalId: "dev.impl-s1", nodeId: agent.id, attempt: { id: comebackId, status: "running" }, stop }]);
    expect(w.slotsOf(notes)).toEqual([{ slotNumber: 1, nodeId: agent.id, phase: "live", attempt: { id: comebackId, status: "running" }, stop }]);
    expect(w.everyStopExpected()).toBe(true);
  });
});
