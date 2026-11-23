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
import { makeSeatPoolPolicy } from "../src/domain/policies/seat-pool.js";
import { reconcileSeatPoolNode, type SeatPoolReconcileResult } from "../src/domain/seat-pool-registration.js";
import {
  makeSeatPoolExecutor, readSeatPoolAgents, seatPoolQueueEffects, type SeatPoolAddDeps, type SeatPoolExecutorDeps,
} from "../src/domain/seat-pool-executor.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { convergeOp, type ConvergeResult } from "../src/domain/topology-converge.js";
import { readClaudeAutoModeForLaunch } from "../src/domain/claude-auto-mode.js";
import { readClaudePermissionRules } from "../src/domain/claude-permission-rules.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ArbitratedSeatState } from "../src/domain/activity-taxonomy.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";

// #3395 (Piece 1): the seat pool's add. A cycle that plans an add reserves a new `<member>-s<n>` slot, issues it under
// the model's custody lease with an operation id, and adds the member through the same converge path as `rig add`,
// from the model member as the export writes it. The job is unarmed in the daemon, so each test composes the executor
// and an engine that has the seat-pool policy, over a real instantiator whose terminal and Claude are fakes that record
// what each launch was given.

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

function idleState(nodeId: string): ArbitratedSeatState {
  return {
    seatNodeId: nodeId, activity: "idle-at-prompt", needsInput: { count: 0, reason: null }, needsInputEvidence: null,
    backgroundWork: null, decidedBy: null, seq: 1, changedAt: IDLE_SINCE, rungs: [], lastSwap: null,
  } as unknown as ArbitratedSeatState;
}

/** One launch as the fakes saw it: the terminal's session, folder and environment, and what Claude was given. */
interface Launch { session: string; cwd: string | undefined; env: Record<string, string>; binding?: NodeBinding }

function addWorld(opts: { agentYaml?: string } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seat-pool-add-")));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "agents", "impl"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "impl", "agent.yaml"), opts.agentYaml ?? AGENT_YAML);
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
  const clock = { now: new Date(Date.now() + 3_600_000) };

  const launches: Launch[] = [];
  // Each session's pane and, once Claude is launched in it, the conversation it runs: what the startup observation reads.
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
    createSession: vi.fn(async (session: string, cwd: string | undefined, env: Record<string, string>) => {
      launches.push({ session, cwd, env: { ...env } });
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
  const claude: RuntimeAdapter = {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async (binding: NodeBinding) => {
      const launch = [...launches].reverse().find((l) => l.session === binding.tmuxSession);
      if (launch) launch.binding = binding;
      const token = randomUUID();
      conversations.set(binding.tmuxSession!, token);
      return { ok: true as const, resumeToken: token, resumeType: "claude_id" };
    }),
  } as unknown as RuntimeAdapter;
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry: sessions, eventBus: bus, tmuxAdapter: tmux });
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry: sessions, eventBus: bus, tmuxAdapter: tmux, listProcesses, sleep: async () => {} });
  const inst = new PodRigInstantiator({
    db, rigRepo, podRepo, sessionRegistry: sessions, eventBus: bus, nodeLauncher, startupOrchestrator,
    fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: (p: string) => fs.existsSync(p) },
    adapters: { "claude-code": claude }, tmuxAdapter: tmux,
  } as unknown as ConstructorParameters<typeof PodRigInstantiator>[0]);
  const exporter = new RigSpecExporter({ rigRepo, sessionRegistry: sessions, podRepo });

  /** The add's call: the real converge path unless a test holds or replaces it. */
  const hooks: { beforeAdd?: () => Promise<void> } = {};
  const converge = vi.fn<SeatPoolAddDeps["converge"]>(async (rigId, op, rigRoot, opts): Promise<ConvergeResult> => {
    await hooks.beforeAdd?.();
    return convergeOp({ instantiator: inst }, rigId, op, rigRoot, opts);
  });
  const makeFolder = vi.fn((folder: string) => { fs.mkdirSync(folder, { recursive: true }); });
  const deps: SeatPoolExecutorDeps = {
    db, rigRepo, slots, jobsRepo,
    queue: seatPoolQueueEffects(queue),
    heldCount: (id) => outbox.heldCount(id),
    confirmedStopped: (id) => nodeExecutorConfirmedStopped(db, id),
    seatState: (id) => activity.get(id) ?? null,
    custody: (ids, fn) => guard.custody(ids, fn),
    now: () => clock.now,
    add: { exportMember: (rigId, nodeId) => exporter.exportedRawMemberFromNode(rigId, nodeId), converge, makeFolder },
  };
  const executor = makeSeatPoolExecutor(deps);
  const engine = new WatchdogPolicyEngine({
    jobsRepo, historyLog: history, eventBus: bus, deliver: async () => ({ status: "ok" }),
    additionalPolicies: [makeSeatPoolPolicy({ cycle: (job) => executor.cycle(job) })],
  });
  const reg = { db, rigRepo, jobsRepo, warn: vi.fn() };

  type Model = { rigId: string; nodeId: string; logicalId: string; session: string };
  /** The model member, materialized and launched through the instantiator, with its job. */
  const model = async (opts: { member?: Record<string, unknown>; pool?: Record<string, unknown> } = {}) => {
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
    expect(up.result.nodes.map((n) => n.status), JSON.stringify(up.result.nodes)).toEqual(["launched"]);
    const node = rigRepo.getRig(up.result.rigId)!.nodes.find((n) => n.logicalId === "dev.impl")!;
    const m: Model = { rigId: up.result.rigId, nodeId: node.id, logicalId: node.logicalId, session: `dev-impl@${RIG}` };
    const result: SeatPoolReconcileResult = reconcileSeatPoolNode(reg, m.nodeId);
    if (!("job" in result)) throw new Error(`no job: ${JSON.stringify(result)}`);
    return { ...m, jobId: result.job.jobId };
  };
  /** One evaluation through the engine; its notes. */
  const notesOf = async (jobId: string) =>
    (((await engine.evaluate(jobsRepo.getByIdOrThrow(jobId))).outcome) as { notes?: Record<string, unknown> }).notes ?? {};
  const correlations = () => (db.prepare("SELECT operation_id, rig_id, node_ids_json FROM operation_correlations").all() as
    Array<{ operation_id: string; rig_id: string | null; node_ids_json: string }>);
  const nodeOf = (rigId: string, logicalId: string) => rigRepo.getRig(rigId)!.nodes.find((n) => n.logicalId === logicalId);
  const launchOf = (session: string) => [...launches].reverse().find((l) => l.session === session);
  return {
    root, modelCwd, db, bus, rigRepo, podRepo, slots, sessions, queue, jobsRepo, history, activity, clock, inst, exporter,
    converge, makeFolder, hooks, deps, executor, engine, launches, model, notesOf, correlations, nodeOf, launchOf,
  };
}

/** The launch settings a launch was handed, apart from the seat's own identity. */
const LAUNCH_FLAGS = ["claudeMcp", "claudeAutoMode", "claudePermissions", "launchWrapper", "launchPosture", "permissionMode", "model", "effort"] as const;
const flagsOf = (binding: NodeBinding | undefined) =>
  Object.fromEntries(LAUNCH_FLAGS.map((key) => [key, binding?.[key]]));

describe("seat-pool add: a new agent from the model member (#3395 Piece 1)", () => {
  it("A model with `claude_mcp: none`, `claude_auto_mode`, `process_limits`, permissions, `env`, a launch wrapper and `restore_policy` gives a new pool agent the same stored values and the same launch flags.", async () => {
    const w = addWorld();
    const member = {
      claude_mcp: "none",
      claude_auto_mode: { environment: ["$defaults", "Source control: github.com/acme"], soft_deny: ["$defaults", "Never run migrations by hand"] },
      process_limits: { tasks_max: 512 },
      claude_permissions: { allow: ["Bash(node lane.mjs *)"], deny: ["Read(./private/**)"] },
      env: { POOL_FLAVOR: "mint" },
      launch_wrapper: ["/usr/bin/env", "POOL_WRAPPED=1"],
      restore_policy: "checkpoint_only",
      statusline_throttle: 30,
    };
    const m = await w.model({ member });
    const modelLaunch = w.launchOf(m.session)!;
    expect(modelLaunch.binding).toBeDefined();

    const first = await w.notesOf(m.jobId);
    expect(first.add).toMatchObject({ issued: [{ slotNumber: 1, logicalId: "dev.impl-s1", attempt: { status: "in_flight" } }] });
    await w.executor.idle();

    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
    const modelNode = w.nodeOf(m.rigId, "dev.impl")!;
    expect(agent).toBeDefined();
    // the same stored values
    expect(agent.claudeMcp).toBe("none");
    expect(readClaudeAutoModeForLaunch(w.db, agent.id)).toEqual(readClaudeAutoModeForLaunch(w.db, modelNode.id));
    expect(readClaudeAutoModeForLaunch(w.db, agent.id)).toEqual(member.claude_auto_mode);
    expect(agent.processLimits).toEqual(modelNode.processLimits);
    expect(agent.processLimits).toEqual({ tasksMax: 512 });
    expect(readClaudePermissionRules(w.db, agent.id)).toEqual(readClaudePermissionRules(w.db, modelNode.id));
    expect(readClaudePermissionRules(w.db, agent.id)).toEqual(member.claude_permissions);
    expect(agent.env).toEqual(modelNode.env);
    expect(agent.launchWrapper).toEqual(modelNode.launchWrapper);
    expect(agent.launchWrapper).toEqual(member.launch_wrapper);
    expect(agent.restorePolicy).toBe("checkpoint_only");
    expect(agent.statuslineThrottle).toBe(30);
    expect(agent.statuslineThrottle).toBe(modelNode.statuslineThrottle);
    expect(agent.cwd).toBe(modelNode.cwd);
    // the same launch flags
    const agentLaunch = w.launchOf(`dev-impl-s1@${RIG}`)!;
    expect(agentLaunch.binding).toBeDefined();
    expect(flagsOf(agentLaunch.binding)).toEqual(flagsOf(modelLaunch.binding));
    expect(agentLaunch.binding!.claudeMcp).toBe("none");
    expect(agentLaunch.binding!.launchWrapper).toEqual(member.launch_wrapper);
    expect(agentLaunch.env).toMatchObject({ POOL_FLAVOR: "mint" });
    expect(agentLaunch.env["POOL_FLAVOR"]).toBe(modelLaunch.env["POOL_FLAVOR"]);
    expect(agentLaunch.cwd).toBe(modelLaunch.cwd);
    // the add went through the converge path with the model's launch root and the operation's recordCreated
    expect(w.converge).toHaveBeenCalledTimes(1);
    const [rigId, op, rigRoot, opts] = w.converge.mock.calls[0]!;
    expect(rigId).toBe(m.rigId);
    expect(op).toMatchObject({ kind: "add_member", pod: "dev", member: { id: "impl-s1", statusline_throttle: 30, claude_mcp: "none" } });
    expect(rigRoot).toBe(w.root);
    expect(opts).toEqual(expect.objectContaining({ recordCreated: expect.any(Function), launchAdditionsFrom: expect.any(Object) }));
  });

  it("A new pool agent has no `pool` block and no `session_source`.", async () => {
    const w = addWorld();
    const m = await w.model({ member: { label: "Implementer", session_source: { mode: "fork", ref: { kind: "native_id", value: "00000000-0000-4000-8000-000000000001" } } } });
    expect(w.nodeOf(m.rigId, "dev.impl")!.sessionSource).toBeDefined();
    await w.notesOf(m.jobId);
    await w.executor.idle();

    const member = w.converge.mock.calls[0]![1].member;
    for (const key of ["pool", "session_source", "label"]) expect(member).not.toHaveProperty(key);
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
    expect(agent).toBeDefined();
    expect(w.rigRepo.getNodePool(agent.id)).toBeUndefined();
    expect(agent.sessionSource ?? null).toBeNull();
    expect(w.exporter.exportedRawMemberFromNode(m.rigId, agent.id)).not.toHaveProperty("pool");
    expect(w.exporter.exportedRawMemberFromNode(m.rigId, agent.id)).not.toHaveProperty("session_source");
  });

  it("A new pool agent is never kept alive, even when the model's agent spec turns keep-alive on by default.", async () => {
    const w = addWorld({ agentYaml: `name: impl\nversion: "1.0.0"\ndefaults:\n  lifecycle:\n    keep_alive: true\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []` });
    const m = await w.model();
    // the model itself takes the agent spec's default
    expect(w.nodeOf(m.rigId, "dev.impl")!.keepAlive).toBe(true);
    await w.notesOf(m.jobId);
    await w.executor.idle();

    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
    expect(agent).toBeDefined();
    expect(agent.keepAlive ?? false).toBe(false);
    expect(w.converge.mock.calls[0]![1].member).toMatchObject({ keep_alive: false });
    expect(w.slots.forModel(m.nodeId)[0]).toMatchObject({ nodeId: agent.id, phase: "live" });
  });
});

describe("seat-pool add: a model whose settings a new agent can't take (#3395 Piece 1)", () => {
  const refusals: Array<[string, (db: Database.Database, nodeId: string) => void, string]> = [
    [
      "A model whose stored `process_limits` can't be read makes the pool add no agent and record why in the job history.",
      (db, id) => { db.prepare("UPDATE nodes SET process_limits = '{' WHERE id = ?").run(id); },
      "add refused: the model's stored process_limits can't be read (",
    ],
    [
      "A model whose stored `claude_auto_mode` can't be read also makes the pool add no agent and record why.",
      (db, id) => { db.prepare("UPDATE nodes SET claude_auto_mode_json = 'broken' WHERE id = ?").run(id); },
      "add refused: the model's stored claude_auto_mode can't be read",
    ],
    [
      "A model with an `accountHome` makes the pool add no agent and record why.",
      (db, id) => { db.prepare("UPDATE nodes SET account_home = '/accounts/second' WHERE id = ?").run(id); },
      "add refused: the model has an accountHome, which a pool agent does not carry",
    ],
    [
      "A model with an `api-key` token ref makes the pool add no agent and record why.",
      (db, id) => {
        db.prepare("UPDATE nodes SET claude_token_ref = ? WHERE id = ?")
          .run(JSON.stringify({ label: "team-key", tokenFile: "/keys/team", kind: "api-key" }), id);
      },
      "add refused: the model has an api-key token ref, which a pool agent does not carry",
    ],
  ];

  it.each(refusals)("%s", async (_title, spoil, why) => {
    const w = addWorld();
    const m = await w.model();
    spoil(w.db, m.nodeId);
    const before = w.correlations();

    const notes = await w.notesOf(m.jobId);
    await w.executor.idle();
    expect((notes.add as { refused: string }).refused.startsWith(why), JSON.stringify(notes.add)).toBe(true);
    expect(notes).not.toHaveProperty("held");
    expect(w.converge).not.toHaveBeenCalled();
    expect(w.slots.forModel(m.nodeId)).toEqual([]);
    expect(w.correlations()).toEqual(before);
    expect(w.nodeOf(m.rigId, "dev.impl-s1")).toBeUndefined();
    // recorded in the job's history
    const recorded = w.history.listForJob(m.jobId)[0]?.evaluationNotes as Record<string, unknown> | undefined;
    expect((recorded?.add as { refused?: string } | undefined)?.refused).toBe((notes.add as { refused: string }).refused);
  });

  it("A model member the export can't write makes the pool add no agent and record why.", async () => {
    const w = addWorld();
    const m = await w.model();
    w.db.prepare("UPDATE nodes SET claude_permissions_json = 'broken' WHERE id = ?").run(m.nodeId);

    const notes = await w.notesOf(m.jobId);
    expect((notes.add as { refused: string }).refused).toMatch(/^add refused: the model member can't be exported \(/);
    expect(w.converge).not.toHaveBeenCalled();
    expect(w.slots.forModel(m.nodeId)).toEqual([]);
    expect(w.correlations()).toEqual([]);
  });
});

describe("seat-pool add: names, folders and what an add reports (#3395 Piece 1)", () => {
  it("Without `cwd_template` a new pool agent works in the model's folder; with it, `{rig}` and `{slot}` are filled in and the daemon only creates the folder.", async () => {
    const without = addWorld();
    const m = await without.model();
    await without.notesOf(m.jobId);
    await without.executor.idle();
    expect(without.nodeOf(m.rigId, "dev.impl-s1")!.cwd).toBe(without.modelCwd);
    expect(without.makeFolder).not.toHaveBeenCalled();

    const w = addWorld();
    const template = path.join(w.root, "slots", "{rig}", "{slot}");
    const t = await w.model({ pool: { max: 3, min: 1, cwd_template: template } });
    const folder = path.join(w.root, "slots", RIG, "impl-s1");
    expect(fs.existsSync(folder)).toBe(false);
    await w.notesOf(t.jobId);
    await w.executor.idle();
    expect(w.makeFolder.mock.calls).toEqual([[folder]]);
    expect(fs.readdirSync(folder)).toEqual([]);
    expect(w.converge.mock.calls[0]![1].member).toMatchObject({ id: "impl-s1", cwd: folder });
    expect(w.nodeOf(t.rigId, "dev.impl-s1")!.cwd).toBe(folder);
    expect(w.launchOf(`dev-impl-s1@${RIG}`)!.cwd).toBe(folder);
  });

  it("An add that ends with no node removes its slot row and frees its number, and a new number skips a logical id the rig already has.", async () => {
    const w = addWorld();
    const m = await w.model();
    // the agent spec is gone when the add runs: the preflight refuses it before any node is created
    const agentFile = path.join(w.root, "agents", "impl", "agent.yaml");
    fs.rmSync(agentFile);

    const first = await w.notesOf(m.jobId);
    const issued = (first.add as { issued: Array<{ attempt: { id: string } }> }).issued;
    expect(issued).toHaveLength(1);
    await w.executor.idle();
    expect(w.slots.forModel(m.nodeId)).toEqual([]);
    expect(w.nodeOf(m.rigId, "dev.impl-s1")).toBeUndefined();
    expect(w.slots.nextSlot(m.nodeId)).toEqual({ slotNumber: 1, logicalId: "dev.impl-s1" });

    fs.writeFileSync(agentFile, AGENT_YAML);
    // a member that already has the next name: the next add skips it
    const taken = w.rigRepo.addNode(m.rigId, "dev.impl-s1", { runtime: "claude-code", podId: w.nodeOf(m.rigId, "dev.impl")!.podId!, cwd: w.modelCwd });
    const second = await w.notesOf(m.jobId);
    expect(second.settled).toEqual([{
      slotNumber: 1, logicalId: "dev.impl-s1",
      attempt: { id: issued[0]!.attempt.id, status: "no_node", code: "preflight_failed", message: expect.any(String) },
    }]);
    expect(JSON.stringify(second)).not.toContain("\"stop\"");
    expect(second.add).toMatchObject({ issued: [{ slotNumber: 2, logicalId: "dev.impl-s2" }] });
    await w.executor.idle();
    expect(w.slots.forModel(m.nodeId).map((s) => [s.slotNumber, s.phase])).toEqual([[2, "live"]]);
    expect(w.nodeOf(m.rigId, "dev.impl-s1")!.id).toBe(taken.id);
    expect(w.nodeOf(m.rigId, "dev.impl-s2")).toBeDefined();
  });

  it("While a slot is `drained`, the pool adds no new number and reports `held: drained slot awaiting comeback`.", async () => {
    const w = addWorld();
    const m = await w.model();
    const drained = w.rigRepo.addNode(m.rigId, "dev.impl-s1", { runtime: "claude-code", podId: w.nodeOf(m.rigId, "dev.impl")!.podId!, cwd: w.modelCwd });
    w.slots.insert({ modelNodeId: m.nodeId, slotNumber: 1, nodeId: drained.id, phase: "drained", at: IDLE_SINCE });
    const before = w.slots.forModel(m.nodeId);

    const notes = await w.notesOf(m.jobId);
    await w.executor.idle();
    expect(notes.add).toEqual({ held: "held: drained slot awaiting comeback" });
    expect(notes).not.toHaveProperty("held");
    expect(w.converge).not.toHaveBeenCalled();
    expect(w.slots.forModel(m.nodeId)).toEqual(before);
    expect(w.correlations()).toEqual([]);
  });

  it("An add that settles with its agent running is reported `running`, and while it is issued it is reported `in_flight` and never issued again.", async () => {
    const w = addWorld();
    const m = await w.model();
    const gate = deferred();
    w.hooks.beforeAdd = () => gate.promise;

    const first = await w.notesOf(m.jobId);
    const attemptId = (first.add as { issued: Array<{ attempt: { id: string } }> }).issued[0]!.attempt.id;
    expect(first.add).toEqual({
      issued: [{ slotNumber: 1, logicalId: "dev.impl-s1", attempt: { id: attemptId, status: "in_flight", message: `in flight (attempt ${attemptId})` } }],
    });
    const [slot] = w.slots.forModel(m.nodeId);
    expect(slot).toMatchObject({ slotNumber: 1, nodeId: null, phase: "adding", attemptId, attemptKind: "add", attemptState: "issued" });
    expect(JSON.parse(slot!.attemptBasis!)).toEqual({
      eventSeq: expect.any(Number), targets: [m.rigId, "dev"], body: JSON.stringify({ member: w.converge.mock.calls[0]![1].member, rigRoot: w.root }),
    });
    expect(w.correlations()).toEqual([{ operation_id: attemptId, rig_id: null, node_ids_json: "[]" }]);

    // while the add is issued: in flight, and no second add
    const during = await w.notesOf(m.jobId);
    expect(during.slots).toEqual([{ slotNumber: 1, nodeId: null, phase: "adding", attempt: { id: attemptId, status: "in_flight", message: `in flight (attempt ${attemptId})` } }]);
    expect(during).not.toHaveProperty("add");
    expect(w.converge).toHaveBeenCalledTimes(1);
    // the planner reads the slot's attempt as issued
    expect(readSeatPoolAgents(w.deps, w.slots.forModel(m.nodeId)).map((a) => a.attemptState)).toEqual(["issued"]);

    gate.resolve();
    await w.executor.idle();
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
    expect(w.slots.forModel(m.nodeId)[0]).toMatchObject({ nodeId: agent.id, phase: "live", attemptState: "settled" });
    expect(JSON.parse(w.correlations()[0]!.node_ids_json)).toEqual([agent.id]);
    const after = await w.notesOf(m.jobId);
    expect(after.settled).toEqual([{ slotNumber: 1, logicalId: "dev.impl-s1", nodeId: agent.id, attempt: { id: attemptId, status: "running" } }]);
    expect(after.slots).toEqual([{ slotNumber: 1, nodeId: agent.id, phase: "live", attempt: { id: attemptId, status: "running" } }]);
    expect(after).not.toHaveProperty("add");
    expect(JSON.stringify([first, during, after])).not.toContain("\"stop\"");
    expect(w.converge).toHaveBeenCalledTimes(1);
  });

  it("An add whose issue fails with an unexpected error leaves no slot row, keeps its number free, and the next cycle adds slot 1.", async () => {
    const w = addWorld();
    const m = await w.model();
    const issue = vi.spyOn(w.slots, "issueAttempt").mockImplementationOnce(() => { throw new Error("disk I/O error"); });

    await expect(w.executor.cycle({ jobId: m.jobId, context: { model_node_id: m.nodeId } })).rejects.toThrow("disk I/O error");
    await w.executor.idle();
    expect(issue).toHaveBeenCalledTimes(1);
    expect(w.slots.forModel(m.nodeId)).toEqual([]);
    expect(w.slots.nextSlot(m.nodeId)).toEqual({ slotNumber: 1, logicalId: "dev.impl-s1" });
    expect(w.converge).not.toHaveBeenCalled();
    expect(w.correlations()).toEqual([]);

    const next = await w.notesOf(m.jobId);
    expect(next.add).toMatchObject({ issued: [{ slotNumber: 1, logicalId: "dev.impl-s1" }] });
    await w.executor.idle();
    expect(w.slots.forModel(m.nodeId).map((s) => [s.slotNumber, s.phase])).toEqual([[1, "live"]]);
  });

  it("An add that settles while the next cycle waits for custody is reported `running` in both `slots` and `settled` of that cycle, never `in_flight` beside `running`.", async () => {
    const w = addWorld();
    const m = await w.model();
    const gate = deferred();
    w.hooks.beforeAdd = () => gate.promise;
    const first = await w.notesOf(m.jobId);
    const attemptId = (first.add as { issued: Array<{ attempt: { id: string } }> }).issued[0]!.attempt.id;

    // the next cycle reads its slots, then the add settles while it waits for the lease
    const custody = w.deps.custody;
    w.deps.custody = async (ids, fn) => { gate.resolve(); await w.executor.idle(); return custody(ids, fn); };
    const during = await w.notesOf(m.jobId);
    const agent = w.nodeOf(m.rigId, "dev.impl-s1")!;
    expect(during.settled).toEqual([{ slotNumber: 1, logicalId: "dev.impl-s1", nodeId: agent.id, attempt: { id: attemptId, status: "running" } }]);
    expect(during.slots).toEqual([{ slotNumber: 1, nodeId: agent.id, phase: "live", attempt: { id: attemptId, status: "running" } }]);
  });

  it("With `count` above one, each add has its own reservation, issue and operation id, one after another.", async () => {
    const w = addWorld();
    const m = await w.model({ pool: { max: 3, min: 2 } });
    const notes = await w.notesOf(m.jobId);
    const issued = (notes.add as { issued: Array<{ slotNumber: number; attempt: { id: string } }> }).issued;
    expect(issued.map((i) => i.slotNumber)).toEqual([1, 2]);
    expect(new Set(issued.map((i) => i.attempt.id)).size).toBe(2);
    await w.executor.idle();
    expect(w.converge.mock.calls.map((c) => c[1].member["id"])).toEqual(["impl-s1", "impl-s2"]);
    expect(w.slots.forModel(m.nodeId).map((s) => [s.slotNumber, s.phase, s.attemptState])).toEqual([[1, "live", "settled"], [2, "live", "settled"]]);
    expect(w.correlations().map((c) => c.operation_id).sort()).toEqual(issued.map((i) => i.attempt.id).sort());
  });
});

describe("seat-pool add: the model's member startup (#3395 Piece 1)", () => {
  const STARTUP = { files: [{ path: "guidance/member.md", delivery_hint: "send_text", required: true }], actions: [] };

  it("A model whose member startup file comes from a root other than the rig's stored root gives a new pool agent that startup, resolved from the model's own launch root, and the rig export still leaves it out.", async () => {
    const w = addWorld();
    fs.mkdirSync(path.join(w.root, "guidance"));
    fs.writeFileSync(path.join(w.root, "guidance", "member.md"), "member guidance");
    const m = await w.model({ member: { startup: STARTUP } });
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seat-pool-other-root-")));
    cleanups.push(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
    w.rigRepo.setRigStartupLayers(m.rigId, { ...w.rigRepo.getRigStartupLayers(m.rigId)!, root: elsewhere });
    expect(w.exporter.memberStartupNotCarried(m.rigId)).toContainEqual({ logicalId: "dev.impl", reason: "different source root" });

    const notes = await w.notesOf(m.jobId);
    await w.executor.idle();
    expect(notes.add).toMatchObject({ issued: [{ slotNumber: 1 }] });
    const [, op, rigRoot] = w.converge.mock.calls[0]!;
    expect(rigRoot).toBe(w.root);
    expect((op.member["startup"] as { files: Array<{ path: string }> }).files.map((f) => f.path)).toEqual(["guidance/member.md"]);
    expect(w.slots.forModel(m.nodeId).map((s) => [s.slotNumber, s.phase])).toEqual([[1, "live"]]);
    // the rig export is unchanged: it still leaves the member's startup out
    const exported = w.exporter.exportRig(m.rigId) as { pods: Array<{ members: Array<{ id: string; startup?: unknown }> }> };
    expect(exported.pods[0]!.members.find((member) => member.id === "impl")!.startup).toBeUndefined();
  });

  it("A model whose member startup files can't be resolved from its own launch root makes the pool add no agent and record why.", async () => {
    const w = addWorld();
    fs.mkdirSync(path.join(w.root, "guidance"));
    fs.writeFileSync(path.join(w.root, "guidance", "member.md"), "member guidance");
    const m = await w.model({ member: { startup: STARTUP } });
    // no launch recipe: the add would resolve the files from no root of the model's
    const layers = w.rigRepo.getRigStartupLayers(m.rigId)!;
    const recipe = w.rigRepo.getNodeLaunchRecipe(m.nodeId)!;
    w.rigRepo.setRigStartupLayers(m.rigId, { ...layers, materializedSources: [{ root: recipe.rigRoot, spec: recipe.rigSpec, nodeIds: [m.nodeId] }] });
    w.db.prepare("UPDATE nodes SET launch_recipe_json = NULL WHERE id = ?").run(m.nodeId);

    const notes = await w.notesOf(m.jobId);
    await w.executor.idle();
    expect((notes.add as { refused: string }).refused).toMatch(/^add refused: the model member can't be exported \(.*startup/);
    expect(w.converge).not.toHaveBeenCalled();
    expect(w.slots.forModel(m.nodeId)).toEqual([]);
    expect(w.correlations()).toEqual([]);
  });

  it("A model whose declared member startup can't be read (a file path that leaves the root) makes the pool add no agent and record why, while the rig export still leaves the startup out and names it.", async () => {
    const w = addWorld();
    fs.mkdirSync(path.join(w.root, "guidance"));
    fs.writeFileSync(path.join(w.root, "guidance", "member.md"), "member guidance");
    const m = await w.model({ member: { startup: STARTUP } });
    // the launch recipe keeps a declared startup whose file path escapes the root: the add can't read it
    const recipe = w.rigRepo.getNodeLaunchRecipe(m.nodeId)!;
    const rigSpec = structuredClone(recipe.rigSpec);
    const member = rigSpec.pods.find((pod) => pod.id === "dev")!.members.find((entry) => entry.id === "impl")!;
    member.startup = { ...member.startup!, files: member.startup!.files.map((file) => ({ ...file, path: "../outside.md" })) };
    w.db.prepare("UPDATE nodes SET launch_recipe_json = ? WHERE id = ?").run(JSON.stringify({ ...recipe, rigSpec }), m.nodeId);
    expect(w.rigRepo.getNodeLaunchRecipe(m.nodeId)).not.toBeNull();
    expect(w.exporter.memberStartupNotCarried(m.rigId)).toContainEqual({ logicalId: "dev.impl", reason: "source unavailable" });

    const notes = await w.notesOf(m.jobId);
    await w.executor.idle();
    expect((notes.add as { refused: string }).refused).toMatch(/^add refused: the model member can't be exported \(.*startup can't be read/);
    expect(w.converge).not.toHaveBeenCalled();
    expect(w.slots.forModel(m.nodeId)).toEqual([]);
    expect(w.correlations()).toEqual([]);
    const exported = w.exporter.exportRig(m.rigId) as { pods: Array<{ members: Array<{ id: string; startup?: unknown }> }> };
    expect(exported.pods[0]!.members.find((entry) => entry.id === "impl")!.startup).toBeUndefined();
  });
});
