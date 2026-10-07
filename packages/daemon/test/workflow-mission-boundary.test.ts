import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogScheduler } from "../src/domain/watchdog-scheduler.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";

const boundary = `
lifecycle:
  profile: release-boundary-v0
  workflow:
    context_refs: [SPEC.md, PROGRESS.md]
    entry: { role: orchestrator }
    roles:
      orchestrator: { preferred_targets: [orch@rig] }
    steps:
      - id: mission-boundary
        actor_role: orchestrator
        objective: Inspect current receipts and decide the next authored boundary.
        allowed_exits: [waiting, done, failed]
        re_present_after_seconds: 300
        re_present_max_seconds: 3600
`;

describe("authored mission boundary with event-first wait", () => {
  let db: Database.Database;
  let queue: QueueRepository;
  let jobs: WatchdogJobsRepository;
  let runtime: WorkflowRuntime;
  let scheduler: WatchdogScheduler;
  let stopEvents: () => void;
  let root: string;
  let mission: string;
  let delivered: string[];

  function wire() {
    const bus = new EventBus(db);
    queue = new QueueRepository(db, bus, { validateRig: () => true });
    queue.attachOutbox(new OutboxHandler(db));
    jobs = new WatchdogJobsRepository(db);
    queue.attachWatchdogJobsRepository(jobs);
    stopEvents = queue.startWaitReminders();
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue, watchdogJobsRepo: jobs });
    scheduler = new WatchdogScheduler({ jobsRepo: jobs, policyEngine: new WatchdogPolicyEngine({
      jobsRepo: jobs, historyLog: new WatchdogHistoryLog(db), eventBus: bus,
      deliver: async ({ message }) => { delivered.push(message); return { status: "ok" }; },
      onWakeAttempt: ({ jobId, deliveryStatus }) => queue.recordWatchdogWakeAttempt(jobId, deliveryStatus),
    }), onTickError: (error) => { throw error; } });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-06T00:00:00Z"));
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r', 'rig')").run();
    delivered = [];
    wire();
    root = mkdtempSync(join(tmpdir(), "mission-boundary-"));
    mission = join(root, "missions", "release-demo");
    mkdirSync(mission, { recursive: true });
    writeFileSync(join(root, "project.yaml"), `kind: project\nmetadata: {id: demo}\nmissions: {root: missions}\nlifecycle: {profile: release-boundary-v0}\ninstall: {context: [authority.md]}\n`);
    const refs = [];
    for (let i = 1; i <= 9; i++) {
      const ref = `slices/s${i}/slice.yaml`;
      mkdirSync(join(mission, `slices/s${i}`), { recursive: true });
      writeFileSync(join(mission, ref), "kind: slice\ncomposition: {mission: ../../mission.yaml}\n");
      refs.push(`    - {ref: ${ref}, order: ${i * 10}, active: true}`);
    }
    writeFileSync(join(mission, "mission.yaml"), `kind: mission\nmetadata: {name: release-demo, status: active}\ncomposition:\n  slices:\n${refs.join("\n")}\n${boundary}`);
  });

  afterEach(() => { stopEvents(); db.close(); rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });

  const stepTime = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000);
  const instantiateInput = () => ({ missionPath: mission, operationKey: "opaque-boundary-operation", rootObjective: "Recover project context", createdBySession: "orch@rig" });
  const timer = (packet: string) => jobs.getByIdOrThrow(queue.getParkWakeStatus(packet)!.ref);

  it("compiles only the authored boundary, binds its sources, and replays one instance without interpreting receipts", async () => {
    const before = readFileSync(join(mission, "mission.yaml"), "utf8");
    const compiled = runtime.compileLifecycle(mission, "opaque-boundary-operation");
    expect(compiled.eligible).toBe(true);
    expect(compiled.sources).toHaveLength(11);
    expect(compiled.workflowSpec?.steps.map((s) => s.id)).toEqual(["mission-boundary"]);
    expect(compiled.workflowSpec?.steps[0]?.acceptance).toBeUndefined();
    const run = await runtime.instantiateLifecycle(instantiateInput());
    expect(run.instance.lifecycleBinding).toMatchObject({ identity: compiled.identity });
    expect(run.instance.compiledInputDigest).toBe(compiled.compiledInputDigest);
    const body = queue.getByIdOrThrow(run.entryQitemId).body;
    for (const ref of [join(root, "authority.md"), join(mission, "SPEC.md"), join(mission, "PROGRESS.md")]) expect(body).toContain(ref);
    expect(body).toContain(`--instance ${run.instance.instanceId} --current-packet ${run.entryQitemId}`);
    expect(body).toContain("shortcut, not the whole story");
    await runtime.project({ instanceId: run.instance.instanceId, currentPacketId: run.entryQitemId,
      actorSession: "orch@rig", exit: "waiting", blockedOn: "external:receipt",
      closureEvidence: { receipt: { outcome: "published", verdict: "CLEAR" } } });
    expect(queue.getByIdOrThrow(run.entryQitemId).state).toBe("blocked");
    stopEvents(); wire();
    const replay = await runtime.instantiateLifecycle(instantiateInput());
    expect(replay.instance.instanceId).toBe(run.instance.instanceId);
    expect(replay.entryQitemId).toBe(run.entryQitemId);
    expect((db.prepare("SELECT count(*) n FROM workflow_instances").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT count(*) n FROM queue_items").get() as { n: number }).n).toBe(1);
    expect(readFileSync(join(mission, "mission.yaml"), "utf8")).toBe(before);
    appendFileSync(join(mission, "mission.yaml"), "# changed authored input\n");
    await expect(runtime.instantiateLifecycle(instantiateInput())).rejects.toThrow();
    expect((db.prepare("SELECT count(*) n FROM workflow_instances").get() as { n: number }).n).toBe(1);
  });

  it("backs off 5/10/20/40/60 minutes across acknowledgments and restart, resets only for new evidence, and stops on the agent's exit", async () => {
    const run = await runtime.instantiateLifecycle(instantiateInput());
    const wait = { instanceId: run.instance.instanceId, currentPacketId: run.entryQitemId, actorSession: "orch@rig", exit: "waiting" as const, blockedOn: "external:receipt", closureEvidence: { receipt: "proof/a.md", candidate: "a" } };
    await expect(runtime.project({ ...wait, blockedOn: run.entryQitemId })).rejects.toMatchObject({ code: "wake_self_blocker" });
    await runtime.project(wait);
    const jobId = timer(run.entryQitemId).jobId;
    for (const [index, delay] of [300, 600, 1200, 2400, 3600, 3600].entries()) {
      expect(timer(run.entryQitemId).intervalSeconds).toBe(delay);
      stepTime(delay - 1);
      await runtime.project({ ...wait, resultNote: `Still waiting ${index}`, closureEvidence: { candidate: "a", receipt: "proof/a.md" } });
      await runtime.project({ ...wait, resultNote: `Acknowledged ${index}`, closureEvidence: undefined });
      expect(timer(run.entryQitemId).jobId).toBe(jobId);
      expect(timer(run.entryQitemId).intervalSeconds).toBe(delay);
      await scheduler.runTickNow();
      expect(delivered).toHaveLength(index);
      stepTime(1); await scheduler.runTickNow();
      expect(delivered).toHaveLength(index + 1);
      expect(delivered[index]).toContain(`--current-packet ${run.entryQitemId}`);
      expect(delivered[index]).toContain(join(mission, "PROGRESS.md"));
      if (index === 2) { stopEvents(); wire(); }
    }
    await runtime.project({ ...wait, closureEvidence: { candidate: "b", receipt: "proof/b.md" } });
    expect(timer(run.entryQitemId).intervalSeconds).toBe(300);
    expect(timer(run.entryQitemId).lastEvaluationAt).toBe(new Date().toISOString());
    expect(timer(run.entryQitemId).jobId).toBe(jobId);
    const before = readFileSync(join(mission, "mission.yaml"), "utf8");
    await runtime.project({ ...wait, exit: "done", resultNote: "Agent chose to close the boundary" });
    expect(jobs.getByIdOrThrow(jobId).state).toBe("terminal");
    stepTime(7200); await scheduler.runTickNow();
    expect(delivered).toHaveLength(6);
    expect(readFileSync(join(mission, "mission.yaml"), "utf8")).toBe(before);
  });

  it("wakes on the exact blocker transition, bridges missed events at restart, and absorbs event replay", async () => {
    const run = await runtime.instantiateLifecycle(instantiateInput());
    const blocker = await queue.create({ sourceSession: "orch@rig", destinationSession: "worker@rig", body: "Receipt work", nudge: false });
    await runtime.project({ instanceId: run.instance.instanceId, currentPacketId: run.entryQitemId, actorSession: "orch@rig", exit: "waiting", blockedOn: blocker.qitemId });
    const jobId = timer(run.entryQitemId).jobId;
    stepTime(1);
    await queue.claim({ qitemId: blocker.qitemId, destinationSession: "worker@rig", actorSession: "worker@rig" });
    // Wake-now marker: epoch is always due, so a blocker change 1s into the
    // 300s wait still wakes (#801 keeps fresh reminders on full interval).
    expect(timer(run.entryQitemId).lastEvaluationAt).toBe(new Date(0).toISOString());
    await scheduler.runTickNow();
    expect(delivered).toHaveLength(1);
    expect(timer(run.entryQitemId).intervalSeconds).toBe(300);
    queue.reconcileWaitReminders(blocker.qitemId);
    await scheduler.runTickNow();
    expect(delivered).toHaveLength(1);
    stopEvents();
    await queue.update({ qitemId: blocker.qitemId, actorSession: "worker@rig", state: "in-progress", transitionNote: "New receipt evidence" });
    wire();
    // Same wake-now marker on the evidence path.
    expect(timer(run.entryQitemId).lastEvaluationAt).toBe(new Date(0).toISOString());
    await scheduler.runTickNow();
    expect(delivered).toHaveLength(2);
    expect(timer(run.entryQitemId).jobId).toBe(jobId);
    await queue.update({ qitemId: blocker.qitemId, actorSession: "worker@rig", state: "done", closureReason: "no-follow-on" });
    expect(queue.getByIdOrThrow(run.entryQitemId).state).toBe("pending");
    expect(jobs.getByIdOrThrow(jobId).state).toBe("terminal");
    stepTime(7200); await scheduler.runTickNow();
    expect(delivered).toHaveLength(2);
  });

  it("refuses conflicting profiles and invalid backoff without instantiation", () => {
    const path = join(mission, "mission.yaml");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace(/        re_present_.*\n/g, ""));
    expect(runtime.compileLifecycle(mission, "key").workflowSpec?.steps[0]).toMatchObject({ re_present_after_seconds: 300, re_present_max_seconds: 3600 });
    for (const invalid of [original.replace("profile: release-boundary-v0", "profile: other"), original.replace("re_present_max_seconds: 3600", "re_present_max_seconds: 200")]) {
      writeFileSync(path, invalid);
      expect(() => runtime.compileLifecycle(mission, "key")).toThrow();
    }
    expect((db.prepare("SELECT count(*) n FROM workflow_instances").get() as { n: number }).n).toBe(0);
  });

  it("continues backoff without acknowledgments, ignores unrelated traffic, and honors same-state blocker progress", async () => {
    const run = await runtime.instantiateLifecycle(instantiateInput());
    const blocker = await queue.create({ sourceSession: "orch@rig", destinationSession: "worker@rig", body: "Blocker", nudge: false });
    const park = { qitemId: blocker.qitemId, actorSession: "worker@rig", state: "blocked" as const, blockedOn: "external:receipt", closureReason: "blocked_on", closureTarget: "external:receipt" };
    await queue.update(park);
    await runtime.project({ instanceId: run.instance.instanceId, currentPacketId: run.entryQitemId, actorSession: "orch@rig", exit: "waiting", blockedOn: blocker.qitemId });
    const jobId = timer(run.entryQitemId).jobId;
    for (const [index, delay] of [300, 600, 1200].entries()) {
      stepTime(delay);
      await scheduler.runTickNow();
      expect(delivered).toHaveLength(index + 1);
      expect(timer(run.entryQitemId).intervalSeconds).toBe(delay * 2);
      expect(queue.getParkWakeStatus(run.entryQitemId)).toMatchObject({ live: true, unconsumed: true });
    }
    const schedule = timer(run.entryQitemId);
    stepTime(1);
    await queue.create({ sourceSession: "orch@rig", destinationSession: "other@rig", body: "Unrelated", nudge: false });
    expect(timer(run.entryQitemId)).toEqual(schedule);
    await scheduler.runTickNow();
    expect(delivered).toHaveLength(3);
    expect(timer(run.entryQitemId).jobId).toBe(jobId);
    await queue.update({ ...park, transitionNote: "New evidence while still blocked" });
    await scheduler.runTickNow();
    expect(delivered).toHaveLength(4);
    expect(timer(run.entryQitemId).intervalSeconds).toBe(300);
  });
});
